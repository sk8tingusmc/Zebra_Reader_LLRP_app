/**
 * Zebra FX9600 4-Port RFID Reader
 * Custom LLRP implementation with full antenna support
 * Supports auto-reconnect and continuous reading
 *
 * Zebra-specific adaptations:
 * - Parses GET_READER_CAPABILITIES to build dBm -> power index map
 * - Uses HopTableID = 0 (default) for regulatory compliance
 * - Calls SET_READER_CONFIG before starting ROSpec
 * - Power configured in dBm, automatically converted to reader's power table index
 */

const net = require('net');
const EventEmitter = require('events');
const fs = require('fs');

// Configuration - Edit these settings
const CONFIG = {
    // Zebra FX9600 reader IP (enable LLRP Server mode on port 5084 in web UI)
    ip: '192.168.1.111',
    port: 5084,
    antennas: [1],  // Only antenna 1 connected
    // Per-antenna power in dBm (will be mapped to reader's power table index)
    // Zebra FX9600 typically supports ~10-30 dBm depending on region/firmware
    antennaPowerDbm: {
        1: 30,    // Antenna 1: 30 dBm
        2: 30,    // Antenna 2: 30 dBm
        3: 30,    // Antenna 3: 30 dBm
        4: 30,    // Antenna 4: 30 dBm
    },
    reconnectInterval: 5000,  // ms between reconnect attempts
    enableReconnect: true,
    debugRx: true,  // Set to true to log all received message types
};

// LLRP Message Types
const MSG = {
    GET_READER_CAPABILITIES: 1,
    GET_READER_CAPABILITIES_RESPONSE: 11,
    ENABLE_EVENTS_AND_REPORTS: 64,
    ENABLE_EVENTS_AND_REPORTS_RESPONSE: 12,
    ADD_ROSPEC: 20,
    ADD_ROSPEC_RESPONSE: 30,
    DELETE_ROSPEC: 21,
    DELETE_ROSPEC_RESPONSE: 31,
    START_ROSPEC: 22,
    START_ROSPEC_RESPONSE: 32,
    STOP_ROSPEC: 23,
    STOP_ROSPEC_RESPONSE: 33,
    ENABLE_ROSPEC: 24,
    ENABLE_ROSPEC_RESPONSE: 34,
    SET_READER_CONFIG: 3,
    SET_READER_CONFIG_RESPONSE: 13,
    READER_EVENT_NOTIFICATION: 63,
    RO_ACCESS_REPORT: 61,
    KEEPALIVE: 62,
    KEEPALIVE_ACK: 72,
    CLOSE_CONNECTION: 14,
    CLOSE_CONNECTION_RESPONSE: 4,
    ERROR_MESSAGE: 100,
};

// LLRP Parameter Types
const PARAM = {
    GENERAL_CAPABILITIES: 137,
    LLRP_CAPABILITIES: 142,
    REGULATORY_CAPABILITIES: 143,
    UHFC1G2_RF_MODE_TABLE: 329,
    TRANSMIT_POWER_LEVEL_TABLE_ENTRY: 145,
    FREQUENCY_HOP_TABLE: 147,
};

class LLRPReader extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.socket = null;
        this.messageId = 1;
        this.buffer = Buffer.alloc(0);
        this.connected = false;
        this.shouldReconnect = config.enableReconnect;
        this.reconnectTimer = null;
        this.isShuttingDown = false;
        this.configStarted = false;
        this.rospecStarted = false;  // Only process tags after ROSpec is fully running

        // Zebra-specific: Power table mapping (dBm * 100 -> index)
        this.powerTable = [];  // Array of {index, powerDbm} sorted by powerDbm
        this.antennaPowerIndex = {};  // Computed power indices per antenna
        this.hopTableIds = [];  // Valid hop table IDs from capabilities
        this.hopTableId = 1;  // Will be set from capabilities (default fallback = 1)
    }

    connect() {
        if (this.isShuttingDown) return;

        this.socket = new net.Socket();
        this.socket.setTimeout(30000);

        this.socket.connect(this.config.port, this.config.ip, () => {
            console.log(`Connected to ${this.config.ip}:${this.config.port}`);
            this.connected = true;
            this.emit('connected');
            this.socket.setTimeout(0);

            // Send ENABLE_EVENTS_AND_REPORTS (64) immediately
            this.sendMessage(64);

            // Pull capabilities after brief delay
            setTimeout(() => {
                if (this.connected) this.sendGetReaderCapabilities();
            }, 100);

            // Stuck detector - warn if no capabilities parsed after 2 seconds
            setTimeout(() => {
                if (this.connected && this.powerTable.length === 0) {
                    console.log("WARNING: Still no capabilities parsed (no power table). Did we receive msgType=11?");
                }
            }, 2000);
        });

        this.socket.on('data', (data) => this.handleData(data));

        this.socket.on('timeout', () => {
            console.log('Connection timeout - reconnecting...');
            this.socket.destroy();
        });

        this.socket.on('error', (err) => {
            if (!this.isShuttingDown) {
                console.error('Connection error:', err.message);
                this.emit('error', err);
            }
        });

        this.socket.on('close', () => {
            this.connected = false;
            if (!this.isShuttingDown) {
                this.emit('disconnect');
                this.scheduleReconnect();
            }
        });
    }

    scheduleReconnect() {
        if (!this.shouldReconnect || this.isShuttingDown) return;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        console.log(`Reconnecting in ${this.config.reconnectInterval / 1000} seconds...`);
        this.reconnectTimer = setTimeout(() => {
            console.log('Attempting to reconnect...');
            this.configStarted = false;
            this.rospecStarted = false;
            this.messageId = 1;
            this.buffer = Buffer.alloc(0);
            this.powerTable = [];
            this.antennaPowerIndex = {};
            this.hopTableIds = [];
            this.hopTableId = 1;
            this.connect();
        }, this.config.reconnectInterval);
    }

    disconnect() {
        this.isShuttingDown = true;
        this.shouldReconnect = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.socket) {
            if (this.connected) {
                this.sendCloseConnection();
            }
            setTimeout(() => {
                if (this.socket) {
                    this.socket.destroy();
                    this.socket = null;
                }
            }, 500);
        }
    }

    handleData(data) {
        this.buffer = Buffer.concat([this.buffer, data]);

        while (this.buffer.length >= 10) {
            const msgLength = this.buffer.readUInt32BE(2);
            if (this.buffer.length < msgLength) break;

            const message = this.buffer.slice(0, msgLength);
            this.buffer = this.buffer.slice(msgLength);
            this.processMessage(message);
        }
    }

    processMessage(data) {
        const msgType = ((data[0] & 0x03) << 8) | data[1];
        if (this.config.debugRx) console.log(`RX msgType=${msgType} len=${data.length}`);

        switch (msgType) {
            case MSG.ENABLE_EVENTS_AND_REPORTS_RESPONSE:
                console.log('ENABLE_EVENTS_AND_REPORTS_RESPONSE received');
                break;
            case MSG.READER_EVENT_NOTIFICATION:
                // Just note it arrived - actual startup chain is driven by capabilities (type 11)
                if (!this.configStarted) {
                    this.configStarted = true;
                    console.log('Reader event notification received.');
                }
                break;
            case MSG.GET_READER_CAPABILITIES_RESPONSE:
                if (!this.parseCapabilities(data)) return;
                this.computePowerIndices();
                this.sendDeleteROSpec();
                break;
            case MSG.ERROR_MESSAGE:
                this.handleErrorMessage(data);
                break;
            case MSG.SET_READER_CONFIG_RESPONSE:
                this.checkResponse(data, 'SET_READER_CONFIG');
                this.sendDeleteROSpec();
                break;
            case MSG.DELETE_ROSPEC_RESPONSE:
                this.checkResponse(data, 'DELETE_ROSPEC');
                this.sendAddROSpec();
                break;
            case MSG.ADD_ROSPEC_RESPONSE:
                this.checkResponse(data, 'ADD_ROSPEC');
                this.sendEnableROSpec();
                break;
            case MSG.ENABLE_ROSPEC_RESPONSE:
                this.checkResponse(data, 'ENABLE_ROSPEC');
                this.sendStartROSpec();
                break;
            case MSG.START_ROSPEC_RESPONSE:
                if (this.checkResponse(data, 'START_ROSPEC')) {
                    this.rospecStarted = true;  // Now safe to process tags
                    console.log('\nReader started - reading tags...');
                    console.log('Press Ctrl+C to stop.\n');
                    this.emit('ready');
                }
                break;
            case MSG.RO_ACCESS_REPORT:
                this.parseTagReport(data);
                break;
            case MSG.KEEPALIVE:
                this.sendKeepaliveAck();
                break;
        }
    }

    parseCapabilities(data) {
        console.log('Parsing reader capabilities...');
        let offset = 10;  // Skip LLRP header

        // First, check for LLRPStatus
        if (offset + 4 <= data.length) {
            const statusType = data.readUInt16BE(offset) & 0x3FF;
            if (statusType === 287) {  // LLRPStatus
                const statusLen = data.readUInt16BE(offset + 2);
                const statusCode = data.readUInt16BE(offset + 4);
                if (statusCode !== 0) {
                    console.error(`GET_READER_CAPABILITIES failed with status: ${statusCode}`);
                    return false;
                }
                offset += statusLen;
            }
        }

        // Parse TLV parameters to find power table
        while (offset + 4 <= data.length) {
            const paramType = data.readUInt16BE(offset) & 0x3FF;
            const paramLen = data.readUInt16BE(offset + 2);

            if (paramLen === 0 || paramLen > data.length - offset) break;

            // Look for RegulatoryCapabilities (143) which contains power table
            if (paramType === PARAM.REGULATORY_CAPABILITIES) {
                this.parseRegulatoryCapabilities(data.slice(offset, offset + paramLen));
            }

            offset += paramLen;
        }

        if (this.powerTable.length === 0) {
            console.warn('Warning: No power table found in capabilities, using default index');
        } else {
            console.log(`Found ${this.powerTable.length} power levels in reader capabilities`);
            const minPower = this.powerTable[0].powerDbm;
            const maxPower = this.powerTable[this.powerTable.length - 1].powerDbm;
            console.log(`  Power range: ${minPower.toFixed(1)} - ${maxPower.toFixed(1)} dBm`);
        }

        // Select hop table ID
        if (this.hopTableIds.length > 0) {
            this.hopTableId = this.hopTableIds[0];
            console.log(`  Using HopTableID: ${this.hopTableId} (found ${this.hopTableIds.length} tables)`);
        } else {
            this.hopTableId = 1;  // Fallback
            console.warn('  Warning: No hop table found, defaulting HopTableID=1');
        }

        return true;
    }

    parseRegulatoryCapabilities(data) {
        // RegulatoryCapabilities structure:
        // Header (4 bytes) + CountryCode (2 bytes) + CommunicationsStandard (2 bytes)
        // + UHFBandCapabilities (nested)
        let offset = 4;  // Skip TLV header

        if (offset + 4 > data.length) return;

        const countryCode = data.readUInt16BE(offset);
        offset += 2;
        const commStandard = data.readUInt16BE(offset);
        offset += 2;

        console.log(`  Country code: ${countryCode}, Comm standard: ${commStandard}`);

        // Parse nested parameters (UHFBandCapabilities, etc.)
        while (offset + 4 <= data.length) {
            const paramType = data.readUInt16BE(offset) & 0x3FF;
            const paramLen = data.readUInt16BE(offset + 2);

            if (paramLen === 0 || paramLen > data.length - offset) break;

            if (paramType === 144) {  // UHFBandCapabilities
                this.parseUHFBandCapabilities(data.slice(offset, offset + paramLen));
            }

            offset += paramLen;
        }
    }

    parseUHFBandCapabilities(data) {
        // UHFBandCapabilities contains TransmitPowerLevelTableEntry and FrequencyHopTable
        let offset = 4;  // Skip TLV header

        while (offset + 4 <= data.length) {
            const paramType = data.readUInt16BE(offset) & 0x3FF;
            const paramLen = data.readUInt16BE(offset + 2);

            if (paramLen === 0 || paramLen > data.length - offset) break;

            if (paramType === PARAM.TRANSMIT_POWER_LEVEL_TABLE_ENTRY) {
                // TransmitPowerLevelTableEntry: Header (4) + Index (2) + TransmitPowerValue (2)
                if (paramLen >= 8) {
                    const index = data.readUInt16BE(offset + 4);
                    const powerValue = data.readInt16BE(offset + 6);  // Power in 0.01 dBm (signed)
                    const powerDbm = powerValue / 100.0;
                    this.powerTable.push({ index, powerDbm });
                }
            } else if (paramType === PARAM.FREQUENCY_HOP_TABLE) {
                // FrequencyHopTable: Header (4) + HopTableID (2 bytes) + ...
                if (paramLen >= 6) {
                    const hopTableId = data.readUInt16BE(offset + 4);
                    if (hopTableId > 0) {
                        this.hopTableIds.push(hopTableId);
                    }
                }
            }

            offset += paramLen;
        }

        // Sort power table by dBm value
        this.powerTable.sort((a, b) => a.powerDbm - b.powerDbm);
    }

    computePowerIndices() {
        // Convert desired dBm values to reader power table indices
        for (const ant of this.config.antennas) {
            const desiredDbm = this.config.antennaPowerDbm[ant] || 30;
            const index = this.findClosestPowerIndex(desiredDbm);
            this.antennaPowerIndex[ant] = index;

            const actualDbm = this.powerTable.find(p => p.index === index)?.powerDbm || desiredDbm;
            console.log(`  Antenna ${ant}: requested ${desiredDbm} dBm -> index ${index} (${actualDbm.toFixed(1)} dBm)`);
        }
    }

    findClosestPowerIndex(desiredDbm) {
        if (this.powerTable.length === 0) {
            // No power table available, use reasonable default index
            // Many readers use index 1 as minimum, higher numbers for more power
            return Math.min(Math.max(1, Math.round(desiredDbm)), 100);
        }

        // Find closest match in power table
        let closest = this.powerTable[0];
        let minDiff = Math.abs(this.powerTable[0].powerDbm - desiredDbm);

        for (const entry of this.powerTable) {
            const diff = Math.abs(entry.powerDbm - desiredDbm);
            if (diff < minDiff) {
                minDiff = diff;
                closest = entry;
            }
        }

        return closest.index;
    }

    checkResponse(data, msgName) {
        // Check LLRPStatus in response - parse full error details
        // Returns true if successful, false if error
        let offset = 10;  // Skip LLRP header
        let success = true;

        while (offset + 4 <= data.length) {
            const paramType = data.readUInt16BE(offset) & 0x3FF;
            const paramLen = data.readUInt16BE(offset + 2);

            if (paramLen === 0 || paramLen > data.length - offset) break;

            if (paramType === 287) { // LLRPStatus
                const statusCode = data.readUInt16BE(offset + 4);
                if (statusCode !== 0) {
                    success = false;
                    console.error(`${msgName} failed with status code: ${statusCode}`);

                    // Parse error description if present
                    if (paramLen > 6) {
                        const descLen = data.readUInt16BE(offset + 6);
                        if (descLen > 0 && offset + 8 + descLen <= data.length) {
                            const desc = data.slice(offset + 8, offset + 8 + descLen).toString('utf8');
                            console.error(`  Error description: ${desc}`);
                        }

                        // Check for nested FieldError (288) or ParameterError (289)
                        let nestedOffset = offset + 8 + (data.readUInt16BE(offset + 6) || 0);
                        while (nestedOffset + 4 <= offset + paramLen) {
                            const nestedType = data.readUInt16BE(nestedOffset) & 0x3FF;
                            const nestedLen = data.readUInt16BE(nestedOffset + 2);

                            if (nestedLen === 0 || nestedLen > paramLen) break;

                            if (nestedType === 288 && nestedLen >= 8) { // FieldError
                                const fieldNum = data.readUInt16BE(nestedOffset + 4);
                                const errorCode = data.readUInt16BE(nestedOffset + 6);
                                console.error(`  FieldError: field=${fieldNum}, code=${errorCode}`);
                            }
                            if (nestedType === 289 && nestedLen >= 8) { // ParameterError
                                const paramErrorType = data.readUInt16BE(nestedOffset + 4);
                                const errorCode = data.readUInt16BE(nestedOffset + 6);
                                console.error(`  ParameterError: paramType=${paramErrorType}, code=${errorCode}`);
                            }

                            nestedOffset += nestedLen;
                        }
                    }
                }
            }

            offset += paramLen;
        }

        return success;
    }

    handleErrorMessage(data) {
        console.error('[ERROR] LLRP Error Message received');
        console.error('[ERROR] Full message hex:', data.toString('hex'));

        // Parse the error message structure
        let offset = 10; // Skip LLRP header
        while (offset < data.length - 4) {
            const paramType = data.readUInt16BE(offset) & 0x3FF;
            const paramLen = data.readUInt16BE(offset + 2);

            if (paramLen === 0 || paramLen > data.length - offset) break;

            console.error(`[ERROR] Parameter Type: ${paramType}, Length: ${paramLen}`);

            if (paramType === 287) { // LLRPStatus
                const statusCode = data.readUInt16BE(offset + 4);
                console.error(`[ERROR] LLRPStatus Code: ${statusCode}`);
                // Check for error description
                const descLen = data.readUInt16BE(offset + 6);
                if (descLen > 0 && offset + 8 + descLen <= data.length) {
                    const desc = data.slice(offset + 8, offset + 8 + descLen).toString('utf8');
                    console.error(`[ERROR] Description: ${desc}`);
                }
            }

            if (paramType === 288) { // FieldError
                const fieldNum = data.readUInt16BE(offset + 4);
                const errorCode = data.readUInt16BE(offset + 6);
                console.error(`[ERROR] FieldError - Field: ${fieldNum}, Code: ${errorCode}`);
            }

            if (paramType === 289) { // ParameterError
                const paramErrorType = data.readUInt16BE(offset + 4);
                const errorCode = data.readUInt16BE(offset + 6);
                console.error(`[ERROR] ParameterError - ParamType: ${paramErrorType}, Code: ${errorCode}`);
            }

            offset += paramLen;
        }
    }

    sendMessage(type, payload = Buffer.alloc(0)) {
        if (!this.socket || !this.connected) return;

        const header = Buffer.alloc(10);
        const msgLen = 10 + payload.length;

        // Correct LLRP header byte 0 (matches the working minimal script)
        header.writeUInt8((0x04) | ((type >> 8) & 0x03), 0);
        header.writeUInt8(type & 0xFF, 1);
        header.writeUInt32BE(msgLen, 2);
        header.writeUInt32BE(this.messageId++, 6);

        this.socket.write(Buffer.concat([header, payload]));
    }

    sendGetReaderCapabilities() {
        // GET_READER_CAPABILITIES: RequestedData = All (0)
        const payload = Buffer.from([0x00]);
        this.sendMessage(MSG.GET_READER_CAPABILITIES, payload);
    }

    sendSetReaderConfig() {
        // SET_READER_CONFIG with keepalives enabled
        // This is called after capabilities for Zebra compatibility
        const payload = Buffer.from([
            0x00,  // RestoreFactorySettings = false
            // KeepaliveSpec (Type 220)
            0x00, 0xdc, 0x00, 0x09,  // Type 220, Length 9
            0x01,                     // KeepaliveTriggerType = Periodic
            0x00, 0x00, 0x75, 0x30,  // TimeInterval = 30000ms
        ]);
        this.sendMessage(MSG.SET_READER_CONFIG, payload);
    }

    sendDeleteROSpec() {
        const payload = Buffer.alloc(4);
        payload.writeUInt32BE(0, 0);  // Delete all ROSpecs
        this.sendMessage(MSG.DELETE_ROSPEC, payload);
    }

    sendAddROSpec() {
        const rospec = this.buildROSpec();
        this.sendMessage(MSG.ADD_ROSPEC, rospec);
    }

    buildROSpec() {
        // Helper: TLV builder (Type: u16, Length: u16, Value: bytes)
        const tlv = (type, valueBuf) => {
            const h = Buffer.alloc(4);
            h.writeUInt16BE(type, 0);
            h.writeUInt16BE(4 + valueBuf.length, 2);
            return Buffer.concat([h, valueBuf]);
        };

        // Helper: Stop trigger TLV - ALWAYS include duration
        const stopTriggerTLV = (typeNum, triggerType, durationMs) => {
            // Always include 5 bytes (1 type + 4 duration) even for Null trigger
            const v = Buffer.alloc(5);
            v.writeUInt8(triggerType & 0xff, 0);
            v.writeUInt32BE(durationMs >>> 0, 1);
            return tlv(typeNum, v);
        };

        // Gen2 C1G2SingulationControl (336)
        const c1g2SingulationControl = ({ session = 2, tagPopulation = 32, tagTransitTime = 0 } = {}) => {
            const v = Buffer.alloc(1 + 2 + 4);
            // Session is 2 bits at the MSB of the first byte (bits 7-6)
            v.writeUInt8((session << 6) & 0xC0, 0);
            v.writeUInt16BE(tagPopulation & 0xFFFF, 1);
            v.writeUInt32BE(tagTransitTime >>> 0, 3);
            return tlv(336, v);
        };

        // Gen2 C1G2InventoryCommand (330)
        const c1g2InventoryCommand = () => {
            const flags = Buffer.alloc(1);
            flags.writeUInt8(0x00, 0); // TagInventoryStateAware = 0
            const sing = c1g2SingulationControl({ session: 2, tagPopulation: 32, tagTransitTime: 0 });
            return tlv(330, Buffer.concat([flags, sing]));
        };

        // RFTransmitter (224): HopTableID + ChannelIndex + TransmitPower
        // Zebra fix: Use HopTableID = 0 (default) instead of hardcoded 1
        const rfTransmitter = (powerIndex) => {
            const v = Buffer.alloc(6);
            v.writeUInt16BE(this.hopTableId, 0);  // HopTableID = 0 (default) or from capabilities
            v.writeUInt16BE(0, 2);                // ChannelIndex = 0 (auto)
            v.writeUInt16BE(powerIndex, 4);       // TransmitPower index from power table
            return tlv(224, v);
        };

        // AntennaConfiguration (222) - WITH RFTransmitter only (no C1G2InventoryCommand - Zebra doesn't like it)
        const antennaConfiguration = (antennaId) => {
            const antId = Buffer.alloc(2);
            antId.writeUInt16BE(antennaId, 0);
            // Use power index from capabilities, or max valid index, or 1 if unknown
            const powerIndex = this.antennaPowerIndex[antennaId] ??
                (this.powerTable.length ? this.powerTable[this.powerTable.length - 1].index : 1);
            const rfTx = rfTransmitter(powerIndex);
            // NOTE: Removed c1g2InventoryCommand() - minimal.js works without it
            return tlv(222, Buffer.concat([antId, rfTx]));
        };

        // InventoryParameterSpec (186)
        const inventoryParameterSpecWithAntennas = (antennaIds) => {
            const hdr = Buffer.alloc(3);
            hdr.writeUInt16BE(1, 0);  // InventoryParameterSpecID = 1
            hdr.writeUInt8(1, 2);     // ProtocolID = EPCGlobalClass1Gen2 (1)
            const antConfs = Buffer.concat(antennaIds.map(antennaConfiguration));
            return tlv(186, Buffer.concat([hdr, antConfs]));
        };

        // ROSpec header fields
        const rospecHeaderFields = Buffer.alloc(6);
        rospecHeaderFields.writeUInt32BE(1, 0); // ROSpecID = 1
        rospecHeaderFields.writeUInt8(0, 4);    // Priority = 0
        rospecHeaderFields.writeUInt8(0, 5);    // CurrentState = Disabled (0)

        // ROSpecStartTrigger (179): Null trigger (0)
        const roStartTrigger = tlv(179, Buffer.from([0x00]));

        // ROSpecStopTrigger (182): Null trigger (0)
        const roStopTrigger = stopTriggerTLV(182, 0, 0);

        // ROBoundarySpec (178): contains start + stop triggers
        const roBoundary = tlv(178, Buffer.concat([roStartTrigger, roStopTrigger]));

        // AISpec AntennaIDs: count (2 bytes) + list of antenna IDs (2 bytes each)
        // Note: LLRP spec requires AntennaCount field before the list
        const antennaCount = Buffer.alloc(2);
        antennaCount.writeUInt16BE(this.config.antennas.length, 0);
        const antennaIdList = Buffer.concat(
            this.config.antennas.map(ant => {
                const buf = Buffer.alloc(2);
                buf.writeUInt16BE(ant, 0);
                return buf;
            })
        );
        const fullAntennaList = Buffer.concat([antennaCount, antennaIdList]);

        // AISpecStopTrigger (184): Null trigger (0)
        const aiStopTrigger = stopTriggerTLV(184, 0, 0);

        // InventoryParameterSpec with AntennaConfiguration for each antenna
        const invParamSpec = inventoryParameterSpecWithAntennas(this.config.antennas);

        // AISpec (183): AntennaIDs + AISpecStopTrigger + InventoryParameterSpec
        const aiSpec = tlv(183, Buffer.concat([fullAntennaList, aiStopTrigger, invParamSpec]));

        // TagReportContentSelector (238): minimal flags (known-good on Zebra)
        // Use 0x00,0x00 to get default fields; other masks may break reporting on some firmware
        const trcsMask = Buffer.from([0x00, 0x00]);
        const tagReportContentSelector = tlv(238, trcsMask);

        // ROReportSpec (237): Trigger=Upon_N_Tags (1), N=1
        const roReportFields = Buffer.alloc(3);
        roReportFields.writeUInt8(0x01, 0);     // ROReportTrigger = Upon_N_Tags (1)
        roReportFields.writeUInt16BE(1, 1);     // N = 1
        const roReportSpec = tlv(237, Buffer.concat([roReportFields, tagReportContentSelector]));

        // Final ROSpec (177)
        return tlv(177, Buffer.concat([rospecHeaderFields, roBoundary, aiSpec, roReportSpec]));
    }

    sendEnableROSpec() {
        const payload = Buffer.alloc(4);
        payload.writeUInt32BE(1, 0);
        this.sendMessage(MSG.ENABLE_ROSPEC, payload);
    }

    sendStartROSpec() {
        const payload = Buffer.alloc(4);
        payload.writeUInt32BE(1, 0);
        this.sendMessage(MSG.START_ROSPEC, payload);
    }

    sendKeepaliveAck() {
        this.sendMessage(MSG.KEEPALIVE_ACK);
    }

    sendCloseConnection() {
        this.sendMessage(MSG.CLOSE_CONNECTION);
    }

    parseTagReport(data) {
        // Ignore buffered tags from previous session until ROSpec is fully started
        if (!this.rospecStarted) {
            if (this.config.debugRx) console.log('  (Ignoring tag report - ROSpec not started yet)');
            return;
        }

        if (this.config.debugRx) {
            console.log(`  RO_ACCESS_REPORT received, ${data.length} bytes`);
        }

        let offset = 10;

        while (offset + 4 <= data.length) {
            const paramType = data.readUInt16BE(offset) & 0x3FF;
            const paramLen = data.readUInt16BE(offset + 2);

            if (paramLen === 0 || paramLen > data.length - offset) break;

            if (paramType === 240) {  // TagReportData
                const tagData = data.slice(offset + 4, offset + paramLen);
                const tag = this.parseTagReportData(tagData);
                if (!tag.epc) {
                    console.log("TagReportData without EPC, raw hex:", tagData.slice(0, 40).toString("hex"));
                } else {
                    // If reader omitted AntennaID (0, null, or undefined) and we only configured one antenna, assume it
                    if (!tag.antenna && this.config.antennas.length === 1) {
                        tag.antenna = this.config.antennas[0];
                    }
                    this.emit('tag', tag);
                }
            }

            offset += paramLen;
        }
    }

    parseTagReportData(data) {
        const tag = { epc: null, antenna: null, rssi: null, timestamp: null };
        let offset = 0;

        // Debug: show raw TagReportData if debugRx enabled
        if (this.config.debugRx) {
            console.log(`  TagReportData raw (${data.length} bytes): ${data.slice(0, Math.min(50, data.length)).toString('hex')}`);
        }

        while (offset < data.length) {
            if (data[offset] & 0x80) {
                // TV-encoded parameter (Type-Value, no length field)
                const tvType = data[offset] & 0x7F;
                switch (tvType) {
                    case 1:  // AntennaID (TV): 1 byte type + 2 bytes value
                        if (offset + 3 <= data.length) {
                            tag.antenna = data.readUInt16BE(offset + 1);
                        }
                        offset += 3;
                        break;
                    case 6:  // PeakRSSI (TV): 1 byte type + 1 byte value (signed)
                        if (offset + 2 <= data.length) {
                            tag.rssi = data.readInt8(offset + 1);
                        }
                        offset += 2;
                        break;
                    case 7:  // ChannelIndex (TV): 1 byte type + 2 bytes value
                        offset += 3;
                        break;
                    case 8:  // FirstSeenTimestampUTC (TV): 1 byte type + 8 bytes value
                        offset += 9;
                        break;
                    case 9:  // LastSeenTimestampUTC (TV): 1 byte type + 8 bytes value
                        if (offset + 9 <= data.length) {
                            tag.timestamp = data.readBigUInt64BE(offset + 1);
                        }
                        offset += 9;
                        break;
                    case 10: // TagSeenCount (TV): 1 byte type + 2 bytes value
                        if (offset + 3 <= data.length) {
                            tag.seenCount = data.readUInt16BE(offset + 1);
                        }
                        offset += 3;
                        break;
                    case 13: // EPC-96 (TV): 1 byte type + 12 bytes EPC
                        if (offset + 13 <= data.length) {
                            tag.epc = data.slice(offset + 1, offset + 13).toString('hex').toUpperCase();
                        }
                        offset += 13;
                        break;
                    case 14: // ROSpecID (TV): 1 byte type + 4 bytes value
                        offset += 5;
                        break;
                    case 15: // SpecIndex (TV): 1 byte type + 2 bytes value
                        offset += 3;
                        break;
                    case 16: // InventoryParameterSpecID (TV): 1 byte type + 2 bytes value
                        offset += 3;
                        break;
                    default: {
                        // Unknown TV param - don't know its length, try to resync
                        // Scan forward for next TV header (MSB set) or give up
                        let jumped = false;
                        for (let j = 1; j <= 16 && offset + j < data.length; j++) {
                            if (data[offset + j] & 0x80) {
                                offset += j;
                                jumped = true;
                                break;
                            }
                        }
                        if (!jumped) return tag; // Give up on this tag block
                        break;
                    }
                }
            } else {
                if (offset + 3 >= data.length) break;

                const tlvType = data.readUInt16BE(offset) & 0x3FF;
                const tlvLen = data.readUInt16BE(offset + 2);

                if (tlvLen === 0 || offset + tlvLen > data.length) {
                    // Try to find next TV parameter by scanning forward
                    let found = false;
                    for (let skip = 1; skip <= 4 && offset + skip < data.length; skip++) {
                        if (data[offset + skip] & 0x80) {
                            offset += skip;
                            found = true;
                            break;
                        }
                    }
                    if (!found) break;
                    continue;
                }

                if (tlvType === 241) {  // EPCData
                    if (offset + 5 < data.length) {
                        const epcBitLen = data.readUInt16BE(offset + 4);
                        const epcLen = Math.floor(epcBitLen / 8);
                        if (offset + 6 + epcLen <= data.length) {
                            tag.epc = data.slice(offset + 6, offset + 6 + epcLen).toString('hex').toUpperCase();
                        }
                    }
                } else if (tlvType === 13) {  // EPC-96
                    if (offset + 4 + 12 <= data.length) {
                        tag.epc = data.slice(offset + 4, offset + 4 + 12).toString('hex').toUpperCase();
                    }
                }

                offset += tlvLen;
            }
        }

        return tag;
    }
}

// ============================================
// Main Application
// ============================================

const stats = {
    antennaReads: {},
    uniqueTags: new Set(),
    startTime: Date.now()
};

CONFIG.antennas.forEach(ant => stats.antennaReads[ant] = 0);

// Determine log filename based on antenna(s)
const antennaStr = CONFIG.antennas.join('_');
const logFilename = `test_antenna${antennaStr}.log`;

// Count existing tests in the log file to determine test number
function getNextTestNumber() {
    try {
        if (fs.existsSync(logFilename)) {
            const content = fs.readFileSync(logFilename, 'utf8');
            const matches = content.match(/Antenna.*Test (\d+)/g);
            if (matches && matches.length > 0) {
                return matches.length + 1;
            }
        }
    } catch (e) {
        // File doesn't exist or can't be read
    }
    return 1;
}

const testNumber = getNextTestNumber();

const powerStr = CONFIG.antennas.map(a => `${a}:${CONFIG.antennaPowerDbm[a] || 30}dBm`).join(', ');
console.log(`
================================================
  ZEBRA FX9600 8-PORT RFID READER
================================================
  IP:         ${CONFIG.ip}
  Port:       ${CONFIG.port}
  Antennas:   ${CONFIG.antennas.join(', ')}
  TX Power:   ${powerStr} (will map to reader index)
  Reconnect:  ${CONFIG.enableReconnect ? 'Enabled' : 'Disabled'}
  Log file:   ${logFilename} (Test ${testNumber})
================================================
`);

const reader = new LLRPReader(CONFIG);

reader.on('tag', (tag) => {
    stats.antennaReads[tag.antenna] = (stats.antennaReads[tag.antenna] || 0) + 1;
    stats.uniqueTags.add(tag.epc);

    const time = new Date().toISOString().substr(11, 12);
    console.log(`[${time}] ANT-${tag.antenna ?? '?'} | ${tag.epc} | RSSI: ${tag.rssi ?? '?'} dBm`);
});

reader.on('connected', () => {
    console.log('Configuring reader...');
});

reader.on('error', () => {
    // Errors logged in reader class
});

function printStats() {
    const runtime = ((Date.now() - stats.startTime) / 1000).toFixed(1);
    console.log('\n================================================');
    console.log('SESSION STATISTICS');
    console.log('================================================');
    console.log(`  Runtime:     ${runtime}s`);
    console.log(`  Unique tags: ${stats.uniqueTags.size}`);
    console.log('  Reads per antenna:');
    for (const ant of CONFIG.antennas) {
        console.log(`    Antenna ${ant}: ${stats.antennaReads[ant] || 0} reads`);
    }
    console.log('================================================\n');
}

function writeTestLog() {
    const runtime = ((Date.now() - stats.startTime) / 1000).toFixed(1);
    const antennaLabel = CONFIG.antennas.length === 1
        ? `Antenna ${CONFIG.antennas[0]}`
        : `Antennas ${CONFIG.antennas.join(', ')}`;

    const epcList = Array.from(stats.uniqueTags).join(', ');
    const powerStr = CONFIG.antennas.map(a => `${a}:${CONFIG.antennaPowerDbm[a] || 30}dBm`).join(', ');

    let logContent = `${antennaLabel} Test ${testNumber} (Power: ${powerStr})\n`;
    logContent += '================================================\n';
    logContent += 'SESSION STATISTICS\n';
    logContent += '================================================\n';
    logContent += `  Runtime:     ${runtime}s\n`;
    logContent += `  Unique tags: ${stats.uniqueTags.size} [${epcList}]\n`;
    logContent += '  Reads per antenna:\n';
    for (const ant of CONFIG.antennas) {
        logContent += `    Antenna ${ant}: ${stats.antennaReads[ant] || 0} reads\n`;
    }
    logContent += '\n';

    fs.appendFileSync(logFilename, logContent);
    console.log(`\nTest results appended to ${logFilename}`);
}

process.on('SIGINT', () => {
    console.log('\n\nShutting down...');
    reader.disconnect();
    printStats();
    writeTestLog();
    setTimeout(() => process.exit(0), 1000);
});

console.log(`Connecting to reader at ${CONFIG.ip}:${CONFIG.port}...`);
console.log('(Will retry automatically if connection fails)\n');
reader.connect();

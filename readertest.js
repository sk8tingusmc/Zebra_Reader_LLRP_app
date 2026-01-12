/**
 * Minimal Zebra FX9600 LLRP Test
 * Stripped down to essentials - just connect and read tags
 */

const net = require('net');

const CONFIG = {
    ip: '192.168.1.111',
    port: 5084,
    antenna: 1,
    powerIndex: 200,  // From your capabilities: 200 = 30 dBm
};

// LLRP Message Types
const MSG = {
    GET_READER_CAPABILITIES: 1,
    GET_READER_CAPABILITIES_RESPONSE: 11,
    GET_READER_CONFIG: 2,
    GET_READER_CONFIG_RESPONSE: 12,
    ADD_ROSPEC: 20,
    ADD_ROSPEC_RESPONSE: 30,
    DELETE_ROSPEC: 21,
    DELETE_ROSPEC_RESPONSE: 31,
    START_ROSPEC: 22,
    START_ROSPEC_RESPONSE: 32,
    ENABLE_ROSPEC: 24,
    ENABLE_ROSPEC_RESPONSE: 34,
    SET_READER_CONFIG: 3,
    SET_READER_CONFIG_RESPONSE: 13,
    READER_EVENT_NOTIFICATION: 63,
    RO_ACCESS_REPORT: 61,
    KEEPALIVE: 62,
    KEEPALIVE_ACK: 72,
};

let socket = null;
let messageId = 1;
let buffer = Buffer.alloc(0);

function sendMessage(type, payload = Buffer.alloc(0)) {
    const header = Buffer.alloc(10);
    header.writeUInt8((0x01 << 2) | ((type >> 8) & 0x03), 0);
    header.writeUInt8(type & 0xFF, 1);
    header.writeUInt32BE(10 + payload.length, 2);
    header.writeUInt32BE(messageId++, 6);
    socket.write(Buffer.concat([header, payload]));
}

// TLV helper
function tlv(type, value) {
    const h = Buffer.alloc(4);
    h.writeUInt16BE(type, 0);
    h.writeUInt16BE(4 + value.length, 2);
    return Buffer.concat([h, value]);
}

function buildROSpec() {
    // C1G2SingulationControl (336)
    const singulation = () => {
        const v = Buffer.alloc(7);
        v.writeUInt8(0x80, 0);      // Session 2 (bits 7-6)
        v.writeUInt16BE(32, 1);     // TagPopulation
        v.writeUInt32BE(0, 3);      // TagTransitTime
        return tlv(336, v);
    };

    // C1G2RFControl (335): ModeIndex + Tari
    const rfControl = () => {
        const v = Buffer.alloc(4);
        v.writeUInt16BE(0, 0);  // ModeIndex = 0 (first available mode)
        v.writeUInt16BE(0, 2);  // Tari = 0 (use default)
        return tlv(335, v);
    };

    // C1G2InventoryCommand (330)
    const inventoryCmd = () => {
        const flags = Buffer.from([0x00]);  // TagInventoryStateAware = false
        return tlv(330, Buffer.concat([flags, rfControl(), singulation()]));
    };

    // RFTransmitter (224): HopTableID=1, ChannelIndex=0, PowerIndex
    const rfTransmitter = () => {
        const v = Buffer.alloc(6);
        v.writeUInt16BE(1, 0);                    // HopTableID = 1 (from capabilities!)
        v.writeUInt16BE(0, 2);                    // ChannelIndex = 0 (auto)
        v.writeUInt16BE(CONFIG.powerIndex, 4);   // Power index 200 = 30dBm
        return tlv(224, v);
    };

    // AntennaConfiguration (222) - WITH RFTransmitter
    const antennaConfig = () => {
        const antId = Buffer.alloc(2);
        antId.writeUInt16BE(CONFIG.antenna, 0);
        return tlv(222, Buffer.concat([antId, rfTransmitter(), inventoryCmd()]));
    };

    // InventoryParameterSpec (186) - WITH AntennaConfiguration
    const invParamSpec = () => {
        const hdr = Buffer.alloc(3);
        hdr.writeUInt16BE(1, 0);  // SpecID = 1
        hdr.writeUInt8(1, 2);     // ProtocolID = EPCGlobalClass1Gen2
        return tlv(186, Buffer.concat([hdr, antennaConfig()]));
    };

    // ROSpecStartTrigger (179): Null
    const startTrigger = tlv(179, Buffer.from([0x00]));

    // ROSpecStopTrigger (182): Null with duration
    const stopTrigger = tlv(182, Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]));

    // ROBoundarySpec (178)
    const boundary = tlv(178, Buffer.concat([startTrigger, stopTrigger]));

    // AISpec AntennaIDs - explicit antenna 1
    const antennaIds = Buffer.alloc(4);
    antennaIds.writeUInt16BE(1, 0);               // Count = 1
    antennaIds.writeUInt16BE(CONFIG.antenna, 2);  // Antenna ID = 1 (explicit!)

    // AISpecStopTrigger (184): Null
    const aiStopTrigger = tlv(184, Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]));

    // AISpec (183)
    const aiSpec = tlv(183, Buffer.concat([antennaIds, aiStopTrigger, invParamSpec()]));

    // TagReportContentSelector (238): Enable everything
    const trcs = tlv(238, Buffer.from([0xFF, 0xFF]));

    // ROReportSpec (237): Report on every tag
    const reportSpec = tlv(237, Buffer.concat([Buffer.from([0x01, 0x00, 0x01]), trcs]));

    // ROSpec header
    const header = Buffer.alloc(6);
    header.writeUInt32BE(1, 0);  // ROSpecID = 1
    header.writeUInt8(0, 4);     // Priority
    header.writeUInt8(0, 5);     // State = Disabled

    return tlv(177, Buffer.concat([header, boundary, aiSpec, reportSpec]));
}

function parseTagReport(data) {
    let offset = 10;
    while (offset + 4 < data.length) {
        const paramType = data.readUInt16BE(offset) & 0x03FF;  // Mask vendor bits
        const paramLen = data.readUInt16BE(offset + 2);
        if (paramLen === 0 || offset + paramLen > data.length) break;

        if (paramType === 240) {  // TagReportData
            const tagData = data.slice(offset + 4, offset + paramLen);
            const tag = parseTag(tagData);
            if (tag.epc) {
                const time = new Date().toISOString().substr(11, 12);
                console.log(`[${time}] ANT-${tag.antenna} | ${tag.epc} | RSSI: ${tag.rssi} dBm`);
            } else {
                console.log('Tag without EPC, raw:', tagData.slice(0, 30).toString('hex'));
            }
        }
        offset += paramLen;
    }
}

function parseTag(data) {
    const tag = { epc: null, antenna: 0, rssi: 0 };
    let offset = 0;

    while (offset < data.length - 1) {
        if (data[offset] & 0x80) {
            // TV parameter
            const tvType = data[offset] & 0x7F;
            switch (tvType) {
                case 1:  // AntennaID
                    if (offset + 2 < data.length) tag.antenna = data.readUInt16BE(offset + 1);
                    offset += 3;
                    break;
                case 6:  // PeakRSSI
                    if (offset + 1 < data.length) tag.rssi = data.readInt8(offset + 1);
                    offset += 2;
                    break;
                case 13: // EPC-96
                    if (offset + 12 < data.length) {
                        tag.epc = data.slice(offset + 1, offset + 13).toString('hex').toUpperCase();
                    }
                    offset += 13;
                    break;
                default:
                    offset += 2;  // Skip unknown TV
            }
        } else {
            // TLV parameter
            if (offset + 4 > data.length) break;
            const tlvType = data.readUInt16BE(offset) & 0x03FF;
            const tlvLen = data.readUInt16BE(offset + 2);
            if (tlvLen === 0 || offset + tlvLen > data.length) break;

            if (tlvType === 241 && tlvLen > 6) {  // EPCData
                const bitLen = data.readUInt16BE(offset + 4);
                const byteLen = Math.floor(bitLen / 8);
                if (offset + 6 + byteLen <= data.length) {
                    tag.epc = data.slice(offset + 6, offset + 6 + byteLen).toString('hex').toUpperCase();
                }
            }
            offset += tlvLen;
        }
    }
    return tag;
}

let started = false;

function processMessage(data) {
    const msgType = ((data[0] & 0x03) << 8) | data[1];

    // After started, only log non-keepalive messages
    if (!started || msgType !== MSG.KEEPALIVE) {
        console.log(`LLRP RX: type=${msgType}, len=${data.length}`);
    }

    // Log raw hex for debugging (first 50 bytes)
    if (msgType !== MSG.KEEPALIVE && msgType !== MSG.READER_EVENT_NOTIFICATION) {
        console.log('  RAW:', data.slice(0, Math.min(50, data.length)).toString('hex'));
    }

    switch (msgType) {
        case MSG.READER_EVENT_NOTIFICATION:
            // Parse event type from notification
            console.log('-> Reader Event:', data.slice(10, Math.min(40, data.length)).toString('hex'));
            if (!started) {
                console.log('-> Getting reader config (all)...');
                // GET_READER_CONFIG: RequestedData=0 (All), AntennaID=0, GPI=0, GPO=0
                const configReq = Buffer.alloc(7);
                configReq.writeUInt8(0, 0);      // RequestedData = 0 (All)
                configReq.writeUInt16BE(0, 1);   // AntennaID = 0 (all)
                configReq.writeUInt16BE(0, 3);   // GPIPortNum = 0
                configReq.writeUInt16BE(0, 5);   // GPOPortNum = 0
                sendMessage(MSG.GET_READER_CONFIG, configReq);
            }
            break;

        case MSG.GET_READER_CONFIG_RESPONSE:
            console.log('-> Antenna Config Response:');
            // Parse AntennaProperties (type 221)
            let offset = 10;
            while (offset + 4 < data.length) {
                const pType = data.readUInt16BE(offset) & 0x03FF;
                const pLen = data.readUInt16BE(offset + 2);
                if (pLen === 0 || offset + pLen > data.length) break;

                if (pType === 221) {  // AntennaProperties
                    const antEnabled = data.readUInt8(offset + 4) & 0x80;
                    const antId = data.readUInt16BE(offset + 5);
                    const antGain = data.readInt16BE(offset + 7);
                    console.log(`   Antenna ${antId}: enabled=${antEnabled ? 'YES' : 'NO'}, gain=${antGain/100}dBi`);
                }
                if (pType === 287) {  // LLRPStatus
                    const code = data.readUInt16BE(offset + 4);
                    if (code !== 0) console.log(`   Status error: ${code}`);
                }
                offset += pLen;
            }
            console.log('-> Getting capabilities to find HopTableID...');
            sendMessage(MSG.GET_READER_CAPABILITIES, Buffer.from([0x00]));  // Request all
            break;

        case MSG.GET_READER_CAPABILITIES_RESPONSE:
            console.log('-> Capabilities received, searching for HopTable...');
            // Recursive search for hop tables
            function findHopTables(buf, start, end, depth = 0) {
                let off = start;
                const indent = '  '.repeat(depth);
                while (off + 4 <= end) {
                    const t = buf.readUInt16BE(off) & 0x03FF;
                    const len = buf.readUInt16BE(off + 2);
                    if (len < 4 || off + len > end) break;

                    if (t === 143) {
                        console.log(`${indent}RegulatoryCapabilities @ ${off}`);
                        // Parse inside: skip header (4) + CountryCode(2) + CommStandard(2) = 8
                        findHopTables(buf, off + 8, off + len, depth + 1);
                    } else if (t === 144) {
                        console.log(`${indent}UHFBandCapabilities @ ${off}, len=${len}`);
                        // Dump first 100 bytes of content
                        console.log(`${indent}  Content: ${buf.slice(off + 4, off + Math.min(len, 104)).toString('hex')}`);
                        // List all nested TLV types
                        let inner = off + 4;
                        while (inner + 4 <= off + len) {
                            const it = buf.readUInt16BE(inner) & 0x03FF;
                            const il = buf.readUInt16BE(inner + 2);
                            if (il < 4 || inner + il > off + len) break;
                            console.log(`${indent}    Nested type=${it}, len=${il}`);
                            if (it === 147) {
                                const hid = buf.readUInt8(inner + 4);
                                console.log(`${indent}      >>> HopTableID = ${hid}`);
                            }
                            if (it === 146) {  // FrequencyInformation
                                console.log(`${indent}      FrequencyInformation content:`);
                                console.log(`${indent}        ${buf.slice(inner + 4, inner + Math.min(il, 50)).toString('hex')}`);
                                // Check for nested FrequencyHopTable (147) or FixedFrequencyTable (148)
                                let fi = inner + 4 + 1;  // skip Hopping flag byte
                                while (fi + 4 <= inner + il) {
                                    const fit = buf.readUInt16BE(fi) & 0x03FF;
                                    const fil = buf.readUInt16BE(fi + 2);
                                    if (fil < 4) break;
                                    console.log(`${indent}        -> Nested type=${fit}, len=${fil}`);
                                    if (fit === 147) {
                                        const hid = buf.readUInt8(fi + 4);
                                        console.log(`${indent}           >>> HopTableID = ${hid}`);
                                    }
                                    fi += fil;
                                }
                            }
                            inner += il;
                        }
                        findHopTables(buf, off + 4, off + len, depth + 1);
                    } else if (t === 147) {
                        // FrequencyHopTable: header(4) + HopTableID(1) + Version(1) + NumHops(2) + Freqs...
                        const hopId = buf.readUInt8(off + 4);
                        console.log(`${indent}FrequencyHopTable @ ${off}: HopTableID = ${hopId}`);
                    } else if (t === 145) {
                        // TransmitPowerLevelTableEntry - skip silently
                    }
                    off += len;
                }
            }
            findHopTables(data, 10, data.length, 0);
            console.log('-> Setting antenna power via SET_READER_CONFIG...');
            // SET_READER_CONFIG with AntennaConfiguration
            const setConfig = Buffer.concat([
                Buffer.from([0x00]),  // ResetToFactoryDefault = false
                // AntennaConfiguration (222) for antenna 1
                tlv(222, Buffer.concat([
                    Buffer.from([0x00, 0x01]),  // AntennaID = 1
                    // RFTransmitter (224)
                    tlv(224, Buffer.from([
                        0x00, 0x01,  // HopTableID = 1
                        0x00, 0x00,  // ChannelIndex = 0
                        0x00, 0xC8   // TransmitPower = 200 (30dBm)
                    ])),
                    // RFReceiver (225)
                    tlv(225, Buffer.from([0x00, 0x01]))  // Sensitivity = 1
                ]))
            ]);
            sendMessage(MSG.SET_READER_CONFIG, setConfig);
            break;

        case MSG.SET_READER_CONFIG_RESPONSE:
            if (checkStatus(data, 'SET_READER_CONFIG')) {
                console.log('-> Antenna power configured!');
            }
            console.log('-> Deleting old ROSpecs...');
            sendMessage(MSG.DELETE_ROSPEC, Buffer.from([0x00, 0x00, 0x00, 0x00]));
            break;

        case MSG.DELETE_ROSPEC_RESPONSE:
            console.log('-> Adding ROSpec...');
            sendMessage(MSG.ADD_ROSPEC, buildROSpec());
            break;

        case MSG.ADD_ROSPEC_RESPONSE:
            if (checkStatus(data, 'ADD_ROSPEC')) {
                console.log('-> Enabling ROSpec...');
                sendMessage(MSG.ENABLE_ROSPEC, Buffer.from([0x00, 0x00, 0x00, 0x01]));
            }
            break;

        case MSG.ENABLE_ROSPEC_RESPONSE:
            if (checkStatus(data, 'ENABLE_ROSPEC')) {
                console.log('-> Starting ROSpec...');
                sendMessage(MSG.START_ROSPEC, Buffer.from([0x00, 0x00, 0x00, 0x01]));
            }
            break;

        case MSG.START_ROSPEC_RESPONSE:
            if (checkStatus(data, 'START_ROSPEC')) {
                started = true;
                console.log('\n*** READING TAGS - Press Ctrl+C to stop ***\n');
                // Periodic status check
                setInterval(() => {
                    console.log(`[${new Date().toISOString().substr(11,8)}] Waiting for tags... (type=61 expected)`);
                }, 5000);
            }
            break;

        case MSG.RO_ACCESS_REPORT:
            parseTagReport(data);
            break;

        case MSG.KEEPALIVE:
            sendMessage(MSG.KEEPALIVE_ACK);
            break;

        default:
            console.log(`  UNKNOWN MSG TYPE ${msgType}, hex:`, data.slice(0, 60).toString('hex'));
            break;
    }
}

function checkStatus(data, name) {
    // Find LLRPStatus (287)
    let offset = 10;
    while (offset + 4 < data.length) {
        const paramType = data.readUInt16BE(offset) & 0x03FF;
        const paramLen = data.readUInt16BE(offset + 2);
        if (paramLen === 0) break;

        if (paramType === 287 && paramLen >= 6) {
            const code = data.readUInt16BE(offset + 4);
            if (code !== 0) {
                console.error(`${name} FAILED: status=${code}`);
                // Try to get error description
                if (paramLen > 6) {
                    const descLen = data.readUInt16BE(offset + 6);
                    if (descLen > 0 && offset + 8 + descLen <= data.length) {
                        console.error(`  -> ${data.slice(offset + 8, offset + 8 + descLen).toString()}`);
                    }
                }
                return false;
            }
            return true;
        }
        offset += paramLen;
    }
    return true;
}

// Connect
console.log(`\nConnecting to Zebra FX9600 at ${CONFIG.ip}:${CONFIG.port}...\n`);

socket = new net.Socket();
socket.connect(CONFIG.port, CONFIG.ip, () => {
    console.log('Connected!\n');
});

socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 10) {
        const len = buffer.readUInt32BE(2);
        if (buffer.length < len) break;
        processMessage(buffer.slice(0, len));
        buffer = buffer.slice(len);
    }
});

socket.on('error', (err) => console.error('Socket error:', err.message));
socket.on('close', () => console.log('Disconnected'));

process.on('SIGINT', () => {
    console.log('\nShutting down...');
    socket.destroy();
    process.exit(0);
});

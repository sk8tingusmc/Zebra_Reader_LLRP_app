# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Node.js application for communicating with Zebra FX9600 RFID readers using the LLRP (Low Level Reader Protocol) over TCP. The code implements a custom LLRP client from scratch without external dependencies beyond Node.js built-ins (`net`, `events`, `fs`, `http`).

## Running the Application

```bash
# Main reader application with full features (auto-reconnect, logging, stats)
node reader.js

# Web UI for controlling the reader (runs on http://localhost:3000)
node ui-server.js

# Minimal test script for basic connectivity testing
node minimal.js

# Detailed test script with capabilities parsing debug output
node readertest.js
```

No build step or package manager setup is required - this is vanilla Node.js.

## Key Files

- `reader.js` - Main application with LLRPReader class, full-featured with stats and logging
- `workingreader.js` - Known-good backup of reader.js (copy here when things work)
- `minimal.js` - Stripped-down LLRP client for debugging connectivity issues
- `ui-server.js` - HTTP server with SSE for web-based control (imports LLRPReader from reader.js)
- `public/` - Web UI assets (index.html, styles.css, app.js)

## Architecture

### LLRP Protocol Implementation

The code implements binary LLRP message encoding/decoding:

- **Message structure**: 10-byte header (version/type, length, message ID) + TLV-encoded payload
- **TLV encoding**: Type (2 bytes) + Length (2 bytes) + Value. Helper function `tlv(type, value)` is used throughout
- **TV encoding**: Type-Value parameters without length field, identified by MSB=1 in first byte

### Key LLRP Message Flow

1. `ENABLE_EVENTS_AND_REPORTS` (64) - Initial connection setup
2. `GET_READER_CAPABILITIES` (1) → Response (11) - Parse power table and hop tables
3. `DELETE_ROSPEC` (21) → Response (31) - Clear existing reader operations
4. `ADD_ROSPEC` (20) → Response (30) - Configure tag reading operation
5. `ENABLE_ROSPEC` (24) → Response (34)
6. `START_ROSPEC` (22) → Response (32) - Begin reading tags
7. `RO_ACCESS_REPORT` (61) - Incoming tag read events
8. `KEEPALIVE` (62) / `KEEPALIVE_ACK` (72) - Connection health

### ROSpec Structure (reader.js `buildROSpec()`)

The ROSpec is a nested TLV structure defining how the reader operates:
- **ROSpec (177)**: Container with ID, priority, state
  - **ROBoundarySpec (178)**: Start/stop triggers
  - **AISpec (183)**: Antenna inventory specification
    - Antenna IDs list
    - **AISpecStopTrigger (184)**
    - **InventoryParameterSpec (186)**: Protocol and antenna configuration
      - **AntennaConfiguration (222)**: Per-antenna settings
        - **RFTransmitter (224)**: HopTableID, ChannelIndex, TransmitPower
  - **ROReportSpec (237)**: When and what to report

**Important**: Do NOT include C1G2InventoryCommand (330) inside AntennaConfiguration - Zebra readers reject or ignore ROSpecs with this parameter.

### Configuration (reader.js)

```javascript
const CONFIG = {
    ip: '192.168.1.111',      // Reader IP
    port: 5084,                // LLRP port
    antennas: [1],             // Active antenna ports (1-4)
    antennaPowerDbm: { 1: 30, 2: 30, 3: 30, 4: 30 },  // Power per antenna
    reconnectInterval: 5000,
    enableReconnect: true,
    debugRx: true,             // Log all received message types and raw tag data
};
```

Power values in dBm are automatically mapped to the reader's power table indices after parsing capabilities.

### Zebra FX9600 Specifics

- HopTableID is extracted from `GET_READER_CAPABILITIES_RESPONSE` rather than hardcoded
- Power indices are derived from the `TransmitPowerLevelTableEntry` (145) parameters
- Reader must be configured in LLRP Server mode on port 5084 via web UI
- Do NOT use C1G2InventoryCommand in AntennaConfiguration (causes tag reading to fail silently)

### Tag Report Parsing

Tags are reported via `RO_ACCESS_REPORT` (61) containing `TagReportData` (240) parameters. Inside each TagReportData, fields use TV encoding (MSB=1):
- TV type 1: AntennaID (2 bytes)
- TV type 6: PeakRSSI (1 byte signed)
- TV type 13: EPC-96 (12 bytes)

The `rospecStarted` flag prevents processing buffered tags from previous sessions.

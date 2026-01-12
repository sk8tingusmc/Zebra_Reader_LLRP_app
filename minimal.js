/**
 * Minimal Zebra FX9600 LLRP Test (more correct)
 * - Enables events/reports
 * - Reads capabilities to choose a valid TransmitPower index (max)
 * - Adds/enables/starts a minimal ROSpec
 */

const net = require("net");

const IP = "192.168.1.111";
const PORT = 5084;

let socket = null;
let msgId = 1;
let buf = Buffer.alloc(0);

let gotCaps = false;
let pendingStart = false;
let txPowerIndex = 1; // will be replaced with max valid index from capabilities

// ---------- TLV helpers ----------
const tlv = (t, v) => {
  const h = Buffer.alloc(4);
  h.writeUInt16BE(t, 0);
  h.writeUInt16BE(4 + v.length, 2);
  return Buffer.concat([h, v]);
};

const send = (type, payload = Buffer.alloc(0)) => {
  const hdr = Buffer.alloc(10);
  hdr.writeUInt8((0x04) | ((type >> 8) & 0x03), 0);
  hdr.writeUInt8(type & 0xff, 1);
  hdr.writeUInt32BE(10 + payload.length, 2);
  hdr.writeUInt32BE(msgId++, 6);
  socket.write(Buffer.concat([hdr, payload]));
};

// ---------- Capability parsing (find max TransmitPowerLevelTableEntry index) ----------
function parseMaxTxPowerIndex(llrpMsg) {
  // LLRP message payload begins at offset 10
  let off = 10;
  let maxIdx = null;

  while (off + 4 <= llrpMsg.length) {
    const t = llrpMsg.readUInt16BE(off) & 0x3ff;
    const l = llrpMsg.readUInt16BE(off + 2);
    if (l < 4 || off + l > llrpMsg.length) break;

    if (t === 145 && l >= 8) {
      // TransmitPowerLevelTableEntry (145)
      // payload: Index (2 bytes), TransmitPowerValue (2 bytes)  (value is in 0.01 dBm or vendor-specific)
      const idx = llrpMsg.readUInt16BE(off + 4);
      // const pwrVal = llrpMsg.readInt16BE(off + 6);
      if (maxIdx === null || idx > maxIdx) maxIdx = idx;
    }

    off += l;
  }

  return maxIdx;
}

// ---------- Build minimal ROSpec ----------
function buildROSpec() {
  // ROSpec header: ROSpecID (4), Priority (1), CurrentState (1)
  const rospecHdr = Buffer.from([
    0x00, 0x00, 0x00, 0x01, // ROSpecID = 1
    0x00, // Priority = 0
    0x00, // CurrentState = Disabled
  ]);

  // ROBoundarySpec
  const startTrigger = tlv(179, Buffer.from([0x00])); // ROSpecStartTrigger: Null
  const stopTrigger = tlv(
    182,
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]) // ROSpecStopTrigger: Null + duration=0
  );
  const boundary = tlv(178, Buffer.concat([startTrigger, stopTrigger]));

  // RFTransmitter (224): HopTableID=1, ChannelIndex=0, TransmitPower=<VALID INDEX>
  // field sizes: HopTableID (2), ChannelIndex (2), TransmitPower (2)
  const rfTx = tlv(
    224,
    Buffer.from([
      0x00, 0x01, // HopTableID = 1
      0x00, 0x00, // ChannelIndex = 0
      (txPowerIndex >> 8) & 0xff,
      txPowerIndex & 0xff, // TransmitPower index
    ])
  );

  // AntennaConfiguration (222): AntennaID (2) + RFTransmitter
  const antConfig = tlv(
    222,
    Buffer.concat([Buffer.from([0x00, 0x01]), rfTx]) // AntennaID=1
  );

  // InventoryParameterSpec (186): SpecID (2), Protocol (1) + AntennaConfiguration
  const invSpec = tlv(
    186,
    Buffer.concat([
      Buffer.from([0x00, 0x01]), // SpecID=1
      Buffer.from([0x01]), // Protocol=EPCGlobalClass1Gen2
      antConfig,
    ])
  );

  // AISpec (183): AntennaIDs + AISpecStopTrigger + InventoryParameterSpec
  // AntennaIDs: count (2) + IDs (2 each)
  const aiSpec = tlv(
    183,
    Buffer.concat([
      Buffer.from([0x00, 0x01, 0x00, 0x01]), // Count=1, AntennaID=1
      tlv(184, Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00])), // AISpecStopTrigger: Null + duration=0
      invSpec,
    ])
  );

  // TagReportContentSelector (238)
  // Safer to keep minimal flags (many readers will still include EPC automatically).
  // (Using 0xFF,0xFF can request unsupported fields and some readers act weird.)
  const tagContent = tlv(238, Buffer.from([0x00, 0x00]));

  // ROReportSpec (237): ROReportTrigger (1) + N (2) + TagReportContentSelector
  // Trigger=1 => Upon_N_Tags_Or_End_Of_ROSpec (commonly supported); N=1
  const roReport = tlv(
    237,
    Buffer.concat([Buffer.from([0x01, 0x00, 0x01]), tagContent])
  );

  return tlv(177, Buffer.concat([rospecHdr, boundary, aiSpec, roReport]));
}

// ---------- Parse tag from RO_ACCESS_REPORT ----------
function parseReport(data) {
  let off = 10;
  while (off + 4 <= data.length) {
    const t = data.readUInt16BE(off) & 0x3ff;
    const l = data.readUInt16BE(off + 2);
    if (l < 4 || off + l > data.length) break;

    if (t === 240) {
      // TagReportData
      const td = data.slice(off + 4, off + l);
      let epc = null,
        ant = 0,
        rssi = null;

      let i = 0;
      while (i < td.length) {
        // TV param?
        if (td[i] & 0x80) {
          const tv = td[i] & 0x7f;

          if (tv === 1 && i + 2 < td.length) {
            // AntennaID (2 bytes)
            ant = td.readUInt16BE(i + 1);
            i += 3;
            continue;
          }
          if (tv === 6 && i + 1 < td.length) {
            // PeakRSSI (1 byte signed)
            rssi = td.readInt8(i + 1);
            i += 2;
            continue;
          }
          if (tv === 13 && i + 12 < td.length) {
            // EPC-96 (12 bytes)
            epc = td.slice(i + 1, i + 13).toString("hex").toUpperCase();
            i += 13;
            continue;
          }

          // Unknown TV param: best-effort skip 2 bytes
          i += 2;
        } else {
          // TLV param inside TagReportData
          if (i + 4 > td.length) break;
          const tt = td.readUInt16BE(i) & 0x3ff;
          const tl = td.readUInt16BE(i + 2);
          if (tl < 4 || i + tl > td.length) break;

          if (tt === 241 && tl >= 6) {
            // EPCData
            const bits = td.readUInt16BE(i + 4);
            const bytes = Math.floor(bits / 8);
            if (i + 6 + bytes <= td.length) {
              epc = td
                .slice(i + 6, i + 6 + bytes)
                .toString("hex")
                .toUpperCase();
            }
          }

          i += tl;
        }
      }

      if (epc) {
        const time = new Date().toISOString().substr(11, 12);
        console.log(
          `[${time}] ANT-${ant || "?"} | ${epc} | RSSI: ${
            rssi === null ? "?" : rssi
          } dBm`
        );
      }
    }

    off += l;
  }
}

// ---------- LLRP sequencing ----------
function startSequence() {
  console.log(`-> DELETE_ROSPEC (all)`);
  // Delete all ROSpecs: ROSpecID=0
  send(21, Buffer.from([0x00, 0x00, 0x00, 0x00]));
}

function handle(data) {
  const type = ((data[0] & 0x03) << 8) | data[1];
  console.log(`RX type=${type} len=${data.length}`);

  if (type === 63) {
    // READER_EVENT_NOTIFICATION
    if (!gotCaps) {
      console.log("-> Reader event arrived before capabilities; waiting on caps...");
      pendingStart = true;
      return;
    }
    startSequence();
  } else if (type === 11) {
    // GET_READER_CAPABILITIES_RESPONSE
    const maxIdx = parseMaxTxPowerIndex(data);
    if (maxIdx !== null) {
      txPowerIndex = maxIdx;
      console.log(`-> Capabilities: max TransmitPower index = ${txPowerIndex}`);
    } else {
      console.log("-> Capabilities: could not find power table; using txPowerIndex=1");
    }
    gotCaps = true;

    if (pendingStart) {
      pendingStart = false;
      startSequence();
    }
  } else if (type === 31) {
    // DELETE_ROSPEC_RESPONSE
    console.log("-> ADD_ROSPEC");
    send(20, buildROSpec());
  } else if (type === 30) {
    // ADD_ROSPEC_RESPONSE
    const status = data.length > 14 ? data.readUInt16BE(14) : -1;
    console.log(`   ADD status=${status}`);
    if (status === 0) {
      console.log("-> ENABLE_ROSPEC");
      send(24, Buffer.from([0x00, 0x00, 0x00, 0x01]));
    }
  } else if (type === 34) {
    // ENABLE_ROSPEC_RESPONSE
    console.log("-> START_ROSPEC");
    send(22, Buffer.from([0x00, 0x00, 0x00, 0x01]));
  } else if (type === 32) {
    // START_ROSPEC_RESPONSE
    console.log("\n*** READING TAGS (expect type=61) ***\n");
  } else if (type === 61) {
    // RO_ACCESS_REPORT
    parseReport(data);
  } else if (type === 62) {
    // KEEPALIVE
    send(72); // KEEPALIVE_ACK
  } else if (type === 100) {
    // ERROR_MESSAGE (rare)
    console.log("ERROR:", data.slice(10).toString("hex"));
  }
}

// ---------- Connect ----------
console.log(`Connecting to ${IP}:${PORT}...`);
socket = new net.Socket();

socket.connect(PORT, IP, () => {
  console.log("Connected!\n");

  // Strongly recommended on many readers
  console.log("-> ENABLE_EVENTS_AND_REPORTS");
  send(64);

  // Pull capabilities so we can pick a valid TX power index
  console.log("-> GET_READER_CAPABILITIES (all)");
  // payload: RequestedData (1 byte). 0 = All
  send(1, Buffer.from([0x00]));
});

socket.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 10) {
    const len = buf.readUInt32BE(2);
    if (buf.length < len) break;
    handle(buf.slice(0, len));
    buf = buf.slice(len);
  }
});

socket.on("error", (e) => console.error("Error:", e.message));
socket.on("close", () => console.log("Disconnected"));
process.on("SIGINT", () => {
  socket.destroy();
  process.exit();
});

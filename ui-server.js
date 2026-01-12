const http = require('http');
const path = require('path');
const fs = require('fs');
const { LLRPReader, CONFIG } = require('./reader');

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const clients = new Set();
let reader = null;
let running = false;
let antennaSelection = [1];
let powerDbm = 30;

const sendEvent = (res, event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const broadcast = (event, data) => {
    for (const res of clients) {
        sendEvent(res, event, data);
    }
};

const startReader = () => {
    if (running) return;

    // Create fresh config from base CONFIG
    const config = {
        ip: CONFIG.ip,
        port: CONFIG.port,
        antennas: [...antennaSelection],
        antennaPowerDbm: {},
        reconnectInterval: CONFIG.reconnectInterval || 5000,
        enableReconnect: true,
        debugRx: false,  // Keep UI server quiet
    };

    // Set power for each selected antenna
    for (const ant of config.antennas) {
        config.antennaPowerDbm[ant] = powerDbm;
    }

    console.log('='.repeat(50));
    console.log('Starting reader with config:');
    console.log(`  Antennas: [${config.antennas.join(', ')}]`);
    console.log(`  Power: ${powerDbm} dBm`);
    console.log('='.repeat(50));

    reader = new LLRPReader(config);

    reader.on('tag', (tag) => {
        if (!tag.epc) return;
        const timestamp = typeof tag.timestamp === 'bigint' ? tag.timestamp.toString() : tag.timestamp;
        broadcast('tag', {
            epc: tag.epc,
            seenCount: tag.seenCount,
            rssi: tag.rssi,
            antenna: tag.antenna,
            timestamp
        });
    });

    reader.on('connected', () => {
        console.log('Reader connected.');
    });

    reader.on('ready', () => {
        console.log('Reader ready - reading tags.');
    });

    reader.on('disconnect', () => {
        console.log('Reader disconnected.');
    });

    reader.on('error', (err) => {
        console.error('Reader error:', err?.message || err);
    });

    reader.connect();
    running = true;
    broadcast('status', { running: true });
};

const stopReader = () => {
    if (!running) return;
    console.log('Stopping reader...');
    if (reader) {
        reader.disconnect();
        reader = null;
    }
    running = false;
    broadcast('status', { running: false });
};

const updateConfig = (nextAntennas, nextPowerDbm) => {
    let changed = false;

    if (Array.isArray(nextAntennas) && nextAntennas.length > 0) {
        const sorted = nextAntennas.slice().sort((a, b) => a - b);
        const currentSorted = antennaSelection.slice().sort((a, b) => a - b);
        if (JSON.stringify(sorted) !== JSON.stringify(currentSorted)) {
            antennaSelection = sorted;
            changed = true;
            console.log(`Config updated: antennas = [${antennaSelection.join(', ')}]`);
        }
    }

    if (typeof nextPowerDbm === 'number' && Number.isFinite(nextPowerDbm)) {
        if (nextPowerDbm !== powerDbm) {
            powerDbm = nextPowerDbm;
            changed = true;
            console.log(`Config updated: power = ${powerDbm} dBm`);
        }
    }

    broadcast('config', { antennas: antennaSelection, powerDbm });

    // Restart reader if running and config changed
    if (running && changed) {
        console.log('Config changed - restarting reader...');
        stopReader();
        // Small delay to ensure clean disconnect
        setTimeout(() => {
            startReader();
        }, 500);
    }
};

const clearState = () => {
    broadcast('clear', { ok: true });
};

const contentTypeFor = (filePath) => {
    if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
    if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
    if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
    return 'application/octet-stream';
};

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        res.write('\n');
        clients.add(res);
        sendEvent(res, 'status', { running });
        sendEvent(res, 'config', { antennas: antennaSelection, powerDbm });

        const keepAlive = setInterval(() => {
            res.write(': ping\n\n');
        }, 15000);

        req.on('close', () => {
            clearInterval(keepAlive);
            clients.delete(res);
        });
        return;
    }

    if (url.pathname === '/start' && (req.method === 'POST' || req.method === 'GET')) {
        startReader();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ running: true }));
        return;
    }

    if (url.pathname === '/stop' && (req.method === 'POST' || req.method === 'GET')) {
        stopReader();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ running: false }));
        return;
    }

    if (url.pathname === '/clear' && (req.method === 'POST' || req.method === 'GET')) {
        clearState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cleared: true }));
        return;
    }

    if (url.pathname === '/config' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const parsed = JSON.parse(body || '{}');
                const antennas = Array.isArray(parsed.antennas)
                    ? parsed.antennas.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 4)
                    : null;
                const nextPower = typeof parsed.powerDbm === 'number' ? parsed.powerDbm : null;
                updateConfig(antennas, nextPower);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false }));
            }
        });
        return;
    }

    const filePath = url.pathname === '/'
        ? path.join(PUBLIC_DIR, 'index.html')
        : path.join(PUBLIC_DIR, url.pathname);

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`
==================================================
  RFID Tag Monitor - Web UI
==================================================
  URL:      http://localhost:${PORT}
  Reader:   ${CONFIG.ip}:${CONFIG.port}
==================================================
`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    stopReader();
    server.close(() => {
        process.exit(0);
    });
});

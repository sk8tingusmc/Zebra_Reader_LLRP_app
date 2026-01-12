// DOM Elements
const tagBody = document.getElementById('tagBody');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const clearBtn = document.getElementById('clearBtn');
const powerBtn = document.getElementById('powerBtn');
const powerDisplay = document.getElementById('powerDisplay');
const antennaGroup = document.getElementById('antennaGroup');
const powerModal = document.getElementById('powerModal');
const powerSlider = document.getElementById('powerSlider');
const powerValue = document.getElementById('powerValue');
const powerCancel = document.getElementById('powerCancel');
const powerApply = document.getElementById('powerApply');
const totalTagsEl = document.getElementById('totalTags');
const totalReadsEl = document.getElementById('totalReads');
const readsPerSecEl = document.getElementById('readsPerSec');
const timerEl = document.getElementById('timer');
const tagCountEl = document.getElementById('tagCount');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

// State
const tagMap = new Map();
const rowMap = new Map();
let running = false;
let elapsedMs = 0;
let startAt = 0;
let timerId = null;
let powerDbm = 30;
const antennaSelection = new Set([1]);

// Helpers
const pad = (value, len = 2) => String(value).padStart(len, '0');

const formatClock = (ms) => {
  const total = Math.max(0, Math.floor(ms));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

const formatDateTime = (date) => {
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${hh}:${mi}:${ss}`;
};

const parseTimestamp = (value) => {
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const ns = BigInt(value);
    const ms = Number(ns / 1000n);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value);
  }
  return new Date();
};

const formatRssi = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '?';
  return value.toFixed(1);
};

const getRssiClass = (rssi) => {
  if (typeof rssi !== 'number') return '';
  if (rssi >= -50) return 'strong';
  if (rssi >= -65) return 'medium';
  return 'weak';
};

// Timer functions
const updateTimer = () => {
  const current = running ? performance.now() - startAt : elapsedMs;
  timerEl.textContent = formatClock(current);
};

const updateStats = () => {
  let totalReads = 0;
  for (const record of tagMap.values()) totalReads += record.count || 0;
  totalReadsEl.textContent = totalReads.toLocaleString();
  totalTagsEl.textContent = tagMap.size.toLocaleString();
  tagCountEl.textContent = `${tagMap.size} tag${tagMap.size !== 1 ? 's' : ''}`;

  const currentElapsed = running ? performance.now() - startAt : elapsedMs;
  const perSec = currentElapsed > 0 ? totalReads / (currentElapsed / 1000) : 0;
  readsPerSecEl.textContent = perSec.toFixed(1);
};

const startTimer = () => {
  if (running) return;
  running = true;
  startAt = performance.now() - elapsedMs;
  timerId = timerId || setInterval(() => {
    updateTimer();
    updateStats();
  }, 100);
};

const stopTimer = () => {
  if (!running) return;
  running = false;
  elapsedMs = performance.now() - startAt;
  updateTimer();
  updateStats();
};

const resetTimer = (keepRunning) => {
  elapsedMs = 0;
  startAt = performance.now();
  if (!keepRunning) running = false;
  updateTimer();
  updateStats();
};

// UI State
const setRunningState = (isRunning) => {
  startBtn.disabled = isRunning;
  stopBtn.disabled = !isRunning;

  if (isRunning) {
    statusDot.classList.add('connected');
    statusText.textContent = 'Reading';
    startTimer();
  } else {
    statusDot.classList.remove('connected');
    statusText.textContent = 'Stopped';
    stopTimer();
  }
};

const updatePowerDisplay = () => {
  const formatted = powerDbm.toFixed(1);
  powerDisplay.textContent = `${formatted} dBm`;
};

// Antenna buttons
const renderAntennaButtons = () => {
  antennaGroup.textContent = '';
  for (let i = 1; i <= 4; i += 1) {
    const btn = document.createElement('button');
    btn.className = `btn antenna${antennaSelection.has(i) ? ' active' : ''}`;
    btn.textContent = String(i);
    btn.title = `Antenna ${i}`;
    btn.addEventListener('click', () => {
      if (antennaSelection.has(i)) {
        if (antennaSelection.size === 1) return; // Must have at least one
        antennaSelection.delete(i);
      } else {
        antennaSelection.add(i);
      }
      renderAntennaButtons();
      sendConfig();
    });
    antennaGroup.appendChild(btn);
  }
};

// API
const sendConfig = () => {
  const antennas = Array.from(antennaSelection).sort((a, b) => a - b);
  console.log('Sending config:', { antennas, powerDbm });
  fetch('/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ antennas, powerDbm })
  }).catch(console.error);
};

// Table rendering
const upsertRow = (record) => {
  let row = rowMap.get(record.epc);
  if (!row) {
    row = document.createElement('tr');
    row.innerHTML = `
      <td class="epc-cell"></td>
      <td></td>
      <td class="rssi-cell"></td>
      <td class="antenna-cell"></td>
      <td class="timestamp-cell"></td>
    `;
    tagBody.prepend(row); // New tags at top
    rowMap.set(record.epc, row);
  }

  const cells = row.children;
  cells[0].textContent = record.epc;
  cells[1].textContent = record.count ?? 0;

  const rssiText = formatRssi(record.rssi);
  cells[2].textContent = rssiText;
  cells[2].className = `rssi-cell ${getRssiClass(record.rssi)}`;

  cells[3].textContent = record.antenna ?? '?';
  cells[4].textContent = formatDateTime(parseTimestamp(record.timestamp));
};

const handleTagUpdate = (data) => {
  const existing = tagMap.get(data.epc) || { count: 0 };
  const count = Number.isFinite(data.seenCount) ? data.seenCount : existing.count + 1;
  const record = {
    epc: data.epc,
    count,
    rssi: data.rssi,
    antenna: data.antenna,
    timestamp: data.timestamp
  };
  tagMap.set(data.epc, record);
  upsertRow(record);
  updateStats();
};

const clearAll = (keepRunning) => {
  tagMap.clear();
  rowMap.clear();
  tagBody.textContent = '';
  resetTimer(keepRunning);
};

// Event listeners
startBtn.addEventListener('click', () => {
  sendConfig();
  fetch('/start', { method: 'POST' }).catch(console.error);
});

stopBtn.addEventListener('click', () => {
  fetch('/stop', { method: 'POST' }).catch(console.error);
});

clearBtn.addEventListener('click', () => {
  fetch('/clear', { method: 'POST' }).catch(console.error);
});

powerBtn.addEventListener('click', () => {
  powerSlider.value = powerDbm;
  powerValue.textContent = `${powerDbm.toFixed(1)} dBm`;
  powerModal.classList.add('open');
  powerModal.setAttribute('aria-hidden', 'false');
});

powerCancel.addEventListener('click', () => {
  powerModal.classList.remove('open');
  powerModal.setAttribute('aria-hidden', 'true');
});

powerApply.addEventListener('click', () => {
  powerDbm = Number(powerSlider.value);
  updatePowerDisplay();
  powerModal.classList.remove('open');
  powerModal.setAttribute('aria-hidden', 'true');
  sendConfig();
});

powerSlider.addEventListener('input', () => {
  powerValue.textContent = `${Number(powerSlider.value).toFixed(1)} dBm`;
});

// Close modal on backdrop click
powerModal.addEventListener('click', (e) => {
  if (e.target === powerModal) {
    powerModal.classList.remove('open');
    powerModal.setAttribute('aria-hidden', 'true');
  }
});

// SSE Events
const events = new EventSource('/events');

events.addEventListener('tag', (event) => {
  const data = JSON.parse(event.data);
  handleTagUpdate(data);
});

events.addEventListener('status', (event) => {
  const data = JSON.parse(event.data);
  setRunningState(!!data.running);
});

events.addEventListener('config', (event) => {
  const data = JSON.parse(event.data);
  if (Array.isArray(data.antennas) && data.antennas.length > 0) {
    antennaSelection.clear();
    for (const ant of data.antennas) antennaSelection.add(Number(ant));
    renderAntennaButtons();
  }
  if (typeof data.powerDbm === 'number') {
    powerDbm = data.powerDbm;
    updatePowerDisplay();
  }
});

events.addEventListener('clear', () => {
  clearAll(running);
});

events.addEventListener('error', () => {
  statusDot.classList.remove('connected');
  statusText.textContent = 'Connection Error';
});

// Initialize
setRunningState(false);
updateTimer();
updateStats();
updatePowerDisplay();
renderAntennaButtons();

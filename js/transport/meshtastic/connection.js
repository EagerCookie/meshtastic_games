/**
 * Meshtastic connection implementations — BLE, Serial, HTTP.
 *
 * Each exports:
 *   { connect(), disconnect(), write(bytes), onData(cb), onDisconnect(cb) }
 */

// ============================================================================
// BLE (Web Bluetooth)
// ============================================================================

const BLE_SERVICE_UUID    = '6ba1b218-15a8-461f-9fa8-5dcae273eafd';
const BLE_TORADIO_UUID    = 'f75c76d2-129e-4dad-a1dd-7866124401e7';
const BLE_FROMRADIO_UUID  = '2c55e69e-4993-11ed-b878-0242ac120002';
const BLE_FROMNUM_UUID    = 'ed9da18c-a800-4f66-a670-aa7547e34453';

export async function createBleConnection() {
  if (!navigator.bluetooth) throw new Error('Web Bluetooth not available in this browser');

  let device, server, toRadioChar, fromRadioChar, fromNumChar;
  let dataCallbacks = [];
  let disconnectCallbacks = [];
  let connected = false;

  async function connect() {
    device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [BLE_SERVICE_UUID],
    });

    device.addEventListener('gattserverdisconnected', () => {
      connected = false;
      disconnectCallbacks.forEach(cb => cb());
    });

    server = await device.gatt.connect();

    // Re-connect if disconnected (BLE can be flaky)
    server.device.addEventListener('gattserverdisconnected', async () => {
      connected = false;
      disconnectCallbacks.forEach(cb => cb());
    });

    const service = await server.getPrimaryService(BLE_SERVICE_UUID);

    toRadioChar   = await service.getCharacteristic(BLE_TORADIO_UUID);
    fromRadioChar = await service.getCharacteristic(BLE_FROMRADIO_UUID);
    fromNumChar   = await service.getCharacteristic(BLE_FROMNUM_UUID);

    // Subscribe to FromNum notifications — triggers read of FromRadio
    await fromNumChar.startNotifications();
    fromNumChar.addEventListener('characteristicvaluechanged', async () => {
      try {
        const value = await fromRadioChar.readValue();
        if (value && value.buffer) {
          const bytes = new Uint8Array(value.buffer);
          dataCallbacks.forEach(cb => cb(bytes));
        }
      } catch (e) {
        console.warn('[BLE] Read error:', e.message);
      }
    });

    connected = true;
  }

  async function write(bytes) {
    if (!connected || !toRadioChar) throw new Error('BLE not connected');
    await toRadioChar.writeValue(bytes);
  }

  function onData(cb) { dataCallbacks.push(cb); }
  function onDisconnect(cb) { disconnectCallbacks.push(cb); }

  async function disconnect() {
    connected = false;
    dataCallbacks = [];
    disconnectCallbacks = [];
    if (server) {
      try { await server.disconnect(); } catch (_) {}
    }
  }

  return { connect, disconnect, write, onData, onDisconnect, get connected() { return connected; } };
}

// ============================================================================
// Serial (Web Serial)
// ============================================================================

// Official Meshtastic web client (web-main) uses 115200
const SERIAL_BAUD = 115200;
const FRAME_START_1 = 0x94;
const FRAME_START_2 = 0xC3;
const MAX_FRAME = 512;

export async function createSerialConnection() {
  if (!navigator.serial) {
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
      throw new Error('Web Serial requires HTTPS or localhost. Open http://localhost, not IP address.');
    }
    throw new Error('Web Serial not available — use Chrome/Edge and grant permission.');
  }

  let port, writer;
  let dataCallbacks = [];
  let disconnectCallbacks = [];
  let activityCallbacks = []; // raw activity (console) callbacks
  let connected = false;
  let readLoopAbort = null;

  // --- internal: parse 0x94 0xC3 framed packets ---
  // Uses Uint8Array buffer and batch processing to minimise GC pressure
  // during animations (Serial console output is continuous).
  let frameBuf = new Uint8Array(0);
  let pendingData = [];

  function flushPending() {
    if (pendingData.length === 0) return;
    // Concatenate all pending chunks
    let total = 0;
    for (const c of pendingData) total += c.length;
    const combined = new Uint8Array(frameBuf.length + total);
    combined.set(frameBuf, 0);
    let off = frameBuf.length;
    for (const c of pendingData) { combined.set(c, off); off += c.length; }
    frameBuf = combined;
    pendingData = [];
    _processBuffer();
  }

  function handleChunk(chunk) {
    pendingData.push(chunk);
  }

  // Batch process every 50ms to reduce per-frame overhead
  let flushTimer = null;
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushPending();
    }, 50);
  }
  const origHandleChunk = handleChunk;
  handleChunk = (chunk) => { origHandleChunk(chunk); scheduleFlush(); };

  function _processBuffer() {
    while (frameBuf.length >= 4) {
      // Find START1 (0x94)
      let idx = -1;
      for (let i = 0; i < frameBuf.length; i++) {
        if (frameBuf[i] === FRAME_START_1) { idx = i; break; }
      }
      if (idx < 0) {
        if (frameBuf.length > MAX_FRAME * 2) frameBuf = new Uint8Array(0);
        break;
      }
      if (idx > 0) frameBuf = frameBuf.slice(idx);
      if (frameBuf.length < 4) break;
      if (frameBuf[0] !== FRAME_START_1 || frameBuf[1] !== FRAME_START_2) {
        frameBuf = frameBuf.slice(1); continue;
      }
      const length = (frameBuf[2] << 8) | frameBuf[3];
      if (length > MAX_FRAME) { frameBuf = frameBuf.slice(1); continue; }
      if (frameBuf.length < 4 + length) break;

      const data = frameBuf.slice(4, 4 + length);
      frameBuf = frameBuf.slice(4 + length);

      console.log('[Serial] ←', length, 'bytes');
      dataCallbacks.forEach(cb => {
        try { cb(data); } catch (e) { console.warn('[Serial] callback error:', e); }
      });
    }
  }

  // --- internal: read loop ---
  async function readLoop() {
    try {
      const r = port.readable.getReader();
      try {
        while (!readLoopAbort.signal.aborted) {
          const { value, done } = await r.read();
          if (done) break;
          if (value) {
            activityCallbacks.forEach(cb => { try { cb(); } catch (_) {} });
            handleChunk(value);
          }
        }
      } finally {
        try { r.releaseLock(); } catch (_) {}
      }
    } catch (e) {
      if (!readLoopAbort.signal.aborted) {
        console.warn('[Serial] Read error:', e.message);
        connected = false;
        disconnectCallbacks.forEach(cb => cb());
      }
    }
  }

  // --- public API ---
  async function connect() {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: SERIAL_BAUD, flowControl: 'none' });
    writer = port.writable.getWriter();
    readLoopAbort = new AbortController();
    connected = true;
    readLoop().catch(e => console.warn('[Serial] Read loop error:', e));
  }

  async function write(bytes) {
    if (!connected || !writer) throw new Error('Serial not connected');
    const len = bytes.length;
    const framed = new Uint8Array(4 + len);
    framed[0] = FRAME_START_1; framed[1] = FRAME_START_2;
    framed[2] = (len >>> 8) & 0xff; framed[3] = len & 0xff;
    framed.set(bytes, 4);
    await writer.write(framed);
  }

  function onData(cb) { dataCallbacks.push(cb); }
  function onDisconnect(cb) { disconnectCallbacks.push(cb); }
  function onActivity(cb) { activityCallbacks.push(cb); }

  async function disconnect() {
    connected = false;
    if (readLoopAbort) readLoopAbort.abort();
    dataCallbacks = [];
    disconnectCallbacks = [];
    activityCallbacks = [];
    try { writer?.releaseLock(); } catch (_) {}
    try { await port?.close(); } catch (_) {}
  }

  return { connect, disconnect, write, onData, onDisconnect, onActivity,
           get connected() { return connected; } };
}

// ============================================================================
// HTTP (WiFi)
// ============================================================================

export async function createHttpConnection(baseUrl = '') {
  // baseUrl e.g. 'http://192.168.1.100' — user must provide
  let dataCallbacks = [];
  let disconnectCallbacks = [];
  let connected = false;
  let pollTimer = null;
  let lastSeen = 0;

  async function connect() {
    // Initial GET — node may send MyNodeInfo/config immediately on connect.
    // Must READ the response body, not just check resp.ok!
    const resp = await fetch(`${baseUrl}/api/v1/fromradio?all=true`, {
      mode: 'cors',
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const buffer = await resp.arrayBuffer();
    if (buffer && buffer.byteLength > 0) {
      console.log('[HTTP] Connect ←', buffer.byteLength, 'bytes');
      _parseHttpResponse(new Uint8Array(buffer), dataCallbacks);
    }

    connected = true;

    // Start polling (3-second interval like the official client)
    _poll();
  }

  async function _poll() {
    if (!connected) return;
    try {
      const resp = await fetch(`${baseUrl}/api/v1/fromradio?all=true`, {
        mode: 'cors',
        signal: AbortSignal.timeout(7000),
      });
      if (resp.ok) {
        const buffer = await resp.arrayBuffer();
        if (buffer && buffer.byteLength > 0) {
          console.log('[HTTP] ←', buffer.byteLength, 'bytes');
          _parseHttpResponse(new Uint8Array(buffer), dataCallbacks);
        }
      }
    } catch (e) {
      console.warn('[HTTP] Poll error:', e.message);
    }
    if (connected) {
      pollTimer = setTimeout(_poll, 3000);
    }
  }

  async function write(bytes) {
    if (!connected) throw new Error('HTTP not connected');
    await fetch(`${baseUrl}/api/v1/toradio`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-protobuf' },
      body: bytes,
      mode: 'cors',
      signal: AbortSignal.timeout(4000),
    });
  }

  function onData(cb) { dataCallbacks.push(cb); }
  function onDisconnect(cb) { disconnectCallbacks.push(cb); }

  async function disconnect() {
    connected = false;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    dataCallbacks = [];
    disconnectCallbacks = [];
  }

  return { connect, disconnect, write, onData, onDisconnect, get connected() { return connected; } };
}

// Internal: parse HTTP response containing concatenated FromRadio protobuf messages.
// Both the node's built-in HTTP API and bridge.py return this format.
function _parseHttpResponse(bytes, dataCallbacks) {
  dataCallbacks.forEach(cb => {
    try { cb(bytes); } catch (e) {}
  });
}


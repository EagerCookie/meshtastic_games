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
  if (!navigator.serial) throw new Error('Web Serial not available in this browser');

  let port, writer;
  let dataCallbacks = [];
  let disconnectCallbacks = [];
  let activityCallbacks = []; // raw activity (console) callbacks
  let connected = false;
  let readLoopAbort = null;
  let discardedTotal = 0;

  // --- internal: parse 0x94 0xC3 framed packets ---
  // Matches serial_reader.py frame_reader() state machine exactly.
  let frameBuf = [];

  function handleChunk(chunk) {
    // Accumulate bytes (use Array for compatibility with find/indexOf patterns)
    for (let i = 0; i < chunk.length; i++) frameBuf.push(chunk[i]);

    while (true) {
      // Step 1: Find START1 (0x94)
      const idx = frameBuf.indexOf(FRAME_START_1);
      if (idx < 0) {
        // No START1 — clear buffer (matching Python: buf.clear())
        if (frameBuf.length > 0) {
          discardedTotal += frameBuf.length;
          console.log('[Serial] Discarding', frameBuf.length, 'bytes (no 0x94), total discarded:', discardedTotal);
        }
        frameBuf = [];
        break;
      }
      // Discard bytes before START1
      if (idx > 0) {
        console.log('[Serial] Discarding', idx, 'bytes before START1 marker');
        frameBuf = frameBuf.slice(idx);
      }
      // Need at least 4 bytes for header
      if (frameBuf.length < 4) break;
      // Check for full START1+START2 header
      if (frameBuf[0] !== FRAME_START_1 || frameBuf[1] !== FRAME_START_2) {
        frameBuf.shift(); // pop first byte, retry
        continue;
      }
      // Read big-endian length
      const length = (frameBuf[2] << 8) | frameBuf[3];
      if (length > MAX_FRAME) {
        // Bogus length — discard START1 and retry
        frameBuf.shift();
        continue;
      }
      if (frameBuf.length < 4 + length) break; // need more data

      // Extract payload
      const data = new Uint8Array(frameBuf.slice(4, 4 + length));
      frameBuf = frameBuf.slice(4 + length);

      console.log('[Serial] ← frame', length, 'bytes');
      dataCallbacks.forEach(cb => {
        try { cb(data); } catch (e) { console.warn('[Serial] callback error:', e); }
      });
    }
  }

  // --- internal: read loop ---
  async function readLoop() {
    console.log('[Serial] Read loop started');
    try {
      const r = port.readable.getReader();
      console.log('[Serial] Reader acquired, waiting for data...');
      try {
        while (!readLoopAbort.signal.aborted) {
          const { value, done } = await r.read();
          if (done) { console.log('[Serial] Stream done'); break; }
          if (value) {
            console.log('[Serial] ← raw chunk', value.length, 'bytes, first:',
                        Array.from(value.slice(0,8)).map(b=>b.toString(16).padStart(2,'0')).join(' '));
            // Notify activity listeners (for idle detection)
            activityCallbacks.forEach(cb => { try { cb(); } catch (_) {} });
            handleChunk(value);
          }
        }
      } finally {
        try { r.releaseLock(); } catch (_) {}
      }
    } catch (e) {
      if (!readLoopAbort.signal.aborted) {
        console.warn('[Serial] Read error:', e.message, e.name);
        connected = false;
        disconnectCallbacks.forEach(cb => cb());
      }
    }
    console.log('[Serial] Read loop ended');
  }

  // --- public API ---
  async function connect() {
    port = await navigator.serial.requestPort();
    console.log('[Serial] Port selected, opening at', SERIAL_BAUD, 'baud...');
    await port.open({ baudRate: SERIAL_BAUD, flowControl: 'none' });
    console.log('[Serial] Port opened');

    writer = port.writable.getWriter();
    console.log('[Serial] Writer acquired');
    readLoopAbort = new AbortController();
    connected = true;

    // Start read loop
    readLoop().catch(e => console.warn('[Serial] Read loop error:', e));
  }

  async function write(bytes) {
    if (!connected || !writer) throw new Error('Serial not connected');
    // Frame: 0x94 0xC3 + 2-byte big-endian length + data
    // This triggers the node to switch from console to API mode
    const len = bytes.length;
    const framed = new Uint8Array(4 + len);
    framed[0] = FRAME_START_1;
    framed[1] = FRAME_START_2;
    framed[2] = (len >>> 8) & 0xff;
    framed[3] = len & 0xff;
    framed.set(bytes, 4);
    console.log('[Serial] → writing', framed.length, 'bytes, payload', len, 'bytes');
    await writer.write(framed);
    console.log('[Serial] → write complete');
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


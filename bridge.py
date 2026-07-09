#!/usr/bin/env python3
"""Mesh Artillery — HTTP ↔ Meshtastic TCP bridge.

   Browser  ← HTTP :8081 →  this bridge  → TCP :4403 → Meshtastic node

   Implements the Meshtastic HTTP API:
     GET  /api/v1/fromradio?all=true   → buffered FromRadio messages
     PUT  /api/v1/toradio               → forward ToRadio to node

   Zero external dependencies — only Python stdlib.

Usage:
   python bridge.py --node-ip 192.168.1.100 --node-port 4403 --http-port 8081
"""

import argparse
import asyncio
import struct
import sys
import time

FRAME_START = b"\x94\xc3"
DEBUG = False


class Bridge:
    def __init__(self, node_ip, node_port):
        self.node_ip = node_ip
        self.node_port = node_port
        self.reader = None
        self.writer = None
        self.messages = []  # (timestamp, fromradio_bytes)

    async def connect(self):
        self.reader, self.writer = await asyncio.wait_for(
            asyncio.open_connection(self.node_ip, self.node_port), timeout=5
        )
        print(f"Connected to node {self.node_ip}:{self.node_port}")
        asyncio.create_task(self._read_loop())

    async def _read_loop(self):
        """Continuously read from node, parse 0x94 0xC3 frames, buffer messages."""
        buf = b""
        while True:
            try:
                data = await asyncio.wait_for(self.reader.read(4096), timeout=0.3)
            except asyncio.TimeoutError:
                continue
            except Exception:
                break
            if not data:
                break

            buf += data
            while len(buf) >= 4:
                if buf[:2] != FRAME_START:
                    buf = buf[1:]
                    continue
                n = (buf[2] << 8) | buf[3]
                if len(buf) < 4 + n:
                    break
                msg = buf[4 : 4 + n]
                buf = buf[4 + n :]
                if DEBUG:
                    print(f"TCP recv: {len(msg)} bytes from node, hex: {msg.hex()}")
                else:
                    print(f"TCP recv: {len(msg)} bytes from node")
                self.messages.append((time.time(), msg))

        print("Node disconnected")

    async def send_to_node(self, data: bytes):
        """Send ToRadio bytes to the node."""
        if not self.writer:
            raise RuntimeError("Not connected to node")
        header = FRAME_START + struct.pack(">H", len(data))
        packet = header + data
        if DEBUG:
            print(f"TCP send: {len(data)} bytes to node, hex: {packet.hex()}")
        self.writer.write(packet)
        await self.writer.drain()

    def get_messages(self):
        """Return all buffered FromRadio messages — raw concatenated protobuf
           (matching the format of the node's built-in HTTP API)."""
        out = bytearray()
        for _, msg in self.messages:
            out.extend(msg)
        self.messages.clear()
        return bytes(out)

    async def close(self):
        if self.writer:
            self.writer.close()
            await self.writer.wait_closed()


# ---------------------------------------------------------------------------
# Minimal HTTP server (zero dependencies)
# ---------------------------------------------------------------------------

async def handle_client(reader, writer, bridge):
    """Parse HTTP request, route to handler."""
    try:
        raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=30)
    except Exception:
        writer.close()
        return

    head = raw.decode("utf-8", errors="replace")
    lines = head.split("\r\n")
    if not lines:
        writer.close()
        return

    parts = lines[0].split(" ")
    if len(parts) < 2:
        writer.close()
        return

    method = parts[0].upper()
    path = parts[1].split("?")[0]

    # Find Content-Length for PUT
    content_length = 0
    for line in lines[1:]:
        if line.lower().startswith("content-length:"):
            try:
                content_length = int(line.split(":")[1].strip())
            except ValueError:
                pass
            break

    if method == "GET" and path == "/api/v1/fromradio":
        data = bridge.get_messages()
        print(f"GET /fromradio → {len(data)} bytes")
        resp = (
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: application/x-protobuf\r\n"
            f"Content-Length: {len(data)}\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Connection: close\r\n"
            "\r\n"
        )
        writer.write(resp.encode() + data)
        await writer.drain()

    elif method == "PUT" and path == "/api/v1/toradio":
        body = b""
        while len(body) < content_length:
            chunk = await asyncio.wait_for(reader.read(4096), timeout=10)
            if not chunk:
                break
            body += chunk

        if body:
            if DEBUG:
                print(f"PUT /toradio → {len(body)} bytes to node, hex: {body.hex()}")
            else:
                print(f"PUT /toradio → {len(body)} bytes to node")
            try:
                await bridge.send_to_node(body)
                print(f"  → sent OK to {bridge.node_ip}:{bridge.node_port}")
            except Exception as e:
                resp = f"HTTP/1.1 502 Bad Gateway\r\n\r\n{str(e)}"
                writer.write(resp.encode())
                await writer.drain()
                writer.close()
                return

        resp = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
        writer.write(resp.encode())
        await writer.drain()

    elif method == "OPTIONS":
        # CORS preflight
        resp = (
            "HTTP/1.1 204 No Content\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Access-Control-Allow-Methods: GET, PUT, OPTIONS\r\n"
            "Access-Control-Allow-Headers: Content-Type\r\n"
            "Connection: close\r\n"
            "\r\n"
        )
        writer.write(resp.encode())
        await writer.drain()

    else:
        resp = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        writer.write(resp.encode())
        await writer.drain()

    writer.close()


# ---------------------------------------------------------------------------
# Listen mode — just print incoming packets as JSON
# ---------------------------------------------------------------------------

def _read_fixed32(data, off):
    return (data[off] | (data[off+1] << 8) | (data[off+2] << 16) | (data[off+3] << 24)) & 0xFFFFFFFF

def _read_varint(data, off):
    v, s = 0, 0
    while off < len(data):
        b = data[off]; off += 1
        v |= (b & 0x7f) << s; s += 7
        if not (b & 0x80): break
    return v, off

def _parse_protobuf(data):
    """Minimal protobuf parser — returns dict of field_number → [values]."""
    off = 0
    fields = {}
    while off < len(data):
        tag, off = _read_varint(data, off)
        fn = tag >> 3; wt = tag & 7
        if wt == 0:  # varint
            v, off = _read_varint(data, off)
            fields.setdefault(fn, []).append(("varint", v))
        elif wt == 2:  # length-delimited
            n, off = _read_varint(data, off)
            sub = data[off:off+n]; off += n
            fields.setdefault(fn, []).append(("bytes", sub))
        elif wt == 5:  # fixed32
            v = _read_fixed32(data, off); off += 4
            fields.setdefault(fn, []).append(("fixed32", v))
        else:
            break
    return fields

def decode_packet(raw):
    """Decode one FromRadio/MeshPacket and return human-readable dict."""
    fromradio = _parse_protobuf(raw)
    # Find MeshPacket — try field 1 then field 2
    mp_bytes = None
    for fn in (1, 2):
        for wt, data in fromradio.get(fn, []):
            if wt == "bytes":
                mp_bytes = data
                break
    if not mp_bytes:
        return {"error": "no MeshPacket in FromRadio", "fields": list(fromradio.keys())}

    mp = _parse_protobuf(mp_bytes)
    result = {}

    # from
    for wt, v in mp.get(1, []):
        result["from"] = f"!{v:08x}"
    # to
    for wt, v in mp.get(2, []):
        result["to"] = "broadcast" if v == 0xFFFFFFFF else f"!{v:08x}"
    # channel
    for wt, v in mp.get(3, []):
        result["channel"] = v
    # id
    for wt, v in mp.get(6, []):
        result["packetId"] = f"0x{v:08x}"
    # wantAck
    for wt, v in mp.get(13, []):
        result["wantAck"] = bool(v)

    # Decoded data
    for wt, data_bytes in mp.get(4, []):
        data = _parse_protobuf(data_bytes)
        for wt, portnum in data.get(1, []):
            result["portnum"] = portnum
        for wt, payload in data.get(2, []):
            try:
                result["text"] = payload.decode("utf-8")
            except:
                result["text"] = f"<{len(payload)} bytes>"
            # Try parsing as JSON game packet
            try:
                result["game"] = json.loads(payload.decode("utf-8"))
            except:
                pass

    return result


async def interactive_mode(args):
    """Interactive mode with threaded stdin + asyncio message polling."""
    import json as _json, threading
    global json
    json = _json

    bridge = Bridge(args.node_ip, args.node_port)
    await bridge.connect()
    await asyncio.sleep(0.5)

    field_num = 1
    channel = 1
    want_ack = False
    running = True
    input_queue = []

    def stdin_reader():
        while running:
            try:
                line = sys.stdin.readline()
                if line:
                    input_queue.append(line.strip())
            except EOFError:
                break

    reader_thread = threading.Thread(target=stdin_reader, daemon=True)
    reader_thread.start()

    print("Interactive mode — type a message to send")
    print("Commands: /f1 /f2 (field), /c0 /c1 (channel), /a (toggle ack), /q (quit)")
    print()

    while running:
        # Print incoming messages
        msgs = bridge.get_messages()
        if msgs:
            off = 0
            while off < len(msgs):
                n, off = _read_varint(msgs, off)
                if n == 0 or off + n > len(msgs): break
                raw = msgs[off:off+n]; off += n
                decoded = decode_packet(raw)
                text = decoded.get("text", "")
                game = decoded.get("game")
                from_id = decoded.get("from", "?")
                ch = decoded.get("channel", "?")
                pn = decoded.get("portnum", "?")
                print(f"\n← [{from_id}] ch={ch} pn={pn}: {text}")
                if game: print(f"  game: {json.dumps(game)}")

        # Process input
        while input_queue:
            line = input_queue.pop(0)
            if line == "/q":
                running = False
                break
            if line == "/f1":
                field_num = 1; print(f"→ field={field_num}"); continue
            if line == "/f2":
                field_num = 2; print(f"→ field={field_num}"); continue
            if line == "/c0":
                channel = 0; print(f"→ chan={channel}"); continue
            if line == "/c1":
                channel = 1; print(f"→ chan={channel}"); continue
            if line == "/a":
                want_ack = not want_ack; print(f"→ ack={want_ack}"); continue
            if line:
                data = build_to_radio(line, channel=channel, field_num=field_num,
                                      want_ack=want_ack, from_id=0)
                print(f"→ TX: '{line}' f={field_num} ch={channel} ack={want_ack} ({len(data)}B)")
                await bridge.send_to_node(data)

        await asyncio.sleep(0.3)

    await bridge.close()

async def listen_mode(args):
    """Connect to node and print all incoming packets as JSON."""
    import json as _json
    global json
    json = _json

    bridge = Bridge(args.node_ip, args.node_port)
    await bridge.connect()
    print(f"Listening on {args.node_ip}:{args.node_port} — Ctrl+C to stop\n")

    while True:
        msgs = bridge.get_messages()
        if msgs:
            off = 0
            while off < len(msgs):
                n, off = _read_varint(msgs, off)
                if n == 0 or off + n > len(msgs): break
                raw = msgs[off:off+n]; off += n
                decoded = decode_packet(raw)
                print(json.dumps(decoded, indent=2, ensure_ascii=False))
                print("---")
        await asyncio.sleep(1)

# ---------------------------------------------------------------------------
# Test mode — send raw protobuf messages to verify TX path
# ---------------------------------------------------------------------------

def _varint(v):
    """Encode unsigned integer as protobuf varint bytes."""
    buf = []
    while v > 0x7f:
        buf.append((v & 0x7f) | 0x80)
        v >>= 7
    buf.append(v & 0x7f)
    return bytes(buf)

def _fixed32(v):
    """Encode as little-endian 32-bit."""
    return struct.pack("<I", v & 0xFFFFFFFF)

def _tag(field, wire_type):
    return _varint((field << 3) | wire_type)

def _bytes_field(field, data):
    return _tag(field, 2) + _varint(len(data)) + data

def build_to_radio(text, to=0xFFFFFFFF, channel=1, want_ack=False, field_num=1, from_id=None):
    """Build ToRadio protobuf with MeshPacket containing a text message."""
    payload = text.encode("utf-8")

    # Data message: portnum=1 (TEXT_MESSAGE_APP), payload=text
    data_msg = _tag(1, 0) + _varint(1) + _tag(2, 2) + _varint(len(payload)) + payload

    # MeshPacket
    if from_id is None:
        from_id = 0  # let node fill its own ID
    mp = b""
    mp += _tag(1, 5) + _fixed32(from_id)       # from (0 = node's own ID)
    mp += _tag(2, 5) + _fixed32(to)             # to
    mp += _tag(3, 0) + _varint(channel)         # channel
    mp += _bytes_field(4, data_msg)             # decoded
    mp += _tag(6, 5) + _fixed32(0)              # id = 0 (let node auto-generate)
    if want_ack:
        mp += _tag(10, 0) + _varint(1)          # want_ack (field 10, not 13!)

    # ToRadio: packet is always field 1 (field_num kept for debug compatibility)
    toradio = _bytes_field(field_num, mp)
    return toradio


async def test_mode(args):
    """Send test messages with different ToRadio formats and see which one works."""
    bridge = Bridge(args.node_ip, args.node_port)
    await bridge.connect()
    await asyncio.sleep(1)  # let node settle

    tests = [
        ("field=1 chan=0 from=0",
         build_to_radio("HELLO MESH", channel=0, field_num=1, from_id=0)),
        ("field=1 chan=1 from=0",
         build_to_radio("HELLO GAMES", channel=1, field_num=1, from_id=0)),
        ("field=1 chan=0 from=nodeId",
         build_to_radio("HELLO MESH2", channel=0, field_num=1, from_id=0x4A283840)),
        ("field=1 chan=1 from=nodeId",
         build_to_radio("HELLO GAMES2", channel=1, field_num=1, from_id=0x4A283840)),
    ]

    for desc, data in tests:
        print(f"\nSending: {desc}")
        print(f"  {len(data)} bytes: {data[:40].hex()}...")
        await bridge.send_to_node(data)  # adds 0x94 0xC3 framing internally
        await asyncio.sleep(3)  # wait for LoRa TX + response

    print("\nTest done. Check meshmonitor / node logs for messages.")
    await bridge.close()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main(args):
    if args.interactive:
        await interactive_mode(args)
        return
    if args.listen:
        await listen_mode(args)
        return
    if args.test:
        await test_mode(args)
        return

    bridge = Bridge(args.node_ip, args.node_port)
    await bridge.connect()

    server = await asyncio.start_server(
        lambda r, w: handle_client(r, w, bridge),
        args.http_host,
        args.http_port,
    )

    print(f"HTTP bridge: http://{args.http_host}:{args.http_port} → TCP {args.node_ip}:{args.node_port}")
    print("Endpoints: GET /api/v1/fromradio?all=true   PUT /api/v1/toradio")

    try:
        async with server:
            await server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        await bridge.close()
        print("\nShutdown.")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="Mesh Artillery HTTP bridge")
    p.add_argument("--node-ip", default="192.168.1.100", help="Meshtastic node IP")
    p.add_argument("--node-port", type=int, default=4403, help="Meshtastic TCP port")
    p.add_argument("--http-host", default="0.0.0.0", help="HTTP listen host")
    p.add_argument("--http-port", type=int, default=8081, help="HTTP listen port")
    p.add_argument("--test", action="store_true", help="Send test messages")
    p.add_argument("--listen", action="store_true", help="Listen for incoming packets as JSON")
    p.add_argument("--interactive", action="store_true", help="Interactive send/listen mode")
    p.add_argument("--debug", action="store_true", help="Show raw hex bytes of packets")
    args = p.parse_args()
    if args.debug:
        DEBUG = True
    try:
        asyncio.run(main(args))
    except KeyboardInterrupt:
        print("\nShutdown.")

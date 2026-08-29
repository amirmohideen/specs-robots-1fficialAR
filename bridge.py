#!/usr/bin/env python3
"""
bridge.py - WebSocket Relay Bridge for Micro Duck Spectacles App & Simulator.

Relays real-time hand gesture packets between Snap Spectacles and the
Micro Duck web simulation. Runs with pure Python standard library (no extra pip packages required).

Usage:
    python3 bridge.py [--host 0.0.0.0] [--port 8765]
"""

import argparse
import base64
import hashlib
import json
import os
import select
import socket
import struct
import sys
import threading
import time

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WebSocketClient:
    def __init__(self, sock: socket.socket, addr, client_id: int):
        self.sock = sock
        self.addr = addr
        self.client_id = client_id
        self.handshake_done = False
        self.closed = False
        self.buffer = bytearray()
        self.role = "unknown"  # "spectacles" | "simulator" | "tester"

    def fileno(self):
        return self.sock.fileno()


class MicroDuckBridgeServer:
    def __init__(self, host: str = "0.0.0.0", port: int = 8765):
        self.host = host
        self.port = port
        self.server_sock = None
        self.clients: list[WebSocketClient] = []
        self.next_client_id = 1
        self.packet_count = 0
        self.running = False

    def start(self):
        self.server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server_sock.bind((self.host, self.port))
        self.server_sock.listen(16)
        self.running = True

        local_ip = self._get_local_ip()
        print("=" * 64, flush=True)
        print("🐤 MICRO DUCK SPECTACLES WEBSOCKET BRIDGE SERVER", flush=True)
        print("=" * 64, flush=True)
        print(f"  • Listening on: ws://{self.host}:{self.port}", flush=True)
        print(f"  • Local LAN IP: ws://{local_ip}:{self.port}", flush=True)
        print(f"  • Spectacles setting: bridgeHost = '{local_ip}', port = {self.port}", flush=True)
        print(f"  • Simulator: Auto-connects to ws://127.0.0.1:{self.port}", flush=True)
        print("=" * 64, flush=True)
        print("[Bridge] Waiting for Spectacles and Simulator connections...\n", flush=True)

        while self.running:
            try:
                rlist = [self.server_sock] + [c.sock for c in self.clients if not c.closed]
                readable, _, exceptional = select.select(rlist, [], rlist, 0.5)

                for sock in readable:
                    if sock is self.server_sock:
                        client_sock, addr = self.server_sock.accept()
                        client_sock.setblocking(False)
                        client = WebSocketClient(client_sock, addr, self.next_client_id)
                        self.next_client_id += 1
                        self.clients.append(client)
                        print(f"[Bridge] (+) Connection from {addr[0]}:{addr[1]} (id={client.client_id})")
                    else:
                        client = next((c for c in self.clients if c.sock is sock), None)
                        if client:
                            self._handle_client_data(client)

                for sock in exceptional:
                    client = next((c for c in self.clients if c.sock is sock), None)
                    if client:
                        self._disconnect_client(client)

                self.clients = [c for c in self.clients if not c.closed]

            except KeyboardInterrupt:
                print("\n[Bridge] Stopping server...")
                break
            except Exception as e:
                print(f"[Bridge] Error in main loop: {e}")

        self.stop()

    def stop(self):
        self.running = False
        for c in self.clients:
            self._disconnect_client(c)
        if self.server_sock:
            try:
                self.server_sock.close()
            except Exception:
                pass
        print("[Bridge] Server stopped.")

    def _handle_client_data(self, client: WebSocketClient):
        try:
            chunk = client.sock.recv(4096)
            if not chunk:
                self._disconnect_client(client)
                return
            client.buffer.extend(chunk)
        except Exception:
            self._disconnect_client(client)
            return

        if not client.handshake_done:
            if b"\r\n\r\n" in client.buffer:
                self._perform_handshake(client)
            return

        while len(client.buffer) >= 2:
            first_byte = client.buffer[0]
            fin = (first_byte & 0x80) != 0
            opcode = first_byte & 0x0F

            second_byte = client.buffer[1]
            masked = (second_byte & 0x80) != 0
            payload_len = second_byte & 0x7F

            offset = 2
            if payload_len == 126:
                if len(client.buffer) < 4:
                    return
                payload_len = struct.unpack("!H", client.buffer[2:4])[0]
                offset = 4
            elif payload_len == 127:
                if len(client.buffer) < 10:
                    return
                payload_len = struct.unpack("!Q", client.buffer[2:10])[0]
                offset = 10

            mask_key = None
            if masked:
                if len(client.buffer) < offset + 4:
                    return
                mask_key = client.buffer[offset : offset + 4]
                offset += 4

            if len(client.buffer) < offset + payload_len:
                return

            raw_payload = client.buffer[offset : offset + payload_len]
            del client.buffer[: offset + payload_len]

            if masked and mask_key:
                unmasked = bytearray(payload_len)
                for i in range(payload_len):
                    unmasked[i] = raw_payload[i] ^ mask_key[i % 4]
                payload_bytes = bytes(unmasked)
            else:
                payload_bytes = bytes(raw_payload)

            if opcode == 0x8:  # Close frame
                self._disconnect_client(client)
                return
            elif opcode == 0x9:  # Ping
                self._send_frame(client, 0xA, payload_bytes)
                continue
            elif opcode == 0x1:  # Text frame
                self._process_message(client, payload_bytes.decode("utf-8", errors="ignore"))

    def _perform_handshake(self, client: WebSocketClient):
        header_end = client.buffer.find(b"\r\n\r\n")
        req_text = client.buffer[:header_end].decode("utf-8", errors="ignore")
        del client.buffer[: header_end + 4]

        key = None
        for line in req_text.split("\r\n"):
            if line.lower().startswith("sec-websocket-key:"):
                key = line.split(":", 1)[1].strip()
                break

        if not key:
            self._disconnect_client(client)
            return

        accept_key = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        resp = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept_key}\r\n\r\n"
        )
        try:
            client.sock.sendall(resp.encode())
            client.handshake_done = True
            print(f"[Bridge] (✓) WebSocket handshake complete for client {client.client_id}")
        except Exception:
            self._disconnect_client(client)

    def _process_message(self, sender: WebSocketClient, text: str):
        self.packet_count += 1
        try:
            msg = json.loads(text)
            source = msg.get("source", "unknown")
            action = msg.get("action")
            vx = msg.get("vx", 0)
            wz = msg.get("wz", 0)
            gesture = msg.get("gesture", "")

            if self.packet_count % 150 == 1 or action:
                act_str = f" [ACTION: {action}]" if action else ""
                print(f"[Bridge] Relayed packet #{self.packet_count}: src={source} vx={vx:.2f} wz={wz:.2f} {gesture}{act_str}")

        except Exception:
            pass

        # Broadcast to all other connected clients
        for c in self.clients:
            if c is not sender and c.handshake_done and not c.closed:
                self._send_text(c, text)

    def _send_text(self, client: WebSocketClient, text: str):
        payload = text.encode("utf-8")
        self._send_frame(client, 0x1, payload)

    def _send_frame(self, client: WebSocketClient, opcode: int, payload: bytes):
        if client.closed:
            return
        frame = bytearray()
        frame.append(0x80 | (opcode & 0x0F))
        n = len(payload)
        if n <= 125:
            frame.append(n)
        elif n <= 65535:
            frame.append(126)
            frame.extend(struct.pack("!H", n))
        else:
            frame.append(127)
            frame.extend(struct.pack("!Q", n))
        frame.extend(payload)
        try:
            client.sock.sendall(frame)
        except Exception:
            self._disconnect_client(client)

    def _disconnect_client(self, client: WebSocketClient):
        if client.closed:
            return
        client.closed = True
        try:
            client.sock.close()
        except Exception:
            pass
        print(f"[Bridge] (-) Disconnected client {client.client_id} ({client.addr[0]}:{client.addr[1]})")

    def _get_local_ip(self) -> str:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            return ip
        except Exception:
            return "127.0.0.1"


def main():
    parser = argparse.ArgumentParser(description="Micro Duck Spectacles WebSocket Relay Bridge")
    parser.add_argument("--host", default="0.0.0.0", help="Binding host (default 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8765, help="WebSocket port (default 8765)")
    args = parser.parse_args()

    server = MicroDuckBridgeServer(host=args.host, port=args.port)
    server.start()


if __name__ == "__main__":
    main()

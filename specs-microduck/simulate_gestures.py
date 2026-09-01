#!/usr/bin/env python3
"""
simulate_gestures.py - Simulates Snap Spectacles hand gestures for Micro Duck.

Enables testing the Micro Duck simulation and bridge without physical Spectacles hardware.
Exercises palm tilt steering, index pinch (quack), middle pinch (kick), roll, and mode switch.

Usage:
    python3 simulate_gestures.py [--host 127.0.0.1] [--port 8765] [--loop]
"""

import argparse
import base64
import hashlib
import json
import math
import os
import socket
import struct
import sys
import time

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class SpectaclesGestureSimulator:
    def __init__(self, host: str = "127.0.0.1", port: int = 8765):
        self.host = host
        self.port = port
        self.sock = None

    def connect(self):
        print(f"[Sim] Connecting to Micro Duck Bridge at ws://{self.host}:{self.port} ...")
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.settimeout(5)
        self.sock.connect((self.host, self.port))

        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET / HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(1024)
            if not chunk:
                raise ConnectionError("Server closed connection during handshake")
            resp += chunk

        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        if accept.encode() not in resp:
            raise ConnectionError("Invalid WebSocket handshake response")
        print(f"[Sim] Connected to ws://{self.host}:{self.port} (Spectacles Client)!\n")

    def send_packet(
        self,
        vx: float,
        vy: float = 0.0,
        wz: float = 0.0,
        jaw: float = 0.0,
        action: str = None,
        gesture: str = "Hand Tilt",
    ):
        packet = {
            "type": "control",
            "vx": round(vx, 4),
            "vy": round(vy, 4),
            "wz": round(wz, 4),
            "jaw": round(jaw, 3),
            "source": "spectacles",
            "hand": "right",
            "gesture": gesture,
            "timestamp": int(time.time() * 1000),
        }
        if action:
            packet["action"] = action

        payload = json.dumps(packet).encode("utf-8")
        mask = os.urandom(4)
        n = len(payload)

        frame = bytearray()
        frame.append(0x81)  # Text frame, fin=1
        if n <= 125:
            frame.append(0x80 | n)
        elif n <= 65535:
            frame.append(0x80 | 126)
            frame.extend(struct.pack("!H", n))
        else:
            frame.append(0x80 | 127)
            frame.extend(struct.pack("!Q", n))

        frame.extend(mask)
        masked_payload = bytearray(n)
        for i in range(n):
            masked_payload[i] = payload[i] ^ mask[i % 4]
        frame.extend(masked_payload)

        self.sock.sendall(frame)

    def run_demo_routine(self):
        hz = 30
        dt = 1.0 / hz

        print("--- Step 1: Neutral Pose (Idle) ---")
        for _ in range(int(1.5 * hz)):
            self.send_packet(vx=0.0, wz=0.0, gesture="Neutral Hand")
            time.sleep(dt)

        print("--- Step 2: Palm Forward Tilt (Walk Forward) ---")
        for i in range(int(3.0 * hz)):
            t = i / (3.0 * hz)
            vx = 0.45 * math.sin(t * math.pi)
            self.send_packet(vx=vx, wz=0.0, gesture="Palm Pitch Forward")
            time.sleep(dt)

        print("--- Step 3: Palm Tilt + Roll (Smooth Curved Turn) ---")
        for i in range(int(3.5 * hz)):
            t = i / (3.5 * hz)
            vx = 0.35
            wz = 0.8 * math.sin(t * 2 * math.pi)
            self.send_packet(vx=vx, wz=wz, gesture="Palm Roll Turn")
            time.sleep(dt)

        print("--- Step 4: Index Pinch Gesture (Quack & Beak Open!) ---")
        self.send_packet(vx=0.0, wz=0.0, jaw=1.0, action="quack", gesture="Index Pinch (Quack)")
        for _ in range(int(0.8 * hz)):
            self.send_packet(vx=0.0, wz=0.0, jaw=0.9, gesture="Quack Hold")
            time.sleep(dt)

        print("--- Step 5: Middle Pinch Gesture (Soccer Kick!) ---")
        self.send_packet(vx=0.0, wz=0.0, action="kickR", gesture="Middle Pinch (Right Kick)")
        time.sleep(1.0)

        print("--- Step 6: Ring Pinch Gesture (Roll / Recovery) ---")
        self.send_packet(vx=0.0, wz=0.0, action="roll", gesture="Ring Pinch (Roll)")
        time.sleep(1.5)

        print("--- Step 7: Double Pinch Gesture (Switch to Rollers Mode!) ---")
        self.send_packet(vx=0.0, wz=0.0, action="locoToggle", gesture="Double Pinch (Mode Switch)")
        time.sleep(1.5)

        print("--- Step 8: High Speed Roller Skating! ---")
        for i in range(int(3.0 * hz)):
            t = i / (3.0 * hz)
            vx = 0.58 * min(1.0, t * 2)
            wz = 0.4 * math.sin(t * 4 * math.pi)
            self.send_packet(vx=vx, wz=wz, gesture="Roller Glide")
            time.sleep(dt)

        print("--- Step 9: Reset Simulation ---")
        self.send_packet(vx=0.0, wz=0.0, action="reset", gesture="Open Palm Wave (Reset)")
        time.sleep(1.0)

        print("\n✨ Demo gesture routine completed successfully!")


def main():
    parser = argparse.ArgumentParser(description="Simulate Spectacles gestures for Micro Duck")
    parser.add_argument("--host", default="127.0.0.1", help="Bridge host (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="Bridge port (default 8765)")
    parser.add_argument("--loop", action="store_true", help="Continuously repeat demo routine")
    args = parser.parse_args()

    sim = SpectaclesGestureSimulator(host=args.host, port=args.port)
    try:
        sim.connect()
    except Exception as e:
        print(f"[Sim] Connection failed: {e}")
        print("Tip: Make sure bridge.py is running (e.g. `python3 bridge.py`)")
        sys.exit(1)

    while True:
        sim.run_demo_routine()
        if not args.loop:
            break
        print("\nRepeating in 2 seconds...")
        time.sleep(2)


if __name__ == "__main__":
    main()

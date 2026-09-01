#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import glob
import json
import math
import socket
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

MOTOR_NAMES = (
    "shoulder_pan", "shoulder_lift", "elbow_flex",
    "wrist_flex", "wrist_roll", "gripper",
)
MOTOR_IDS = {name: index + 1 for index, name in enumerate(MOTOR_NAMES)}
JOINT_LIMITS_RAD = {
    "shoulder_pan": (-1.9198621772, 1.9198621772),
    "shoulder_lift": (-1.7453292520, 1.7453292520),
    "elbow_flex": (-1.69, 1.69),
    "wrist_flex": (-1.6580628495, 1.6580627293),
    "wrist_roll": (-2.7438472970, 2.8412063094),
    "gripper": (-0.1745329776, 1.7453291996),
}
JOINT_CENTER_DEG = {
    name: math.degrees((low + high) * 0.5)
    for name, (low, high) in JOINT_LIMITS_RAD.items()
}
SERVO_MAX_TICK = 4095
GRIPPER_CLOSED_RAD = -0.1
GRIPPER_OPEN_RAD = 1.0


def find_serial_port() -> str | None:
    for pattern in (
        "/dev/cu.usbmodem*", "/dev/tty.usbmodem*",
        "/dev/tty.wchusbserial*", "/dev/ttyUSB*", "/dev/ttyACM*",
    ):
        matches = sorted(glob.glob(pattern))
        if matches:
            return matches[0]
    return None


def local_address(port: int) -> str:
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("10.255.255.255", 1))
        host = probe.getsockname()[0]
    except OSError:
        host = socket.gethostbyname(socket.gethostname())
    finally:
        probe.close()
    return f"ws://{host}:{port}/ws"


def finite_joint_targets(raw: Any) -> dict[str, float]:
    if not isinstance(raw, dict):
        return {}
    return {
        name: float(raw[name])
        for name in MOTOR_NAMES
        if isinstance(raw.get(name), (int, float)) and math.isfinite(raw[name])
    }


class SO101Arm:
    def __init__(self, max_velocity: float, dry_run: bool = False) -> None:
        self.max_velocity = max_velocity
        self.dry_run = dry_run
        self.bus: Any = None
        self.calibration: dict[str, Any] = {}
        self.joints_rad = {name: 0.0 for name in MOTOR_NAMES}
        self.last_targets_rad = dict(self.joints_rad)
        self.last_write_time = time.monotonic()

    def connect(self, port: str | None) -> str:
        if self.dry_run:
            return "virtual"
        from lerobot.motors import Motor, MotorNormMode
        from lerobot.motors.feetech import FeetechMotorsBus

        selected_port = port or find_serial_port()
        if selected_port is None:
            raise RuntimeError("Connect the SO-101 by USB or pass --port.")
        motors = {
            name: Motor(MOTOR_IDS[name], "sts3215", MotorNormMode.DEGREES)
            for name in MOTOR_NAMES[:-1]
        }
        motors["gripper"] = Motor(6, "sts3215", MotorNormMode.RANGE_0_100)
        self.bus = FeetechMotorsBus(port=selected_port, motors=motors)
        self.bus.connect()
        self.calibration = self.bus.read_calibration()
        self.bus.calibration = self.calibration
        self.bus.disable_torque()
        self.read()
        self.last_targets_rad = dict(self.joints_rad)
        return selected_port

    def read(self) -> dict[str, float]:
        if self.dry_run:
            return dict(self.joints_rad)
        values = self.bus.sync_read("Present_Position")
        for name in MOTOR_NAMES:
            if name not in values:
                continue
            if name == "gripper":
                low, high = JOINT_LIMITS_RAD[name]
                self.joints_rad[name] = low + float(values[name]) / 100.0 * (high - low)
            else:
                self.joints_rad[name] = math.radians(
                    float(values[name]) + JOINT_CENTER_DEG[name]
                )
        return dict(self.joints_rad)

    def enable_torque(self) -> None:
        if not self.dry_run:
            self.bus.enable_torque()

    def disable_torque(self) -> None:
        if not self.dry_run and self.bus is not None:
            self.bus.disable_torque()

    def write(self, requested: dict[str, float]) -> dict[str, float]:
        now = time.monotonic()
        dt = min(0.25, max(1.0 / 60.0, now - self.last_write_time))
        self.last_write_time = now
        max_step = self.max_velocity * dt
        accepted: dict[str, float] = {}
        for name, value in requested.items():
            low, high = JOINT_LIMITS_RAD[name]
            target = min(high, max(low, value))
            previous = self.last_targets_rad.get(name, self.joints_rad[name])
            delta = target - previous
            if abs(delta) > max_step:
                target = previous + math.copysign(max_step, delta)
            self.last_targets_rad[name] = target
            accepted[name] = target
        if self.dry_run:
            self.joints_rad.update(accepted)
            return accepted

        goal: dict[str, float] = {}
        for name, radians in accepted.items():
            if name == "gripper":
                low, high = JOINT_LIMITS_RAD[name]
                goal[name] = (radians - low) / (high - low) * 100.0
            else:
                goal[name] = math.degrees(radians) - JOINT_CENTER_DEG[name]
        if goal:
            self.bus.sync_write("Goal_Position", goal)
        return accepted

    def close(self) -> None:
        if self.dry_run or self.bus is None:
            return
        self.disable_torque()
        self.bus.disconnect()

    def calibration_summary(self) -> dict[str, Any]:
        limits: dict[str, list[float]] = {}
        for name in MOTOR_NAMES:
            low, high = JOINT_LIMITS_RAD[name]
            entry = self.calibration.get(name)
            if entry is not None and name != "gripper":
                span = (
                    int(getattr(entry, "range_max"))
                    - int(getattr(entry, "range_min"))
                ) * 2.0 * math.pi / SERVO_MAX_TICK
                center = (low + high) * 0.5
                low = max(low, center - span * 0.5)
                high = min(high, center + span * 0.5)
            limits[name] = [low, high]
        return {
            "source": "robot_calibration" if self.calibration else "so101_limits",
            "joint_limits_rad": limits,
        }


class SO101Kinematics:
    def __init__(self) -> None:
        from ikpy.chain import Chain

        urdf = Path(__file__).with_name("bridge") / "so101_kinematics.urdf"
        self.chain = Chain.from_urdf_file(
            str(urdf),
            base_elements=["base_link"],
            active_links_mask=[False, True, True, True, True, True, False],
        )
        self.seed = [0.0] * len(self.chain.links)

    def solve(self, raw_position: Any, gripper_rad: float) -> dict[str, float]:
        if not isinstance(raw_position, dict):
            return {}
        position = [raw_position.get(axis) for axis in ("x", "y", "z")]
        if any(
            not isinstance(value, (int, float)) or not math.isfinite(value)
            for value in position
        ):
            return {}
        solution = self.chain.inverse_kinematics(position, initial_position=self.seed)
        self.seed = solution
        return {
            "shoulder_pan": float(solution[1]),
            "shoulder_lift": float(solution[2]),
            "elbow_flex": float(solution[3]),
            "wrist_flex": float(solution[4]),
            "wrist_roll": float(solution[5]),
            "gripper": gripper_rad,
        }


def confirm_motion(client_ip: str) -> bool:
    print(f"\nLens connected from {client_ip}.")
    response = input("Clear the robot workspace, then type ARM to enable motion: ")
    return response.strip() == "ARM"


def create_app(arm: SO101Arm, kinematics: SO101Kinematics) -> FastAPI:
    clients: set[WebSocket] = set()
    controller_ip: str | None = None
    bus_lock: asyncio.Lock | None = None
    broadcast_task: asyncio.Task | None = None
    gripper_target = GRIPPER_OPEN_RAD

    async def broadcast_state() -> None:
        while True:
            try:
                async with bus_lock:
                    joints = await asyncio.to_thread(arm.read)
                message = json.dumps(
                    {"event": "arm_state", "joints_rad": joints, "t": time.time()}
                )
                disconnected: set[WebSocket] = set()
                for client in clients:
                    try:
                        await client.send_text(message)
                    except Exception:
                        disconnected.add(client)
                clients.difference_update(disconnected)
            except Exception as error:
                print(f"Bridge read error: {error}", flush=True)
            await asyncio.sleep(1.0 / 30.0)

    @asynccontextmanager
    async def lifespan(_app):
        nonlocal bus_lock, broadcast_task
        bus_lock = asyncio.Lock()
        broadcast_task = asyncio.create_task(broadcast_state())
        yield
        broadcast_task.cancel()
        arm.close()

    app = FastAPI(lifespan=lifespan)

    @app.get("/health")
    async def health():
        return {
            "status": "ok",
            "dry_run": arm.dry_run,
            "hardware_ready": not arm.dry_run and arm.bus is not None,
            "joints_rad": arm.joints_rad,
            "calibration": arm.calibration_summary(),
        }

    async def send_snapshot(websocket: WebSocket) -> None:
        """Send the evidence the Lens requires before enabling Real arm."""
        await websocket.send_json({
            "event": "bridge_status",
            "hardware_ready": not arm.dry_run and arm.bus is not None,
            "dry_run": arm.dry_run,
        })
        await websocket.send_json(
            {"event": "calibration", "calibration": arm.calibration_summary()}
        )
        await websocket.send_json({
            "event": "arm_state",
            "joints_rad": arm.joints_rad,
            "t": time.time(),
        })

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket):
        nonlocal controller_ip, gripper_target
        client_ip = websocket.client.host if websocket.client else "unknown"
        await websocket.accept()
        clients.add(websocket)
        await websocket.send_json(
            {"event": "calibration", "calibration": arm.calibration_summary()}
        )
        if controller_ip is not None:
            await websocket.close(code=1008, reason="Another Lens controls the arm")
            clients.discard(websocket)
            return
        approved = await asyncio.to_thread(confirm_motion, client_ip)
        if not approved:
            await websocket.close(code=1008, reason="Motion approval declined")
            clients.discard(websocket)
            return

        controller_ip = client_ip
        async with bus_lock:
            await asyncio.to_thread(arm.enable_torque)

        try:
            await send_snapshot(websocket)
            print("Real arm motion enabled.")
            while True:
                message = json.loads(await websocket.receive_text())
                event = message.get("event")
                targets: dict[str, float] = {}
                if event in {"command", "joints"}:
                    targets = finite_joint_targets(message.get("joints_rad"))
                elif event == "target":
                    targets = await asyncio.to_thread(
                        kinematics.solve, message.get("pos"), gripper_target
                    )
                elif event == "grasp":
                    value = float(
                        message.get("value", 0.0 if message.get("closed") else 1.0)
                    )
                    value = min(1.0, max(0.0, value))
                    gripper_target = GRIPPER_CLOSED_RAD + value * (
                        GRIPPER_OPEN_RAD - GRIPPER_CLOSED_RAD
                    )
                    targets = {"gripper": gripper_target}
                elif event == "ping":
                    await websocket.send_json({"event": "pong"})
                elif event == "hello":
                    await send_snapshot(websocket)
                if targets:
                    async with bus_lock:
                        await asyncio.to_thread(arm.write, targets)
        except WebSocketDisconnect:
            pass
        except (json.JSONDecodeError, ValueError) as error:
            await websocket.send_json({"event": "error", "message": str(error)})
        finally:
            clients.discard(websocket)
            if controller_ip == client_ip:
                async with bus_lock:
                    await asyncio.to_thread(arm.disable_torque)
                controller_ip = None
                print("Lens disconnected. Motor torque disabled.")

    return app


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Connect the SO-101 Lens to a physical SO-101."
    )
    parser.add_argument("--port")
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Loopback only by default; the trusted WSS helper is the LAN listener.",
    )
    parser.add_argument("--ws-port", type=int, default=8097)
    parser.add_argument("--max-velocity", type=float, default=1.0)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    arm = SO101Arm(max_velocity=max(0.1, args.max_velocity), dry_run=args.dry_run)
    selected_port = arm.connect(args.port)
    kinematics = SO101Kinematics()
    print(f"SO-101: {selected_port}")
    print(f"Local bridge: ws://{args.host}:{args.ws_port}/ws")
    print("Keep this process running while Real arm mode is active.")

    import uvicorn

    uvicorn.run(
        create_app(arm, kinematics),
        host=args.host,
        port=args.ws_port,
        log_level="warning",
    )


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Trusted, LAN-only WSS front door for the SO-101 hardware bridge.

The helper owns no robot hardware. It authenticates one paired Lens, applies a
local operator enable gate, and proxies that connection to bridge.py on
loopback. A tiny hosted control plane is used only for private-IP DNS records,
ACME DNS-01 proof, and one-time pairing bundles.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import socket
import ssl
import subprocess
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from websockets.asyncio.client import connect
from websockets.asyncio.server import ServerConnection, serve


DEFAULT_CONTROL_PLANE = "https://arm.curvilinear.space"
DEFAULT_CONFIG_DIR = Path.home() / ".so101-helper"
CONTROL_EVENTS = {"command", "target", "target_hover", "grasp", "joints"}


def _json_file(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def load_config(config_dir: Path) -> dict[str, Any]:
    return _json_file(config_dir / "config.json")


def save_config(config_dir: Path, config: dict[str, Any]) -> None:
    config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = config_dir / "config.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def discover_private_ipv4() -> str:
    candidates: list[str] = []
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("1.1.1.1", 443))
        candidates.append(probe.getsockname()[0])
    except OSError:
        pass
    finally:
        probe.close()
    try:
        candidates.extend(socket.gethostbyname_ex(socket.gethostname())[2])
    except OSError:
        pass
    for candidate in candidates:
        try:
            address = ipaddress.ip_address(candidate)
            if address.version == 4 and address.is_private and not address.is_loopback:
                return candidate
        except ValueError:
            continue
    raise RuntimeError("No private LAN IPv4 address found; pass --lan-ip explicitly")


def api_request(
    config: dict[str, Any],
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    authenticated: bool = True,
) -> dict[str, Any]:
    headers = {
        "content-type": "application/json",
        # Cloudflare's browser-integrity layer rejects urllib's default
        # Python-urllib signature before requests reach the Worker.
        "user-agent": "SO101-Local-Helper/1.0",
    }
    if authenticated:
        secret = config.get("device_secret")
        if not secret:
            raise RuntimeError("Helper is not enrolled; run setup first")
        headers["authorization"] = "Bearer " + secret
    request = Request(
        config.get("control_plane", DEFAULT_CONTROL_PLANE).rstrip("/") + path,
        data=None if body is None else json.dumps(body).encode("utf-8"),
        headers=headers,
        method=method,
    )
    try:
        with urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Control plane returned HTTP {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"Cannot reach the pairing control plane: {error.reason}") from error


def enroll(config_dir: Path, control_plane: str, lan_ip: str) -> dict[str, Any]:
    config = load_config(config_dir)
    config["control_plane"] = control_plane.rstrip("/")
    if config.get("device_id"):
        result = api_request(
            config,
            "PUT",
            f"/v1/devices/{config['device_id']}/address",
            {"ipv4": lan_ip},
        )
        config["hostname"] = result["hostname"]
    else:
        result = api_request(
            config,
            "POST",
            "/v1/devices/register",
            {"ipv4": lan_ip},
            authenticated=False,
        )
        config.update(
            device_id=result["device_id"],
            hostname=result["hostname"],
            device_secret=result["device_secret"],
            controller_token_hashes=[],
        )
    config["lan_ip"] = lan_ip
    save_config(config_dir, config)
    return config


def cert_paths(config_dir: Path, hostname: str) -> tuple[Path, Path]:
    live = config_dir / "acme" / "live" / hostname
    return live / "fullchain.pem", live / "privkey.pem"


def certbot_path() -> Path:
    certbot_executable = Path(sys.executable).with_name("certbot")
    if not certbot_executable.is_file():
        discovered = shutil.which("certbot")
        if not discovered:
            raise RuntimeError("Certbot is not installed; install bridge/requirements-hardware.txt")
        certbot_executable = Path(discovered)
    return certbot_executable


def issue_certificate(config_dir: Path, config: dict[str, Any], email: str, staging: bool) -> None:
    script = Path(__file__).resolve()
    auth_hook = shlex.join([sys.executable, str(script), "--config-dir", str(config_dir), "acme-auth"])
    cleanup_hook = shlex.join([sys.executable, str(script), "--config-dir", str(config_dir), "acme-cleanup"])
    command = [
        str(certbot_path()),
        "certonly",
        "--manual",
        "--preferred-challenges",
        "dns",
        "--manual-auth-hook",
        auth_hook,
        "--manual-cleanup-hook",
        cleanup_hook,
        "--non-interactive",
        "--agree-tos",
        "--email",
        email,
        "--config-dir",
        str(config_dir / "acme"),
        "--work-dir",
        str(config_dir / "acme-work"),
        "--logs-dir",
        str(config_dir / "acme-logs"),
        "--cert-name",
        config["hostname"],
        "-d",
        config["hostname"],
    ]
    if staging:
        command.append("--staging")
    subprocess.run(command, check=True)


def renew_certificate(config_dir: Path, config: dict[str, Any]) -> None:
    hostname = config.get("hostname")
    certificate, _ = cert_paths(config_dir, hostname or "missing")
    if not hostname or not certificate.exists():
        return
    subprocess.run([
        str(certbot_path()),
        "renew",
        "--non-interactive",
        "--cert-name",
        hostname,
        "--config-dir",
        str(config_dir / "acme"),
        "--work-dir",
        str(config_dir / "acme-work"),
        "--logs-dir",
        str(config_dir / "acme-logs"),
    ], check=True)


def certificate_hook(config_dir: Path, cleanup: bool) -> None:
    config = load_config(config_dir)
    if cleanup:
        api_request(config, "DELETE", f"/v1/devices/{config['device_id']}/acme")
        return
    validation = os.environ.get("CERTBOT_VALIDATION", "")
    domain = os.environ.get("CERTBOT_DOMAIN", "")
    if domain != config.get("hostname") or not validation:
        raise RuntimeError("Certbot challenge does not match this enrolled helper")
    api_request(
        config,
        "PUT",
        f"/v1/devices/{config['device_id']}/acme",
        {"value": validation},
    )
    # Cloudflare authoritative DNS updates quickly, but allow its edge to
    # converge before the CA performs the DNS-01 lookup.
    time.sleep(12)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_pairing(config_dir: Path, config: dict[str, Any]) -> dict[str, Any]:
    bearer_token = secrets.token_urlsafe(32)
    hashes = list(config.get("controller_token_hashes", []))
    hashes.append(token_hash(bearer_token))
    # Bound local credentials. The oldest paired Lens is revoked when a fifth
    # credential is added; reset-pairings can revoke all of them immediately.
    config["controller_token_hashes"] = hashes[-4:]
    result = api_request(
        config,
        "POST",
        f"/v1/devices/{config['device_id']}/pairings",
        {"bearer_token": bearer_token},
    )
    save_config(config_dir, config)
    return result


class LocalWssHelper:
    def __init__(self, config_dir: Path, config: dict[str, Any], bridge_url: str) -> None:
        self.config_dir = config_dir
        self.config = config
        self.bridge_url = bridge_url
        self.armed = False
        self.owner: ServerConnection | None = None
        self.owner_lock = asyncio.Lock()

    def token_is_valid(self, token: str) -> bool:
        candidate = token_hash(token)
        return any(secrets.compare_digest(candidate, saved) for saved in self.config.get("controller_token_hashes", []))

    async def handler(self, client: ServerConnection) -> None:
        if client.request.path != "/ws":
            await client.close(code=1008, reason="invalid path")
            return
        try:
            raw = await asyncio.wait_for(client.recv(), timeout=10)
            message = json.loads(raw)
            if message.get("event") != "authenticate" or not self.token_is_valid(message.get("token", "")):
                await client.close(code=1008, reason="authentication failed")
                return
        except (asyncio.TimeoutError, json.JSONDecodeError, TypeError):
            await client.close(code=1008, reason="authentication required")
            return

        async with self.owner_lock:
            if self.owner is not None:
                await client.close(code=1013, reason="arm already has a controller")
                return
            self.owner = client

        print("[helper] Paired Lens connected; local arm enable is still required", flush=True)
        try:
            async with connect(self.bridge_url, max_size=1_048_576) as bridge:
                await client.send(json.dumps({"event": "authenticated", "armed": self.armed}))

                async def lens_to_bridge() -> None:
                    async for raw_message in client:
                        try:
                            parsed = json.loads(raw_message)
                        except (json.JSONDecodeError, TypeError):
                            continue
                        if parsed.get("event") in CONTROL_EVENTS and not self.armed:
                            await client.send(json.dumps({"event": "control_denied", "reason": "local_arm_not_enabled"}))
                            continue
                        await bridge.send(raw_message)

                async def bridge_to_lens() -> None:
                    async for raw_message in bridge:
                        await client.send(raw_message)

                tasks = [asyncio.create_task(lens_to_bridge()), asyncio.create_task(bridge_to_lens())]
                done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in pending:
                    task.cancel()
                await asyncio.gather(*done, *pending, return_exceptions=True)
        except Exception as error:
            print(f"[helper] Connection ended: {error}", flush=True)
        finally:
            async with self.owner_lock:
                if self.owner is client:
                    self.owner = None
                    self.armed = False
            print("[helper] Lens disconnected; arm authority released and helper disarmed", flush=True)

    async def console(self) -> None:
        print("[helper] Commands: enable, disable, pair, status, reset-pairings, quit", flush=True)
        while True:
            command = (await self.console_input("so101-helper> ")).strip().lower()
            if command == "enable":
                self.armed = True
                print("[helper] ARM CONTROL ENABLED locally", flush=True)
            elif command == "disable":
                self.armed = False
                print("[helper] Arm control disabled", flush=True)
            elif command == "pair":
                result = await asyncio.to_thread(create_pairing, self.config_dir, self.config)
                print(f"[helper] One-time Lens pairing code: {result['code']} (expires in 10 minutes)", flush=True)
            elif command == "reset-pairings":
                self.config["controller_token_hashes"] = []
                save_config(self.config_dir, self.config)
                self.armed = False
                print("[helper] All paired Lens credentials revoked", flush=True)
            elif command == "status":
                print(
                    f"[helper] hostname={self.config['hostname']} connected={self.owner is not None} armed={self.armed}",
                    flush=True,
                )
            elif command in {"quit", "exit"}:
                self.armed = False
                print("[helper] Shutting down disarmed", flush=True)
                return
            elif command:
                print("[helper] Unknown command", flush=True)

    async def console_input(self, prompt: str) -> str:
        print(prompt, end="", flush=True)
        loop = asyncio.get_running_loop()
        try:
            file_descriptor = sys.stdin.fileno()
            future: asyncio.Future[str] = loop.create_future()

            def input_ready() -> None:
                if not future.done():
                    future.set_result(sys.stdin.readline())

            loop.add_reader(file_descriptor, input_ready)
            try:
                return await future
            finally:
                loop.remove_reader(file_descriptor)
        except (AttributeError, NotImplementedError, OSError):
            # Windows Proactor loops don't expose add_reader. The foreground
            # helper remains usable there via a worker thread.
            return await asyncio.to_thread(sys.stdin.readline)


async def run_server(config_dir: Path, config: dict[str, Any], bridge_url: str, port: int, pair_on_start: bool) -> None:
    hostname = config.get("hostname")
    if not hostname:
        raise RuntimeError("Helper is not enrolled; run setup first")
    certificate, private_key = cert_paths(config_dir, hostname)
    if not certificate.exists() or not private_key.exists():
        raise RuntimeError("Trusted certificate missing; run setup without --skip-certificate")
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(certificate, private_key)
    helper = LocalWssHelper(config_dir, config, bridge_url)
    if pair_on_start:
        result = await asyncio.to_thread(create_pairing, config_dir, config)
        print(f"[helper] One-time Lens pairing code: {result['code']} (expires in 10 minutes)", flush=True)
    print(f"[helper] LAN data plane: wss://{hostname}:{port}/ws -> {bridge_url}", flush=True)
    print("[helper] Starts DISARMED. Type 'enable' only when the workspace is clear.", flush=True)
    async with serve(helper.handler, "0.0.0.0", port, ssl=context, max_size=1_048_576):
        await helper.console()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config-dir", type=Path, default=DEFAULT_CONFIG_DIR)
    commands = parser.add_subparsers(dest="command", required=True)

    setup = commands.add_parser("setup", help="Enroll DNS and obtain a public TLS certificate")
    setup.add_argument("--control-plane", default=DEFAULT_CONTROL_PLANE)
    setup.add_argument("--lan-ip")
    setup.add_argument("--email")
    setup.add_argument("--staging", action="store_true")
    setup.add_argument("--skip-certificate", action="store_true")

    commands.add_parser("pair", help="Create a one-time Lens pairing code")
    commands.add_parser("status", help="Show non-secret local configuration")
    commands.add_parser("reset-pairings", help="Revoke every locally paired Lens")
    commands.add_parser("acme-auth", help=argparse.SUPPRESS)
    commands.add_parser("acme-cleanup", help=argparse.SUPPRESS)

    run = commands.add_parser("serve", help="Run the trusted local WSS endpoint")
    run.add_argument("--bridge", default="ws://127.0.0.1:8097/ws")
    run.add_argument("--port", type=int, default=8443)
    run.add_argument("--pair", action="store_true")

    args = parser.parse_args()
    config_dir: Path = args.config_dir.expanduser().resolve()

    if args.command == "setup":
        lan_ip = args.lan_ip or discover_private_ipv4()
        config = enroll(config_dir, args.control_plane, lan_ip)
        print(f"[helper] Enrolled {config['hostname']} -> {lan_ip}")
        if not args.skip_certificate:
            if not args.email:
                parser.error("setup requires --email unless --skip-certificate is used")
            issue_certificate(config_dir, config, args.email, args.staging)
            print("[helper] Trusted TLS certificate installed locally")
    elif args.command == "pair":
        result = create_pairing(config_dir, load_config(config_dir))
        print(f"One-time Lens pairing code: {result['code']} (expires in 10 minutes)")
    elif args.command == "status":
        config = load_config(config_dir)
        certificate, _ = cert_paths(config_dir, config.get("hostname", "missing"))
        print(json.dumps({
            "enrolled": bool(config.get("device_id")),
            "hostname": config.get("hostname"),
            "lan_ip": config.get("lan_ip"),
            "certificate_installed": certificate.exists(),
            "paired_credentials": len(config.get("controller_token_hashes", [])),
        }, indent=2))
    elif args.command == "reset-pairings":
        config = load_config(config_dir)
        config["controller_token_hashes"] = []
        save_config(config_dir, config)
        print("All paired Lens credentials revoked")
    elif args.command == "acme-auth":
        certificate_hook(config_dir, cleanup=False)
    elif args.command == "acme-cleanup":
        certificate_hook(config_dir, cleanup=True)
    elif args.command == "serve":
        config = load_config(config_dir)
        try:
            renew_certificate(config_dir, config)
        except (RuntimeError, subprocess.CalledProcessError) as error:
            print(f"[helper] Certificate renewal check failed; using the installed certificate: {error}")
        asyncio.run(run_server(config_dir, config, args.bridge, args.port, args.pair))


if __name__ == "__main__":
    main()

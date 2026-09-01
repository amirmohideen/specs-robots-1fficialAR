# Connect the Lens to a real SO-101

## What this installs

Each arm owner runs two local processes on the computer physically connected
to their robot:

- `so101_bridge.py` owns the USB serial connection and listens only on
  `127.0.0.1:8097` by default.
- `bridge/local_wss_helper.py` exposes a certificate-backed
  `wss://…arm.curvilinear.space:8443/ws` endpoint on that computer's LAN.

Spectacles connects directly to that private-LAN endpoint. The hosted service
is used only to create private-address DNS records, prove certificate ownership,
and redeem a short-lived pairing code. It has no robot WebSocket, command API,
or telemetry store. Do not configure router port forwarding.

## Prerequisites

- An assembled and calibrated SO-101 with logic USB and servo power connected.
- macOS and Python 3.11 (the currently validated host configuration).
- Spectacles and the arm computer on the same Wi-Fi/LAN. Guest networks and
  networks with client isolation will not work.
- Outbound HTTPS/DNS during setup and inbound TCP 8443 on the private LAN. If
  macOS asks whether Python may accept incoming connections, allow it on the
  private network.
- A clear arm workspace and an immediately accessible power disconnect.

## One-time installation

```bash
git clone https://github.com/a-sumo/so101-helper.git
cd so101-helper
python3.11 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements-bridge.txt
```

Connect the controller and identify its serial device if auto-discovery finds
more than one candidate:

```bash
ls /dev/cu.usbmodem* /dev/cu.usbserial*
```

Enroll this computer using the arm owner's email for Let's Encrypt certificate
registration:

```bash
.venv/bin/python bridge/local_wss_helper.py setup --email owner@example.com
```

The TLS key and pairing credentials are stored locally under
`~/.so101-helper/` with private file permissions. A Cloudflare account is not
required. Rerun `setup` after moving the computer to a LAN with a different
private IP address.

## First pairing

Start the bridge in Terminal 1. Its loopback default is intentional:

```bash
.venv/bin/python so101_bridge.py
```

If necessary, select the serial port explicitly:

```bash
.venv/bin/python so101_bridge.py --port /dev/cu.usbmodemXXXX
```

Check the local bridge before continuing:

```bash
curl http://127.0.0.1:8097/health
```

The response must contain `"status":"ok"`, `"dry_run":false`, calibration,
and six joint values. Never use `--dry-run` for a physical-arm validation.

In Terminal 2, start the trusted endpoint and print a pairing code:

```bash
.venv/bin/python bridge/local_wss_helper.py serve --pair
```

Launch the Lens on physical Spectacles. About one second after first launch,
the Lens opens the Spectacles system PIN keyboard. Enter the eight-digit code
from Terminal 2. There is no corresponding Cloudflare webpage or Lens Studio
desktop prompt. The code expires after ten minutes and can be consumed once.

When the paired Lens connects, Terminal 1 asks for its existing local torque
confirmation. Clear the workspace and type:

```text
ARM
```

Terminal 2 still reports that the helper is disarmed. After checking the arm
and workspace again, type:

```text
so101-helper> enable
```

This two-stage local confirmation is intentional. The helper rejects motion
events until `enable`; the bridge disables torque when its connection ends.

In the Lens, open **Operate**, choose **Real arm**, and wait for **ARM LIVE**.
Start with one small joint motion and verify the physical and virtual directions
match before using Follow hand.

## Later sessions

Start the bridge and helper again, but pairing is already stored on Spectacles:

```bash
# Terminal 1
.venv/bin/python so101_bridge.py

# Terminal 2
.venv/bin/python bridge/local_wss_helper.py serve
```

The Lens reconnects automatically. Repeat the local `ARM` and `enable`
confirmations each session. The helper deliberately starts disarmed.

Helper console commands:

- `enable` and `disable` control the helper's local motion gate.
- `pair` prints a new one-time code for another Lens.
- `status` shows the non-secret hostname, connection, and armed state.
- `reset-pairings` revokes all paired Lens credentials.
- `quit` exits disarmed.

Only one Lens may control the arm. Lens disconnect, helper shutdown, and bridge
disconnect release authority. Use `disable` before removing the headset or
approaching the arm.

## Troubleshooting

- **No PIN prompt:** confirm this is the latest Lens build on physical
  Spectacles. The system keyboard is not a Cloudflare or desktop prompt.
- **Code rejected:** type `pair` in the running helper and enter the new code
  within ten minutes.
- **Helper cannot connect:** check both devices use the same LAN, TCP 8443 is
  allowed locally, and the network does not isolate wireless clients.
- **Real arm cannot be selected:** check Terminal 1 accepted `ARM`, then inspect
  `curl http://127.0.0.1:8097/health`; it must report hardware ready and not
  dry-run. The Lens needs bridge status, calibration, and fresh telemetry.
- **LAN address changed:** rerun `setup --email …` and restart the helper.
- **Stop safely:** type `disable` in the helper, then stop the helper and bridge.

The trusted `wss://` route does not require Lens Studio's **Allow Experimental
API** setting. A raw `ws://` address is a development-only route and is not the
published end-user setup.

<h1 align="center">Spectacles Robotics Projects</h1>

<p align="center">
  <b>An unofficial collection of robotics projects built on Snap Spectacles.</b>
</p>

<p align="center">
  <a href="#projects">Projects</a> •
  <a href="#getting-started">Getting Started</a> •
  <a href="#contributors">Contributors</a> •
  <a href="#licenses">Licenses</a>
</p>

---

> [!IMPORTANT]
> **This repository is unofficial.** It is not developed, maintained, endorsed, or
> supported by Snap Inc. Every project here was built by independent developers and is
> tracked in one place purely for discoverability. For official Spectacles samples, see
> [Snapchat/Spectacles-Sample](https://github.com/Snapchat/Spectacles-Sample).

## About

Augmented reality is turning out to be a natural interface for robotics: you can see what
the robot sees, understand what it intends to do, and direct it with your hands instead of
a gamepad or a terminal. This repo tracks projects that explore that intersection on
[Snap Spectacles](https://www.spectacles.com/) — teleoperation, navigation, sensor
visualization, and LLM-driven control across quadrupeds, humanoids, and desktop robots.

Each project lives in its own top-level folder and is imported with its **full original
commit history**, so authorship and development context are preserved. Nothing here is a
rewrite — these are the upstream projects, mirrored.

## Projects

| Project | Robot(s) | Interaction | Author |
|---|---|---|---|
| [Spectacles-2-Unitree](#spectacles-2-unitree) | Unitree G1 humanoid | Hand-tracked teleoperation | [TastyDucks](https://github.com/TastyDucks) |
| [spectacles-reachy-mini](#spectacles-reachy-mini) | Reachy Mini | Puppeteering + LLM assistant | [V4C38](https://github.com/V4C38) |
| [spectacles-dimensional-os](#spectacles-dimensional-os) | Unitree Go2 + G1 | Navigation + LiDAR visualization | [V4C38](https://github.com/V4C38) |

---

### Spectacles-2-Unitree

📁 [`Spectacles-2-Unitree/`](./Spectacles-2-Unitree) &nbsp;•&nbsp; 🔗 Upstream: [TastyDucks/Spectacles-Sample](https://github.com/TastyDucks/Spectacles-Sample/tree/main/Spectacles-2-Unitree) &nbsp;•&nbsp; 📝 Originally proposed as [Spectacles-Sample#5](https://github.com/Snapchat/Spectacles-Sample/pull/5)

Teleoperation of a **Unitree G1 humanoid** from Spectacles — in simulation or on real
hardware. You drive the robot's arms and hands directly with your own, and see its camera
feed streamed back into the lens.

A good reference for several Spectacles techniques at once: **hand tracking** mapped onto
an inverse-kinematics solver, **WebSockets** for low-latency robot control, **dynamic
texture creation** for the live video feed, and **world querying** for spatial awareness.

**What's inside**
- `Unitree.esproj` — the Lens Studio project
- `coordination-server/` — Python relay between the lens and the robot
- `unitree-client/` — robot-side client with a Pinocchio/CasADi IK solver for the G1
- `.devcontainer/` + `Dockerfile` — containerized build for the Python components

> Hand tracking is off by default. See the project README for the toggle.

---

### spectacles-reachy-mini

📁 [`spectacles-reachy-mini/`](./spectacles-reachy-mini) &nbsp;•&nbsp; 🔗 Upstream: [V4C38/spectacles-reachy-mini](https://github.com/V4C38/spectacles-reachy-mini) &nbsp;•&nbsp; 🎬 [Demo video](https://youtu.be/o7Qg9_Oi4b0)

Control a [**Reachy Mini**](https://huggingface.co/spaces/pollen-robotics/Reachy_Mini)
desktop robot from Spectacles in two distinct modes:

- **Puppeteer Mode** — you grab a floating target in AR and the robot continuously looks
  at it. Direct, physical, immediate.
- **Assistant Mode** — you talk to an LLM agent (ChatGPT) that has custom tools wired up
  to actually move the robot.

The contrast between the two is the interesting part: the same hardware feels like a
different machine depending on whether a human or a model is holding the controls. Most
logic lives in the lens rather than in Python, which makes it approachable for Lens Studio
developers who don't want to fight firmware.

**What's inside**
- `lens-studio/` — the spatial UI, interaction logic, and state machine
- `reachy-mini-app/` — Python app exposing an extended robot API over WebSocket

> No robot? There's a **simulation mode** — pick "I have no Reachy Mini" in the setup wizard.

---

### spectacles-dimensional-os

📁 [`spectacles-dimensional-os/`](./spectacles-dimensional-os) &nbsp;•&nbsp; 🔗 Upstream: [V4C38/spectacles-dimensional-os](https://github.com/V4C38/spectacles-dimensional-os)

**AR as an interface for robot navigation and sensor data.** Drive a **Unitree Go2**
quadruped or **G1** humanoid and see its world model — including streamed **LiDAR** — laid
over your own, through the Spectacles 2024 developer kit.

The physical stack (navigation, sensor streaming) is handled by
[**Dimensional OS**](https://github.com/dimensionalOS/dimos), so the project can focus on
the interface question: what does a robot's intent look like when you can see it in space?
It also digs into **pose drift** — keeping the AR frame and the robot frame agreeing over
time, which is the unglamorous problem that decides whether any of this feels real.

**What's inside**
- `lens-studio/` — the Spectacles AR interface
- `dimos-ar/` — Python bridge to Dimensional OS
- `launcher/` — startup tooling
- `assets/` — demo media and reference material

---

## Getting Started

**These projects use [Git LFS](https://git-lfs.com/)** for 3D assets, textures, meshes, and
demo media. Install it *before* cloning, or the large files will arrive as text pointers
instead of real content:

```bash
git lfs install
git clone https://github.com/agrancini-sc/specs-robots-1fficialAR.git
```

Already cloned without it? Recover with:

```bash
git lfs install && git lfs pull
```

Then open the project you want:

- **Lens side** — open the `.esproj` (or the `lens-studio/` folder) in
  [Lens Studio](https://ar.snap.com/lens-studio), then push to your Spectacles.
- **Robot side** — follow that project's own README for the Python app, container, or
  bridge. Each project's setup steps are authoritative; this file only points you at them.

> Each project has its own README with detailed setup, architecture notes, and
> customization guides. Start there.

## Contributors

All credit for this work belongs to its original authors. This repo aggregates; it does not
claim authorship.

**Spectacles-2-Unitree** — © 2025 Patrick Rose, Vincent Trastour, Arthur Baney, and
Alessio Grancini. Committed and submitted upstream by
[**@TastyDucks**](https://github.com/TastyDucks). Includes Python, STL, and URDF files
derived from [Unitree's `avp_teleoperate`](https://github.com/unitreerobotics/avp_teleoperate)
(Apache 2.0) — see the project's
[`ATTRIBUTION.md`](./Spectacles-2-Unitree/ATTRIBUTION.md) for the full third-party list.

**spectacles-reachy-mini** — © 2026 [**@V4C38**](https://github.com/V4C38).

**spectacles-dimensional-os** — © 2026 [**@V4C38**](https://github.com/V4C38) and the
`spectacles-dimensional-os` contributors. Built on
[Dimensional OS](https://github.com/dimensionalOS/dimos).

Robot platforms referenced here are products of
[Unitree Robotics](https://www.unitree.com/) and
[Pollen Robotics](https://www.pollen-robotics.com/), and are trademarks of their respective
owners.

## Licenses

Every project in this repo is **MIT licensed**, and each folder keeps its own `LICENSE`
file with the original copyright notice intact:

| Project | License |
|---|---|
| [Spectacles-2-Unitree](./Spectacles-2-Unitree/LICENSE) | MIT |
| [spectacles-reachy-mini](./spectacles-reachy-mini/LICENSE) | MIT |
| [spectacles-dimensional-os](./spectacles-dimensional-os/LICENSE) | MIT |

Third-party components retain their own licenses (Apache 2.0, BSD, LGPL v3, and others) as
documented within each project.

## Contributing

Know of a Spectacles robotics project that belongs here? Open an issue with a link. If it's
your own project and you'd rather it **not** be mirrored, open an issue and it will be
removed.

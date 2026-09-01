#!/usr/bin/env python3
"""
setup_simulator.py
Automated setup script for Pollen Robotics Micro Duck Simulator with Snap Spectacles integration.

This script:
1. Clones the official Micro Duck simulator from Hugging Face:
   https://huggingface.co/spaces/pollen-robotics/microduck-simulator
2. Injects the Spectacles Controller Source (spectacles.js).
3. Registers SpectaclesSource into the simulator game engine (game.js).
4. Runs npm install so you are ready to launch!
"""

import os
import sys
import subprocess
import shutil
import re

REPO_URL = "https://huggingface.co/spaces/pollen-robotics/microduck-simulator"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
TARGET_DIR = os.path.join(PROJECT_ROOT, "microduck-simulator")
APP_DIR = os.path.join(TARGET_DIR, "app")
SRC_DIR = os.path.join(APP_DIR, "src", "game")
CONTROLS_DIR = os.path.join(SRC_DIR, "controls")

def log(msg):
    print(f"\033[1;33m[Setup]\033[0m {msg}")

def success(msg):
    print(f"\033[1;32m[✓]\033[0m {msg}")

def error(msg):
    print(f"\033[1;31m[✗]\033[0m {msg}")
    sys.exit(1)

def main():
    print("=" * 65)
    print("🐤  MICRO DUCK × SNAP SPECTACLES SIMULATOR INTEGRATION SETUP")
    print("=" * 65)

    # 1. Clone repository
    if os.path.exists(TARGET_DIR):
        log(f"Found existing simulator directory at: {TARGET_DIR}")
    else:
        log(f"Cloning Micro Duck Simulator from {REPO_URL}...")
        try:
            subprocess.run(["git", "clone", REPO_URL, TARGET_DIR], check=True)
            success("Simulator cloned successfully!")
        except Exception as e:
            error(f"Failed to clone simulator repository: {e}")

    # 2. Copy spectacles.js controller
    src_spectacles = os.path.join(SCRIPT_DIR, "spectacles.js")
    dst_spectacles = os.path.join(CONTROLS_DIR, "spectacles.js")

    if not os.path.exists(src_spectacles):
        error(f"Missing {src_spectacles}. Ensure spectacles.js is present.")

    os.makedirs(CONTROLS_DIR, exist_ok=True)
    shutil.copyfile(src_spectacles, dst_spectacles)
    success(f"Installed Spectacles controller source -> {dst_spectacles}")

    # 3. Patch game.js
    game_js_path = os.path.join(SRC_DIR, "game.js")
    if os.path.exists(game_js_path):
        with open(game_js_path, "r", encoding="utf-8") as f:
            content = f.read()

        # Add import if missing
        if "SpectaclesSource" not in content:
            import_stmt = 'import { SpectaclesSource } from "./controls/spectacles.js";\n'
            content = import_stmt + content
            log("Added SpectaclesSource import to game.js")

        # Register in controller sources
        if "specsSource" not in content and "new Controller" in content:
            # Look for sources: [padSource, touchSource, kbSource]
            content = re.sub(
                r"sources:\s*\[([^\]]+)\]",
                r"sources: [\1, new SpectaclesSource({ getVelocityLimits: () => model.getVelocityLimits() })]",
                content
            )
            log("Registered SpectaclesSource in Controller sources array")

        with open(game_js_path, "w", encoding="utf-8") as f:
            f.write(content)
        success("Patched game.js for real-time Spectacles streaming!")
    else:
        error(f"game.js not found at {game_js_path}")

    # 4. Run npm install
    log("Installing simulator npm dependencies...")
    try:
        subprocess.run(["npm", "install"], cwd=APP_DIR, check=True)
        success("NPM dependencies installed successfully!")
    except Exception as e:
        print(f"Warning: npm install returned {e}. You may need to run 'npm install' inside {APP_DIR} manually.")

    print("\n" + "=" * 65)
    success("Setup complete! You can now run:")
    print(f"  1. Start Bridge:    python3 bridge.py --port 8765")
    print(f"  2. Start Simulator: cd \"{APP_DIR}\" && npm run dev")
    print(f"  3. Open Lens:       Open Lens Studio and push to Spectacles!")
    print("=" * 65)

if __name__ == "__main__":
    main()

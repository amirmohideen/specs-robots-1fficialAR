// Spectacles input source for Micro Duck Simulator.
// Implements the Controller source contract (see controller.js).
// Receives spatial hand gesture packets from Snap Spectacles (or bridge relay)
// over WebSocket at ~30-50 Hz, or via BroadcastChannel / direct URL parameter.

const SPECTACLES_ALPHA = 0.22; // EMA smoothing factor for velocity commands
const SPECTACLES_TIMEOUT_S = 1.2; // Release authority if no packets arrived within timeout

export class SpectaclesSource {
  id = "spectacles";
  connected = false;
  command = new Float32Array(3); // [vx, 0, wz], EMA smoothed
  axes = { jaw: 0, orbitX: 0, orbitY: 0, ride: 0 };
  pressed = { handTracked: false, quack: false, kick: false, roll: false };
  onAction = () => {}; // Assigned by Controller at registration

  #getVelocityLimits;
  #active = false;
  #target = [0, 0]; // [vx, wz]
  #targetJaw = 0;
  #lastPacketTime = 0;
  #ws = null;
  #wsUrl = "ws://192.168.29.46:8765";
  #reconnectTimer = null;
  #broadcastChannel = null;
  #disposed = false;

  constructor({ getVelocityLimits, wsUrl } = {}) {
    this.#getVelocityLimits = getVelocityLimits;
    if (wsUrl) {
      this.#wsUrl = wsUrl;
    } else if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const customWs = params.get("specs_ws") || params.get("ws");
      if (customWs) {
        this.#wsUrl = customWs;
      } else {
        const host = window.location.hostname || "192.168.29.46";
        this.#wsUrl = `ws://${host === "localhost" ? "192.168.29.46" : host}:8765`;
      }
    }
  }

  init() {
    this.#disposed = false;
    this.#connectWebSocket();
    this.#initBroadcastChannel();
  }

  dispose() {
    this.#disposed = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#ws) {
      try {
        this.#ws.close();
      } catch (e) {}
      this.#ws = null;
    }
    if (this.#broadcastChannel) {
      try {
        this.#broadcastChannel.close();
      } catch (e) {}
      this.#broadcastChannel = null;
    }
    this.connected = false;
    this.#active = false;
  }

  #initBroadcastChannel() {
    if (typeof window === "undefined" || !("BroadcastChannel" in window)) return;
    try {
      this.#broadcastChannel = new BroadcastChannel("microduck_spectacles");
      this.#broadcastChannel.onmessage = (event) => {
        if (event.data) {
          this.#handlePacket(event.data);
        }
      };
    } catch (e) {}
  }

  #connectWebSocket() {
    if (this.#disposed || typeof window === "undefined") return;

    try {
      const ws = new WebSocket(this.#wsUrl);
      this.#ws = ws;

      ws.onopen = () => {
        if (this.#ws !== ws) return;
        this.connected = true;
        console.log(`[SpectaclesSource] Connected to bridge at ${this.#wsUrl}`);
      };

      ws.onmessage = (event) => {
        if (this.#ws !== ws) return;
        try {
          const data = JSON.parse(event.data);
          this.#handlePacket(data);
        } catch (e) {}
      };

      ws.onerror = () => {
        // Will trigger onclose and schedule retry
      };

      ws.onclose = () => {
        if (this.#ws === ws) {
          this.connected = false;
          this.#ws = null;
          this.#active = false;
          if (!this.#disposed) {
            this.#reconnectTimer = setTimeout(() => this.#connectWebSocket(), 2000);
          }
        }
      };
    } catch (e) {
      if (!this.#disposed) {
        this.#reconnectTimer = setTimeout(() => this.#connectWebSocket(), 3000);
      }
    }
  }

  #handlePacket(data) {
    if (!data) return;

    // Pong response
    if (data.type === "ping" && this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      return;
    }

    if (data.type === "control" || typeof data.vx === "number") {
      const now = performance.now() / 1000;
      this.#lastPacketTime = now;
      this.connected = true;

      // Extract velocities and jaw
      const rawVx = data.vx ?? 0;
      const rawWz = data.wz ?? 0;
      const rawJaw = data.jaw ?? 0;

      const [limFwd, limBack, limAng] = this.#getVelocityLimits
        ? this.#getVelocityLimits()
        : [0.5, 0.25, 1.0];

      // Clamp target to current robot locomotion limits
      const clampedVx = rawVx > 0 ? Math.min(rawVx, limFwd) : Math.max(rawVx, -limBack);
      const clampedWz = Math.max(-limAng, Math.min(limAng, rawWz));

      this.#target = [clampedVx, clampedWz];
      this.#targetJaw = Math.max(0, Math.min(1, rawJaw));

      const isDriving = Math.abs(clampedVx) > 0.01 || Math.abs(clampedWz) > 0.02 || rawJaw > 0.05;
      this.#active = isDriving;
      this.pressed.handTracked = true;

      // Handle edge-triggered actions
      if (data.action) {
        this.onAction(data.action, { source: this.id, hand: data.hand, gesture: data.gesture });
        if (data.action === "quack") this.pressed.quack = true;
        if (data.action.startsWith("kick")) this.pressed.kick = true;
        if (data.action === "roll") this.pressed.roll = true;
      }
    }
  }

  isActive() {
    return this.#active;
  }

  poll(dt) {
    const now = performance.now() / 1000;

    // Timeout release if stream stops
    if (this.#lastPacketTime > 0 && now - this.#lastPacketTime > SPECTACLES_TIMEOUT_S) {
      this.#target = [0, 0];
      this.#targetJaw = 0;
      this.pressed.handTracked = false;
    }

    // Dynamic adaptive EMA smoothing toward target command
    const rate = dt > 0 ? dt : 0.02;
    const alpha = Math.min(1.0, rate * 18.0);
    
    // Smooth forward/backward velocity with acceleration limiting (prevents tipping)
    const diffVx = this.#target[0] - this.command[0];
    const maxDeltaVx = 1.8 * rate; // Max 1.8 m/s^2 accel
    const clampedDeltaVx = Math.max(-maxDeltaVx, Math.min(maxDeltaVx, diffVx * alpha));
    this.command[0] += clampedDeltaVx;
    this.command[1] = 0; // vy stays zero

    // Smooth turning rate
    const diffWz = this.#target[1] - this.command[2];
    const maxDeltaWz = 4.5 * rate; // Max 4.5 rad/s^2 angular accel
    const clampedDeltaWz = Math.max(-maxDeltaWz, Math.min(maxDeltaWz, diffWz * alpha));
    this.command[2] += clampedDeltaWz;

    // Auxiliary axes (analog jaw opening for beak)
    this.axes.jaw += (this.#targetJaw - this.axes.jaw) * alpha;

    // Decay active flag once settled
    const speedSq = this.command[0] * this.command[0] + this.command[2] * this.command[2];
    if (speedSq < 0.0001 && this.axes.jaw < 0.01 && now - this.#lastPacketTime > 0.5) {
      this.command[0] = 0;
      this.command[2] = 0;
      this.axes.jaw = 0;
      this.#active = false;
      this.pressed.quack = false;
      this.pressed.kick = false;
      this.pressed.roll = false;
    }
  }
}

/**
 * MicroDuckSpecsClient.ts
 * Manages high-frequency WebSocket networking between Snap Spectacles and the Micro Duck simulator / bridge.
 * Built for Lens Studio 5.x / Spectacles OS.
 */

export type DuckConnectionState = "disconnected" | "connecting" | "connected" | "error"

export interface DuckControlPacket {
  type: "control"
  vx: number       // Forward/backward velocity [-0.25 .. 0.5 m/s]
  vy: number       // Lateral velocity (usually 0.0)
  wz: number       // Turn rate [-1.0 .. 1.0 rad/s]
  jaw: number      // Mouth openness [0.0 .. 1.0]
  action?: string  // Edge action ("quack" | "kickL" | "kickR" | "alternateKick" | "sitToggle" | "locoToggle" | "roll" | "reset" | "spawnBall")
  source: string   // "spectacles"
  hand: "left" | "right"
  gesture?: string // Description of active gesture (e.g. "tilt", "pinch_index", "pinch_middle", "fist")
  timestamp: number
}

@component
export class MicroDuckSpecsClient extends BaseScriptComponent {
  @ui.label('<span style="color: #FACC15; font-weight: bold;">Micro Duck Specs Bridge Client</span><br/><span style="color: #94A3B8; font-size: 11px;">WebSocket transport to Micro Duck Simulator</span>')
  @ui.separator

  @input
  @hint("Bridge/Simulator IP address (e.g. 192.168.29.46 or 127.0.0.1 for editor testing)")
  bridgeHost: string = "192.168.29.46"

  @input
  @hint("Bridge/Simulator WebSocket port (default 8765 or 8080)")
  bridgePort: number = 8765

  @input
  @hint("Use secure WebSocket (wss://) when connecting to hosted endpoints")
  useSecureWebSocket: boolean = false

  @input
  @hint("Automatically connect on lens startup")
  autoConnect: boolean = true

  @input
  @hint("Enable debug logging to Studio / Spectacles console")
  enableLogging: boolean = true

  @input
  @hint("Auto-reconnect delay in seconds upon disconnection")
  reconnectDelaySeconds: number = 2.0

  @input
  @hint("Packet streaming rate in Hz (default 30 Hz)")
  streamRateHz: number = 30.0

  private internetModule: InternetModule = require("LensStudio:InternetModule")
  private socket: WebSocket | null = null
  private connectionState: DuckConnectionState = "disconnected"
  private reconnectTimer: number = 0
  private sentCount: number = 0
  private droppedCount: number = 0
  private lastPingTime: number = 0
  private latencyMs: number = 0
  private lastSendTime: number = 0

  // Event callbacks
  public onStateChanged: ((state: DuckConnectionState) => void)[] = []
  public onMessageReceived: ((data: any) => void)[] = []

  onAwake(): void {
    if (this.autoConnect) {
      this.connect()
    }
    this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this))
  }

  onDestroy(): void {
    this.disconnect()
  }

  public connect(): void {
    if (this.socket !== null) {
      this.disconnect()
    }

    let host = this.bridgeHost.trim()
    if (host.startsWith("ws://")) host = host.substring("ws://".length)
    if (host.startsWith("wss://")) host = host.substring("wss://".length)
    if (host.endsWith("/")) host = host.substring(0, host.length - 1)

    const proto = this.useSecureWebSocket ? "wss://" : "ws://"
    const url = host.indexOf(":") >= 0 ? `${proto}${host}` : `${proto}${host}:${this.bridgePort}`
    this.log(`Connecting to Micro Duck Bridge at ${url}...`)
    this.setState("connecting")

    try {
      this.socket = this.internetModule.createWebSocket(url)

      this.socket.onopen = () => {
        this.log(`Connected to Micro Duck at ${url}`)
        this.setState("connected")
        this.ping()
      }

      this.socket.onmessage = (event: any) => {
        try {
          const text = typeof event.data === "string" ? event.data : ""
          if (text) {
            const json = JSON.parse(text)
            if (this.lastPingTime > 0 && json.type === "pong") {
              this.latencyMs = Math.round((getTime() - this.lastPingTime) * 1000)
              this.lastPingTime = 0
            }
            for (const cb of this.onMessageReceived) {
              cb(json)
            }
          }
        } catch (e) {
          // JSON parsing error
        }
      }

      this.socket.onerror = (err: any) => {
        this.log(`WebSocket error: ${err}`)
        this.setState("error")
      }

      this.socket.onclose = (event: any) => {
        this.log(`WebSocket closed (code=${event ? event.code : "N/A"})`)
        this.socket = null
        this.setState("disconnected")
        this.scheduleReconnect()
      }
    } catch (err) {
      this.log(`Failed to initiate WebSocket connection: ${err}`)
      this.socket = null
      this.setState("error")
      this.scheduleReconnect()
    }
  }

  public disconnect(): void {
    if (this.socket !== null) {
      try {
        this.socket.close()
      } catch (e) {}
      this.socket = null
    }
    this.setState("disconnected")
  }

  public sendControl(
    vx: number,
    vy: number,
    wz: number,
    jaw: number = 0,
    action?: string,
    hand: "left" | "right" = "right",
    gesture?: string
  ): boolean {
    const now = getTime()
    const interval = 1.0 / this.streamRateHz

    // Always allow immediate dispatch for edge actions; rate limit continuous stick data
    if (!action && now - this.lastSendTime < interval) {
      return false
    }

    if (!this.isConnected()) {
      this.droppedCount++
      return false
    }

    const payload: DuckControlPacket = {
      type: "control",
      vx: Number(vx.toFixed(4)),
      vy: Number(vy.toFixed(4)),
      wz: Number(wz.toFixed(4)),
      jaw: Number(jaw.toFixed(3)),
      action: action,
      source: "spectacles",
      hand: hand,
      gesture: gesture,
      timestamp: Date.now()
    }

    const sent = this.sendRaw(payload)
    if (sent) {
      this.lastSendTime = now
    }
    return sent
  }

  public sendAction(action: string, hand: "left" | "right" = "right", gesture?: string): boolean {
    return this.sendControl(0, 0, 0, 0, action, hand, gesture)
  }

  public ping(): boolean {
    if (!this.isConnected()) return false
    this.lastPingTime = getTime()
    return this.sendRaw({ type: "ping", timestamp: Date.now() })
  }

  private sendRaw(data: any): boolean {
    if (this.socket === null || this.connectionState !== "connected") {
      return false
    }
    try {
      const serialized = JSON.stringify(data)
      this.socket.send(serialized)
      this.sentCount++
      return true
    } catch (err) {
      this.log(`Send error: ${err}`)
      return false
    }
  }

  private scheduleReconnect(): void {
    if (this.autoConnect && this.connectionState !== "connected") {
      this.reconnectTimer = getTime() + this.reconnectDelaySeconds
    }
  }

  private onUpdate(): void {
    if (
      this.autoConnect &&
      this.connectionState !== "connected" &&
      this.connectionState !== "connecting" &&
      this.reconnectTimer > 0 &&
      getTime() >= this.reconnectTimer
    ) {
      this.reconnectTimer = 0
      this.log("Attempting automatic reconnection...")
      this.connect()
    }
  }

  private setState(newState: DuckConnectionState): void {
    if (this.connectionState !== newState) {
      this.connectionState = newState
      for (const cb of this.onStateChanged) {
        cb(newState)
      }
    }
  }

  public isConnected(): boolean {
    return this.connectionState === "connected" && this.socket !== null
  }

  public getConnectionState(): DuckConnectionState {
    return this.connectionState
  }

  public getStats() {
    return {
      sent: this.sentCount,
      dropped: this.droppedCount,
      latencyMs: this.latencyMs,
      endpoint: `${this.bridgeHost}:${this.bridgePort}`
    }
  }

  private log(msg: string): void {
    if (this.enableLogging) {
      print(`[MicroDuckSpecsClient] ${msg}`)
    }
  }
}

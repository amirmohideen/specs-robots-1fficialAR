/**
 * MicroDuckHUD.ts
 * AR Heads-Up Display and Spatial UI for Snap Spectacles.
 * Shows live telemetry, gesture feedback, connection state, and control hints.
 */

import { MicroDuckSpecsClient, DuckConnectionState } from "./MicroDuckSpecsClient"
import { MicroDuckGestureController } from "./MicroDuckGestureController"

@component
export class MicroDuckHUD extends BaseScriptComponent {
  @ui.label('<span style="color: #FACC15; font-weight: bold;">Micro Duck AR HUD</span><br/><span style="color: #94A3B8; font-size: 11px;">Spatial UI overlay for Spectacles with real-time telemetry</span>')
  @ui.separator

  @input
  @hint("Reference to the MicroDuckGestureController")
  gestureController: MicroDuckGestureController | null = null

  @input
  @hint("Reference to the MicroDuckSpecsClient")
  bridgeClient: MicroDuckSpecsClient | null = null

  @input
  @hint("Text component for main telemetry readout (Speed / Turn / Gesture)")
  statusText: Text | null = null

  @input
  @hint("Text component for connection status badge")
  connectionText: Text | null = null

  @input
  @hint("Text component for popup gesture announcements (Quack, Kick, etc.)")
  popupText: Text | null = null

  @input
  @hint("Text component for displaying full gesture controls guide")
  instructionText: Text | null = null

  @input
  @hint("Show the on-screen gesture controls instruction card")
  showInstructions: boolean = true

  @input
  @hint("Visual transform or cursor indicating throttle / steering direction")
  directionIndicator: SceneObject | null = null

  private popupExpiry: number = 0

  onAwake(): void {
    if (this.bridgeClient) {
      this.bridgeClient.onStateChanged.push(this.onConnectionStateChanged.bind(this))
    }

    if (this.gestureController) {
      this.gestureController.onGestureAction.push(this.onGestureActionTriggered.bind(this))
    }

    this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this))
    this.updateConnectionDisplay("disconnected")
    this.updateInstructionDisplay()
  }

  private updateInstructionDisplay(): void {
    if (!this.instructionText) return
    if (!this.showInstructions) {
      this.instructionText.text = ""
      return
    }

    this.instructionText.text =
      "• Palm Down: Forward  |  • Palm Up: Reverse\n" +
      "• Roll Hand: Steer  |  • Level Hand: Stop\n" +
      "• Index Pinch: Quack  |  • Middle Pinch: Kick\n" +
      "• Ring Pinch: Roll  |  • Double Pinch: Mode"
  }

  private onConnectionStateChanged(state: DuckConnectionState): void {
    this.updateConnectionDisplay(state)
  }

  private updateConnectionDisplay(state: DuckConnectionState): void {
    if (!this.connectionText) return

    switch (state) {
      case "connected":
        this.connectionText.text = "● SIM CONNECTED"
        break
      case "connecting":
        this.connectionText.text = "◌ CONNECTING..."
        break
      case "error":
        this.connectionText.text = "▲ CONNECTION ERROR"
        break
      case "disconnected":
      default:
        this.connectionText.text = "○ DISCONNECTED"
        break
    }
  }

  private onGestureActionTriggered(action: string, gestureName: string): void {
    if (!this.popupText) return

    let emoji = "✨"
    if (action === "quack") emoji = "🐤 QUACK!"
    else if (action === "kickL" || action === "kickR" || action === "alternateKick") emoji = "⚽ KICK!"
    else if (action === "roll") emoji = "🔄 ROLL!"
    else if (action === "sitToggle") emoji = "🪑 SIT/STAND"
    else if (action === "locoToggle") emoji = "🛼 MODE SWITCH"
    else if (action === "reset") emoji = "🔁 RESET"

    this.popupText.text = `${emoji} (${gestureName})`
    this.popupExpiry = getTime() + 1.6
  }

  private onUpdate(): void {
    const now = getTime()

    // Handle popup fadeout
    if (this.popupText && now > this.popupExpiry && this.popupText.text !== "") {
      this.popupText.text = ""
    }

    if (!this.gestureController || !this.statusText) return

    const state = this.gestureController.currentState
    const stats = this.bridgeClient ? this.bridgeClient.getStats() : null

    if (!state.isHandTracked) {
      this.statusText.text = "Raise hand to steer Micro Duck 🐤\nTilt palm to move, pinch to quack/kick"
      return
    }

    const vxFormatted = (state.vx >= 0 ? "+" : "") + state.vx.toFixed(2)
    const wzFormatted = (state.wz >= 0 ? "+" : "") + state.wz.toFixed(2)
    const pingFormatted = stats && stats.latencyMs > 0 ? `${stats.latencyMs}ms` : "--"

    let tiltLabel = "LEVEL ⏹️"
    if (state.pitchDeg < -6.0) tiltLabel = "FORWARD 🏃"
    else if (state.pitchDeg > 6.0) tiltLabel = "REVERSE 🔙"

    let rollLabel = "CENTER"
    if (state.rollDeg > 8.0) rollLabel = "RIGHT ➡️"
    else if (state.rollDeg < -8.0) rollLabel = "LEFT ⬅️"

    this.statusText.text =
      `[MICRO DUCK TELEMETRY]\n` +
      `Tilt (Pitch): ${state.pitchDeg.toFixed(1)}° [${tiltLabel}]  |  Roll: ${state.rollDeg.toFixed(1)}° [${rollLabel}]\n` +
      `Speed: ${vxFormatted} m/s  |  Turn: ${wzFormatted} rad/s\n` +
      `Gesture: ${state.activeGestureName}  |  Jaw: ${(state.jaw * 100).toFixed(0)}%  |  Ping: ${pingFormatted}`

    // Update visual direction pointer
    if (this.directionIndicator) {
      const transform = this.directionIndicator.getTransform()
      const posX = state.wz * 15.0 // Horizontal offset based on turn rate
      const posY = state.vx * 20.0 // Vertical offset based on throttle
      transform.setLocalPosition(new vec3(posX, posY, 0))
    }
  }
}

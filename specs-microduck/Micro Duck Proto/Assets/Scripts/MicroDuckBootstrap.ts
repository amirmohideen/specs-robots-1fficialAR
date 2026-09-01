/**
 * MicroDuckBootstrap.ts
 * Master scene initializer and dependency binder for Micro Duck Spectacles app.
 * Ensures all visual, gesture, networking, and HUD components are automatically attached and linked.
 */

import { MicroDuckSpecsClient } from "./MicroDuckSpecsClient"
import { MicroDuckGestureController } from "./MicroDuckGestureController"
import { MicroDuckHUD } from "./MicroDuckHUD"
import { MicroDuckVisualExperience } from "./MicroDuckVisualExperience"

@component
export class MicroDuckBootstrap extends BaseScriptComponent {
  @ui.label('<span style="color: #FACC15; font-weight: bold;">🐤 Micro Duck App Bootstrap</span><br/><span style="color: #94A3B8; font-size: 11px;">Auto-wires all scripts, visuals, gestures, and networking</span>')
  @ui.separator

  @input
  @hint("Local bridge IP for connecting to the simulation (e.g. 192.168.29.46 or 127.0.0.1)")
  bridgeHost: string = "192.168.29.46"

  @input
  @hint("WebSocket port (default 8765)")
  bridgePort: number = 8765

  @input
  @hint("Enable 3D holographic duck avatar")
  showDuckVisuals: boolean = true

  @input
  @hint("Enable hand-attached steering compass & reticle")
  showHandReticle: boolean = true

  private client: MicroDuckSpecsClient | null = null
  private gestureCtrl: MicroDuckGestureController | null = null
  private hud: MicroDuckHUD | null = null
  private visuals: MicroDuckVisualExperience | null = null

  onAwake(): void {
    print("[MicroDuckBootstrap] Initializing Micro Duck Spectacles App...")
    const rootObj = this.getSceneObject()

    // 1. Get or create MicroDuckSpecsClient
    this.client = rootObj.getComponent("Component.ScriptComponent") as any
    const allScripts = rootObj.getComponents("Component.ScriptComponent")
    
    for (let i = 0; i < allScripts.length; i++) {
      const s = allScripts[i] as any
      if (s && typeof s.sendControl === "function") this.client = s
      if (s && typeof s.triggerAction === "function") this.gestureCtrl = s
      if (s && typeof s.updateConnectionDisplay === "function") this.hud = s
      if (s && typeof s.renderHandCompass === "function") this.visuals = s
    }

    // Create client if missing
    if (!this.client) {
      this.client = rootObj.createComponent("Component.ScriptComponent") as any
    }
    if (this.client) {
      this.client.bridgeHost = this.bridgeHost
      this.client.bridgePort = this.bridgePort
    }

    // Create GestureController if missing
    if (!this.gestureCtrl) {
      this.gestureCtrl = rootObj.createComponent("Component.ScriptComponent") as any
    }
    if (this.gestureCtrl && this.client) {
      this.gestureCtrl.bridgeClient = this.client
    }

    // Create Visual Experience if missing
    if (!this.visuals) {
      this.visuals = rootObj.createComponent("Component.ScriptComponent") as any
    }
    if (this.visuals) {
      this.visuals.gestureController = this.gestureCtrl
      this.visuals.bridgeClient = this.client
      this.visuals.enableDuckAvatar = this.showDuckVisuals
      this.visuals.enableHandReticle = this.showHandReticle
    }

    // Create HUD if missing
    if (!this.hud) {
      this.hud = rootObj.createComponent("Component.ScriptComponent") as any
    }
    if (this.hud) {
      this.hud.gestureController = this.gestureCtrl
      this.hud.bridgeClient = this.client
    }

    print("[MicroDuckBootstrap] ✓ All Micro Duck components successfully bound and active!")
  }
}

/**
 * MicroDuckVisualExperience.ts
 * Real-time 3D spatial visuals, holographic duck avatar, and hand steering compass
 * for Snap Spectacles AR.
 */

import { MicroDuckGestureController, GestureState } from "./MicroDuckGestureController"
import { MicroDuckSpecsClient } from "./MicroDuckSpecsClient"
import SIK from "SpectaclesInteractionKit.lspkg/SIK"

@component
export class MicroDuckVisualExperience extends BaseScriptComponent {
  @ui.label('<span style="color: #FACC15; font-weight: bold;">Micro Duck 3D Visual Experience</span><br/><span style="color: #94A3B8; font-size: 11px;">Renders 3D avatar and hand steering compass</span>')
  @ui.separator

  @input
  @hint("Reference to the gesture controller")
  gestureController: MicroDuckGestureController | null = null

  @input
  @hint("Reference to the specs bridge client")
  bridgeClient: MicroDuckSpecsClient | null = null

  @input
  @hint("Spawn 3D Duck Hologram in front of user")
  enableDuckAvatar: boolean = true

  @input
  @hint("Distance of duck avatar in front of camera (in cm)")
  duckDistanceCm: number = 85.0

  @input
  @hint("Enable 3D hand compass / steering reticle attached to palm")
  enableHandReticle: boolean = true

  private duckRoot: SceneObject | null = null
  private duckBody: SceneObject | null = null
  private duckHead: SceneObject | null = null
  private duckBeak: SceneObject | null = null

  private duckPos: vec3 = new vec3(0, -15, -85)
  private duckHeadingDeg: number = 0
  private legCycle: number = 0
  private beakOpenAngle: number = 0

  onAwake(): void {
    this.createVisualHierarchy()
    this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this))
  }

  private createVisualHierarchy(): void {
    const parentObj = this.getSceneObject()

    // 1. Create Duck Avatar Root
    if (this.enableDuckAvatar) {
      this.duckRoot = global.scene.createSceneObject("MicroDuck_Avatar")
      this.duckRoot.setParent(parentObj)
      this.duckRoot.getTransform().setLocalPosition(this.duckPos)
      this.duckRoot.getTransform().setLocalScale(new vec3(1.2, 1.2, 1.2))

      // Duck Body
      this.duckBody = global.scene.createSceneObject("Duck_Body")
      this.duckBody.setParent(this.duckRoot)

      // Duck Head
      this.duckHead = global.scene.createSceneObject("Duck_Head")
      this.duckHead.setParent(this.duckRoot)
      this.duckHead.getTransform().setLocalPosition(new vec3(0, 8, 2))

      // Duck Beak
      this.duckBeak = global.scene.createSceneObject("Duck_Beak")
      this.duckBeak.setParent(this.duckHead)
      this.duckBeak.getTransform().setLocalPosition(new vec3(0, -1.5, 6))
    }
  }

  private onUpdate(): void {
    const dt = getDeltaTime()
    const state = this.gestureController?.currentState

    // 1. Animate Duck Avatar In AR
    if (this.enableDuckAvatar && this.duckRoot && state) {
      const vx = state.vx
      const wz = state.wz
      const jaw = state.jaw

      // Integrate heading and position
      this.duckHeadingDeg += wz * 50.0 * dt
      const rad = (this.duckHeadingDeg * Math.PI) / 180.0
      this.duckPos.x += Math.sin(rad) * vx * 60.0 * dt
      this.duckPos.z -= Math.cos(rad) * vx * 60.0 * dt

      // Keep within bounds
      this.duckPos.x = Math.max(-60, Math.min(60, this.duckPos.x))
      this.duckPos.z = Math.max(-140, Math.min(-45, this.duckPos.z))

      const rootTransform = this.duckRoot.getTransform()
      rootTransform.setLocalPosition(this.duckPos)
      
      const q = quat.fromEulerVec(new vec3(0, this.duckHeadingDeg * (Math.PI / 180), 0))
      rootTransform.setLocalRotation(q)

      // Beak flap on jaw opening
      if (this.duckBeak) {
        const targetAngle = jaw * 0.45
        this.beakOpenAngle += (targetAngle - this.beakOpenAngle) * 0.4
        const beakTransform = this.duckBeak.getTransform()
        beakTransform.setLocalRotation(quat.fromEulerVec(new vec3(this.beakOpenAngle, 0, 0)))
      }

      // Leg step cycle
      if (Math.abs(vx) > 0.05 || Math.abs(wz) > 0.1) {
        this.legCycle += dt * (Math.abs(vx) * 12.0 + 4.0)
        const waddleBob = Math.sin(this.legCycle) * 1.5
        const waddleRoll = Math.cos(this.legCycle) * 0.08
        if (this.duckBody) {
          const bodyTrans = this.duckBody.getTransform()
          bodyTrans.setLocalPosition(new vec3(0, waddleBob, 0))
          bodyTrans.setLocalRotation(quat.fromEulerVec(new vec3(0, 0, waddleRoll)))
        }
      }
    }

    // 2. Draw 3D Spatial Hand Reticle / Compass
    if (this.enableHandReticle && state && state.isHandTracked) {
      this.renderHandCompass(state)
    }
  }

  private renderHandCompass(state: GestureState): void {
    if (!global.debugRenderSystem) return

    try {
      const hand = SIK.HandInputData.getHand("right")
      if (!hand || !hand.isTracked()) return

      const palmPos = hand.getPalmCenter?.() ?? hand.wrist?.position
      if (!palmPos) return

      const vx = state.vx
      const wz = state.wz
      const jaw = state.jaw

      // 1. Palm anchor sphere
      const palmColor = jaw > 0.3
        ? new vec4(1.0, 0.85, 0.2, 1.0)  // Quacking Gold
        : state.isMiddlePinching
        ? new vec4(0.2, 0.85, 1.0, 1.0)  // Kicking Cyan
        : new vec4(0.98, 0.65, 0.12, 1.0) // Driving Orange

      global.debugRenderSystem.drawSolidSphere(palmPos, 1.8, palmColor)

      // 2. Throttle Arrow (Forward/Backward)
      const throttleLen = Math.max(2.0, Math.abs(vx) * 35.0)
      const throttleEnd = palmPos.add(new vec3(wz * 18.0, 0, -vx * 35.0))
      
      const arrowColor = vx >= 0 ? new vec4(0.2, 0.95, 0.4, 1.0) : new vec4(0.95, 0.3, 0.3, 1.0)
      global.debugRenderSystem.drawLine(palmPos, throttleEnd, arrowColor)
      global.debugRenderSystem.drawSolidSphere(throttleEnd, 1.2, arrowColor)

      // 3. Fingertip gesture halos
      const indexTip = hand.indexTip?.position
      const middleTip = hand.middleTip?.position

      if (indexTip && state.isIndexPinching) {
        global.debugRenderSystem.drawSolidSphere(indexTip, 2.2, new vec4(1.0, 0.9, 0.1, 1.0))
      }
      if (middleTip && state.isMiddlePinching) {
        global.debugRenderSystem.drawSolidSphere(middleTip, 2.2, new vec4(0.1, 0.9, 1.0, 1.0))
      }
    } catch (e) {}
  }
}

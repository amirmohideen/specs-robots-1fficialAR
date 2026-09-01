/**
 * MicroDuckGestureController.ts
 * Ultra-smooth, robust spatial hand tracking & gesture controller for Micro Duck.
 * Built with Spectacles Interaction Kit (SIK) for Snap Spectacles.
 */

import SIK from "SpectaclesInteractionKit.lspkg/SIK"
import { BaseHand } from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/BaseHand"
import { HandType } from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/HandType"
import { MicroDuckSpecsClient } from "./MicroDuckSpecsClient"

export interface GestureState {
  isHandTracked: boolean
  vx: number
  vy: number
  wz: number
  jaw: number
  pitchDeg: number
  rollDeg: number
  isIndexPinching: boolean
  isMiddlePinching: boolean
  isRingPinching: boolean
  isFist: boolean
  activeGestureName: string
}

@component
export class MicroDuckGestureController extends BaseScriptComponent {
  @ui.label('<span style="color: #FACC15; font-weight: bold;">Micro Duck Gesture Controller</span><br/><span style="color: #94A3B8; font-size: 11px;">Robust spatial tracking with adaptive smoothing and hysteresis</span>')
  @ui.separator

  @input
  @hint("Reference to the MicroDuckSpecsClient component")
  bridgeClient: MicroDuckSpecsClient | null = null

  @input
  @hint("Primary driving hand ('right' or 'left')")
  drivingHandType: string = "right"

  @input
  @hint("Forward pitch deadzone angle in degrees before moving")
  pitchDeadzoneDeg: number = 6.0

  @input
  @hint("Maximum forward pitch angle in degrees for full speed")
  pitchMaxDeg: number = 38.0

  @input
  @hint("Roll deadzone angle in degrees before turning")
  rollDeadzoneDeg: number = 8.0

  @input
  @hint("Maximum roll angle in degrees for full turn rate")
  rollMaxDeg: number = 42.0

  @input
  @hint("Max forward velocity in meters/second (Legs: 0.5, Rollers: 0.6)")
  maxForwardVelocity: number = 0.5

  @input
  @hint("Max backward velocity in meters/second (Legs: -0.25, Rollers: -0.3)")
  maxBackwardVelocity: number = 0.25

  @input
  @hint("Max turn rate in radians/second")
  maxTurnRate: number = 1.0

  @input
  @hint("Invert forward/backward pitch direction")
  invertPitch: boolean = false

  @input
  @hint("Invert left/right turning rotation direction")
  invertRotation: boolean = true

  @input
  @hint("Smoothing factor for velocity commands [0.1 = responsive, 0.6 = heavily smoothed]")
  smoothingAlpha: number = 0.28

  @input
  @hint("Enable editor mouse fallback for testing in Lens Studio preview")
  enableEditorFallback: boolean = true

  // Current runtime state
  private activeHand: BaseHand | null = null
  private rawPitchDeg: number = 0
  private rawRollDeg: number = 0
  private filteredPitchDeg: number = 0
  private filteredRollDeg: number = 0
  private smoothedVx: number = 0
  private smoothedWz: number = 0
  private smoothedJaw: number = 0
  
  // Hysteresis & Debounce states
  private isIndexPinchingState: boolean = false
  private isMiddlePinchingState: boolean = false
  private isRingPinchingState: boolean = false
  private lastActionTime: number = 0
  private lastLocoToggleTime: number = 0
  private isRollerMode: boolean = false

  public currentState: GestureState = {
    isHandTracked: false,
    vx: 0,
    vy: 0,
    wz: 0,
    jaw: 0,
    pitchDeg: 0,
    rollDeg: 0,
    isIndexPinching: false,
    isMiddlePinching: false,
    isRingPinching: false,
    isFist: false,
    activeGestureName: "Waiting for Hand"
  }

  // Event callbacks for UI, audio, and visual systems
  public onGestureAction: ((action: string, gestureName: string) => void)[] = []

  onAwake(): void {
    this.createEvent("UpdateEvent").bind(this.onUpdate.bind(this))
  }

  private onUpdate(): void {
    const handTypeStr = this.drivingHandType.toLowerCase() === "left" ? "left" : "right"
    let hand = SIK.HandInputData.getHand(handTypeStr as any)

    // Fallback to opposite hand if primary hand is not in view
    if (!hand || !hand.isTracked()) {
      const oppHandTypeStr = handTypeStr === "left" ? "right" : "left"
      const oppHand = SIK.HandInputData.getHand(oppHandTypeStr as any)
      if (oppHand && oppHand.isTracked()) {
        hand = oppHand
      }
    }

    if (hand && hand.isTracked()) {
      this.activeHand = hand
      this.currentState.isHandTracked = true
      this.processHandGestures(hand)
    } else if (this.enableEditorFallback && global.deviceInfoSystem?.isEditor()) {
      this.currentState.isHandTracked = true
      this.processEditorFallback()
    } else {
      this.activeHand = null
      this.currentState.isHandTracked = false

      // Smooth decay when hand exits tracking frustum
      this.smoothedVx *= 0.85
      this.smoothedWz *= 0.85
      this.smoothedJaw *= 0.75
      if (Math.abs(this.smoothedVx) < 0.005) this.smoothedVx = 0
      if (Math.abs(this.smoothedWz) < 0.005) this.smoothedWz = 0
      if (Math.abs(this.smoothedJaw) < 0.01) this.smoothedJaw = 0

      this.currentState.vx = this.smoothedVx
      this.currentState.wz = this.smoothedWz
      this.currentState.jaw = this.smoothedJaw
      this.currentState.activeGestureName = "No Hand"
    }

    // Stream continuous twist command to bridge client
    if (this.bridgeClient) {
      const handType = this.drivingHandType.toLowerCase() === "left" ? "left" : "right"
      this.bridgeClient.sendControl(
        this.currentState.vx,
        0,
        this.currentState.wz,
        this.currentState.jaw,
        undefined,
        handType,
        this.currentState.activeGestureName
      )
    }
  }

  private processHandGestures(hand: BaseHand): void {
    const now = getTime()
    const dt = Math.max(0.001, getDeltaTime())

    // 1. Multi-Fallback Robust Hand Landmarks
    const wristPos = hand.wrist?.position
    const palmCenter = hand.getPalmCenter?.() ?? wristPos
    const indexTip = hand.indexTip?.position
    const middleTip = hand.middleTip?.position
    const thumbTip = hand.thumbTip?.position
    const pinkyTip = hand.pinkyTip?.position
    const ringTip = hand.ringTip?.position

    let pitchDeg = 0
    let rollDeg = 0

    // Primary Forward Vector (Wrist / Palm -> Fingertips)
    const baseAnchor = wristPos ?? palmCenter
    const tipAnchor = middleTip ?? indexTip

    if (baseAnchor && tipAnchor) {
      const forwardVec = tipAnchor.sub(baseAnchor).normalize()
      // pitchDeg: negative = pointing down/forward, positive = pointing up/backward
      pitchDeg = Math.asin(Math.max(-1, Math.min(1, forwardVec.y))) * (180.0 / Math.PI)
    }

    // Primary Lateral Vector (Thumb -> Pinky or Middle)
    if (thumbTip && (pinkyTip || middleTip)) {
      const otherTip = pinkyTip ?? middleTip!
      const isRight = this.drivingHandType.toLowerCase() === "right"
      const sideVec = (isRight ? thumbTip.sub(otherTip) : otherTip.sub(thumbTip)).normalize()
      rollDeg = Math.asin(Math.max(-1, Math.min(1, sideVec.y))) * (180.0 / Math.PI)
    }

    // Adaptive smoothing on angles
    const angleAlpha = 0.35
    this.filteredPitchDeg += (pitchDeg - this.filteredPitchDeg) * angleAlpha
    this.filteredRollDeg += (rollDeg - this.filteredRollDeg) * angleAlpha

    this.currentState.pitchDeg = this.filteredPitchDeg
    this.currentState.rollDeg = this.filteredRollDeg

    // 2. Velocity Mapping:
    // Negative pitch (palm tilted forward/down) -> Drive FORWARD
    // Positive pitch (palm tilted backward/up) -> Reverse BACKWARD
    let targetVx = 0
    if (this.filteredPitchDeg < -this.pitchDeadzoneDeg) {
      const rawNorm = Math.min(1.0, (-this.filteredPitchDeg - this.pitchDeadzoneDeg) / (this.pitchMaxDeg - this.pitchDeadzoneDeg))
      const shapedNorm = Math.pow(rawNorm, 1.15)
      targetVx = (this.invertPitch ? -1 : 1) * shapedNorm * this.maxForwardVelocity
    } else if (this.filteredPitchDeg > this.pitchDeadzoneDeg) {
      const rawNorm = Math.min(1.0, (this.filteredPitchDeg - this.pitchDeadzoneDeg) / (this.pitchMaxDeg - this.pitchDeadzoneDeg))
      const shapedNorm = Math.pow(rawNorm, 1.15)
      targetVx = (this.invertPitch ? 1 : -1) * -shapedNorm * this.maxBackwardVelocity
    }

    // 3. Turning Rate Mapping:
    let targetWz = 0
    if (Math.abs(this.filteredRollDeg) > this.rollDeadzoneDeg) {
      const sign = this.filteredRollDeg > 0 ? 1 : -1
      const rawNorm = Math.min(1.0, (Math.abs(this.filteredRollDeg) - this.rollDeadzoneDeg) / (this.rollMaxDeg - this.rollDeadzoneDeg))
      const shapedNorm = Math.pow(rawNorm, 1.2)
      targetWz = (this.invertRotation ? 1 : -1) * sign * shapedNorm * this.maxTurnRate
    }

    // Smooth continuous velocity outputs using dynamic EMA
    const vAlpha = 1.0 - this.smoothingAlpha
    this.smoothedVx += (targetVx - this.smoothedVx) * vAlpha
    this.smoothedWz += (targetWz - this.smoothedWz) * vAlpha
    this.currentState.vx = this.smoothedVx
    this.currentState.wz = this.smoothedWz

    // 4. Pinch Detection with Dual-Threshold Schmitt Trigger Hysteresis
    const pinchStrength = hand.getPinchStrength() ?? (hand.isPinching() ? 1.0 : 0.0)
    
    // Index Pinch (Quack): enter at 0.78, exit below 0.35
    if (this.isIndexPinchingState) {
      if (pinchStrength < 0.35 && !hand.isPinching()) this.isIndexPinchingState = false
    } else {
      if (pinchStrength > 0.78 || hand.isPinching()) this.isIndexPinchingState = true
    }

    // Middle Pinch (Soccer Kick): enter at dist < 3.0cm, exit at dist > 4.2cm
    const middleDist = (thumbTip && middleTip) ? thumbTip.distance(middleTip) : 999.0
    if (this.isMiddlePinchingState) {
      if (middleDist > 4.2) this.isMiddlePinchingState = false
    } else {
      if (middleDist < 3.0) this.isMiddlePinchingState = true
    }

    // Ring Pinch (Roll / Recovery): enter at dist < 3.0cm, exit at dist > 4.2cm
    const ringDist = (thumbTip && ringTip) ? thumbTip.distance(ringTip) : 999.0
    if (this.isRingPinchingState) {
      if (ringDist > 4.2) this.isRingPinchingState = false
    } else {
      if (ringDist < 3.0) this.isRingPinchingState = true
    }

    // Smooth Analog Jaw Opening
    this.smoothedJaw += (pinchStrength - this.smoothedJaw) * 0.4
    this.currentState.jaw = this.smoothedJaw

    this.currentState.isIndexPinching = this.isIndexPinchingState
    this.currentState.isMiddlePinching = this.isMiddlePinchingState
    this.currentState.isRingPinching = this.isRingPinchingState

    let currentGesture = "Driving"
    if (Math.abs(this.smoothedVx) < 0.04 && Math.abs(this.smoothedWz) < 0.08) {
      currentGesture = "Neutral (Steady)"
    }

    // 5. Fire Clean Debounced Actions
    if (this.isIndexPinchingState && !this.wasIndexPinching) {
      if (now - this.lastActionTime > 0.28) {
        this.triggerAction("quack", "Index Pinch (Quack)")
        this.lastActionTime = now
      }
    }

    if (this.isMiddlePinchingState && !this.wasMiddlePinching) {
      if (now - this.lastActionTime > 0.35) {
        const kickAction = this.drivingHandType.toLowerCase() === "left" ? "kickL" : "kickR"
        this.triggerAction(kickAction, "Middle Pinch (Kick)")
        this.lastActionTime = now
      }
    }

    if (this.isRingPinchingState && !this.wasRingPinching) {
      if (now - this.lastActionTime > 0.45) {
        this.triggerAction("roll", "Ring Pinch (Roll)")
        this.lastActionTime = now
      }
    }

    // Mode switch: double pinch held
    if (this.isIndexPinchingState && this.isMiddlePinchingState && now - this.lastLocoToggleTime > 1.4) {
      this.isRollerMode = !this.isRollerMode
      this.triggerAction("locoToggle", `Mode: ${this.isRollerMode ? "Rollers" : "Legs"}`)
      this.lastLocoToggleTime = now
    }

    if (this.isIndexPinchingState) currentGesture = "Quacking 🐤"
    if (this.isMiddlePinchingState) currentGesture = "Kicking ⚽"
    if (this.isRingPinchingState) currentGesture = "Rolling 🔄"

    this.currentState.activeGestureName = currentGesture
    this.wasIndexPinching = this.isIndexPinchingState
    this.wasMiddlePinching = this.isMiddlePinchingState
    this.wasRingPinching = this.isRingPinchingState
  }

  private wasIndexPinching: boolean = false
  private wasMiddlePinching: boolean = false
  private wasRingPinching: boolean = false

  public triggerAction(action: string, gestureName: string): void {
    print(`[MicroDuckGestureController] Gesture Action: ${action} (${gestureName})`)
    
    if (this.bridgeClient) {
      const handType = this.drivingHandType.toLowerCase() === "left" ? "left" : "right"
      this.bridgeClient.sendAction(action, handType, gestureName)
    }

    for (const cb of this.onGestureAction) {
      cb(action, gestureName)
    }
  }

  public performAction(actionName: string): void {
    this.triggerAction(actionName, `UI: ${actionName}`)
  }

  public resetSim(): void {
    this.triggerAction("reset", "Reset Sim")
  }

  public toggleSit(): void {
    this.triggerAction("sitToggle", "Sit Toggle")
  }

  public toggleLocomotion(): void {
    this.isRollerMode = !this.isRollerMode
    this.triggerAction("locoToggle", `Mode: ${this.isRollerMode ? "Rollers" : "Legs"}`)
  }

  private processEditorFallback(): void {
    this.smoothedVx += (0 - this.smoothedVx) * 0.1
    this.smoothedWz += (0 - this.smoothedWz) * 0.1
    this.currentState.vx = this.smoothedVx
    this.currentState.wz = this.smoothedWz
    this.currentState.activeGestureName = "Editor Fallback (Ready)"
  }
}

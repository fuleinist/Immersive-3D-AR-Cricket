import * as THREE from 'three';
import { alpha } from './poseSmoothing';

/**
 * Grip-anchored bat transform.
 *
 * The bat hangs off the SELECTED hand only — right-handed stance grips at
 * the right wrist (landmark 16), left-handed at the left wrist (15) — and
 * the blade axis sits exactly perpendicular (90°) against that hand's
 * forearm (elbow -> wrist). This replaces the old two-wrist construction
 * (midWrist anchor + wristDiff x forearm cross), which floated the grip
 * between the arms and could mirror the blade toward the wrong side.
 *
 * Orientation derives from the forearm axis plus the body frame:
 *
 *   side    = normalize(rShoulder - lShoulder)   (anatomical right)
 *   up      = normalize(midShoulder - midHip)    (torso up)
 *   forward = normalize(up x side)               (chest forward)
 *
 * The blade is the forearm axis rotated exactly 90° within the
 * forearm/body-up plane toward body-up — equivalently the component of
 * body-up perpendicular to the forearm, normalized. Because the reference
 * is a fixed body axis (never a difference of two noisy wrist positions),
 * the blade can never flip to the wrong side: its up-component is
 * strictly positive while the up-reference is active. When the forearm is
 * near-parallel to body-up (arm hanging straight down), the reference
 * falls back to chest-forward, so the bat points horizontally forward
 * instead of degenerating. The construction is coordinate-free, so a
 * left-handed pose (the mirror of a right-handed one) mirrors the bat
 * deterministically — the only axis that picks up the reflection's
 * determinant sign is the face normal, by algebraic necessity.
 *
 * The basis completes with batX = forearm axis (already exactly
 * perpendicular to the blade) and batZ = batX x batY, a proper
 * right-handed rotation for the bat mesh (local +Y = blade, +Z = face).
 *
 * SWING AWARENESS. The body-up reference is right for stance, but a real
 * cricket swing carries the forearm horizontal/forward while the blade
 * must sweep DOWN through the ball. notePoseFrame() (called once per new
 * pose frame, never per render frame) tracks the grip-chain velocity
 * RELATIVE to the torso — common-mode rejection, so locomotion never
 * reads as a swing — and raises `swingBlend` 0..1; solve() then rotates
 * the blade within the
 * plane perpendicular to the forearm, from the stance orientation toward
 * the world-down (gravity) component of that plane. Rotating about the
 * forearm axis keeps the 90° invariant exact at any blend, and blending
 * toward a plane-projected reference can never degenerate the way a raw
 * lerp toward (0,-1,0) could when the forearm itself points down. A pure
 * fast-but-upward motion (backlift) is capped at half blend so the blade
 * only tilts; a downward downswing sweeps it all the way over. The phase
 * transitions are time-based (fast attack, gentle release) with a speed
 * floor for hysteresis — a slow state machine, not a per-frame filter, so
 * it cannot inject chatter. The renderer applies the solved transform
 * directly (the bat is a rigid extension of the arm: the ONLY smoothing
 * it experiences is the landmarks' own One Euro filter). When swingBlend
 * is exactly 0 (stance/idle, no pose frames seen) the solve path is
 * bit-identical to the pre-swing solver.
 *
 * Degenerate frames (collapsed forearm/shoulders/torso, non-finite
 * inputs) return false and leave the outputs untouched, so callers keep
 * the last good transform. All scratch is preallocated: zero per-frame
 * allocation.
 */

export type BatHandedness = 'right' | 'left';

/** BlazePose indices of the gripping-hand chain per handedness. */
export const GRIP_CHAIN: Record<BatHandedness, { elbow: number; wrist: number }> = {
  right: { elbow: 14, wrist: 16 },
  left: { elbow: 13, wrist: 15 },
};

/** Joint positions the solver reads, in the renderer's avatar-local space. */
export interface BatJoints {
  lShoulder: THREE.Vector3;
  rShoulder: THREE.Vector3;
  lElbow: THREE.Vector3;
  rElbow: THREE.Vector3;
  lWrist: THREE.Vector3;
  rWrist: THREE.Vector3;
  lHip: THREE.Vector3;
  rHip: THREE.Vector3;
}

/** A body reference whose |dot| with the forearm exceeds this is too
 *  parallel to project — the fallback fully owns the reference here
 *  (0.95 ~= within 18°). */
const PARALLEL_LIMIT = 0.95;
/** Below this |forearm·bodyUp| the blade reference is purely body-up.
 *  Between REF_BLEND_START and PARALLEL_LIMIT the reference blends
 *  continuously toward the fallback, so a forearm hovering near the band
 *  edge cannot flap the blade between two references ~90° apart on
 *  consecutive pose frames (the old hard switch showed up as the bat
 *  visibly shaking whenever the arm hung near-vertical). */
const REF_BLEND_START = 0.88;
const MIN_LEN_SQ = 1e-12;

/** World gravity direction in solver space (the renderer maps both
 *  landmark conventions to y-up locally). Read-only. */
const WORLD_DOWN = new THREE.Vector3(0, -1, 0);

/**
 * Swing detection thresholds, in solver-local units per second (the
 * renderer's avatar space is metric x avatar size, so 1 u/s ~= 1 m/s at
 * size 1). A practiced cricket downswing peaks at 4-8 m/s; idle hand
 * fidget stays under ~1 m/s. `thresholdScale` (seated mode) multiplies
 * every one of these, since arm-only seated swings are slower.
 */
const SWING_SPEED_ON = 1.2; // wrist speed where the blend ramp starts
const SWING_SPEED_FULL = 3.0; // speed-only contribution saturates here
const SWING_SPEED_OFF = 0.9; // below this (and DOWN_OFF) the target floors to 0
const SWING_DOWN_ON = 0.6; // downward wrist speed where the downswing ramp starts
const SWING_DOWN_FULL = 2.0; // downward speed for a full blade-over blend
const SWING_DOWN_OFF = 0.45; // downward floor for the hysteresis band
/** Pure speed with no downward component (backlift, fast horizontal cut)
 *  can only tilt the blade this far — never below horizontal. */
const SPEED_ONLY_CAP = 0.5;
/** Low-pass cutoff (Hz) for the finite-difference speed estimate. */
const VELOCITY_DCUTOFF = 1.5;
/** Blend time constants (s): the blade tips over fast once the downswing
 *  is on, and sweeps back to stance gently so it never snaps. */
const BLEND_ATTACK_TAU = 0.07;
const BLEND_RELEASE_TAU = 0.24;

const MIN_DT = 1 / 240;
const MAX_DT = 0.5;
const DEFAULT_DT = 1 / 30;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Hermite smoothstep on [0,1]: C1-continuous at both ends. */
const smoothstep01 = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

const isFiniteVec = (v: THREE.Vector3): boolean =>
  Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

export class BatTransformSolver {
  private readonly forearm = new THREE.Vector3();
  private readonly bodyUp = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly batY = new THREE.Vector3();
  private readonly batZ = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly basis = new THREE.Matrix4();

  // Swing tracking state (notePoseFrame): previous grip-chain positions,
  // velocity scratch and the low-passed speed/downward-speed estimates.
  private readonly prevWrist = new THREE.Vector3();
  private readonly prevElbow = new THREE.Vector3();
  private readonly prevMidShoulder = new THREE.Vector3();
  private readonly midShoulder = new THREE.Vector3();
  private readonly velW = new THREE.Vector3();
  private readonly velE = new THREE.Vector3();
  private readonly velTorso = new THREE.Vector3();
  private readonly refBlend = new THREE.Vector3();
  private readonly downPerp = new THREE.Vector3();
  private havePrev = false;
  private speedSmooth = 0;
  private downSmooth = 0;

  /**
   * 0 = stance (blade toward body-up), 1 = full downswing (blade toward
   * gravity). Advanced only by notePoseFrame(); read by solve(). Exposed
   * for tuning inspection and the headless harness.
   */
  public swingBlend = 0;
  /**
   * Multiplier on every swing threshold: seated players swing arm-only
   * and slower, so sit mode sets this < 1 to keep the down-blend
   * reachable. Standing play leaves it at 1.
   */
  public thresholdScale = 1;

  /** Clear all swing state (stance change, tracking-mode change). */
  resetSwing(): void {
    this.havePrev = false;
    this.speedSmooth = 0;
    this.downSmooth = 0;
    this.swingBlend = 0;
  }

  /**
   * Advance swing detection by one POSE frame. Must be called at the pose
   * stream's cadence (landmarks only change per pose frame — calling it
   * per render frame would alias a fast swing into alternating v/0
   * readings whose low-passed mean underestimates proportionally to the
   * display rate). Calling it with unchanged joints is the supported way
   * to decay the blend when the pose stream stalls: velocity reads 0, the
   * target floors out and the blend releases back to stance.
   *
   * Non-finite joints skip the update entirely (last blend held).
   */
  notePoseFrame(joints: BatJoints, handedness: BatHandedness, dtSeconds: number): void {
    const right = handedness === 'right';
    const wrist = right ? joints.rWrist : joints.lWrist;
    const elbow = right ? joints.rElbow : joints.lElbow;
    const { lShoulder, rShoulder } = joints;
    if (![wrist, elbow, lShoulder, rShoulder].every(isFiniteVec)) return;

    let dt = dtSeconds;
    if (!Number.isFinite(dt) || dt <= 0) dt = DEFAULT_DT;
    else if (dt < MIN_DT) dt = MIN_DT;
    else if (dt > MAX_DT) dt = MAX_DT;

    const midShoulder = this.midShoulder.addVectors(lShoulder, rShoulder).multiplyScalar(0.5);

    if (!this.havePrev) {
      this.havePrev = true;
      this.prevWrist.copy(wrist);
      this.prevElbow.copy(elbow);
      this.prevMidShoulder.copy(midShoulder);
      return;
    }

    // Finite-difference velocity of the grip chain in solver space,
    // measured RELATIVE to the torso (mid-shoulder) frame. Common-mode
    // rejection: locomotion — shuffling, stepping, bouncing between
    // deliveries — carries the wrists with the shoulders and must not read
    // as a swing, or the blade wobbles by blend*theta (~pi at stance)
    // while the arm itself is steady. A real swing is exactly the motion
    // that survives: the grip chain moving fast relative to the torso.
    // The wrist is the primary signal; the elbow (x0.8) corroborates it so
    // a briefly untracked wrist can't kill the phase detection.
    const vT = this.velTorso.subVectors(midShoulder, this.prevMidShoulder).divideScalar(dt);
    const vW = this.velW.subVectors(wrist, this.prevWrist).divideScalar(dt).sub(vT);
    const vE = this.velE.subVectors(elbow, this.prevElbow).divideScalar(dt).sub(vT);
    this.prevWrist.copy(wrist);
    this.prevElbow.copy(elbow);
    this.prevMidShoulder.copy(midShoulder);

    const speed = Math.max(vW.length(), vE.length() * 0.8);
    const down = Math.max(Math.max(0, -vW.y), Math.max(0, -vE.y) * 0.8);

    const a = alpha(VELOCITY_DCUTOFF, dt);
    this.speedSmooth += a * (speed - this.speedSmooth);
    this.downSmooth += a * (down - this.downSmooth);

    // Swing target with hysteresis: below the OFF floors the target snaps
    // to 0 (the release time-constant still smooths the actual blend);
    // above them the downward component dominates while raw speed alone
    // is capped so a backlift can only tilt the blade, never drop it.
    const s = this.thresholdScale;
    let target = 0;
    if (this.speedSmooth >= SWING_SPEED_OFF * s || this.downSmooth >= SWING_DOWN_OFF * s) {
      const speedI = clamp01((this.speedSmooth - SWING_SPEED_ON * s) / ((SWING_SPEED_FULL - SWING_SPEED_ON) * s));
      const downI = clamp01((this.downSmooth - SWING_DOWN_ON * s) / ((SWING_DOWN_FULL - SWING_DOWN_ON) * s));
      target = Math.max(speedI * SPEED_ONLY_CAP, downI);
    }

    const tau = target > this.swingBlend ? BLEND_ATTACK_TAU : BLEND_RELEASE_TAU;
    this.swingBlend += (target - this.swingBlend) * (1 - Math.exp(-dt / tau));
  }

  /**
   * Write the bat transform for `handedness` into `outPos` (exactly the
   * grip wrist) and `outQuat`. Returns false on a degenerate frame,
   * leaving both outputs untouched.
   */
  solve(
    joints: BatJoints,
    handedness: BatHandedness,
    outPos: THREE.Vector3,
    outQuat: THREE.Quaternion,
  ): boolean {
    const right = handedness === 'right';
    const elbow = right ? joints.rElbow : joints.lElbow;
    const wrist = right ? joints.rWrist : joints.lWrist;
    const { lShoulder, rShoulder, lHip, rHip } = joints;

    if (![elbow, wrist, lShoulder, rShoulder, lHip, rHip].every(isFiniteVec)) {
      return false;
    }

    // Forearm axis (elbow -> wrist) — the blade must sit 90° against it.
    const forearm = this.forearm.subVectors(wrist, elbow);
    if (forearm.lengthSq() < MIN_LEN_SQ) return false;
    forearm.normalize();

    // Body frame: anatomical right along the shoulder line, torso up
    // (sum form — the 1/2 midpoint factor cancels under normalization).
    const side = this.side.subVectors(rShoulder, lShoulder);
    if (side.lengthSq() < MIN_LEN_SQ) return false;
    side.normalize();

    const bodyUp = this.bodyUp
      .addVectors(lShoulder, rShoulder)
      .sub(this.tmp.addVectors(lHip, rHip));
    if (bodyUp.lengthSq() < MIN_LEN_SQ) return false;
    bodyUp.normalize();

    // chest = up x right (right-handed anatomy relation). Extreme shoulder
    // tilt can shrink this cross; fall back to any unit vector
    // perpendicular to up.
    const forward = this.forward.crossVectors(bodyUp, side);
    if (forward.lengthSq() < MIN_LEN_SQ) {
      forward.set(0, 0, 1);
      if (Math.abs(bodyUp.z) > 0.9) forward.set(1, 0, 0);
      forward.cross(bodyUp);
    }
    forward.normalize();

    // Blade axis: forearm rotated exactly 90° toward the most usable body
    // reference. Prefer body-up (plumb bat in stance); as the forearm
    // approaches parallel with it (arm hanging near-straight down), blend
    // continuously toward the chest-forward fallback instead of switching
    // — a hard switch flaps the blade ~90° whenever wrist noise straddles
    // the threshold, which reads as the bat shaking in a relaxed hold.
    // Guaranteed to terminate: forward is perpendicular to up by
    // construction, so both can never be near-parallel to the forearm.
    let ref = bodyUp;
    const upness = Math.abs(forearm.dot(bodyUp));
    if (upness > REF_BLEND_START) {
      const fallback = Math.abs(forearm.dot(forward)) <= PARALLEL_LIMIT ? forward : side;
      if (upness >= PARALLEL_LIMIT) {
        ref = fallback;
      } else {
        const t = smoothstep01((upness - REF_BLEND_START) / (PARALLEL_LIMIT - REF_BLEND_START));
        ref = this.refBlend.copy(bodyUp).lerp(fallback, t);
        if (ref.lengthSq() < MIN_LEN_SQ) return false; // unreachable: forward ⊥ up
        ref.normalize();
      }
    }

    // Gram-Schmidt: the component of `ref` perpendicular to the forearm.
    // The result always leans toward `ref` (dot > 0), which is what pins
    // the blade to the correct, deterministic side.
    const batY = this.batY.copy(ref).addScaledVector(forearm, -ref.dot(forearm));
    if (batY.lengthSq() < MIN_LEN_SQ) return false; // unreachable — never NaN
    batY.normalize();

    // Right-handed basis: X = forearm (exactly perpendicular to the blade),
    // Z = X x Y. The mesh's local +Y (blade) / +Z (face) land on batY/batZ.
    const batZ = this.batZ.crossVectors(forearm, batY);

    // Swing-aware: rotate the blade within the plane perpendicular to the
    // forearm, from the stance orientation toward the world-down component
    // of that plane, by swingBlend * the signed angle between them.
    // Rotation about the forearm axis preserves the exact 90° invariant
    // and the unit norm at any blend — including the antiparallel case
    // (blade straight up -> straight down sweeps through batZ) that a
    // naive lerp would collapse. Skipped entirely at blend 0, so
    // stance/idle output stays bit-identical to the pre-swing solver.
    if (this.swingBlend > 0) {
      // Component of gravity perpendicular to the forearm: down + f.y*f.
      const downPerp = this.downPerp.copy(WORLD_DOWN).addScaledVector(forearm, forearm.y);
      if (downPerp.lengthSq() >= MIN_LEN_SQ) {
        downPerp.normalize();
        const theta = Math.atan2(downPerp.dot(batZ), downPerp.dot(batY));
        const phi = this.swingBlend * theta;
        const c = Math.cos(phi);
        const sn = Math.sin(phi);
        batY.multiplyScalar(c).addScaledVector(batZ, sn);
        batZ.crossVectors(forearm, batY);
      }
      // forearm ~parallel to gravity (arm hanging straight down): no
      // meaningful down direction in the blade plane — keep the stance blade.
    }

    this.basis.makeBasis(forearm, batY, batZ);
    outQuat.setFromRotationMatrix(this.basis);
    outPos.copy(wrist);
    return true;
  }
}

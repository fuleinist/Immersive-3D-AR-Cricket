import * as THREE from 'three';
import { alpha } from './poseSmoothing';

/**
 * Grip-anchored bat transform.
 *
 * The bat hangs off the SELECTED hand only — right-handed stance grips at
 * the right wrist (landmark 16), left-handed at the left wrist (15) — and
 * the blade is framed by a TWO-SEGMENT arm hinge plus a phase-aware wrist
 * cock, replacing the old rigid "blade exactly 90° to the forearm" lock.
 * The 90° lock was biomechanically wrong: motion-capture studies of
 * skilled cricket batters (McErlain-Naylor et al., J. Sports Sci. 2021,
 * 39(16):1877-1888, doi:10.1080/02640414.2021.1934289; Peploe et al.,
 * Sports Biomechanics 2019, 18(5):534-546) measure the wrist cocking
 * angle — the angular offset between the lead forearm and the bat —
 * at ~119° ± 12° at the commencement of the downswing, deepening to
 * ~105° (minimum) early in the downswing (wrist lag), then uncocking to
 * ~162–169° at bat-ball impact. At impact the bat is a near-straight
 * extension of the forearm, NOT perpendicular to it. Wrist uncocking is
 * one of the three dominant predictors of bat speed (with X-factor and
 * lead elbow extension), and those studies model the hand->bat link as
 * rigid with all rotation about the wrist — exactly this solver's
 * grip-anchor + per-frame-rigid design.
 *
 * TWO-SEGMENT HINGE AXIS. The blade is framed against the "hinge axis"
 *
 *   h = normalize(mix(forearm, upperArm, w))
 *   forearm  = normalize(wrist - elbow)
 *   upperArm = normalize(elbow - shoulder)          (grip side)
 *   w = 0.5 * clamp01((120° - elbowFlex) / 60°)
 *
 * where elbowFlex is the interior elbow angle (straight arm = 180°).
 * With a straight-ish arm (flex >= 120°: stance, idle, hang, impact)
 * w = 0 and h IS the forearm axis, bit-identically. As the elbow tucks
 * (backlift: rear elbow measured at 56–65° at downswing commencement)
 * the hinge borrows up to half of the upper arm, so the bat responds to
 * BOTH arm segments — shoulder rotation visibly carries the blade even
 * when the forearm itself barely moves, the way a real cocked-wrist grip
 * redistributes the angle across the two segments. The hinge never makes
 * the blade LESS stable: the shoulder is the least noisy arm landmark.
 *
 * PHASE-AWARE WRIST COCK. The blade sits in the plane spanned by h and
 * the body reference (below), at the cock angle θ measured from h:
 *
 *   blade = sin(θ)·n + cos(θ)·h
 *
 *   n = component of the body reference perpendicular to h (normalized)
 *
 * θ is driven by the swing state machine's swingBlend:
 *
 *   blend 0      -> θ = 90°   stance/idle: blade exactly perpendicular —
 *                             bit-identical to the pre-swing solver
 *   blend 0..0.3 -> θ 90°->75° pickup/backlift: wrists cock deeper into
 *                             lag (research: minimum cocking ≈ 105°
 *                             interior = 75° here)
 *   blend 0.3..1 -> θ 75°->15° downswing uncocking: the measured 60° of
 *                             wrist uncocking (75° -> 15°) — matches the
 *                             studies' 57.5–61.9°; at full blend the bat
 *                             is the near-extension of the arm, the
 *                             classic impact geometry (interior 162–169°)
 *
 * So the down-sweep of a real swing emerges from uncocking (the blade
 * pitching down through the arm's plane as the arm itself rotates),
 * instead of the old roll-about-the-forearm hack that kept the 90° lock
 * and tipped the blade toward gravity.
 *
 * The body reference and basis completion are unchanged: reference is
 * body-up (midShoulder - midHip) with the continuous chest-forward
 * fallback band when the hinge is near-parallel to it (|dot| 0.88..0.95)
 * so a hanging arm can't flap the blade; n always leans toward the
 * reference (dot > 0), which pins the blade to the correct,
 * deterministic side. The basis completes as a proper orthonormal
 * rotation with local +Y landing exactly on the blade: at rest X is the
 * hinge axis and Z = X x Y; once the cock leaves 90° the face becomes
 * Z = normalize(hinge x blade) with X = blade x Z, which reduces to the
 * rest basis exactly at 90°. The construction is coordinate-free,
 * so a left-handed pose (the mirror of a right-handed one) mirrors the
 * bat deterministically — the only axis that picks up the reflection's
 * determinant sign is the face normal, by algebraic necessity.
 *
 * SWING DETECTION (unchanged). notePoseFrame() (called once per new pose
 * frame, never per render frame) tracks the grip-chain velocity RELATIVE
 * to the torso — common-mode rejection, so locomotion never reads as a
 * swing — and raises `swingBlend` 0..1. A pure fast-but-upward motion
 * (backlift) is capped at half blend; a downward downswing drives it to
 * 1. The phase transitions are time-based (fast attack, gentle release)
 * with a speed floor for hysteresis — a slow state machine, not a
 * per-frame filter, so it cannot inject chatter. The renderer applies
 * the solved transform directly (the bat is a rigid extension of the
 * arm: the ONLY smoothing it experiences is the landmarks' own One Euro
 * filter). When swingBlend is exactly 0 (stance/idle, no pose frames
 * seen) and the elbow is straight enough that the hinge is disengaged,
 * the solve path is bit-identical to the pre-swing solver.
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

/** A body reference whose |dot| with the hinge exceeds this is too
 *  parallel to project — the fallback fully owns the reference here
 *  (0.95 ~= within 18°). */
const PARALLEL_LIMIT = 0.95;
/** Below this |hinge·bodyUp| the blade reference is purely body-up.
 *  Between REF_BLEND_START and PARALLEL_LIMIT the reference blends
 *  continuously toward the fallback, so a hinge hovering near the band
 *  edge cannot flap the blade between two references ~90° apart on
 *  consecutive pose frames (the old hard switch showed up as the bat
 *  visibly shaking whenever the arm hung near-vertical). */
const REF_BLEND_START = 0.88;
const MIN_LEN_SQ = 1e-12;

/**
 * Phase-aware wrist-cock angles (degrees), measured FROM the hinge axis
 * toward the body-up side — i.e. 180° minus the studies' interior wrist
 * cocking angle. Research pins (McErlain-Naylor et al. 2021; Peploe et
 * al. 2019, skilled batters, mean ± SD):
 *  - downswing commencement: interior 119.3 ± 11.8° (M) / 118.7 ± 12.2°
 *    (F) -> 61° here; the model passes this point mid-transition
 *  - minimum during downswing (wrist lag): interior ~105° (implied by
 *    the 57.5–61.9° of uncocking to impact) -> COCK_LAG_DEG = 75°
 *  - impact: interior 162.1 ± 8.5° (M) / 168.9 ± 10.4° (F) ->
 *    COCK_IMPACT_DEG = 15° (near-extension of the arm)
 *  - stance/idle is unmeasured (address varies; the bat is mimed here),
 *    so COCK_STANCE_DEG stays exactly 90° — the established, tested idle
 *    look, bit-identical to the pre-swing solver.
 */
const COCK_STANCE_DEG = 90;
const COCK_LAG_DEG = 75;
const COCK_IMPACT_DEG = 15;
/** Fraction of the blend where the downswing's wrist lag peaks before
 *  uncocking whips the blade through (early downswing). */
const LAG_BLEND_END = 0.3;

/**
 * Two-segment hinge: maximum ownership the upper arm takes of the hinge
 * axis, and the interior elbow-angle band over which that ownership
 * ramps in. Rear elbow at downswing commencement measures 56–65° (full
 * tuck -> HINGE_MAX); at impact 113–126° (hinge ~disengaged); stance and
 * idle arms run straighter than ELBOW_HINGE_START_DEG, so the hinge is
 * exactly the forearm there.
 */
const HINGE_MAX = 0.5;
const ELBOW_HINGE_START_DEG = 120;
const ELBOW_HINGE_FULL_DEG = 60;

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
 *  can only drive the blend this far — the cock never passes its lag
 *  peak toward impact angles without a real downswing. */
const SPEED_ONLY_CAP = 0.5;
/** Low-pass cutoff (Hz) for the finite-difference speed estimate. */
const VELOCITY_DCUTOFF = 1.5;
/** Blend time constants (s): the cock deepens fast once the downswing
 *  is on, and returns to stance gently so it never snaps. */
const BLEND_ATTACK_TAU = 0.07;
const BLEND_RELEASE_TAU = 0.24;

const MIN_DT = 1 / 240;
const MAX_DT = 0.5;
const DEFAULT_DT = 1 / 30;

const DEG2RAD = Math.PI / 180;

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
  private readonly upperArm = new THREE.Vector3();
  private readonly hinge = new THREE.Vector3();
  private readonly bodyUp = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly batX = new THREE.Vector3();
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
  private havePrev = false;
  private speedSmooth = 0;
  private downSmooth = 0;

  /**
   * 0 = stance (blade perpendicular to the arm), 1 = full downswing
   * (blade uncocked to the arm's near-extension). Advanced only by
   * notePoseFrame(); read by solve(). Exposed for tuning inspection and
   * the headless harness.
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
   * The phase-aware wrist-cock angle (radians from the hinge axis) for
   * the current swingBlend: 90° at stance, deepening to the 75° lag
   * peak, then the 60° uncocking whip to 15° at full downswing — the
   * measured cricket-swing numbers (see file header). Piecewise
   * smoothstep, C1-continuous at the lag peak.
   */
  private cockAngleRad(): number {
    const b = this.swingBlend;
    if (b <= 0) return Math.PI / 2;
    const deg =
      b <= LAG_BLEND_END
        ? COCK_STANCE_DEG +
          (COCK_LAG_DEG - COCK_STANCE_DEG) * smoothstep01(b / LAG_BLEND_END)
        : COCK_LAG_DEG +
          (COCK_IMPACT_DEG - COCK_LAG_DEG) *
            smoothstep01((b - LAG_BLEND_END) / (1 - LAG_BLEND_END));
    return deg * DEG2RAD;
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
    // as a swing, or the blade's cock angle pumps at the shuffle rhythm
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
    // is capped so a backlift can only cock the blade into lag, never
    // uncock it toward impact angles.
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
    const shoulder = right ? joints.rShoulder : joints.lShoulder;
    const elbow = right ? joints.rElbow : joints.lElbow;
    const wrist = right ? joints.rWrist : joints.lWrist;
    const { lShoulder, rShoulder, lHip, rHip } = joints;

    if (![shoulder, elbow, wrist, lShoulder, rShoulder, lHip, rHip].every(isFiniteVec)) {
      return false;
    }

    // Forearm axis (elbow -> wrist) — the distal segment of the hinge.
    const forearm = this.forearm.subVectors(wrist, elbow);
    if (forearm.lengthSq() < MIN_LEN_SQ) return false;
    forearm.normalize();

    // Two-segment hinge axis: borrow up to HINGE_MAX of the upper arm as
    // the elbow tucks. Interior elbow angle (straight = 180°) sets the
    // weight; measured cricket rear elbows run 56–65° at the top of the
    // backlift (hinge fully engaged) and 113–126° at impact (disengaged).
    // At weight 0 the hinge IS the forearm, bit-identically.
    const hinge = this.hinge.copy(forearm);
    const upperArm = this.upperArm.subVectors(elbow, shoulder);
    if (upperArm.lengthSq() >= MIN_LEN_SQ) {
      upperArm.normalize();
      const cosFlex = THREE.MathUtils.clamp(-upperArm.dot(forearm), -1, 1);
      const flexDeg = Math.acos(cosFlex) / DEG2RAD;
      const w =
        HINGE_MAX *
        clamp01(
          (ELBOW_HINGE_START_DEG - flexDeg) / (ELBOW_HINGE_START_DEG - ELBOW_HINGE_FULL_DEG),
        );
      if (w > 0) {
        hinge.lerp(upperArm, w);
        // Unreachable by construction (weight < 1 and the segments are
        // < 120° apart inside the engagement band), but never trust it.
        if (hinge.lengthSq() < MIN_LEN_SQ) return false;
        hinge.normalize();
      }
    }

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

    // Blade plane: spanned by the hinge and the most usable body
    // reference. Prefer body-up (plumb bat in stance); as the hinge
    // approaches parallel with it (arm hanging near-straight down), blend
    // continuously toward the chest-forward fallback instead of switching
    // — a hard switch flaps the blade ~90° whenever wrist noise straddles
    // the threshold, which reads as the bat shaking in a relaxed hold.
    // Guaranteed to terminate: forward is perpendicular to up by
    // construction, so both can never be near-parallel to the hinge.
    let ref = bodyUp;
    const upness = Math.abs(hinge.dot(bodyUp));
    if (upness > REF_BLEND_START) {
      const fallback = Math.abs(hinge.dot(forward)) <= PARALLEL_LIMIT ? forward : side;
      if (upness >= PARALLEL_LIMIT) {
        ref = fallback;
      } else {
        const t = smoothstep01((upness - REF_BLEND_START) / (PARALLEL_LIMIT - REF_BLEND_START));
        ref = this.refBlend.copy(bodyUp).lerp(fallback, t);
        if (ref.lengthSq() < MIN_LEN_SQ) return false; // unreachable: forward ⊥ up
        ref.normalize();
      }
    }

    // Gram-Schmidt: the component of `ref` perpendicular to the hinge —
    // the 90° cock direction. The result always leans toward `ref`
    // (dot > 0), which is what pins the blade to the correct,
    // deterministic side.
    const batY = this.batY.copy(ref).addScaledVector(hinge, -ref.dot(hinge));
    if (batY.lengthSq() < MIN_LEN_SQ) return false; // unreachable — never NaN
    batY.normalize();

    // Phase-aware wrist cock: rotate the blade within the hinge/reference
    // plane, from perpendicular (stance) through the lag peak to the
    // near-extension of the arm (full downswing). n ⊥ h and both are
    // unit, so the combination stays unit. At any cock angle the blade
    // leaves the perpendicular to the hinge, so the basis can no longer
    // be (hinge, blade, hinge x blade) — that is not a rotation and
    // setFromRotationMatrix would mangle it. The orthonormal completion
    // below keeps local +Y landing EXACTLY on the computed blade:
    //   Z (face) = normalize(hinge x blade)   — perpendicular to both
    //   X        = blade x Z                  — in-plane, unit by construction
    // At the 90° stance this reduces to the old (hinge, blade, hinge x
    // blade) basis exactly (X = hinge), and blend 0 skips the combine so
    // stance/idle output stays bit-identical to the pre-swing solver.
    if (this.swingBlend > 0) {
      const theta = this.cockAngleRad();
      const c = Math.cos(theta);
      const sn = Math.sin(theta);
      batY.multiplyScalar(sn).addScaledVector(hinge, c);

      const batZ = this.batZ.crossVectors(hinge, batY);
      if (batZ.lengthSq() < MIN_LEN_SQ) return false; // unreachable: cock >= 15°
      batZ.normalize();
      const batX = this.batX.crossVectors(batY, batZ);
      this.basis.makeBasis(batX, batY, batZ);
    } else {
      // Right-handed basis: X = hinge axis, Z = X x Y. The mesh's local
      // +Y (blade) / +Z (face) land on batY/batZ.
      const batZ = this.batZ.crossVectors(hinge, batY);
      this.basis.makeBasis(hinge, batY, batZ);
    }
    outQuat.setFromRotationMatrix(this.basis);
    outPos.copy(wrist);
    return true;
  }
}

import * as THREE from 'three';

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
 *  parallel to project — skip it (0.95 ~= within 18°). */
const PARALLEL_LIMIT = 0.95;
const MIN_LEN_SQ = 1e-12;

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
    // reference. Prefer body-up (plumb bat in stance); when the forearm is
    // too parallel (arm hanging straight down), fall back to chest-forward.
    // Guaranteed to terminate: forward is perpendicular to up by
    // construction, so both can never be near-parallel to the forearm.
    let ref = bodyUp;
    if (Math.abs(forearm.dot(bodyUp)) > PARALLEL_LIMIT) {
      ref = Math.abs(forearm.dot(forward)) <= PARALLEL_LIMIT ? forward : side;
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
    this.basis.makeBasis(forearm, batY, batZ);
    outQuat.setFromRotationMatrix(this.basis);
    outPos.copy(wrist);
    return true;
  }
}

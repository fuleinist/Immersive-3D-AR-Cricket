/**
 * Pure shot physics for the bat-ball interaction (issue #12).
 *
 * No React, no three, no DOM. Every function here runs in the render loop and
 * in the headless harness (scripts/verify-shot-physics.mjs) from the same code.
 * Nothing allocates inside the sub-step loop: callers pass in objects they
 * created once and results are written into them.
 *
 * World convention (the one the scene uses): +z runs from the bowler toward
 * the batter, +y is up, +x is the leg side for a right-hander (so -x is off).
 * A bat frame is the one services/batTransform.ts produces: local +Y along the
 * blade from grip to toe, +Z out of the hitting face, +X across the face.
 *
 * The seven defects this module fixes:
 *   1. cannon nests contact data under e.contact, so the old handler threw on
 *      every bat contact. Collision is decided here instead of from an event
 *      payload, so no cast is needed and nothing can throw.
 *   2. The hit handler never set the ball's velocity, so swing speed counted
 *      for nothing: the kinematic bat body has zero velocity in cannon-es.
 *      computeBatBallImpact returns an exit velocity the caller applies.
 *   3. Mount closures captured a stale hasHit / deliveryIndex / collider size.
 *      These functions take their inputs as arguments and read nothing that was
 *      captured at mount.
 *   4. Crease geometry lives in the exported constants below and matches the
 *      scene: stumps at z = +1.35, crease line at z = +0.13.
 *   5. The bat is the whole blade, not a box centred on the wrist: the tested
 *      segment is grip -> toe, so the bottom of the blade can hit.
 *   6. Discrete 60 Hz stepping tunnels at fast pace; the swept collider tests
 *      eight sub-steps across the frame instead of one sample point.
 *   7. Pitch contacts get the spin transfer the delivery data assumes.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** One render frame of the bat, published by Avatar in world space. */
export interface BatSample {
  /** Grip end of the blade (the selected wrist), world meters. */
  gripWorld: Vec3;
  /** Toe end of the blade, bat-local (0, +0.82 * size, 0). */
  toeWorld: Vec3;
  /** Outward normal of the hitting face, world axes. */
  faceNormalWorld: Vec3;
  /** Across the face, world axes (bat local +X). */
  rightAxisWorld: Vec3;
  /** performance.now() of the pose frame that produced this sample. */
  timestampMs: number;
}

/** Caller-owned output for the bat-ball test. Create once, reuse. */
export interface ImpactResult {
  hit: boolean;
  /** Contact fraction along the blade: 0 at the grip, 1 at the toe. */
  u: number;
  /** Sweet-spot quality, in [MIN_SWEET_QUALITY, 1]. */
  quality: number;
  /** Ball exit velocity. */
  exitVelocity: Vec3;
  /** World point of contact. */
  contactPoint: Vec3;
  /** Sub-step index (1..SWEPT_SUBSTEPS) that produced the contact. */
  subStep: number;
  /** Fraction of the frame elapsed at contact. */
  frameFraction: number;
}

/** Caller-owned output for the stump segment test. Create once, reuse. */
export interface StumpContact {
  hit: boolean;
  /** Fraction of the tested segment where the stump plane was crossed. */
  fraction: number;
  /** Crossing point. */
  point: Vec3;
  /** Which stump: 0 = off, 1 = middle, 2 = leg, -1 = none. */
  stump: number;
}

/* ------------------------------------------------------------------ tuning */

export const SWEPT_SUBSTEPS = 8;

/** Floor for the point-velocity denominator. A stalled pose frame must not
 *  divide by zero, and a frame faster than 240 Hz is treated as 240 Hz. */
export const MIN_STEP_SECONDS = 1 / 240;

/** Bat point velocities above this are clipped. A 28 m/s blade is about 100
 *  mph bat speed - anything faster is pose noise, not a shot. */
export const MAX_BAT_POINT_SPEED = 28;

/** Sweet spot: u = 0.62 along the blade, Gaussian quality with sigma 0.22,
 *  floored at 0.35 so an edge or toe contact still carries some quality. */
export const SWEET_SPOT_U = 0.62;
export const SWEET_SPOT_SIGMA = 0.22;
export const MIN_SWEET_QUALITY = 0.35;

export const BASE_RESTITUTION = 0.48;
export const SWEET_RESTITUTION_GAIN = 0.36;

/** Lift the bat imparts on a good contact, proportional to quality. */
export const LIFT_PER_QUALITY = 1.8;

/** Pitch contact. */
export const PITCH_RESTITUTION = 0.68;
export const GRAVITY = 9.8;

/** Lateral velocity transferred from pitch-gripping spin at the first pitch
 *  contact. Magnitude 0.10, applied to the x velocity only. The sign follows
 *  the convention in types.ts: positive spin[2] rips the ball toward off side,
 *  which is -x for a right-hander. spin[1] is the front-on seam axis and turns
 *  the ball off the pitch only through grip, so it contributes nothing here. */
export const SPIN_LATERAL_COEFFICIENT = -0.10;

/** Crease geometry. These values are what components/Scene.tsx draws, so the
 *  harness and the runtime cannot disagree. */
export const CREASE_Z = 0.13;
export const STUMP_PLANE_Z = 1.35;
export const STUMP_XS = [-0.11, 0.0, 0.11];
export const STUMP_RADIUS = 0.02;
export const STUMP_HEIGHT = 0.71;
/** Half width of the stump zone: half the stump spacing plus a stump radius and
 *  a ball radius. */
export const STUMP_ZONE_HALF_X = 0.145;
/** Top of the stump zone: stump height plus the bail. */
export const STUMP_ZONE_MAX_Y = 0.73;

/** Bat frame geometry. The toe sample is bat-local (0, +BAT_BLADE_FRACTION *
 *  size, 0); components/Avatar.tsx publishes the sample with this fraction, so
 *  the tested segment is the whole blade rather than a wrist-centred box. */
export const BAT_BLADE_FRACTION = 0.82;

/** History guards for the swept collider: a pose stream that stalls, or an arm
 *  that is lost, must not invent a swing from stale data. */
export const POSE_STALL_MS = 150;
export const MIN_VISIBILITY = 0.45;

/* ------------------------------------------------------- small vector math */

function dot(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return ax * bx + ay * by + az * bz;
}

/**
 * Sweet-spot quality for a contact fraction u: peaks at u = 0.62 with a
 * Gaussian falloff (sigma 0.22), floored at 0.35.
 */
export function sweetSpotQuality(u: number): number {
  const d = u - SWEET_SPOT_U;
  const q = Math.exp(-(d * d) / (2 * SWEET_SPOT_SIGMA * SWEET_SPOT_SIGMA));
  return Math.max(MIN_SWEET_QUALITY, q);
}

/**
 * Bat point velocity at contact fraction u, from the frame's grip delta and toe
 * delta: v_bat = ((1 - u) * gripDelta + u * toeDelta) / max(dt, 1/240),
 * clamped to MAX_BAT_POINT_SPEED. Writes into out and returns out.
 */
export function batPointVelocity(
  gripDelta: Vec3,
  toeDelta: Vec3,
  u: number,
  dtSeconds: number,
  out: Vec3,
): Vec3 {
  const dt = Math.max(dtSeconds, MIN_STEP_SECONDS);
  const gripWeight = 1 - u;
  out.x = (gripWeight * gripDelta.x + u * toeDelta.x) / dt;
  out.y = (gripWeight * gripDelta.y + u * toeDelta.y) / dt;
  out.z = (gripWeight * gripDelta.z + u * toeDelta.z) / dt;
  const speed = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
  if (speed > MAX_BAT_POINT_SPEED) {
    const k = MAX_BAT_POINT_SPEED / speed;
    out.x *= k;
    out.y *= k;
    out.z *= k;
  }
  return out;
}

/* ------------------------------------------------------ the bat-ball test */

/**
 * Geometry test. Does a ball of radius ballRadius centred at ballCentre overlap
 * the bat box whose long axis is the blade segment grip -> toe? Returns the
 * contact fraction u along the blade, or -1 with no overlap, and writes the
 * contact point into out when it hits.
 *
 * Extents: [0, blade length] along the blade, [-halfWidth, +halfWidth] across
 * the face (bat local +X), [-halfThickness, +halfThickness] through the face
 * (the face normal direction). This is the whole blade, not a box centred on
 * the wrist - the bottom 20 cm had no collider before.
 */
export function batSegmentContact(
  grip: Vec3,
  toe: Vec3,
  faceNormal: Vec3,
  ballCentre: Vec3,
  ballRadius: number,
  halfWidth: number,
  halfThickness: number,
  out: ImpactResult,
): number {
  const bx = toe.x - grip.x;
  const by = toe.y - grip.y;
  const bz = toe.z - grip.z;
  const bladeSq = bx * bx + by * by + bz * bz;
  if (bladeSq < 1e-12) return -1;
  const bladeLen = Math.sqrt(bladeSq);
  const ax = bx / bladeLen;
  const ay = by / bladeLen;
  const az = bz / bladeLen;

  // Across the face: right axis = blade x face normal. A frame with the blade
  // parallel to the face normal is degenerate and cannot be a bat.
  let rx = ay * faceNormal.z - az * faceNormal.y;
  let ry = az * faceNormal.x - ax * faceNormal.z;
  let rz = ax * faceNormal.y - ay * faceNormal.x;
  const rSq = rx * rx + ry * ry + rz * rz;
  if (rSq < 1e-12) return -1;
  const rLen = Math.sqrt(rSq);
  rx /= rLen; ry /= rLen; rz /= rLen;

  const nx = faceNormal.x, ny = faceNormal.y, nz = faceNormal.z;
  const dx = ballCentre.x - grip.x;
  const dy = ballCentre.y - grip.y;
  const dz = ballCentre.z - grip.z;

  // Closest point on the box to the ball centre.
  let s = dot(dx, dy, dz, ax, ay, az);
  if (s < 0) s = 0; else if (s > bladeLen) s = bladeLen;
  let w = dot(dx, dy, dz, rx, ry, rz);
  if (w < -halfWidth) w = -halfWidth; else if (w > halfWidth) w = halfWidth;
  let h = dot(dx, dy, dz, nx, ny, nz);
  if (h < -halfThickness) h = -halfThickness; else if (h > halfThickness) h = halfThickness;

  const cx = grip.x + s * ax + w * rx + h * nx;
  const cy = grip.y + s * ay + w * ry + h * ny;
  const cz = grip.z + s * az + w * rz + h * nz;
  const px = ballCentre.x - cx;
  const py = ballCentre.y - cy;
  const pz = ballCentre.z - cz;
  if (px * px + py * py + pz * pz > ballRadius * ballRadius) return -1;

  out.contactPoint.x = cx;
  out.contactPoint.y = cy;
  out.contactPoint.z = cz;
  const u = s / bladeLen;
  out.u = u;
  return u;
}

/**
 * Bat-ball impact. Inputs are the bat frame at the instant of contact plus the
 * ball state; the exit velocity, the hit flag and the contact fraction are
 * written into out. The caller supplies the bat point velocity, which is what
 * makes swing speed count - the kinematic bat body carries no velocity in
 * cannon-es, so the old handler could only ever read the ball's own.
 *
 *   q = sweetSpotQuality(u)
 *   e = BASE_RESTITUTION + SWEET_RESTITUTION_GAIN * q
 *   v_rel = v_ball - v_bat
 *   v_exit = v_bat + v_rel - (1 + e) * dot(v_rel, n) * n + (0, 1.8 * q, 0)
 *
 * A contact only counts when the ball is moving into the face, so
 * dot(v_rel, n) must be negative; a ball already leaving the face produces no
 * result.
 */
export function computeBatBallImpact(
  grip: Vec3,
  toe: Vec3,
  faceNormal: Vec3,
  batPointVelocity: Vec3,
  ballCentre: Vec3,
  ballVelocity: Vec3,
  ballRadius: number,
  halfWidth: number,
  halfThickness: number,
  out: ImpactResult,
): boolean {
  const u = batSegmentContact(grip, toe, faceNormal, ballCentre, ballRadius, halfWidth, halfThickness, out);
  if (u < 0) return false;

  const q = sweetSpotQuality(u);
  const e = BASE_RESTITUTION + SWEET_RESTITUTION_GAIN * q;

  const nx = faceNormal.x, ny = faceNormal.y, nz = faceNormal.z;
  const rvx = ballVelocity.x - batPointVelocity.x;
  const rvy = ballVelocity.y - batPointVelocity.y;
  const rvz = ballVelocity.z - batPointVelocity.z;
  const vn = dot(rvx, rvy, rvz, nx, ny, nz);
  if (vn > -1e-9) return false; // separating: no impulse

  const j = (1 + e) * vn;
  out.quality = q;
  out.exitVelocity.x = batPointVelocity.x + rvx - j * nx;
  out.exitVelocity.y = batPointVelocity.y + rvy - j * ny + LIFT_PER_QUALITY * q;
  out.exitVelocity.z = batPointVelocity.z + rvz - j * nz;
  out.hit = true;
  return true;
}

/* -------------------------------------------------- the swept bat collider */

/**
 * The swept bat collider: it owns the published bat sample and the previous
 * frame's grip and toe, so a contact can be tested across the whole frame. At
 * 24-27 m/s a ball travels 40-45 cm in a 60 Hz frame against a bat-plus-ball
 * slab only a few centimetres thick, so sampling one point per frame lets most
 * contacts pass through.
 *
 * Per frame the caller does two things:
 *   1. beginFrame(visibility) before writing the sample - this applies the
 *      stall / visibility guards and keeps the previous frame's points;
 *   2. test(...) after the sample has been written.
 *
 * History is reset when the pose timestamp stalls for more than POSE_STALL_MS
 * or the arm's visibility drops below MIN_VISIBILITY.
 */
export interface SweptBatCollider {
  /** The per-frame bat sample. Shared and mutable. */
  sample: BatSample;
  havePrev: boolean;
  /** Frame deltas, previous -> current, filled by test(). */
  gripDelta: Vec3;
  toeDelta: Vec3;
  beginFrame(visibility: number, timestampMs: number): boolean;
  test(dtSeconds: number, ballCentre: Vec3, ballVelocity: Vec3, ballRadius: number,
       halfWidth: number, halfThickness: number, out: ImpactResult): boolean;
  resetHistory(): void;
}

export function createSweptBatCollider(): SweptBatCollider {
  const sample: BatSample = {
    gripWorld: { x: 0, y: 0, z: 0 },
    toeWorld: { x: 0, y: 0, z: 0 },
    faceNormalWorld: { x: 0, y: 0, z: 0 },
    rightAxisWorld: { x: 0, y: 0, z: 0 },
    timestampMs: 0,
  };

  // Everything below is allocated once for the lifetime of the collider.
  const prevGrip = { x: 0, y: 0, z: 0 };
  const prevToe = { x: 0, y: 0, z: 0 };
  const gripDelta = { x: 0, y: 0, z: 0 };
  const toeDelta = { x: 0, y: 0, z: 0 };
  const subGrip = { x: 0, y: 0, z: 0 };
  const subToe = { x: 0, y: 0, z: 0 };
  const subBall = { x: 0, y: 0, z: 0 };
  const pointVelocity = { x: 0, y: 0, z: 0 };
  let lastTimestampMs = -1;
  let hasBaseline = false;

  const collider: SweptBatCollider = {
    sample,
    havePrev: false,
    gripDelta,
    toeDelta,

    resetHistory() {
      collider.havePrev = false;
      lastTimestampMs = -1;
      hasBaseline = false;
    },

    beginFrame(visibility: number, timestampMs: number): boolean {
      if (!Number.isFinite(timestampMs)) {
        collider.havePrev = false;
        hasBaseline = false;
        return false;
      }
      const stalled = hasBaseline && timestampMs - lastTimestampMs > POSE_STALL_MS;
      if (!hasBaseline || stalled || visibility < MIN_VISIBILITY) {
        // Nothing to sweep from. This frame's points, once the caller writes
        // them, become the new baseline for the next frame.
        collider.havePrev = false;
        hasBaseline = true;
      } else {
        // Called before the sample is written for this frame, so the sample still
        // holds the previous frame's points: those are the sweep's start.
        prevGrip.x = sample.gripWorld.x;
        prevGrip.y = sample.gripWorld.y;
        prevGrip.z = sample.gripWorld.z;
        prevToe.x = sample.toeWorld.x;
        prevToe.y = sample.toeWorld.y;
        prevToe.z = sample.toeWorld.z;
        collider.havePrev = true;
      }

      sample.timestampMs = timestampMs;
      lastTimestampMs = timestampMs;
      return collider.havePrev;
    },

    test(dtSeconds, ballCentre, ballVelocity, ballRadius, halfWidth, halfThickness, out) {
      if (!collider.havePrev) return false;
      out.hit = false;
      out.subStep = 0;
      out.frameFraction = 0;

      gripDelta.x = sample.gripWorld.x - prevGrip.x;
      gripDelta.y = sample.gripWorld.y - prevGrip.y;
      gripDelta.z = sample.gripWorld.z - prevGrip.z;
      toeDelta.x = sample.toeWorld.x - prevToe.x;
      toeDelta.y = sample.toeWorld.y - prevToe.y;
      toeDelta.z = sample.toeWorld.z - prevToe.z;

      for (let i = 1; i <= SWEPT_SUBSTEPS; i++) {
        const t = i / SWEPT_SUBSTEPS;
        subGrip.x = prevGrip.x + gripDelta.x * t;
        subGrip.y = prevGrip.y + gripDelta.y * t;
        subGrip.z = prevGrip.z + gripDelta.z * t;
        subToe.x = prevToe.x + toeDelta.x * t;
        subToe.y = prevToe.y + toeDelta.y * t;
        subToe.z = prevToe.z + toeDelta.z * t;
        // The ball is stepped from where it was at the start of the frame to
        // where it is now, so a fast ball cannot pass the blade between samples.
        subBall.x = ballCentre.x - ballVelocity.x * dtSeconds * (1 - t);
        subBall.y = ballCentre.y - ballVelocity.y * dtSeconds * (1 - t);
        subBall.z = ballCentre.z - ballVelocity.z * dtSeconds * (1 - t);

        if (!Number.isFinite(subBall.x) || !Number.isFinite(subBall.y) || !Number.isFinite(subBall.z)) return false;

        const u = batSegmentContact(subGrip, subToe, sample.faceNormalWorld, subBall, ballRadius, halfWidth, halfThickness, out);
        if (u < 0) continue;
        batPointVelocity(gripDelta, toeDelta, u, dtSeconds, pointVelocity);
        if (computeBatBallImpact(subGrip, subToe, sample.faceNormalWorld, pointVelocity, subBall, ballVelocity, ballRadius, halfWidth, halfThickness, out)) {
          out.subStep = i;
          out.frameFraction = t;
          return true;
        }
      }
      return false;
    },
  };

  return collider;
}

/**
 * The shared per-frame bat state. Avatar publishes the sample into it, Ball runs
 * the swept test against it. Both hold the same object through a ref created by
 * Scene, so nothing here is captured at mount (defect 3).
 */
export interface BatFrameState {
  collider: SweptBatCollider;
  /** The published sample — the same object as collider.sample. */
  sample: BatSample;
  /** Bat half extents, written by Avatar from the bat it actually builds. */
  halfWidth: number;
  halfThickness: number;
  /** Length of the frame the sample covers, written by Avatar on the pose clock. */
  dtSeconds: number;
  /** True once a sample has been written from a live pose frame. */
  armed: boolean;
}

export function createBatFrameState(): BatFrameState {
  const collider = createSweptBatCollider();
  return {
    collider,
    sample: collider.sample,
    halfWidth: 0,
    halfThickness: 0,
    dtSeconds: 0,
    armed: false,
  };
}

/* ---------------------------------------------------------- pitch contact */

/**
 * First pitch contact. The vertical component reflects with the pitch
 * restitution 0.68; the spin that grips the pitch (spin[2], the z axis) is
 * transferred to the ball's x velocity only, with coefficient 0.10. spin[1] is
 * the front-on seam axis: it needs grip to turn the ball and produces no lateral
 * kick off a hard contact. Writes the post-contact velocity into out.
 */
export function computeBounceSpinImpulse(
  impactVelocity: Vec3,
  spin: readonly [number, number, number],
  out: Vec3,
): Vec3 {
  out.x = impactVelocity.x + SPIN_LATERAL_COEFFICIENT * spin[2];
  out.y = impactVelocity.y < 0 ? -PITCH_RESTITUTION * impactVelocity.y : impactVelocity.y;
  out.z = impactVelocity.z;
  return out;
}

/* -------------------------------------------------- stump segment test */

/**
 * Stump segment test: the ball's swept path from prevPoint to currentPoint
 * against the stump plane at z = STUMP_PLANE_Z. A contact counts when the
 * crossing point is inside the stump zone (|x| <= 0.145, y <= 0.73). Writes
 * into out and returns the hit flag.
 */
export function stumpSegmentTest(
  prevPoint: Vec3,
  currentPoint: Vec3,
  ballRadius: number,
  out: StumpContact,
): boolean {
  out.hit = false;
  out.fraction = 0;
  out.stump = -1;
  const dz = currentPoint.z - prevPoint.z;
  if (Math.abs(dz) < 1e-12) return false;
  const t = (STUMP_PLANE_Z - prevPoint.z) / dz;
  if (t < 0 || t > 1) return false;

  const x = prevPoint.x + (currentPoint.x - prevPoint.x) * t;
  const y = prevPoint.y + (currentPoint.y - prevPoint.y) * t;
  if (y < 0 || y > STUMP_ZONE_MAX_Y) return false;
  // The zone as defined by the issue. STUMP_ZONE_HALF_X already accounts for a
  // stump radius and a ball radius, so this is the zone, not a single stump.
  if (Math.abs(x) > STUMP_ZONE_HALF_X) return false;

  // Which stump the ball actually touches, for the coaching line: a crossing
  // inside the zone but wider than a stump plus the ball is an inside edge
  // through the zone, not a hit on a stump.
  let nearest = -1;
  let best = Infinity;
  for (let i = 0; i < STUMP_XS.length; i++) {
    const d = Math.abs(x - STUMP_XS[i]);
    if (d < best) { best = d; nearest = i; }
  }

  out.hit = true;
  out.fraction = t;
  out.point.x = x;
  out.point.y = y;
  out.point.z = STUMP_PLANE_Z;
  out.stump = best <= ballRadius + STUMP_RADIUS ? nearest : -1;
  return true;
}

/* ------------------------------------------------------------ factories */

export function createImpactResult(): ImpactResult {
  return {
    hit: false,
    u: 0,
    quality: 0,
    exitVelocity: { x: 0, y: 0, z: 0 },
    contactPoint: { x: 0, y: 0, z: 0 },
    subStep: 0,
    frameFraction: 0,
  };
}

export function createStumpContact(): StumpContact {
  return { hit: false, fraction: 0, point: { x: 0, y: 0, z: 0 }, stump: -1 };
}

export function createVec3(): Vec3 {
  return { x: 0, y: 0, z: 0 };
}

/**
 * Contact-feedback models for issue #15 (hit-stop and ball-trail slice).
 *
 * Pure: no React, no three, no DOM and no clock. The renderer passes the time in
 * and reads the state out, so the exact same code drives components/Ball.tsx,
 * components/BallTrail.tsx and the headless harness in
 * scripts/verify-impact-juice.mjs.
 *
 * Two behaviours live here:
 *  - HitStopGate holds the ball for a few frames at bat contact. A harder
 *    contact holds longer. The hold then ramps back to full speed, so the shot
 *    still leaves the bat at the exit velocity the fielding model already used.
 *  - BallTrail keeps the recent flight positions. It bounds the count and the
 *    age, and it drops points that are closer than the minimum spacing, so a
 *    slow ball cannot flood the buffer and a fast ball still draws a line.
 */

/** Below this contact speed the ball is not held at all (m/s). */
export const HIT_STOP_MIN_SPEED_MPS = 8;

/** At and above this contact speed the hold is at its maximum (m/s). */
export const HIT_STOP_MAX_SPEED_MPS = 45;

/** Hold length for the weakest contact that still triggers a hit-stop (ms). */
export const HIT_STOP_MIN_MS = 45;

/** Hold length at and above HIT_STOP_MAX_SPEED_MPS (ms). */
export const HIT_STOP_MAX_MS = 140;

/** Time the ball takes to ramp from a full hold back to full speed (ms). */
export const HIT_STOP_RELEASE_MS = 120;

/** Maximum points the trail keeps. */
export const TRAIL_CAPACITY = 28;

/** A new point is dropped when it is closer than this to the last one (m). */
export const TRAIL_MIN_SPACING_M = 0.22;

/** Points older than this are dropped from the sample (ms). */
export const TRAIL_MAX_AGE_MS = 520;

export interface TrailPoint {
  x: number;
  y: number;
  z: number;
  /** 1 at the newest point, 0 at the oldest point that is still inside maxAge. */
  alpha: number;
}

/** Preallocated sample target, so the render loop never allocates per frame. */
export const makeTrailPoints = (capacity: number): TrailPoint[] =>
  Array.from({ length: Math.max(1, Math.floor(capacity)) }, () => ({
    x: 0,
    y: 0,
    z: 0,
    alpha: 0,
  }));

/**
 * Hold length for a contact speed. Zero below HIT_STOP_MIN_SPEED_MPS and for any
 * non-finite input. Linear between the two speed bounds, clamped above.
 */
export const hitStopDurationMs = (contactSpeedMps: number): number => {
  if (!Number.isFinite(contactSpeedMps)) return 0;
  if (contactSpeedMps < HIT_STOP_MIN_SPEED_MPS) return 0;
  const span = HIT_STOP_MAX_SPEED_MPS - HIT_STOP_MIN_SPEED_MPS;
  const t = Math.min(1, (contactSpeedMps - HIT_STOP_MIN_SPEED_MPS) / span);
  return HIT_STOP_MIN_MS + t * (HIT_STOP_MAX_MS - HIT_STOP_MIN_MS);
};

/**
 * One hit-stop window. `begin` arms it, `advance` returns the velocity scale for
 * the current frame, and `consumeRelease` reports the single frame where the
 * gate let go so the caller can restore the exit velocity once.
 */
export class HitStopGate {
  private startMs = 0;
  private durationMs = 0;
  private active = false;
  private released = false;

  /** Arms the gate. Returns the hold length in ms (0 = no hold). */
  begin(contactSpeedMps: number, nowMs: number): number {
    this.durationMs = hitStopDurationMs(contactSpeedMps);
    this.startMs = Number.isFinite(nowMs) ? nowMs : 0;
    this.active = this.durationMs > 0;
    this.released = false;
    return this.durationMs;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Velocity scale in [0, 1] for this frame. */
  advance(nowMs: number): number {
    if (!this.active) return 1;
    const now = Number.isFinite(nowMs) ? nowMs : this.startMs;
    const elapsed = now - this.startMs;
    // A clock that went backwards keeps the hold, it does not skip it.
    if (elapsed < 0) return 0;
    if (elapsed < this.durationMs) return 0;
    const intoRelease = elapsed - this.durationMs;
    if (intoRelease >= HIT_STOP_RELEASE_MS) {
      this.active = false;
      this.released = true;
      return 1;
    }
    return intoRelease / HIT_STOP_RELEASE_MS;
  }

  /** True on the first call after the hold ended, and false after that. */
  consumeRelease(): boolean {
    if (!this.released) return false;
    this.released = false;
    return true;
  }

  reset(): void {
    this.startMs = 0;
    this.durationMs = 0;
    this.active = false;
    this.released = false;
  }
}

interface StoredPoint {
  x: number;
  y: number;
  z: number;
  t: number;
}

/** Bounded, age-limited ring of recent ball positions. */
export class BallTrail {
  private points: StoredPoint[] = [];
  private readonly capacityLimit: number;
  private readonly minSpacingM: number;
  private readonly maxAgeMs: number;

  constructor(
    capacity: number = TRAIL_CAPACITY,
    minSpacingM: number = TRAIL_MIN_SPACING_M,
    maxAgeMs: number = TRAIL_MAX_AGE_MS,
  ) {
    this.capacityLimit = Math.max(2, Math.floor(capacity));
    this.minSpacingM = Math.max(0, minSpacingM);
    this.maxAgeMs = Math.max(1, maxAgeMs);
  }

  get size(): number {
    return this.points.length;
  }

  get capacity(): number {
    return this.capacityLimit;
  }

  get maxAge(): number {
    return this.maxAgeMs;
  }

  get minSpacing(): number {
    return this.minSpacingM;
  }

  /**
   * Stores a point when it is finite and at least minSpacingM from the last
   * stored point. A duplicate position is always rejected, so a resting ball
   * cannot fill the buffer with zero-length segments. Returns true when stored.
   */
  push(x: number, y: number, z: number, nowMs: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return false;
    }
    const t = Number.isFinite(nowMs) ? nowMs : 0;
    const last = this.points[this.points.length - 1];
    if (last) {
      if (t < last.t) {
        this.points = [];
      } else {
        const distance = Math.hypot(x - last.x, y - last.y, z - last.z);
        if (distance < this.minSpacingM || distance === 0) return false;
      }
    }
    this.points.push({ x, y, z, t });
    while (this.points.length > this.capacityLimit) this.points.shift();
    return true;
  }

  /**
   * Writes the live points, oldest first, into a preallocated target and
   * returns the count. Expired points are dropped from the buffer.
   */
  sampleInto(target: TrailPoint[], nowMs: number): number {
    const now = Number.isFinite(nowMs) ? nowMs : 0;
    while (this.points.length > 0 && now - this.points[0].t > this.maxAgeMs) {
      this.points.shift();
    }
    const count = Math.min(this.points.length, target.length);
    for (let i = 0; i < count; i += 1) {
      const source = this.points[i];
      const dest = target[i];
      const age = Math.max(0, now - source.t);
      dest.x = source.x;
      dest.y = source.y;
      dest.z = source.z;
      dest.alpha = Math.max(0, 1 - age / this.maxAgeMs);
    }
    return count;
  }

  /** Convenience wrapper for tests and tooling. Allocates one array. */
  sample(nowMs: number): TrailPoint[] {
    const target = makeTrailPoints(this.points.length || 1);
    const count = this.sampleInto(target, nowMs);
    return target.slice(0, count);
  }

  reset(): void {
    this.points = [];
  }
}
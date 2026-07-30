import { TrackingMode, ResolvedTrackingMode } from '../types';
import { OneEuroFilter, OneEuroParams } from './poseSmoothing';

/**
 * Lateral root tracking — lets the avatar drift left/right with the
 * player instead of standing root-locked at the crease.
 *
 * Signal: the mid-shoulder x of the SMOOTHED normalized image landmarks
 * ((l[11].x + l[12].x) / 2). Shoulders are the most reliably tracked
 * landmarks in both tracking modes (seated players often have occluded
 * hips, and world landmarks are hip-anchored so their x can never carry
 * body translation). The raw front-camera frame is NOT mirrored (the
 * mirrored preview is a CSS flip), so a player moving to their right
 * reads as DECREASING image x — the offset below flips the sign so the
 * avatar follows the user's motion as they perceive it in the mirror
 * preview.
 *
 * The offset is relative to a calibrated center: calibrate() at session
 * start / stance selection / tracking-mode change captures wherever the
 * player is currently standing as "neutral", and the avatar root only
 * deviates from its base crease position as the player drifts away from
 * that. Displacement maps through `scale` (world meters per unit of
 * normalized frame width), is clamped to a per-mode range (seated players
 * shift less), and is One-Euro-smoothed so webcam jitter can't shake the
 * floor under the avatar's feet.
 *
 * Only the avatar root's world X is touched; the y=0 ground-plane
 * invariant is untouched by construction. Degenerate frames (shoulder
 * visibility drop, non-finite input) HOLD the last smoothed offset —
 * never snap back to center mid-innings.
 *
 * All state is plain numbers: zero per-frame allocation.
 */

export interface LateralRootTuning {
  /** World meters of avatar shift per unit of normalized frame width. */
  scale: number;
  /** Max |offset| (m) while standing. */
  rangeStanding: number;
  /** Max |offset| (m) while seated — smaller, seated players shift less. */
  rangeSitting: number;
  /** Shoulders below this visibility hold the last offset. */
  minVisibility: number;
}

export const LATERAL_ROOT_TUNING: LateralRootTuning = {
  scale: 2.2,
  rangeStanding: 0.6,
  rangeSitting: 0.25,
  minVisibility: 0.5,
};

/**
 * Offset smoothing: 0.9 Hz at rest keeps the floor dead still; beta 1.5
 * opens up quickly enough that a deliberate step is tracked within a few
 * pose frames; deadband 4mm freezes sub-perceptual drift.
 */
const OFFSET_SMOOTHING: OneEuroParams = {
  minCutoff: 0.9,
  beta: 1.5,
  dCutoff: 1.0,
  deadband: 0.004,
};

export class LateralRootTracker {
  private readonly filter = new OneEuroFilter(OFFSET_SMOOTHING);
  private centerX: number | null = null;
  private lastValidX: number | null = null;
  private offset = 0;
  private range: number;

  constructor(private readonly tuning: LateralRootTuning = LATERAL_ROOT_TUNING) {
    this.range = tuning.rangeStanding;
  }

  /** Current smoothed lateral offset (world meters, +x screen-right). */
  get current(): number {
    return this.offset;
  }

  /** Switch the clamp range with the resolved tracking mode. */
  setMode(mode: ResolvedTrackingMode): void {
    this.range = mode === TrackingMode.SITTING ? this.tuning.rangeSitting : this.tuning.rangeStanding;
  }

  /**
   * Capture the neutral center. With no argument, uses the most recent
   * valid mid-shoulder x (null-safe: if nothing valid has been seen, the
   * next valid frame auto-centers). Resets the smoothed offset to 0 so
   * the avatar starts from its base crease position.
   */
  calibrate(centerX?: number): void {
    this.centerX = centerX ?? this.lastValidX;
    this.filter.reset();
    this.offset = 0;
  }

  /**
   * Advance by one pose frame and return the smoothed lateral offset.
   * `midShoulderX` is in normalized image units, `visibility` the min of
   * the two shoulder scores, `dtSeconds` the pose-frame interval.
   * Degenerate frames hold the last offset unchanged.
   */
  update(midShoulderX: number, visibility: number, dtSeconds: number): number {
    if (!Number.isFinite(midShoulderX) || visibility < this.tuning.minVisibility) {
      return this.offset;
    }
    this.lastValidX = midShoulderX;
    if (this.centerX === null) this.centerX = midShoulderX;

    // Sign: raw front-camera x decreases as the player moves to their
    // right (mirrored preview), so (center - x) maps user-right to +X.
    const raw = (this.centerX - midShoulderX) * this.tuning.scale;
    const target = raw < -this.range ? -this.range : raw > this.range ? this.range : raw;
    this.offset = this.filter.filter(target, dtSeconds);
    return this.offset;
  }
}

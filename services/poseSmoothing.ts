import { Landmark } from '../types';

/**
 * One Euro Filter (Casiez, Roussel, Vogel — "1€ filter", CHI 2012).
 *
 * A first-order low-pass filter whose cutoff frequency adapts to the
 * (low-passed) speed of the signal: heavy smoothing while the signal is
 * still (where jitter is most visible), progressively lighter smoothing as
 * it moves faster (where lag would be felt). This is the standard cure for
 * pose-estimation jitter and is cheap enough to run per landmark per frame.
 *
 * This module runs on every pose frame (~30/s) across 33 landmarks x 3
 * channels x 2 streams (normalized + world). All filter state is
 * preallocated at construction; filtering mutates the input landmarks in
 * place and performs zero per-frame allocation.
 */

export interface OneEuroParams {
  /** Cutoff frequency (Hz) when the signal is still. Lower = smoother, laggier. */
  minCutoff: number;
  /** Cutoff increase (Hz) per unit of filtered speed. Higher = more responsive to fast motion. */
  beta: number;
  /** Cutoff frequency (Hz) of the derivative low-pass filter (canonical value: 1). */
  dCutoff: number;
  /**
   * Output hysteresis in signal units. Output changes smaller than this are
   * held back, but the internal filter state keeps tracking, so slow drift
   * accumulates and is never permanently frozen. 0 disables.
   */
  deadband: number;
}

/** Pose frames arrive at ~30 fps; used only for the very first frame. */
const DEFAULT_DT = 1 / 30;
/** Clamp dt so timer hiccups can't destabilize or stall the filter. */
const MIN_DT = 1 / 240;
const MAX_DT = 0.5;

const alpha = (cutoffHz: number, dtSeconds: number): number => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSeconds);
};

/** One Euro filter for a single scalar channel. All state is plain numbers. */
export class OneEuroFilter {
  private xPrev = 0;
  private dxPrev = 0;
  private out = 0;
  private initialized = false;

  constructor(private readonly params: OneEuroParams) {}

  reset(): void {
    this.initialized = false;
  }

  filter(x: number, dt: number): number {
    if (!this.initialized) {
      this.initialized = true;
      this.xPrev = x;
      this.dxPrev = 0;
      this.out = x;
      return x;
    }

    const { minCutoff, beta, dCutoff, deadband } = this.params;

    // Smoothed derivative: raw (x - xPrev)/dt is extremely noisy at 30 fps,
    // so speed is estimated through its own fixed-cutoff low pass.
    const dx = (x - this.xPrev) / dt;
    const aD = alpha(dCutoff, dt);
    const dxHat = this.dxPrev + aD * (dx - this.dxPrev);

    // Adaptive cutoff: still -> minCutoff (max smoothing); moving fast ->
    // cutoff rises with speed, opening the filter up to track the motion.
    const cutoff = minCutoff + beta * Math.abs(dxHat);
    const a = alpha(cutoff, dt);
    const xHat = this.xPrev + a * (x - this.xPrev);

    this.xPrev = xHat;
    this.dxPrev = dxHat;

    // Deadband hysteresis on the reported output only: xPrev/xHat continue
    // tracking, so accumulated sub-deadband drift eventually trips the band
    // and is released as a single (still sub-pixel) step.
    if (Math.abs(xHat - this.out) >= deadband) {
      this.out = xHat;
    }
    return this.out;
  }
}

/**
 * Tuned for MediaPipe NORMALIZED image landmarks (poseLandmarks: x/y in
 * ~[0,1] frame units, z in image-width units) at 30 fps:
 *  - minCutoff 1.0 Hz: at rest alpha ~= 0.17, which rejects ~90% of
 *    white-noise variance — this is what kills the idle avatar shake.
 *  - beta 3.0: a batting-swing wrist moves ~1.5 frame-widths/s, pushing the
 *    cutoff to ~5 Hz (alpha ~= 0.5) so the filter tracks a 10-frame swing
 *    with ~1 frame of lag (measured in scripts/verify-pose-smoothing.mjs).
 *  - deadband 0.0008 ~= half a pixel on a 640 px-wide frame: freezes the
 *    residual sub-pixel shimmer that the 1€ core can't remove without lag.
 */
export const IMAGE_SPACE_SMOOTHING: OneEuroParams = {
  minCutoff: 1.0,
  beta: 3.0,
  dCutoff: 1.0,
  deadband: 0.0008,
};

/**
 * Same profile for WORLD landmarks (poseWorldLandmarks, hip-anchored
 * meters). Speeds are numerically similar (fast swing ~= 2-4 m/s) so the
 * same cutoff/beta apply; deadband is 2 mm.
 */
export const WORLD_SPACE_SMOOTHING: OneEuroParams = {
  minCutoff: 1.0,
  beta: 3.0,
  dCutoff: 1.0,
  deadband: 0.002,
};

/**
 * Per-frame smoother for a full landmark array: one OneEuroFilter per
 * landmark per coordinate (33 x 3 channels), preallocated once at
 * construction. `filter()` mutates x/y/z in place — visibility is left
 * untouched so tracking-mode detection thresholds behave identically.
 */
export class LandmarkSmoother {
  private readonly channels: OneEuroFilter[];
  private readonly landmarkCount: number;
  private lastTimestamp = -1;

  constructor(params: OneEuroParams, landmarkCount = 33) {
    this.landmarkCount = landmarkCount;
    this.channels = new Array(landmarkCount * 3);
    for (let i = 0; i < this.channels.length; i++) {
      this.channels[i] = new OneEuroFilter(params);
    }
  }

  reset(): void {
    for (const c of this.channels) c.reset();
    this.lastTimestamp = -1;
  }

  /**
   * Smooth `landmarks` in place and return the same array (and the same
   * landmark object references) — no per-frame array/object churn.
   * Null/undefined input passes through unchanged.
   */
  filter<T extends Landmark[] | null | undefined>(landmarks: T, timestampMs?: number): T {
    if (!landmarks || landmarks.length === 0) return landmarks;

    const now =
      timestampMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let dt = this.lastTimestamp < 0 ? DEFAULT_DT : (now - this.lastTimestamp) / 1000;
    if (dt < MIN_DT) dt = MIN_DT;
    else if (dt > MAX_DT) dt = MAX_DT;
    this.lastTimestamp = now;

    const n = Math.min(landmarks.length, this.landmarkCount);
    for (let i = 0; i < n; i++) {
      const lm = landmarks[i];
      const base = i * 3;
      lm.x = this.channels[base].filter(lm.x, dt);
      lm.y = this.channels[base + 1].filter(lm.y, dt);
      lm.z = this.channels[base + 2].filter(lm.z, dt);
    }
    return landmarks;
  }
}

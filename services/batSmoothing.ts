import * as THREE from 'three';
import { OneEuroFilter, OneEuroParams, alpha } from './poseSmoothing';

/**
 * Derived-level bat smoothing.
 *
 * The bat's transform is computed from two noisy difference vectors
 * (wristDiff, forearmDir) crossed together — landmark smoothing alone
 * leaves the resulting orientation noise AMPLIFIED, which shows up as the
 * bat shaking in the player's hands. This smoother damps the bat transform
 * itself, one stage downstream of the landmark filters:
 *
 *  - position: an independent One Euro filter per axis (adaptive, so a fast
 *    swing opens the cutoff and the bat still tracks the hands);
 *  - orientation: the One Euro idea lifted to S3 — the angular speed
 *    between the current and target quaternion is low-passed, the cutoff
 *    rises with that speed, and the current orientation slerps toward the
 *    target by the resulting frame-rate-independent factor.
 *
 * Everything runs on the render clock (dt passed in by the caller) and all
 * state/scratch is preallocated: zero per-frame allocation.
 */

/** Position profile: near-still cutoff keeps the grip steady; beta 4 opens
 *  the filter within one render frame once the hands actually move. */
export const BAT_POSITION_SMOOTHING: OneEuroParams = {
  minCutoff: 1.2,
  beta: 4.0,
  dCutoff: 1.0,
  deadband: 0.0005, // 0.5mm in scene units
};

export interface QuatEuroParams {
  /** Cutoff (Hz) while the bat is rotationally still. */
  minCutoff: number;
  /** Cutoff increase (Hz) per rad/s of (smoothed) angular speed. */
  beta: number;
  /** Cutoff (Hz) of the angular-speed low-pass. */
  dCutoff: number;
}

/** Orientation profile: 1.5 Hz at rest damps residual landmark tremor;
 *  a full swing (~8-10 rad/s) lifts the cutoff to ~8 Hz so the bat keeps up. */
export const BAT_ORIENTATION_SMOOTHING: QuatEuroParams = {
  minCutoff: 1.5,
  beta: 0.8,
  dCutoff: 1.0,
};

/** Clamp dt so tab hiccups can't destabilize or stall the filters. */
const MIN_DT = 1 / 240;
const MAX_DT = 0.5;

const isFiniteVec = (v: THREE.Vector3): boolean =>
  Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const isFiniteQuat = (q: THREE.Quaternion): boolean =>
  Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w);

export class BatTransformSmoother {
  private readonly posFilters: [OneEuroFilter, OneEuroFilter, OneEuroFilter];
  private readonly q = new THREE.Quaternion();
  private angVel = 0;
  private initialized = false;

  constructor(
    private readonly oriParams: QuatEuroParams = BAT_ORIENTATION_SMOOTHING,
    posParams: OneEuroParams = BAT_POSITION_SMOOTHING,
  ) {
    this.posFilters = [
      new OneEuroFilter(posParams),
      new OneEuroFilter(posParams),
      new OneEuroFilter(posParams),
    ];
  }

  reset(): void {
    this.initialized = false;
    this.angVel = 0;
    for (const f of this.posFilters) f.reset();
  }

  /**
   * Damp `targetPos`/`targetQuat` toward the current smoothed transform,
   * writing results into `outPos`/`outQuat`. Non-finite targets are skipped
   * (the last good output is kept) so a degenerate landmark frame can never
   * NaN the bat.
   */
  filter(
    targetPos: THREE.Vector3,
    targetQuat: THREE.Quaternion,
    dt: number,
    outPos: THREE.Vector3,
    outQuat: THREE.Quaternion,
  ): void {
    if (!isFiniteVec(targetPos) || !isFiniteQuat(targetQuat)) return;

    let step = dt;
    if (step < MIN_DT) step = MIN_DT;
    else if (step > MAX_DT) step = MAX_DT;

    if (!this.initialized) {
      this.initialized = true;
      this.q.copy(targetQuat);
      this.posFilters[0].filter(targetPos.x, step);
      this.posFilters[1].filter(targetPos.y, step);
      this.posFilters[2].filter(targetPos.z, step);
      outPos.copy(targetPos);
      outQuat.copy(targetQuat);
      return;
    }

    outPos.set(
      this.posFilters[0].filter(targetPos.x, step),
      this.posFilters[1].filter(targetPos.y, step),
      this.posFilters[2].filter(targetPos.z, step),
    );

    // One Euro on S3: smoothed angular speed adapts the slerp factor.
    const dAng = this.q.angleTo(targetQuat) / step;
    const aD = alpha(this.oriParams.dCutoff, step);
    this.angVel += aD * (dAng - this.angVel);
    const cutoff = this.oriParams.minCutoff + this.oriParams.beta * this.angVel;
    this.q.slerp(targetQuat, alpha(cutoff, step));
    outQuat.copy(this.q);
  }
}

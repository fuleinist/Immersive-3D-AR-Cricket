import * as THREE from 'three';
import { OneEuroParams, alpha } from './poseSmoothing';

/**
 * Derived-level bat smoothing.
 *
 * The bat's transform is solved per frame from the grip forearm
 * (services/batTransform.ts): the body frame projected perpendicular to
 * the elbow->wrist axis. Landmark smoothing alone leaves the projected
 * orientation noise AMPLIFIED, which shows up as the bat shaking in the
 * player's hands. This smoother damps the bat transform itself, one
 * stage downstream of the landmark filters:
 *
 *  - position: an independent adaptive low-pass per axis (a fast swing
 *    opens the cutoff and the bat still tracks the hands);
 *  - orientation: the One Euro idea lifted to S3 — the angular speed of
 *    the TARGET stream is low-passed, the cutoff rises with that speed,
 *    and the current orientation slerps toward the target by the
 *    resulting frame-rate-independent factor.
 *
 * CADENCE DECOUPLING. The solved target only changes per POSE frame
 * (~30 Hz) while filter() runs per RENDER frame (~60 Hz). The adaptive
 * part of the filter — the derivative low-pass and the cutoff it sets —
 * is therefore updated only when the caller marks a genuinely new sample
 * (`newSample`, with the pose-cadence `sampleDt`). Integrating toward the
 * target still happens every render frame, so the output converges
 * continuously instead of stair-stepping at the pose rate. Updating the
 * derivative on the render clock instead would alias every pose step to a
 * 2x velocity spike followed by zeros (the cutoff sawtooths: over-tracking
 * each step, then freezing) — that was a direct cause of the bat's
 * perceived shake next to the smoothly-rendered body.
 *
 * The derivative itself is the ERROR speed (target minus filtered value,
 * normalized by the sample interval), not the sample-to-sample signal
 * speed: when the target steps, the cutoff opens in proportion to the
 * step and closes again as the output converges — a step swing settles
 * within a couple of render frames while a jittery target at rest only
 * ever opens the cutoff in proportion to its own tiny steps.
 *
 * Everything runs on the render clock (dt passed in by the caller) and all
 * state/scratch is preallocated: zero per-frame allocation.
 */

/** Position profile: near-still cutoff keeps the grip steady; beta 4 opens
 *  the filter within one pose frame once the hands actually move. */
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

/** Orientation profile: 1.2 Hz at rest damps residual landmark tremor;
 *  a full swing (~8-10 rad/s) lifts the cutoff to ~8 Hz so the bat keeps up. */
export const BAT_ORIENTATION_SMOOTHING: QuatEuroParams = {
  minCutoff: 1.2,
  beta: 0.8,
  dCutoff: 1.0,
};

/** Clamp dt so tab hiccups can't destabilize or stall the filters. */
const MIN_DT = 1 / 240;
const MAX_DT = 0.5;

const clampDt = (dt: number): number => (dt < MIN_DT ? MIN_DT : dt > MAX_DT ? MAX_DT : dt);

const isFiniteVec = (v: THREE.Vector3): boolean =>
  Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const isFiniteQuat = (q: THREE.Quaternion): boolean =>
  Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w);

/**
 * One adaptive low-pass scalar channel, One Euro flavored but with the
 * derivative/cutoff update decoupled from the per-call integration so the
 * adaptation can run on the sample clock while the output advances on the
 * (faster) render clock. All state is plain numbers.
 */
class ScalarChannel {
  private dxHat = 0;
  private cutoff: number;
  private xHat = 0;
  private out = 0;

  constructor(private readonly params: OneEuroParams) {
    this.cutoff = params.minCutoff;
  }

  /** Snap every piece of state to `x` (first call, or a smoother reset). */
  prime(x: number): void {
    this.dxHat = 0;
    this.cutoff = this.params.minCutoff;
    this.xHat = x;
    this.out = x;
  }

  /**
   * Register a genuinely NEW target sample, `dt` after the previous one:
   * low-pass the error speed (target minus filtered value) and re-derive
   * the adaptive cutoff. Must run at the target stream's own cadence —
   * calling it on repeated values would see the convergence shrink the
   * error and sawtooth the cutoff downward between real steps.
   */
  noteSample(x: number, dt: number): void {
    const dx = (x - this.xHat) / dt;
    this.dxHat += alpha(this.params.dCutoff, dt) * (dx - this.dxHat);
    this.cutoff = this.params.minCutoff + this.params.beta * Math.abs(this.dxHat);
  }

  /**
   * Advance the filtered value toward the current target by one frame of
   * `dt` seconds using the latest cutoff, and report it through the
   * deadband hysteresis (the internal value keeps tracking, so sub-band
   * drift accumulates and releases instead of freezing permanently).
   */
  advance(x: number, dt: number): number {
    const a = alpha(this.cutoff, dt);
    this.xHat += a * (x - this.xHat);
    if (Math.abs(this.xHat - this.out) >= this.params.deadband) {
      this.out = this.xHat;
    }
    return this.out;
  }
}

export class BatTransformSmoother {
  private readonly posChannels: [ScalarChannel, ScalarChannel, ScalarChannel];
  private readonly q = new THREE.Quaternion();
  private angVel = 0;
  private oriCutoff: number;
  private initialized = false;

  constructor(
    private readonly oriParams: QuatEuroParams = BAT_ORIENTATION_SMOOTHING,
    posParams: OneEuroParams = BAT_POSITION_SMOOTHING,
  ) {
    this.oriCutoff = oriParams.minCutoff;
    this.posChannels = [
      new ScalarChannel(posParams),
      new ScalarChannel(posParams),
      new ScalarChannel(posParams),
    ];
  }

  reset(): void {
    this.initialized = false;
    this.angVel = 0;
    this.oriCutoff = this.oriParams.minCutoff;
  }

  /**
   * Damp `targetPos`/`targetQuat` toward the current smoothed transform,
   * writing results into `outPos`/`outQuat`. Non-finite targets are skipped
   * (the last good output is kept) so a degenerate landmark frame can never
   * NaN the bat.
   *
   * `newSample` must be true exactly when the target carries genuinely new
   * pose information (once per pose frame), with `sampleDt` the time since
   * the previous sample — the adaptive cutoff updates only then. On plain
   * render frames (`newSample` false) the output simply keeps converging
   * toward the held target, which is what decouples the bat's smoothness
   * from the pose cadence.
   */
  filter(
    targetPos: THREE.Vector3,
    targetQuat: THREE.Quaternion,
    dt: number,
    outPos: THREE.Vector3,
    outQuat: THREE.Quaternion,
    newSample = true,
    sampleDt = dt,
  ): void {
    if (!isFiniteVec(targetPos) || !isFiniteQuat(targetQuat)) return;

    const step = clampDt(dt);
    const sampleStep = clampDt(sampleDt);

    if (!this.initialized) {
      this.initialized = true;
      this.q.copy(targetQuat);
      this.angVel = 0;
      this.oriCutoff = this.oriParams.minCutoff;
      this.posChannels[0].prime(targetPos.x);
      this.posChannels[1].prime(targetPos.y);
      this.posChannels[2].prime(targetPos.z);
      outPos.copy(targetPos);
      outQuat.copy(targetQuat);
      return;
    }

    if (newSample) {
      // Adaptive update on the SAMPLE clock only. Between samples the
      // cutoff holds, so convergence toward the held target is a clean
      // exponential instead of a decay-and-reheat sawtooth.
      this.posChannels[0].noteSample(targetPos.x, sampleStep);
      this.posChannels[1].noteSample(targetPos.y, sampleStep);
      this.posChannels[2].noteSample(targetPos.z, sampleStep);

      const dAng = this.q.angleTo(targetQuat) / sampleStep;
      this.angVel += alpha(this.oriParams.dCutoff, sampleStep) * (dAng - this.angVel);
      this.oriCutoff = this.oriParams.minCutoff + this.oriParams.beta * this.angVel;
    }

    outPos.set(
      this.posChannels[0].advance(targetPos.x, step),
      this.posChannels[1].advance(targetPos.y, step),
      this.posChannels[2].advance(targetPos.z, step),
    );

    this.q.slerp(targetQuat, alpha(this.oriCutoff, step));
    outQuat.copy(this.q);
  }
}

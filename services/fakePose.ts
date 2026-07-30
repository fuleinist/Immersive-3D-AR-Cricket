import { Landmark, PoseResults } from '../types';

/**
 * Synthetic pose stream for headless/dev harnesses (scripts/perf-probe.mjs).
 *
 * Lazily imported by WebcamPose ONLY when `window.__AR_CRICKET_FAKE_POSE__`
 * is set ('standing' | 'sitting') before page load — normal play never
 * downloads or runs this module. The stream mimics a MediaPipe result:
 * fresh landmark arrays per frame (matching MediaPipe's allocation shape
 * so allocation measurements stay honest), ~30 Hz cadence, per-channel
 * jitter, a periodic wrist swing, and a slow lateral body sway.
 *
 * 'sitting' mode reports an untracked lower body (visibility + framing
 * exactly like a desk-occluded player) so the tracking-mode detector
 * resolves SITTING and the seated adaptation path runs.
 */

const FRAME_MS = 33;
const UPPER_VIS = 0.95;

/** Deterministic-ish jitter: cheap LCG so streams vary but stay bounded. */
let seed = 42;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff - 0.5;
};

const lm = (x: number, y: number, z: number, visibility: number): Landmark => ({ x, y, z, visibility });

/**
 * Build one frame of normalized image landmarks. Layout follows the
 * standing set used by the verify harnesses; the right wrist traces a
 * periodic swing arc and the whole body sways laterally over time.
 */
const buildImageLandmarks = (t: number, sitting: boolean): Landmark[] => {
  const sway = Math.sin(t / 2500) * 0.03;
  const swingPhase = (t % 4000) / 4000;
  const swing = swingPhase < 0.25 ? Math.sin((swingPhase / 0.25) * Math.PI) : 0;
  const j = () => rand() * 0.004;

  const hipVis = sitting ? 0.2 : 0.9;
  const kneeVis = sitting ? 0.1 : 0.85;
  const ankleVis = sitting ? 0.05 : 0.8;
  const hipY = sitting ? 0.995 : 0.62;

  const l = Array.from({ length: 33 }, () => lm(0.5 + sway + j(), 0.3 + j(), 0, UPPER_VIS));
  l[0] = lm(0.5 + sway + j(), 0.12 + j(), 0, UPPER_VIS); // head
  l[11] = lm(0.4 + sway + j(), 0.3 + j(), 0, UPPER_VIS); // L shoulder
  l[12] = lm(0.6 + sway + j(), 0.3 + j(), 0, UPPER_VIS); // R shoulder
  l[13] = lm(0.33 + sway + j(), 0.45 + j(), -0.05, UPPER_VIS); // L elbow
  l[14] = lm(0.67 + sway + j() - swing * 0.05, 0.45 + j() - swing * 0.1, -0.05, UPPER_VIS); // R elbow
  l[15] = lm(0.35 + sway + j(), 0.55 + j(), -0.1, UPPER_VIS); // L wrist
  l[16] = lm(0.65 + sway + j() - swing * 0.15, 0.45 + j() - swing * 0.25, -0.1, UPPER_VIS); // R wrist
  l[23] = lm(0.45 + sway + j(), hipY, 0, hipVis);
  l[24] = lm(0.55 + sway + j(), hipY, 0, hipVis);
  l[25] = lm(0.45 + sway + j(), hipY + 0.18, 0, kneeVis);
  l[26] = lm(0.55 + sway + j(), hipY + 0.18, 0, kneeVis);
  l[27] = lm(0.45 + sway + j(), hipY + 0.36, 0, ankleVis);
  l[28] = lm(0.55 + sway + j(), hipY + 0.36, 0, ankleVis);
  return l;
};

/** Hip-anchored metric world landmarks, derived from the image frame. */
const buildWorldLandmarks = (img: Landmark[]): Landmark[] =>
  img.map((p) => ({
    x: (p.x - 0.5) * 0.9,
    y: (p.y - 0.62) * 1.6,
    z: p.z * 0.6,
    visibility: p.visibility,
  }));

/**
 * Drive `onPoseUpdate` with synthetic frames at ~30 Hz. Returns a stop
 * function. The caller owns lifecycle (invoke on unmount/cancel).
 */
export const startFakePoseLoop = (
  onPoseUpdate: (results: PoseResults) => void,
  sitting: boolean,
): (() => void) => {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const image = buildImageLandmarks(performance.now(), sitting);
    onPoseUpdate({
      poseLandmarks: image,
      poseWorldLandmarks: buildWorldLandmarks(image),
    });
  }, FRAME_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
};

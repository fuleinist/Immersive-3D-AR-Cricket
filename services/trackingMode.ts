import { Landmark, TrackingMode, ResolvedTrackingMode } from '../types';

/**
 * BlazePose (MediaPipe Pose) landmark indices — only the ones this module reads.
 * https://developers.google.com/mediapipe/solutions/vision/pose_landmarker
 */
export const POSE_INDEX = {
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;

/** Indices replaced with a synthetic standing pose by adaptSeatedLandmarks. */
const LOWER_BODY_INDICES: readonly number[] = [
  POSE_INDEX.LEFT_HIP, POSE_INDEX.RIGHT_HIP,
  POSE_INDEX.LEFT_KNEE, POSE_INDEX.RIGHT_KNEE,
  POSE_INDEX.LEFT_ANKLE, POSE_INDEX.RIGHT_ANKLE,
  POSE_INDEX.LEFT_HEEL, POSE_INDEX.RIGHT_HEEL,
  POSE_INDEX.LEFT_FOOT_INDEX, POSE_INDEX.RIGHT_FOOT_INDEX,
];

/**
 * Detection window. MediaPipe delivers ~30 pose frames/s, so 45 frames
 * covers roughly 1.5s of calibration while the player is in the menu.
 */
export const MODE_WINDOW_FRAMES = 45;

/**
 * Visibility thresholds. MediaPipe emits a per-landmark `visibility` score in
 * [0, 1]; occluded / out-of-frame landmarks typically score well under 0.5.
 */
const HIP_VIS_STANDING = 0.6; // both hips this visible -> strong standing evidence
const HIP_VIS_SEATED = 0.5;   // either hip below this -> seated evidence
const HIP_IN_FRAME_MAX_Y = 0.98; // normalized y; at/above the bottom edge counts as in-frame
const KNEE_VIS_STANDING = 0.4;
const ANKLE_VIS_PRESENT = 0.3;

/** Minimum share of classified (seated+standing) frames needed for a decision. */
const MIN_CLASSIFIED_RATIO = 0.3;
/** Seated must win this share of classified frames to flip the mode. */
const SEATED_DECISION_RATIO = 0.7;

/** Minimum shoulder visibility before we trust them to anchor a synthetic body. */
const MIN_SHOULDER_VISIBILITY = 0.5;

/**
 * Seated adaptation geometry. The synthetic lower body is a STANDING pose:
 * sit mode is only an input convenience — the avatar must read as standing
 * at the crease, framed identically to full-body tracking.
 *
 * Distances are in units of shoulder width; multiplied by
 * SEATED_METRIC_SHOULDER_WIDTH they become the meters used by the
 * hip-anchored output space (the same convention MediaPipe world landmarks
 * use: origin at the hips, y DOWN, feet ~0.95 below the hip root).
 */
const HIP_DROP = 1.4; // shoulder-mid -> hip-mid; ~= the 0.59m of a real torso
const HIP_NARROWING = 0.76; // hips slightly narrower than shoulders
const STANCE_WIDENING = 0.85; // feet slightly wider than hips, athletic stance
const KNEE_DROP = HIP_DROP + 1.07; // ~0.45m thigh
const ANKLE_DROP = HIP_DROP + 2.26; // ~0.95m hip->ankle, matches Avatar's default pose
const KNEE_FORWARD = 0.14; // ~6cm knee flex, z+ toward the viewer
const HEEL_DROP = ANKLE_DROP + 0.12;
const HEEL_BACK = 0.14; // heel behind the ankle
const FOOT_DROP = ANKLE_DROP + 0.17;
const FOOT_FORWARD = 0.24; // toes in front of the ankle
const SYNTHETIC_VISIBILITY = 0.9;

/**
 * Shoulder width the adapted pose is scaled to, in meters. MediaPipe world
 * landmarks report real meters (~0.4m between shoulder joints), so scaling
 * the seated pose to the same anatomical constant keeps the avatar the same
 * visual height across tracking modes.
 */
export const SEATED_METRIC_SHOULDER_WIDTH = 0.42;

/** Resulting hip->ankle drop of the synthetic legs, in meters. */
export const SEATED_METRIC_ANKLE_DEPTH = (ANKLE_DROP - HIP_DROP) * SEATED_METRIC_SHOULDER_WIDTH;

/** Clamp for the shoulder-width-derived scale, guarding degenerate frames. */
const MIN_ADAPT_SCALE = 0.5;
const MAX_ADAPT_SCALE = 4.0;

/** Per-frame summary of lower-body trackability, from normalized landmarks. */
export interface FrameSample {
  /** min(left, right) hip visibility — the weakest hip gates the decision. */
  hipVisibility: number;
  /** true when both hips sit above the bottom edge of the frame. */
  hipsInFrame: boolean;
  /** max(left, right) knee visibility — one good knee is enough. */
  kneeVisibility: number;
  /** max(left, right) ankle visibility. */
  ankleVisibility: number;
}

export type FrameClass = 'seated' | 'standing' | 'unknown';

export interface ModeDetection {
  mode: ResolvedTrackingMode;
  /** 0..1 — share of classified frames supporting the chosen mode. */
  confidence: number;
  /** seated / (seated + standing) across the window; NaN when nothing classified. */
  seatedFraction: number;
  frames: number;
  reason: string;
}

/**
 * Reduce one frame of normalized image landmarks to lower-body trackability
 * signals. Returns null when the frame carries no usable landmark data.
 */
export const sampleFrame = (landmarks: Landmark[] | null | undefined): FrameSample | null => {
  if (!landmarks || landmarks.length < 33) return null;
  const vis = (i: number) => landmarks[i]?.visibility ?? 0;
  const lHip = landmarks[POSE_INDEX.LEFT_HIP];
  const rHip = landmarks[POSE_INDEX.RIGHT_HIP];
  return {
    hipVisibility: Math.min(vis(POSE_INDEX.LEFT_HIP), vis(POSE_INDEX.RIGHT_HIP)),
    hipsInFrame: lHip.y < HIP_IN_FRAME_MAX_Y && rHip.y < HIP_IN_FRAME_MAX_Y,
    kneeVisibility: Math.max(vis(POSE_INDEX.LEFT_KNEE), vis(POSE_INDEX.RIGHT_KNEE)),
    ankleVisibility: Math.max(vis(POSE_INDEX.LEFT_ANKLE), vis(POSE_INDEX.RIGHT_ANKLE)),
  };
};

/**
 * Classify a single frame.
 *
 * Seated evidence: hips weakly tracked, hips at/below the frame's bottom edge,
 * or knees+ankles both gone (desk occlusion). Standing evidence requires hips
 * AND knees confidently tracked inside the frame. Anything between is unknown
 * so it cannot sway the windowed vote.
 *
 * Known limitation: a standing player very close to the camera (hips cropped
 * by the frame, not by a desk) classifies as seated — indistinguishable from
 * a seated player in a single frame. The manual mode selector overrides this.
 */
export const classifyFrame = (sample: FrameSample): FrameClass => {
  const lowerBodyGone =
    sample.kneeVisibility < KNEE_VIS_STANDING && sample.ankleVisibility < ANKLE_VIS_PRESENT;

  if (sample.hipVisibility < HIP_VIS_SEATED || !sample.hipsInFrame || lowerBodyGone) {
    return 'seated';
  }
  if (
    sample.hipVisibility >= HIP_VIS_STANDING &&
    sample.hipsInFrame &&
    sample.kneeVisibility >= KNEE_VIS_STANDING
  ) {
    return 'standing';
  }
  return 'unknown';
};

/**
 * Windowed decision over a run of frame samples. Biased to STANDING: it is
 * the historical behavior, and ambiguous/insufficient data must never flip a
 * standing player into sit adaptations. A player who steps back only becomes
 * MORE visible, so this cannot false-trigger in that direction.
 */
export const detectTrackingMode = (samples: FrameSample[]): ModeDetection => {
  let seated = 0;
  let standing = 0;
  for (const s of samples) {
    const cls = classifyFrame(s);
    if (cls === 'seated') seated += 1;
    else if (cls === 'standing') standing += 1;
  }

  const frames = samples.length;
  const classified = seated + standing;
  const insufficient: ModeDetection = {
    mode: TrackingMode.STANDING,
    confidence: 0.5,
    seatedFraction: classified > 0 ? seated / classified : 0,
    frames,
    reason: `insufficient classified frames (${classified}/${frames}) — defaulting to standing`,
  };
  if (frames === 0 || classified < Math.max(5, frames * MIN_CLASSIFIED_RATIO)) {
    return insufficient;
  }

  const seatedFraction = seated / classified;
  if (seatedFraction >= SEATED_DECISION_RATIO) {
    return {
      mode: TrackingMode.SITTING,
      confidence: seatedFraction,
      seatedFraction,
      frames,
      reason: `${Math.round(seatedFraction * 100)}% of ${classified} classified frames show an untracked lower body`,
    };
  }
  return {
    mode: TrackingMode.STANDING,
    confidence: 1 - seatedFraction,
    seatedFraction,
    frames,
    reason: seatedFraction > 1 - SEATED_DECISION_RATIO
      ? `mixed signal (${Math.round(seatedFraction * 100)}% seated) — biased to standing`
      : `${Math.round((1 - seatedFraction) * 100)}% of ${classified} classified frames show a tracked lower body`,
  };
};

/**
 * Sit Mode adaptation: return a copy of `landmarks` re-expressed in the same
 * hip-anchored metric space that MediaPipe world landmarks use (origin at
 * the hips, y down, meters), with the lower body (indices 23-32) replaced by
 * a synthetic STANDING pose.
 *
 * The whole pose is translated so the synthetic hip center sits at the
 * origin and uniformly scaled so the shoulder span equals
 * SEATED_METRIC_SHOULDER_WIDTH. Because the transform is a similitude, all
 * relative upper-body geometry — including the wrist/shoulder direction
 * vectors the bat orientation derives from — is preserved exactly; only the
 * absolute anchor and scale change. That is what keeps the avatar on the
 * same ground plane and at the same visual height as full-body tracking:
 * the renderer consumes one space convention regardless of tracking mode,
 * with hips at the root and feet ~0.95m below, instead of mapping raw image
 * coordinates through the world-landmark path.
 *
 * Works in either input landmark space (normalized image or world meters)
 * because all proportions derive from the shoulder span. When the shoulders
 * themselves are untracked, the input is returned unchanged — fabricating a
 * body around garbage would look worse than the existing default-pose
 * fallback.
 */
export const adaptSeatedLandmarks = (landmarks: Landmark[]): Landmark[] => {
  if (!landmarks || landmarks.length < 33) return landmarks;

  const lS = landmarks[POSE_INDEX.LEFT_SHOULDER];
  const rS = landmarks[POSE_INDEX.RIGHT_SHOULDER];
  const shoulderVis = Math.min(lS.visibility ?? 1, rS.visibility ?? 1);
  if (shoulderVis < MIN_SHOULDER_VISIBILITY) return landmarks;

  const shoulderWidth = Math.hypot(lS.x - rS.x, lS.y - rS.y, lS.z - rS.z);
  if (shoulderWidth < 0.01) return landmarks;

  const scale = Math.min(
    MAX_ADAPT_SCALE,
    Math.max(MIN_ADAPT_SCALE, SEATED_METRIC_SHOULDER_WIDTH / shoulderWidth),
  );

  // Anchor: the synthetic hip center in INPUT space — shoulder midpoint
  // dropped by the torso length (image y is down-positive, as is the output
  // space, so +drop moves down in both).
  const anchorX = (lS.x + rS.x) / 2;
  const anchorY = (lS.y + rS.y) / 2 + HIP_DROP * shoulderWidth;
  const anchorZ = (lS.z + rS.z) / 2;

  const out = landmarks.slice();
  for (let i = 0; i < landmarks.length; i++) {
    if (LOWER_BODY_INDICES.includes(i)) continue;
    const p = landmarks[i];
    out[i] = {
      x: (p.x - anchorX) * scale,
      y: (p.y - anchorY) * scale,
      z: (p.z - anchorZ) * scale,
      visibility: p.visibility,
    };
  }

  // Synthetic standing legs, built directly in the hip-anchored metric
  // output space. x follows the live (transformed) shoulders so the stance
  // tracks lateral sway; y/z are fixed anatomical constants.
  const lSx = out[POSE_INDEX.LEFT_SHOULDER].x;
  const rSx = out[POSE_INDEX.RIGHT_SHOULDER].x;
  const set = (leftIdx: number, rightIdx: number, lateral: number, y: number, z: number) => {
    out[leftIdx] = { x: lSx * lateral, y, z, visibility: SYNTHETIC_VISIBILITY };
    out[rightIdx] = { x: rSx * lateral, y, z, visibility: SYNTHETIC_VISIBILITY };
  };

  set(POSE_INDEX.LEFT_HIP, POSE_INDEX.RIGHT_HIP, HIP_NARROWING, 0, 0);
  set(POSE_INDEX.LEFT_KNEE, POSE_INDEX.RIGHT_KNEE, STANCE_WIDENING, (KNEE_DROP - HIP_DROP) * SEATED_METRIC_SHOULDER_WIDTH, KNEE_FORWARD * SEATED_METRIC_SHOULDER_WIDTH);
  set(POSE_INDEX.LEFT_ANKLE, POSE_INDEX.RIGHT_ANKLE, STANCE_WIDENING, SEATED_METRIC_ANKLE_DEPTH, 0);
  set(POSE_INDEX.LEFT_HEEL, POSE_INDEX.RIGHT_HEEL, STANCE_WIDENING, (HEEL_DROP - HIP_DROP) * SEATED_METRIC_SHOULDER_WIDTH, -HEEL_BACK * SEATED_METRIC_SHOULDER_WIDTH);
  set(POSE_INDEX.LEFT_FOOT_INDEX, POSE_INDEX.RIGHT_FOOT_INDEX, STANCE_WIDENING, (FOOT_DROP - HIP_DROP) * SEATED_METRIC_SHOULDER_WIDTH, FOOT_FORWARD * SEATED_METRIC_SHOULDER_WIDTH);

  return out;
};

/** Indices that adaptSeatedLandmarks replaces — exported for tests/tooling. */
export const ADAPTED_LOWER_BODY_INDICES: readonly number[] = LOWER_BODY_INDICES;

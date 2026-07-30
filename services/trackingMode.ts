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

/** Indices replaced with a synthetic seated pose by adaptSeatedLandmarks. */
const LOWER_BODY_INDICES = [
  POSE_INDEX.LEFT_HIP, POSE_INDEX.RIGHT_HIP,
  POSE_INDEX.LEFT_KNEE, POSE_INDEX.RIGHT_KNEE,
  POSE_INDEX.LEFT_ANKLE, POSE_INDEX.RIGHT_ANKLE,
  POSE_INDEX.LEFT_HEEL, POSE_INDEX.RIGHT_HEEL,
  POSE_INDEX.LEFT_FOOT_INDEX, POSE_INDEX.RIGHT_FOOT_INDEX,
] as const;

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
 * Synthetic seated-lower-body proportions, in units of shoulder width.
 * Empirically tuned so the avatar's legs read as "sitting on a chair" for
 * typical webcam framing (head + torso in frame, desk below).
 */
const HIP_DROP = 1.4;
const KNEE_DROP = 1.75;
const ANKLE_DROP = 2.4;
const KNEE_FORWARD = 0.9; // knees toward the camera (negative z = closer)
const ANKLE_FORWARD = 0.7;
const HIP_NARROWING = 0.76; // hips slightly narrower than shoulders
const SYNTHETIC_VISIBILITY = 0.9;

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
 * Sit Mode adaptation: return a copy of `landmarks` where the lower body
 * (hips..feet, indices 23-32) is replaced by a synthetic seated pose anchored
 * to the LIVE shoulders. Upper-body landmarks keep their original object
 * references, so wrist/shoulder-driven shot detection sees identical values.
 *
 * Works in either landmark space (normalized image or world meters) because
 * all proportions derive from the shoulder span; callers choose which array
 * to feed. When the shoulders themselves are untracked, the input is returned
 * unchanged — fabricating a body around garbage would look worse than the
 * existing default-pose fallback.
 */
export const adaptSeatedLandmarks = (landmarks: Landmark[]): Landmark[] => {
  if (!landmarks || landmarks.length < 33) return landmarks;

  const lS = landmarks[POSE_INDEX.LEFT_SHOULDER];
  const rS = landmarks[POSE_INDEX.RIGHT_SHOULDER];
  const shoulderVis = Math.min(lS.visibility ?? 1, rS.visibility ?? 1);
  if (shoulderVis < MIN_SHOULDER_VISIBILITY) return landmarks;

  const shoulderWidth = Math.hypot(lS.x - rS.x, lS.y - rS.y, lS.z - rS.z);
  if (shoulderWidth < 0.01) return landmarks;

  const w = shoulderWidth;
  const midX = (lS.x + rS.x) / 2;
  const midY = (lS.y + rS.y) / 2;

  // Per-side anchors: interpolate between midline and shoulder so the
  // synthetic joints stay on the anatomically correct side.
  const side = (shoulder: Landmark, lateral: number, drop: number, forward: number): Landmark => ({
    x: midX + (shoulder.x - midX) * lateral,
    y: midY + drop * w,
    z: shoulder.z - forward * w,
    visibility: SYNTHETIC_VISIBILITY,
  });

  const out = landmarks.slice();
  const set = (leftIdx: number, rightIdx: number, lateral: number, drop: number, forward: number) => {
    out[leftIdx] = side(lS, lateral, drop, forward);
    out[rightIdx] = side(rS, lateral, drop, forward);
  };

  set(POSE_INDEX.LEFT_HIP, POSE_INDEX.RIGHT_HIP, HIP_NARROWING, HIP_DROP, 0);
  set(POSE_INDEX.LEFT_KNEE, POSE_INDEX.RIGHT_KNEE, 0.9, KNEE_DROP, KNEE_FORWARD);
  set(POSE_INDEX.LEFT_ANKLE, POSE_INDEX.RIGHT_ANKLE, 0.9, ANKLE_DROP, ANKLE_FORWARD);
  set(POSE_INDEX.LEFT_HEEL, POSE_INDEX.RIGHT_HEEL, 0.9, ANKLE_DROP + 0.08, ANKLE_FORWARD + 0.1);
  set(POSE_INDEX.LEFT_FOOT_INDEX, POSE_INDEX.RIGHT_FOOT_INDEX, 0.9, ANKLE_DROP + 0.1, ANKLE_FORWARD - 0.35);

  return out;
};

/** Indices that adaptSeatedLandmarks replaces — exported for tests/tooling. */
export const ADAPTED_LOWER_BODY_INDICES: readonly number[] = LOWER_BODY_INDICES;

/**
 * Pure boundary follow-cam trajectory (issue #15).
 *
 * No React, no three, no DOM, no Math.random, no Date.now. Shared by
 * components/Scene.tsx and scripts/verify-follow-cam.mjs.
 *
 * World convention: +z runs from the bowler toward the batter, +y is up,
 * +x is the leg side for a right-hander. The boundary is a 65 m circle
 * centred on the origin.
 */

export const FOLLOW_CAM_DURATION_S = 1.8;

export interface FollowCamPose {
  posX: number;
  posY: number;
  posZ: number;
  targetX: number;
  targetY: number;
  targetZ: number;
}

export const BASE_CAMERA: Readonly<FollowCamPose> = {
  posX: 0,
  posY: 1.8,
  posZ: 6,
  targetX: 0,
  targetY: 1.0,
  targetZ: 0,
};

const BOUNDARY_RADIUS_M = 65;

// Peak camera translation parameters at full boundary reach (65 m).
// Lateral push shifts the camera toward the shot bearing on X; depth push
// biases Z toward the shot while CAMERA_BACK_M keeps the lens safely behind
// the stumps (z = +1.35) and CAMERA_LIFT_M elevates for a clear outfield view.
const POS_LATERAL_GAIN = 0.08; // +/- 5.2 m at 65 m
const POS_DEPTH_GAIN = 0.02;   // +/- 1.3 m at 65 m
const CAMERA_BACK_M = 2.0;
const CAMERA_LIFT_M = 2.2;

function smoothstep01(t: number): number {
  return t * t * (3 - 2 * t);
}

function writeBase(dest: FollowCamPose): FollowCamPose {
  dest.posX = BASE_CAMERA.posX;
  dest.posY = BASE_CAMERA.posY;
  dest.posZ = BASE_CAMERA.posZ;
  dest.targetX = BASE_CAMERA.targetX;
  dest.targetY = BASE_CAMERA.targetY;
  dest.targetZ = BASE_CAMERA.targetZ;
  return dest;
}

/**
 * Evaluates the boundary follow-cam pose at `elapsedS` seconds after contact
 * for a ball heading toward `(landingX, landingZ)` on the turf plane.
 *
 * - Returns bit-identical BASE_CAMERA for `elapsedS <= 0` or
 *   `elapsedS >= FOLLOW_CAM_DURATION_S`.
 * - Writes into `out` when provided so the render loop allocates nothing.
 * - Clamps the landing point to the 65 m boundary circle.
 */
export function followCamPose(
  elapsedS: number,
  landingX: number,
  landingZ: number,
  out?: FollowCamPose,
): FollowCamPose {
  const dest: FollowCamPose = out ?? {
    posX: BASE_CAMERA.posX,
    posY: BASE_CAMERA.posY,
    posZ: BASE_CAMERA.posZ,
    targetX: BASE_CAMERA.targetX,
    targetY: BASE_CAMERA.targetY,
    targetZ: BASE_CAMERA.targetZ,
  };

  if (!Number.isFinite(elapsedS) || elapsedS <= 0 || elapsedS >= FOLLOW_CAM_DURATION_S) {
    return writeBase(dest);
  }

  const safeX = Number.isFinite(landingX) ? landingX : 0;
  const safeZ = Number.isFinite(landingZ) ? landingZ : 0;

  let cx = safeX;
  let cz = safeZ;
  let clampedDist = Math.hypot(safeX, safeZ);

  if (!Number.isFinite(clampedDist)) {
    const angle = Math.atan2(safeZ, safeX);
    cx = Math.cos(angle) * BOUNDARY_RADIUS_M;
    cz = Math.sin(angle) * BOUNDARY_RADIUS_M;
    clampedDist = BOUNDARY_RADIUS_M;
  } else if (clampedDist > BOUNDARY_RADIUS_M) {
    const scale = BOUNDARY_RADIUS_M / clampedDist;
    cx = safeX * scale;
    cz = safeZ * scale;
    clampedDist = BOUNDARY_RADIUS_M;
  }

  const reach = clampedDist / BOUNDARY_RADIUS_M;

  // Symmetric smoothstep bell peaking at the midpoint (u = 0.5, elapsedS = 0.9 s).
  const u = elapsedS / FOLLOW_CAM_DURATION_S;
  const half = u <= 0.5 ? u * 2 : (1 - u) * 2;
  const w = smoothstep01(half);

  dest.posX = BASE_CAMERA.posX + w * (cx * POS_LATERAL_GAIN);
  dest.posY = BASE_CAMERA.posY + w * (CAMERA_LIFT_M * reach);
  dest.posZ = BASE_CAMERA.posZ + w * (CAMERA_BACK_M * reach + cz * POS_DEPTH_GAIN);

  dest.targetX = BASE_CAMERA.targetX + w * (cx - BASE_CAMERA.targetX);
  dest.targetY = BASE_CAMERA.targetY * (1 - w * reach);
  dest.targetZ = BASE_CAMERA.targetZ + w * (cz - BASE_CAMERA.targetZ);

  return dest;
}

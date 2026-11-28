/**
 * Pure cricket ground layout geometry in metres.
 *
 * No React, no three.js, no DOM. Shared by components/CricketGround.tsx and
 * scripts/verify-ground-layout.mjs.
 *
 * Coordinate convention:
 * - Pitch long axis runs along z, centred on the origin (0, 0).
 * - Batsman-end stumps sit at z = +10.06 (+PITCH_LENGTH / 2); bowler-end
 *   stumps sit at z = -10.06 (-PITCH_LENGTH / 2).
 * - Popping creases sit POPPING_CREASE_FROM_STUMPS (1.22 m) in front of each
 *   bowling crease, toward the centre of the pitch (z = +/-8.84).
 * - Angles for boundaryPoint(angleRad) use standard XZ polar coordinates:
 *   x = r * cos(angleRad), z = r * sin(angleRad).
 */

export const PITCH_LENGTH = 20.12;
export const PITCH_WIDTH = 3.05;
export const BOUNDARY_RADIUS = 65;
export const THIRTY_YARD_RADIUS = 27.43;
export const POPPING_CREASE_FROM_STUMPS = 1.22;

/** Standard MCC Law 7 crease dimensions in metres. */
export const BOWLING_CREASE_WIDTH = 2.64;
export const POPPING_CREASE_WIDTH = 3.66;
export const CREASE_LINE_DEPTH = 0.05;

export interface CreaseLine {
  x: number;
  z: number;
  width: number;
  depth: number;
}

export interface GroundPoint {
  x: number;
  z: number;
}

/**
 * Returns the four crease markings (bowling crease and popping crease at both
 * ends of the pitch), symmetric about the origin.
 */
export function creaseLines(): CreaseLine[] {
  const halfPitch = PITCH_LENGTH / 2;
  const poppingZ = halfPitch - POPPING_CREASE_FROM_STUMPS;

  return [
    // Bowler end (z < 0)
    { x: 0, z: -halfPitch, width: BOWLING_CREASE_WIDTH, depth: CREASE_LINE_DEPTH },
    { x: 0, z: -poppingZ, width: POPPING_CREASE_WIDTH, depth: CREASE_LINE_DEPTH },
    // Batsman end (z > 0)
    { x: 0, z: poppingZ, width: POPPING_CREASE_WIDTH, depth: CREASE_LINE_DEPTH },
    { x: 0, z: halfPitch, width: BOWLING_CREASE_WIDTH, depth: CREASE_LINE_DEPTH },
  ];
}

/** Point on the 65 m boundary circle at the given angle in radians. */
export function boundaryPoint(angleRad: number): GroundPoint {
  return {
    x: Math.cos(angleRad) * BOUNDARY_RADIUS,
    z: Math.sin(angleRad) * BOUNDARY_RADIUS,
  };
}

/** True when (x, z) lies inside or on the 65 m boundary circle. */
export function isInsideBoundary(x: number, z: number): boolean {
  return Math.hypot(x, z) <= BOUNDARY_RADIUS;
}

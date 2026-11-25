/**
 * Pure fielding simulation for the post-hit phase.
 *
 * No React, no three, no DOM. Same code path as the headless harness
 * (scripts/verify-fielding-sim.mjs). No Math.random, no Date.now: the same
 * input always produces the same output.
 *
 * World convention is the one services/shotPhysics.ts uses: +z runs from the
 * bowler toward the batter, +y is up, +x is the leg side for a right-hander.
 * Fielders are placed by bearing angle in degrees and radius in metres from the
 * batter, so a wagon wheel reads directly from the preset lists.
 */

import { GRAVITY } from './shotPhysics';
import type { Vec3 } from './shotPhysics';

export type FieldingOutcome =
  | 'SIX' | 'FOUR' | 'THREE' | 'TWO' | 'SINGLE' | 'DEFENSE' | 'CAUGHT';

export interface FielderPosition {
  id: string;
  label: string;
  x: number;
  z: number;
}

export interface FieldingResult {
  outcome: FieldingOutcome;
  runs: number;
  landingXZ: [number, number];
  carryM: number;
  angleDeg: number;
  interceptTimeS: number | null;
  caughtById: string | null;
}

export const BOUNDARY_M = 65;
export const DRAG_COEFF = 0.012;
export const ROLL_FRICTION = 0.28;
export const FIELDER_SPEED = 6.5;
export const CATCH_RADIUS_M = 2.2;
export const CATCH_MIN_T = 0.35;
export const CATCH_MIN_Y = 0.2;
export const CATCH_MAX_Y = 2.4;
export const INTERCEPT_RADIUS_M = 1.0;
export const STEP_S = 0.005;
export const MAX_FLIGHT_S = 8;
export const STOP_SPEED = 0.5;

/* ------------------------------------------------------------- fielder presets */

function f(id: string, label: string, angleDeg: number, r: number): FielderPosition {
  const a = (angleDeg * Math.PI) / 180;
  return { id, label, x: r * Math.sin(a), z: -r * Math.cos(a) };
}

export const FIELD_PRESETS: Record<string, FielderPosition[]> = {
  'warne-1993': [
    f('slip', 'Slip', -125, 10),
    f('silly-point', 'Silly point', -30, 6),
    f('short-leg', 'Short leg', 35, 8),
    f('mid-wicket', 'Mid-wicket', 55, 25),
    f('cover', 'Cover', -50, 26),
    f('mid-off', 'Mid-off', -15, 24),
    f('mid-on', 'Mid-on', 12, 24),
    f('deep-square-leg', 'Deep square leg', 95, 58),
    f('long-on', 'Long-on', 20, 60),
  ],
  'murali-2004': [
    f('slip', 'Slip', -125, 9),
    f('silly-point', 'Silly point', -28, 6),
    f('short-leg', 'Short leg', 32, 7),
    f('mid-wicket', 'Mid-wicket', 58, 26),
    f('cover', 'Cover', -48, 27),
    f('mid-off', 'Mid-off', -12, 25),
    f('mid-on', 'Mid-on', 15, 25),
    f('deep-square-leg', 'Deep square leg', 92, 56),
    f('long-on', 'Long-on', 22, 62),
  ],
  'wasim-1992': [
    f('slip-1', 'First slip', -125, 10),
    f('slip-2', 'Second slip', -135, 12),
    f('gully', 'Gully', -105, 14),
    f('point', 'Point', -85, 22),
    f('cover', 'Cover', -50, 26),
    f('mid-off', 'Mid-off', -15, 24),
    f('mid-on', 'Mid-on', 12, 24),
    f('fine-leg', 'Fine leg', 140, 44),
    f('third-man', 'Third man', -140, 44),
  ],
  'lee-2002': [
    f('slip-1', 'First slip', -124, 10),
    f('slip-2', 'Second slip', -134, 11),
    f('gully', 'Gully', -104, 15),
    f('point', 'Point', -84, 23),
    f('cover', 'Cover', -49, 27),
    f('mid-off', 'Mid-off', -14, 25),
    f('mid-on', 'Mid-on', 13, 25),
    f('fine-leg', 'Fine leg', 138, 46),
    f('third-man', 'Third man', -138, 46),
  ],
  'bumrah-2019': [
    f('long-on', 'Long-on', 20, 60),
    f('long-off', 'Long-off', -20, 60),
    f('deep-mid-wicket', 'Deep mid-wicket', 65, 58),
    f('deep-point', 'Deep point', -85, 58),
    f('fine-leg', 'Fine leg', 140, 50),
    f('cover', 'Cover', -50, 26),
    f('mid-off', 'Mid-off', -12, 24),
    f('mid-on', 'Mid-on', 14, 24),
    f('square-leg', 'Square leg', 90, 22),
  ],
};

/* ----------------------------------------------------------- pure functions */

export function fieldersFor(deliveryId: string): FielderPosition[] {
  return FIELD_PRESETS[deliveryId] ?? FIELD_PRESETS['lee-2002'];
}

export function classifyByIntercept(
  interceptTimeS: number | null,
  interceptDistanceM: number | null,
): FieldingOutcome {
  if (interceptTimeS === null || interceptDistanceM === null) return 'FOUR';
  if (interceptDistanceM <= 12 || interceptTimeS < 1.1) return 'DEFENSE';
  if (interceptTimeS < 2.1) return 'SINGLE';
  if (interceptTimeS < 3.4) return 'TWO';
  return 'THREE';
}

function runsFor(outcome: FieldingOutcome): number {
  switch (outcome) {
    case 'SIX': return 6;
    case 'FOUR': return 4;
    case 'THREE': return 3;
    case 'TWO': return 2;
    case 'SINGLE': return 1;
    default: return 0; // DEFENSE and CAUGHT
  }
}

/**
 * One shot, end to end: flight with quadratic drag, the catch window before the
 * first bounce, then the rolling phase with rolling friction, the rope, and the
 * fielder closing on the ball. Deterministic - no random, no clock.
 */
export function simulateFielding(
  contactPoint: Vec3,
  exitVelocity: Vec3,
  deliveryId: string,
): FieldingResult {
  const fielders = fieldersFor(deliveryId);

  const p: Vec3 = { x: contactPoint.x, y: contactPoint.y, z: contactPoint.z };
  const v: Vec3 = { x: exitVelocity.x, y: exitVelocity.y, z: exitVelocity.z };

  let t = 0;
  let carryM = 0;
  let firstBounce: { x: number; z: number } | null = null;
  const angleDeg = (Math.atan2(v.x, -v.z) * 180) / Math.PI;

  const result = (
    outcome: FieldingOutcome,
    landingXZ: [number, number],
    interceptTimeS: number | null,
    caughtById: string | null,
  ): FieldingResult => ({
    outcome,
    runs: runsFor(outcome),
    landingXZ,
    carryM,
    angleDeg,
    interceptTimeS,
    caughtById,
  });

  while (t < MAX_FLIGHT_S) {
    const speed = Math.hypot(v.x, v.y, v.z);
    const ax = -DRAG_COEFF * speed * v.x;
    const ay = -GRAVITY - DRAG_COEFF * speed * v.y;
    const az = -DRAG_COEFF * speed * v.z;
    v.x += ax * STEP_S;
    v.y += ay * STEP_S;
    v.z += az * STEP_S;
    p.x += v.x * STEP_S;
    p.y += v.y * STEP_S;
    p.z += v.z * STEP_S;
    t += STEP_S;

    if (firstBounce === null) {
      // Catch window, ahead of the boundary check of the same step.
      if (t >= CATCH_MIN_T) {
        for (const fielder of fielders) {
          if (
            Math.hypot(p.x - fielder.x, p.z - fielder.z) <= CATCH_RADIUS_M &&
            p.y >= CATCH_MIN_Y &&
            p.y <= CATCH_MAX_Y
          ) {
            const landing = firstBounce ?? { x: p.x, z: p.z };
            return result('CAUGHT', [landing.x, landing.z], t, fielder.id);
          }
        }
      }

      if (p.y <= 0) {
        firstBounce = { x: p.x, z: p.z };
        carryM = Math.hypot(p.x - contactPoint.x, p.z - contactPoint.z);
        if (carryM >= BOUNDARY_M) return result('SIX', [firstBounce.x, firstBounce.z], null, null);
      }
    } else {
      // Rolling phase.
      p.y = 0;
      v.y = 0;
      const k = Math.max(0, 1 - (ROLL_FRICTION * GRAVITY * STEP_S) / Math.max(speed, 1e-6));
      v.x *= k;
      v.z *= k;

      carryM = Math.hypot(p.x - contactPoint.x, p.z - contactPoint.z);

      // The rope first.
      if (carryM >= BOUNDARY_M) return result('FOUR', [p.x, p.z], null, null);

      // Then the fielder closing on the ball.
      for (const fielder of fielders) {
        const gap = Math.hypot(p.x - fielder.x, p.z - fielder.z) - FIELDER_SPEED * Math.max(0, t - CATCH_MIN_T);
        if (gap <= INTERCEPT_RADIUS_M) {
          const outcome = classifyByIntercept(t, carryM);
          return result(outcome, [p.x, p.z], t, null);
        }
      }

      const horizontalSpeed = Math.hypot(v.x, v.z);
      if (horizontalSpeed < STOP_SPEED) return result('THREE', [p.x, p.z], null, null);
    }
  }

  return result('THREE', [p.x, p.z], null, null);
}

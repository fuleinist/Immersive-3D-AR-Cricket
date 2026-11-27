/**
 * Wagon-wheel geometry for the innings result card (issue #15).
 *
 * Pure: no React, no three, no DOM, no clock. It only turns recorded balls
 * that carry a landing point into chart-ready angles, sectors and radii.
 */

import type { BallRecord } from '../types';
import { ShotResult } from '../types';

export const SECTOR_COUNT = 8;
export const SECTOR_DEG = 360 / SECTOR_COUNT;

export type WagonOutcome = 'SIX' | 'FOUR' | 'RUNS' | 'WICKET' | 'DOT';

export interface WagonWheelShot {
  angleDeg: number;
  sector: number;
  outcome: WagonOutcome;
  runs: number;
  x: number;
  z: number;
  radius: number;
}

/** Chart-facing outcome. The scoreboard's coarse DEFENSE stays split by runs. */
export function outcomeOf(ball: BallRecord): WagonOutcome {
  if (ball.result === ShotResult.SIX) return 'SIX';
  if (ball.result === ShotResult.FOUR) return 'FOUR';
  if (ball.result === ShotResult.OUT) return 'WICKET';
  if (ball.runs > 0) return 'RUNS';
  return 'DOT';
}

/**
 * Bearing in degrees. 0 points straight down the ground at the bowler (-z) and
 * increases clockwise toward +x. Normalized into 0..360.
 */
export function angleDegFor(x: number, z: number): number {
  const deg = (Math.atan2(x, -z) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/** Sector index 0..7 for a bearing, wrapping negative and over-360 inputs. */
export function sectorOf(angleDeg: number): number {
  const wrapped = ((angleDeg % 360) + 360) % 360;
  return Math.floor(wrapped / SECTOR_DEG);
}

/** One entry per recorded ball that has a landing point, in history order. */
export function wagonWheel(history: BallRecord[], boundaryM = 65): WagonWheelShot[] {
  const shots: WagonWheelShot[] = [];
  for (const ball of history) {
    if (!ball.landingXZ) continue;
    const [x, z] = ball.landingXZ;
    const angleDeg = angleDegFor(x, z);
    shots.push({
      angleDeg,
      sector: sectorOf(angleDeg),
      outcome: outcomeOf(ball),
      runs: ball.runs,
      x,
      z,
      radius: Math.min(1, Math.hypot(x, z) / boundaryM),
    });
  }
  return shots;
}

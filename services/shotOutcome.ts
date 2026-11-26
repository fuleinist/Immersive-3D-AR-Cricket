/**
 * Live shot outcome: the bridge from the bat-ball exit velocity to the runs,
 * the coarse ShotResult the scoreboard uses, and the fielding position when a
 * catch is taken (issue #15, scoring bullet).
 *
 * Pure: no React, no three, no DOM, no clock, no random. The same input always
 * produces the same output. services/fieldingSim.ts owns the physics; this
 * module only decides what the game does with it.
 *
 * Why the coarse result keeps five members: ShotResult is read by seven files,
 * several through exhaustive Record maps. A wider enum would widen this change
 * for no gameplay gain. A single, a two and a three therefore report DEFENSE
 * with real runs, and a catch reports OUT because it is a dismissal.
 */

import { ShotResult } from '../types';
import { fieldersFor, simulateFielding } from './fieldingSim';
import type { FieldingOutcome, FieldingResult } from './fieldingSim';
import type { Vec3 } from './shotPhysics';

/**
 * Runs for each fielding outcome. This is the single runs table for the live
 * path and it agrees with the private runsFor in services/fieldingSim.ts.
 */
export const RUNS_BY_OUTCOME: Record<FieldingOutcome, number> = {
  SIX: 6,
  FOUR: 4,
  THREE: 3,
  TWO: 2,
  SINGLE: 1,
  DEFENSE: 0,
  CAUGHT: 0,
};

/** Coarse scoreboard result for a fielding outcome. */
export function toShotResult(outcome: FieldingOutcome): ShotResult {
  switch (outcome) {
    case 'SIX':
      return ShotResult.SIX;
    case 'FOUR':
      return ShotResult.FOUR;
    case 'CAUGHT':
      // A catch is a dismissal, so it shares the OUT slot with the bowled path.
      return ShotResult.OUT;
    case 'DEFENSE':
    case 'SINGLE':
    case 'TWO':
    case 'THREE':
    default:
      return ShotResult.DEFENSE;
  }
}

/** What the outcome callback carries back to the App. */
export interface ShotOutcomeDetail {
  runs: number;
  /** Fielding position that took the catch, or null. */
  caughtByLabel: string | null;
}

export interface ResolvedShot extends ShotOutcomeDetail {
  result: ShotResult;
  /** True when the fielding model says the ball was caught. */
  caught: boolean;
  /** Contact to landing (or catch) distance in metres, for the innings card. */
  distanceM: number;
  fielding: FieldingResult;
}

/**
 * Fielding position label for an id in a preset. Returns null for an unknown
 * id, so a preset change cannot throw on the scoring path.
 */
export function caughtByLabelFor(deliveryId: string, fielderId: string | null): string | null {
  if (!fielderId) return null;
  const fielder = fieldersFor(deliveryId).find((f) => f.id === fielderId);
  return fielder ? fielder.label : null;
}

/**
 * Resolve one hit. The exit velocity is the swept-collider output in m/s and
 * the contact point is world metres. The fielding model returns the carry, the
 * interceptor and the outcome; this function turns that into the runs the
 * innings card needs.
 *
 * distanceM is measured contact -> landing point, because carryM only counts a
 * ball that has bounced. A catch is measured to the catch point.
 */
export function resolveShot(
  contactPoint: Vec3,
  exitVelocity: Vec3,
  deliveryId: string,
): ResolvedShot {
  const fielding = simulateFielding(contactPoint, exitVelocity, deliveryId);
  const caught = fielding.outcome === 'CAUGHT';
  const [landingX, landingZ] = fielding.landingXZ;
  return {
    result: toShotResult(fielding.outcome),
    runs: RUNS_BY_OUTCOME[fielding.outcome],
    caught,
    caughtByLabel: caught ? caughtByLabelFor(deliveryId, fielding.caughtById) : null,
    distanceM: Math.hypot(landingX - contactPoint.x, landingZ - contactPoint.z),
    fielding,
  };
}

/**
 * Runs for one outcome callback. The App calls this so one rule decides the
 * score: the sim detail when present, and the old 6/4/0 table for the beaten
 * and bowled paths, which carry no detail. A detail with runs 0 must stay 0,
 * so this reads the detail first and never falls through to the table.
 */
export function runsForResult(result: ShotResult, detail?: ShotOutcomeDetail | null): number {
  if (detail) return detail.runs;
  switch (result) {
    case ShotResult.SIX:
      return 6;
    case ShotResult.FOUR:
      return 4;
    default:
      return 0;
  }
}
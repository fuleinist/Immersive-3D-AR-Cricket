/**
 * Pure stump-and-bail impact model (issue #15, dynamic-stumps slice).
 *
 * This module is pure: no React, no three, no DOM and no clock. It holds state
 * and a fixed-step integrator only, so the exact same code drives the render
 * loop in components/Stumps.tsx and the headless harness in
 * scripts/verify-stumps.mjs. A browser is never needed to prove a yorker knocks
 * the gate out — the same resolve/advance calls are asserted in the harness.
 *
 * Geometry comes from services/shotPhysics so the drawn stumps, the physics
 * bodies, the scoring gate test and this model cannot disagree.
 */
import {
  STUMP_HEIGHT,
  STUMP_PLANE_Z,
  STUMP_RADIUS,
  STUMP_XS,
} from './shotPhysics';

export interface StumpVec3 {
  x: number;
  y: number;
  z: number;
}

export interface StumpBody {
  active: boolean;
  /** Base pivot of the stump; y = 0 at rest. */
  position: StumpVec3;
  velocity: StumpVec3;
  /** Radians, rotation about +x at the base. */
  angle: number;
  /** Radians per second. */
  angleVelocity: number;
}

export interface BailBody {
  active: boolean;
  /** Centre of the bail; y = STUMP_HEIGHT at rest. */
  position: StumpVec3;
  velocity: StumpVec3;
  /** Radians, rotation about +z. */
  angle: number;
  /** Radians per second. */
  angleVelocity: number;
}

export interface StumpImpactState {
  seed: number;
  speedMps: number;
  /** One flag per stump, length 3. */
  struck: boolean[];
  zing: boolean;
  /** Length 3. */
  stumps: StumpBody[];
  /** Length 2. Bail j spans stump j and stump j + 1. */
  bails: BailBody[];
  /** Seconds since impact. */
  elapsed: number;
}

export const BALL_RADIUS_M = 0.05;
/** Half width of the gate a ball centre can reach: a stump radius plus a ball radius. */
export const GATE_TOLERANCE_M = STUMP_RADIUS + BALL_RADIUS_M;
/** Below this speed only the struck stump moves; at or above it the whole gate shatters. */
export const NEIGHBOUR_SHATTER_SPEED_MPS = 24;
/** A contact this slow is a touch, not a bails-off flash. */
export const ZING_MIN_SPEED_MPS = 8;

/** Where a bail comes to rest on the pitch. */
export const GROUND_Y = 0.012;
export const BAIL_BOUNCE = 0.25;
export const STUMP_TOPPLE_DAMPING = 2.4;
/** A stump is a hinged body: it topples to horizontal and stays there. */
export const MAX_TOPPLE_ANGLE = Math.PI / 2;
export const GRAVITY_MPS2 = 9.81;

/** Largest step the integrator will take, so a stalled frame cannot teleport a bail. */
const MAX_STEP_SECONDS = 0.05;

/** Small deterministic 32-bit PRNG (mulberry32). Same seed, same stream. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRestImpactState(): StumpImpactState {
  return {
    seed: 0,
    speedMps: 0,
    struck: [false, false, false],
    zing: false,
    stumps: STUMP_XS.map((x) => ({
      active: false,
      position: { x, y: 0, z: STUMP_PLANE_Z },
      velocity: { x: 0, y: 0, z: 0 },
      angle: 0,
      angleVelocity: 0,
    })),
    bails: [0, 1].map((j) => ({
      active: false,
      position: {
        x: (STUMP_XS[j] + STUMP_XS[j + 1]) / 2,
        y: STUMP_HEIGHT,
        z: STUMP_PLANE_Z,
      },
      velocity: { x: 0, y: 0, z: 0 },
      angle: 0,
      angleVelocity: 0,
    })),
    elapsed: 0,
  };
}

/**
 * Resolve a contact. The PRNG is consumed in a fixed order — stumps 0, 1, 2
 * then bails 0, 1 — so two calls with the same arguments are deep-equal.
 */
export function resolveStumpImpact(
  point: StumpVec3,
  speedMps: number,
  seed: number = 1,
): StumpImpactState {
  const state = createRestImpactState();
  state.seed = seed;
  state.speedMps = speedMps;

  const rand = mulberry32(seed);

  // 1. Gate test, one flag per stump.
  const gate = [false, false, false];
  for (let i = 0; i < 3; i++) {
    gate[i] = Math.abs(point.x - STUMP_XS[i]) <= GATE_TOLERANCE_M;
    state.struck[i] = gate[i];
  }

  // 2. A hard enough hit shatters the whole gate, not just the touched stump.
  //    The neighbour rule reads the gate flags from step 1, not the flags it has
  //    just written, so a single off-stump touch spreads one stump either way and
  //    no further.
  if (gate.some(Boolean) && speedMps >= NEIGHBOUR_SHATTER_SPEED_MPS) {
    for (let i = 0; i < 3; i++) {
      if (!gate[i]) continue;
      if (i - 1 >= 0) state.struck[i - 1] = true;
      if (i + 1 < 3) state.struck[i + 1] = true;
    }
  }

  // 3. The LED flash needs real speed, not just a touch.
  state.zing = state.struck.some(Boolean) && speedMps >= ZING_MIN_SPEED_MPS;

  const kick = Math.min(1.4, Math.max(0.35, speedMps / 40));

  // 4/5. Stumps, in index order, drawing four values each whether or not they
  //      were struck, so the stream position never depends on which stumps hit.
  for (let i = 0; i < 3; i++) {
    const vx = (point.x - STUMP_XS[i]) * 18 + (rand() - 0.5) * 0.6;
    const vy = 0.55 + 0.85 * kick + rand() * 0.25;
    const vz = 2.4 + 3.4 * kick + rand() * 0.5;
    const av = 6 + 9 * kick + rand() * 2;

    if (!state.struck[i]) continue;

    const stump = state.stumps[i];
    stump.active = true;
    stump.velocity.x = vx;
    stump.velocity.y = vy;
    stump.velocity.z = vz;
    stump.angleVelocity = av;
    // angle stays 0 and the base pivot stays where it was built.
  }

  // 6. Bails, in index order, same fixed draw pattern.
  for (let j = 0; j < 2; j++) {
    const vx = (rand() - 0.5) * 2.4;
    const vy = 1.6 + 1.5 * kick + rand() * 0.4;
    const vz = 1.2 + 2.2 * kick + rand() * 0.4;
    const av = (rand() - 0.5) * 24;

    if (!state.struck[j] && !state.struck[j + 1]) continue;

    const bail = state.bails[j];
    bail.active = true;
    bail.velocity.x = vx;
    bail.velocity.y = vy;
    bail.velocity.z = vz;
    bail.angleVelocity = av;
    // angle stays 0 and the bail keeps its rest centre.
  }

  return state;
}

/** Advance the model by one step. Mutates the state in place. */
export function advanceImpact(state: StumpImpactState, dt: number): void {
  const step = Math.max(0, Math.min(0.05, dt));

  for (const stump of state.stumps) {
    if (!stump.active) continue;

    // A hinged stump loses its topple rate; the base pivot never moves.
    stump.angleVelocity *= Math.exp(-STUMP_TOPPLE_DAMPING * step);
    stump.angle += stump.angleVelocity * step;
    if (stump.angle >= MAX_TOPPLE_ANGLE) {
      stump.angle = MAX_TOPPLE_ANGLE;
      stump.angleVelocity = 0;
    }
  }

  for (const bail of state.bails) {
    if (!bail.active) continue;

    // A bail already lying on the pitch stays there.
    if (bail.position.y <= GROUND_Y && bail.velocity.y === 0) continue;

    bail.velocity.y -= GRAVITY_MPS2 * step;
    bail.position.x += bail.velocity.x * step;
    bail.position.y += bail.velocity.y * step;
    bail.position.z += bail.velocity.z * step;
    bail.angle += bail.angleVelocity * step;

    if (bail.position.y <= GROUND_Y) {
      bail.position.y = GROUND_Y;
      if (bail.velocity.y < 0) {
        const bounce = -bail.velocity.y * BAIL_BOUNCE;
        if (bounce < 0.35) {
          bail.velocity.x = 0;
          bail.velocity.y = 0;
          bail.velocity.z = 0;
          bail.angleVelocity = 0;
        } else {
          bail.velocity.y = bounce;
          bail.velocity.x *= 0.7;
          bail.velocity.z *= 0.7;
          bail.angleVelocity *= 0.6;
        }
      }
    }
  }

  state.elapsed += step;
}

/** True when every live body has come to rest. Inactive bodies never block it. */
export function isSettled(state: StumpImpactState): boolean {
  for (const stump of state.stumps) {
    if (!stump.active) continue;
    if (stump.angle < MAX_TOPPLE_ANGLE - 1e-6) return false;
    if (stump.angleVelocity !== 0) return false;
  }

  for (const bail of state.bails) {
    if (!bail.active) continue;
    if (bail.position.y > GROUND_Y + 1e-6) return false;
    if (bail.velocity.x !== 0 || bail.velocity.y !== 0 || bail.velocity.z !== 0) return false;
  }

  return true;
}

/** Put the given state back to rest, mutating it in place. */
export function resetImpact(state: StumpImpactState): void {
  const rest = createRestImpactState();

  state.seed = rest.seed;
  state.speedMps = rest.speedMps;
  state.zing = rest.zing;
  state.elapsed = rest.elapsed;

  for (let i = 0; i < state.struck.length; i++) state.struck[i] = false;

  for (let i = 0; i < state.stumps.length; i++) {
    const body = state.stumps[i];
    const target = rest.stumps[i];
    body.active = false;
    body.position.x = target.position.x;
    body.position.y = target.position.y;
    body.position.z = target.position.z;
    body.velocity.x = 0;
    body.velocity.y = 0;
    body.velocity.z = 0;
    body.angle = 0;
    body.angleVelocity = 0;
  }

  for (let j = 0; j < state.bails.length; j++) {
    const body = state.bails[j];
    const target = rest.bails[j];
    body.active = false;
    body.position.x = target.position.x;
    body.position.y = target.position.y;
    body.position.z = target.position.z;
    body.velocity.x = 0;
    body.velocity.y = 0;
    body.velocity.z = 0;
    body.angle = 0;
    body.angleVelocity = 0;
  }
}

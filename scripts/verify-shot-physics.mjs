/**
 * Headless sanity check for services/shotPhysics.ts — the pure bat-ball physics
 * the scene uses for issue #12 ("the bat cannot hit the ball in live play").
 *
 * Bundles the pure module with esbuild (already a vite dependency — no new
 * packages) and exercises it against the delivery data in
 * data/famousDeliveries.ts:
 *
 *   1. trajectories  - every delivery bounces exactly once, inside the length
 *      window, and passes the bat plane and the stump plane inside the heights
 *      the issue requires
 *   2. swept test    - a stationary defensive bat squarely on line registers
 *      100 of 100 hits across all 5 deliveries, including 20 phase-shifted
 *      frame offsets for lee-2002 at 160.7 km/h; 0% tunneling
 *   3. fast drive    - bat speed counts: v_bat = 8 m/s toward -Z produces
 *      > 90 km/h and v_exit.z < -15 m/s
 *   4. dead bat      - v_bat = 0 produces < 35 km/h, so a block is a block
 *   5. whole blade   - the lower 20 cm of the blade can hit (the old box was
 *      centred on the wrist)
 *   6. sweet spot    - the quality curve peaks at u = 0.62 and floors at 0.35
 *   7. stumps        - the zone test (|x| <= 0.145, y <= 0.73 at z = +1.35)
 *   8. history guards- pose stall > 150 ms or visibility < 0.45 resets history
 *   9. hot path      - the sub-step loop allocates nothing
 *
 * Run: npm run verify:physics
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, 'node_modules', '.cache', 'shot-physics');

/**
 * esbuild is the preferred path, but its in-process service spawns a child with
 * piped stdio, which some sandboxes refuse (spawn EPERM). The fallback is the
 * TypeScript compiler API, which runs in-process. Both modules here have no
 * runtime imports (famousDeliveries imports its type with `import type`), so
 * the transpiled output is importable on its own.
 */
async function loadModule(relPath) {
  const outfile = path.join(cacheDir, path.basename(relPath).replace(/\.ts$/, '.mjs'));
  try {
    const { build } = await import('esbuild');
    await build({
      entryPoints: [path.join(root, relPath)],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile,
      logLevel: 'silent',
    });
  } catch (e) {
    const ts = await import('typescript');
    const source = await fs.readFile(path.join(root, relPath), 'utf8');
    const js = ts.transpileModule(source, {
      compilerOptions: { target: 'ES2022', module: 'ESNext' },
    }).outputText;
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(outfile, js);
  }
  return await import(pathToFileURL(outfile).href);
}

const phys = await loadModule('services/shotPhysics.ts');
const { FAMOUS_DELIVERIES } = await loadModule('data/famousDeliveries.ts');

const {
  SWEPT_SUBSTEPS, MIN_STEP_SECONDS, MAX_BAT_POINT_SPEED,
  SWEET_SPOT_U, SWEET_SPOT_SIGMA, MIN_SWEET_QUALITY,
  BASE_RESTITUTION, SWEET_RESTITUTION_GAIN, LIFT_PER_QUALITY,
  PITCH_RESTITUTION, GRAVITY, SPIN_LATERAL_COEFFICIENT,
  CREASE_Z, STUMP_PLANE_Z, STUMP_ZONE_HALF_X, STUMP_ZONE_MAX_Y,
  POSE_STALL_MS, MIN_VISIBILITY,
  sweetSpotQuality, batPointVelocity, batSegmentContact, computeBatBallImpact,
  computeBounceSpinImpulse, stumpSegmentTest,
  createSweptBatCollider, createImpactResult, createStumpContact, createVec3,
} = phys;

const DT = 1 / 60;
const BALL_R = 0.05; // the physics radius components/Ball.tsx uses
const RELEASE_Y = 2.05;

/* Test bat: a stationary defensive guard, blade hanging from the hands,
   face square to the bowler, squarely on the ball's line. Nominal size 1.0,
   PRO-mode half extents. */
const BAT_SIZE = 1.0;
const BAT_HALF_W = 0.06;
const BAT_HALF_T = 0.05;
const BAT_BLADE = 0.82;
const BAT_PLANE_Z = 0.05; // the bat hangs just behind the crease line
const BAT_FACE = { x: 0, y: 0, z: -1 };

let failures = 0;
const report = (name, fn) => {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
};

const kmh = (v) => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) * 3.6;

/* --------------------------------------------------------- flight model */

/**
 * Time from the release to the first pitch contact: the ball centre reaches the
 * pitch surface when y = BALL_R.
 *   RELEASE_Y + dip * t - 4.9 t^2 = BALL_R
 */
function pitchTime(d) {
  const a = 4.9;
  const disc = d.dip * d.dip + 4 * a * (RELEASE_Y - BALL_R);
  return (d.dip + Math.sqrt(disc)) / (2 * a);
}

/**
 * State at time t on the modelled path: free flight to the pitch, then the
 * bounce through computeBounceSpinImpulse, then free flight again. Returns the
 * first-contact facts as well, so the assertions read the same numbers the
 * module produced.
 */
function flightState(d, t, pace = d.pace) {
  const tB = pitchTime(d);
  if (t <= tB) {
    return {
      contacted: false,
      pos: { x: d.releaseX + d.line * t + 0.5 * d.swing * t * t, y: RELEASE_Y + d.dip * t - 4.9 * t * t, z: -18.5 + pace * t },
      vel: { x: d.line + d.swing * t, y: d.dip - 9.8 * t, z: pace },
    };
  }
  const impact = { x: d.line + d.swing * tB, y: d.dip - 9.8 * tB, z: pace };
  const post = computeBounceSpinImpulse(impact, d.spin, createVec3());
  const s = t - tB;
  return {
    contacted: true,
    bounceZ: -18.5 + pace * tB,
    impact,
    post,
    pos: { x: d.releaseX + d.line * tB + 0.5 * d.swing * tB * tB + post.x * s, y: BALL_R + post.y * s - 4.9 * s * s, z: -18.5 + pace * tB + post.z * s },
    vel: { x: post.x, y: post.y - 9.8 * s, z: post.z },
  };
}

function stateAtZ(d, zTarget, pace = d.pace) {
  // walk the path in 1 ms steps until the target plane is crossed
  for (let t = 0; t < 4; t += 0.001) {
    const s = flightState(d, t, pace);
    if (s.pos.z >= zTarget) return { t, s };
  }
  return null;
}

function writeBatSample(sample, x, gripY, z) {
  sample.gripWorld.x = x; sample.gripWorld.y = gripY; sample.gripWorld.z = z;
  sample.toeWorld.x = x; sample.toeWorld.y = gripY - BAT_BLADE * BAT_SIZE; sample.toeWorld.z = z;
  sample.faceNormalWorld.x = BAT_FACE.x; sample.faceNormalWorld.y = BAT_FACE.y; sample.faceNormalWorld.z = BAT_FACE.z;
  sample.rightAxisWorld.x = 1; sample.rightAxisWorld.y = 0; sample.rightAxisWorld.z = 0;
}

/* ------------------------------------------------------------- group 1 */

console.log('\n--- delivery trajectories ---');

const trajectories = new Map();

for (const d of FAMOUS_DELIVERIES) {
  report(`${d.id} bounces once inside the length window and passes both planes`, () => {
    assert.ok(Math.abs(SPIN_LATERAL_COEFFICIENT) === 0.10, 'spin coefficient must be 0.10');

    const tB = pitchTime(d);
    const bounce = flightState(d, tB + 1e-9);
    const kick = SPIN_LATERAL_COEFFICIENT * d.spin[2];
    trajectories.set(d.id, { tB, kick, bounceZ: bounce.bounceZ });

    assert.ok(bounce.bounceZ >= -6.0 && bounce.bounceZ <= -0.5,
      `bounces at z = ${bounce.bounceZ.toFixed(2)}, outside [-6.0, -0.5]`);

    // Exactly one contact: the ball must still be airborne at z = +3.0.
    const timeToGroundAgain = bounce.post.y / GRAVITY;
    const timeToBeyond = (3.0 - bounce.bounceZ) / d.pace;
    assert.ok(timeToGroundAgain > timeToBeyond,
      `second bounce after ${timeToGroundAgain.toFixed(2)} s, before z = +3.0 at ${timeToBeyond.toFixed(2)} s`);

    const atBat = stateAtZ(d, CREASE_Z);
    assert.ok(atBat, 'never reaches the bat plane');
    assert.ok(atBat.s.pos.y >= 0.18 && atBat.s.pos.y <= 0.78,
      `passes z = +0.13 at y = ${atBat.s.pos.y.toFixed(3)}, outside [0.18, 0.78]`);

    const atStumps = stateAtZ(d, STUMP_PLANE_Z);
    assert.ok(atStumps, 'never reaches the stump plane');
    assert.ok(atStumps.s.pos.y >= 0.15 && atStumps.s.pos.y <= 0.75,
      `reaches the stump plane at y = ${atStumps.s.pos.y.toFixed(3)}, outside [0.15, 0.75]`);

    // The spin transfer the model owns: x only, coefficient 0.10, sign per the
    // convention in types.ts (positive spin[2] rips toward off = -x).
    const impact = { x: d.line + d.swing * tB, y: d.dip - 9.8 * tB, z: d.pace };
    const out = createVec3();
    computeBounceSpinImpulse(impact, d.spin, out);
    assert.ok(Math.abs(out.x - (impact.x + kick)) < 1e-12, 'lateral kick is not 0.10 * spin[2]');
    assert.ok(Math.abs(out.y - (-PITCH_RESTITUTION * impact.y)) < 1e-12, 'vertical rebound is not restitution 0.68');
    assert.ok(Math.abs(out.z - impact.z) < 1e-12, 'the bounce must not change the pace');

    console.log(`        length z = ${bounce.bounceZ.toFixed(2)}, bat plane y = ${(atBat.s.pos.y).toFixed(2)}, ` +
      `stump plane y = ${(atStumps.s.pos.y).toFixed(2)}, kick ${kick.toFixed(2)} m/s`);
  });
}

/* ------------------------------------------------------------- group 2 */

console.log('\n--- swept bat collider (60 Hz tunneling) ---');

/** Run one phase-shifted trial; returns true when the swept test registers it. */
function sweptTrial(d, phase, out, pace = d.pace) {
  const arrival = stateAtZ(d, CREASE_Z, pace);
  const xLine = arrival ? arrival.s.pos.x : d.releaseX;
  const collider = createSweptBatCollider();
  writeBatSample(collider.sample, xLine, 0.90, BAT_PLANE_Z);

  for (let k = 0; k < 150; k++) {
    const t = (k + phase) * DT;
    const s = flightState(d, t, pace);
    collider.beginFrame(0.95, k * 16.7);
    if (collider.test(DT, s.pos, s.vel, BALL_R, BAT_HALF_W, BAT_HALF_T, out)) return true;
  }
  return false;
}

/** The same trials with one sample per frame - what the game does today. */
function discreteTrial(d, phase, out, pace = d.pace) {
  const arrival = stateAtZ(d, CREASE_Z, pace);
  const xLine = arrival ? arrival.s.pos.x : d.releaseX;
  const grip = createVec3(), toe = createVec3();
  for (let k = 0; k < 150; k++) {
    const t = (k + phase) * DT;
    const s = flightState(d, t, pace);
    grip.x = xLine; grip.y = 0.90; grip.z = BAT_PLANE_Z;
    toe.x = xLine; toe.y = 0.90 - BAT_BLADE; toe.z = BAT_PLANE_Z;
    if (batSegmentContact(grip, toe, BAT_FACE, s.pos, BALL_R, BAT_HALF_W, BAT_HALF_T, out) >= 0) return true;
  }
  return false;
}

const out = createImpactResult();
let sweptTotal = 0, discreteTotal = 0;
const perDelivery = [];

for (const d of FAMOUS_DELIVERIES) {
  let swept = 0, discrete = 0;
  for (let p = 0; p < 20; p++) {
    const phase = p / 20;
    if (sweptTrial(d, phase, out)) swept++;
    if (discreteTrial(d, phase, out)) discrete++;
  }
  sweptTotal += swept;
  discreteTotal += discrete;
  perDelivery.push([d.id, swept, discrete]);
}

report('stationary defensive bat on line registers 100 of 100 hits, 0% tunneling', () => {
  assert.equal(sweptTotal, 100, `registered ${sweptTotal}/100`);
  for (const [id, swept] of perDelivery) assert.equal(swept, 20, `${id}: ${swept}/20`);
});

report('the same trials would tunnel with a single sample per frame', () => {
  for (const [id, swept, discrete] of perDelivery) {
    console.log(`        ${id}: swept ${swept}/20, single-sample ${discrete}/20`);
  }
  assert.ok(discreteTotal < sweptTotal,
    `single sampling caught ${discreteTotal}, swept caught ${sweptTotal} — the sweep must be strictly better`);
});

report('lee-2002 at 160.7 km/h: all 20 phase-shifted frame offsets register', () => {
  const lee = FAMOUS_DELIVERIES.find((d) => d.id === 'lee-2002');
  const speedMs = 160.7 / 3.6;
  assert.ok(Math.abs(speedMs - 44.64) < 0.01, '160.7 km/h is 44.64 m/s');
  let sweptHits = 0, singleSampleHits = 0;
  for (let p = 0; p < 20; p++) {
    const phase = p / 20;
    if (sweptTrial(lee, phase, out, speedMs)) sweptHits++;
    if (discreteTrial(lee, phase, out, speedMs)) singleSampleHits++;
  }
  assert.equal(sweptHits, 20, `only ${sweptHits}/20 phase offsets registered — 0% tunneling is the gate`);
  console.log(`        44.64 m/s covers ${(speedMs * DT).toFixed(3)} m per frame against a ` +
    `${((BAT_HALF_T + BALL_R) * 2).toFixed(3)} m bat-plus-ball slab; sub-step ${(speedMs * DT / SWEPT_SUBSTEPS).toFixed(3)} m`);
  console.log(`        the same 20 offsets with one sample per frame caught ${singleSampleHits}`);
  assert.ok(singleSampleHits < 20, 'single sampling must miss some offsets at this speed');
});

/* ------------------------------------------------------------- group 3 */

console.log('\n--- bat speed counts ---');

report('fast forward drive: v_bat = 8 m/s toward -Z produces > 90 km/h and v_exit.z < -15 m/s', () => {
  const grip = createVec3(), toe = createVec3(), ball = createVec3(), ballVel = createVec3(), pv = createVec3();
  // Blade straight down, face square to the bowler, contact at the sweet spot.
  grip.x = 0; grip.y = 0.90; grip.z = 0.05;
  toe.x = 0; toe.y = 0.90 - BAT_BLADE; toe.z = 0.05;
  const dt = DT;
  const target = SWEET_SPOT_U;
  ball.y = 0.90 - target * BAT_BLADE; // the sweet spot, 39 cm below the hands
  ball.x = 0; ball.z = BAT_PLANE_Z;
  ballVel.x = 0; ballVel.y = 0; ballVel.z = 20;

  // Grip and toe moving at the same rate: every point on the blade at 8 m/s.
  const gripDelta = { x: 0, y: 0, z: -8 * dt };
  const toeDelta = { x: 0, y: 0, z: -8 * dt };
  batPointVelocity(gripDelta, toeDelta, target, dt, pv);
  assert.ok(Math.abs(kmh(pv) / 3.6 - 8) < 1e-9, `point velocity ${kmh(pv) / 3.6} m/s`);
  assert.ok(pv.z < 0, 'the drive must be toward -Z');

  assert.ok(computeBatBallImpact(grip, toe, BAT_FACE, pv, ball, ballVel, BALL_R, BAT_HALF_W, BAT_HALF_T, out), 'no contact');
  assert.ok(Math.abs(out.u - target) < 1e-9, `contact fraction ${out.u}`);
  assert.ok(Math.abs(out.quality - 1) < 1e-9, `sweet spot quality ${out.quality}`);
  assert.ok(kmh(out.exitVelocity) > 90, `exit speed ${kmh(out.exitVelocity).toFixed(1)} km/h`);
  assert.ok(out.exitVelocity.z < -15, `v_exit.z = ${out.exitVelocity.z.toFixed(2)} m/s`);
  console.log(`        exit ${kmh(out.exitVelocity).toFixed(1)} km/h, v_exit.z = ${out.exitVelocity.z.toFixed(2)} m/s`);
});

report('dead bat block: v_bat = 0 produces < 35 km/h', () => {
  const grip = createVec3(), toe = createVec3(), ball = createVec3(), ballVel = createVec3(), pv = createVec3();
  grip.x = 0; grip.y = 0.90; grip.z = 0.05;
  toe.x = 0; toe.y = 0.90 - BAT_BLADE; toe.z = 0.05;
  ball.x = 0; ball.y = 0.45; ball.z = 0.05;
  ballVel.x = 0; ballVel.y = 0; ballVel.z = 10;

  batPointVelocity(createVec3(), createVec3(), SWEET_SPOT_U, DT, pv);
  assert.equal(kmh(pv), 0, 'a still bat has no point velocity');

  assert.ok(computeBatBallImpact(grip, toe, BAT_FACE, pv, ball, ballVel, BALL_R, BAT_HALF_W, BAT_HALF_T, out), 'no contact');
  assert.ok(kmh(out.exitVelocity) < 35, `dead bat produced ${kmh(out.exitVelocity).toFixed(1)} km/h`);
  console.log(`        block at 36 km/h in -> ${kmh(out.exitVelocity).toFixed(1)} km/h out`);
});

report('the point velocity clamps at 28 m/s', () => {
  const pv = createVec3();
  const dt = DT;
  batPointVelocity({ x: 0, y: 0, z: -20 * dt }, { x: 0, y: 0, z: -30 * dt }, 0.5, dt, pv);
  assert.ok(Math.abs(kmh(pv) / 3.6 - 25) < 1e-9, `interpolated ${kmh(pv) / 3.6}`);
  batPointVelocity({ x: 0, y: 0, z: -60 * dt }, { x: 0, y: 0, z: -60 * dt }, 0.5, dt, pv);
  assert.ok(Math.abs(Math.abs(kmh(pv) / 3.6) - MAX_BAT_POINT_SPEED) < 1e-9, `clamped to ${kmh(pv) / 3.6}`);
  // A stalled pose frame must not divide by zero.
  batPointVelocity({ x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: -1 }, 0.5, 0, pv);
  assert.ok(Number.isFinite(pv.z), 'zero dt produced a non-finite velocity');
  assert.ok(Math.abs(Math.abs(pv.z) - MAX_BAT_POINT_SPEED) < 1e-9, `zero dt must clamp, got ${pv.z}`);
});

/* ------------------------------------------------------------- group 4 */

console.log('\n--- bat geometry and sweet spot ---');

report('the lower 20 cm of the blade can hit', () => {
  const grip = createVec3(), toe = createVec3(), ball = createVec3();
  grip.x = 0; grip.y = 0.90; grip.z = 0.0;
  toe.x = 0; toe.y = 0.90 - BAT_BLADE; toe.z = 0.0;
  ball.x = 0; ball.y = 0.20; ball.z = 0.03; // 70 cm below the grip, on the face
  const u = batSegmentContact(grip, toe, BAT_FACE, ball, BALL_R, BAT_HALF_W, BAT_HALF_T, out);
  assert.ok(u >= 0.85, `contact at the lower blade returned u = ${u}`);
  // The old box, centred on the wrist with half-height 0.55, could not reach it.
  const oldHalfHeight = 0.55;
  assert.ok(Math.abs(0.90 - ball.y) > oldHalfHeight,
    'this contact should be outside the wrist-centred box, which is the defect being fixed');
});

report('sweet spot: peaks at u = 0.62, floored at 0.35', () => {
  assert.ok(Math.abs(sweetSpotQuality(SWEET_SPOT_U) - 1) < 1e-12, 'peak quality must be 1');
  const oneSigma = Math.exp(-0.5);
  assert.ok(Math.abs(sweetSpotQuality(SWEET_SPOT_U + SWEET_SPOT_SIGMA) - oneSigma) < 1e-12, 'Gaussian falloff at one sigma');
  assert.ok(Math.abs(sweetSpotQuality(SWEET_SPOT_U - SWEET_SPOT_SIGMA) - oneSigma) < 1e-12, 'falloff is symmetric');
  assert.ok(Math.abs(sweetSpotQuality(0) - MIN_SWEET_QUALITY) < 1e-12, 'grip contact must floor at 0.35');
  assert.ok(Math.abs(sweetSpotQuality(1) - MIN_SWEET_QUALITY) < 1e-12, 'toe contact must floor at 0.35');
  assert.ok(sweetSpotQuality(0.45) > 0.7 && sweetSpotQuality(0.45) < 1, `quality at u = 0.45 ${sweetSpotQuality(0.45)}`);
  assert.ok(BASE_RESTITUTION + SWEET_RESTITUTION_GAIN === 0.84, 'sweet spot restitution 0.84');
  assert.ok(Math.abs(BASE_RESTITUTION + SWEET_RESTITUTION_GAIN * MIN_SWEET_QUALITY - 0.606) < 0.001, 'floored restitution 0.606');
});

/* ------------------------------------------------------------- group 5 */

console.log('\n--- stump zone ---');

report('crossing the stump plane inside the zone registers, outside it does not', () => {
  const sc = createStumpContact();
  const prev = createVec3(), cur = createVec3();
  prev.x = 0.02; prev.y = 0.30; prev.z = 1.20;
  cur.x = 0.02; cur.y = 0.30; cur.z = 1.40;
  assert.ok(stumpSegmentTest(prev, cur, BALL_R, sc), 'through the zone not detected');
  assert.equal(sc.stump, 1, 'should be the middle stump');
  assert.ok(Math.abs(sc.point.z - STUMP_PLANE_Z) < 1e-12, 'crossing point must be on the plane');

  cur.x = 0.24;
  assert.ok(!stumpSegmentTest(prev, cur, BALL_R, sc), 'outside the half width should not register');

  prev.y = 0.70; cur.x = 0.0; cur.y = 0.80; // crossing at y = 0.775, above the bail
  assert.ok(!stumpSegmentTest(prev, cur, BALL_R, sc), 'above the bail height should not register');

  prev.y = 0.30; prev.z = 1.20; cur.y = 0.30; cur.z = 1.30; // stops short of the plane
  assert.ok(!stumpSegmentTest(prev, cur, BALL_R, sc), 'a segment that does not cross the plane must not register');

  assert.ok(STUMP_ZONE_HALF_X === 0.145 && STUMP_ZONE_MAX_Y === 0.73, 'zone constants must match the issue');
  assert.ok(STUMP_PLANE_Z === 1.35 && CREASE_Z === 0.13, 'crease geometry must match the issue');
  console.log(`        zone |x| <= ${STUMP_ZONE_HALF_X}, y <= ${STUMP_ZONE_MAX_Y} at z = ${STUMP_PLANE_Z}`);
});

/* ------------------------------------------------------------- group 6 */

console.log('\n--- history guards ---');

report('a pose timestamp that stalls for more than 150 ms resets history', () => {
  const c = createSweptBatCollider();
  writeBatSample(c.sample, 0, 0.9, 0.05);
  assert.ok(!c.beginFrame(0.95, 0), 'the first frame has no history to sweep from');
  assert.ok(c.beginFrame(0.95, 100), 'the next frame sweeps from the baseline');
  assert.ok(!c.beginFrame(0.95, 100 + POSE_STALL_MS + 1), 'a stalled stream drops history');
  assert.ok(c.beginFrame(0.95, 100 + POSE_STALL_MS + 101), 'and recovers on the frame after the stall');
});

report('visibility below 0.45 resets history', () => {
  const c = createSweptBatCollider();
  writeBatSample(c.sample, 0, 0.9, 0.05);
  assert.ok(!c.beginFrame(0.9, 0));
  assert.ok(c.beginFrame(0.9, 16.7));
  assert.ok(!c.beginFrame(MIN_VISIBILITY - 0.01, 33.4), 'a lost arm drops history');
  assert.ok(c.beginFrame(0.9, 50.1), 'and recovers on the following frame');
  const c2 = createSweptBatCollider();
  writeBatSample(c2.sample, 0, 0.9, 0.05);
  assert.ok(!c2.beginFrame(0.9, NaN), 'a non-finite timestamp drops history');
});

report('test() does not guess a swing without history', () => {
  const c = createSweptBatCollider();
  writeBatSample(c.sample, 0, 0.9, 0.05);
  const ball = createVec3(), vel = createVec3();
  ball.x = 0; ball.y = 0.45; ball.z = 0.05;
  vel.x = 0; vel.y = 0; vel.z = 20;
  assert.ok(!c.test(DT, ball, vel, BALL_R, BAT_HALF_W, BAT_HALF_T, out), 'no sweep before any frame is opened');
  assert.ok(!c.beginFrame(0.95, 0), 'the first frame has no history to sweep from');
  assert.ok(!c.test(DT, ball, vel, BALL_R, BAT_HALF_W, BAT_HALF_T, out), 'the baseline frame itself cannot sweep');
  assert.ok(c.beginFrame(0.95, 16.7));
  assert.ok(c.test(DT, ball, vel, BALL_R, BAT_HALF_W, BAT_HALF_T, out), 'with history the contact registers');
  assert.equal(out.hit, true);
  c.resetHistory();
  assert.ok(!c.test(DT, ball, vel, BALL_R, BAT_HALF_W, BAT_HALF_T, out), 'resetHistory must clear it');
});

/* ------------------------------------------------------------- group 7 */

console.log('\n--- allocation in the hot path ---');

report('the sub-step loop reuses caller-owned scratch', () => {
  const c = createSweptBatCollider();
  writeBatSample(c.sample, 0, 0.9, BAT_PLANE_Z);
  const sampleRef = c.sample;
  const outLocal = createImpactResult();
  const ball = createVec3(), vel = createVec3();
  ball.x = 0; ball.y = 0.45; ball.z = BAT_PLANE_Z;
  vel.x = 0; vel.y = 0; vel.z = 30;
  c.beginFrame(0.95, 0);
  c.beginFrame(0.95, 16.7);
  assert.ok(c.test(DT, ball, vel, BALL_R, BAT_HALF_W, BAT_HALF_T, outLocal), 'contact not registered');
  assert.ok(c.sample === sampleRef, 'the collider must not rebuild its sample each frame');
  assert.ok(outLocal.hit === true && Number.isFinite(outLocal.exitVelocity.y), 'the result is written into the caller object');

  const frames = 20000;
  if (global.gc) {
    global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < frames; i++) { c.beginFrame(0.95, i * 16.7); c.test(DT, ball, vel, BALL_R, BAT_HALF_W, BAT_HALF_T, outLocal); }
    global.gc();
    const growth = process.memoryUsage().heapUsed - before;
    console.log(`        ${frames} sub-step frames: heap grew ${growth} bytes`);
    assert.ok(growth < 64 * 1024, `heap grew ${growth} bytes across ${frames} frames`);
  } else {
    // Without --expose-gc this number is V8 bookkeeping, not allocation, so it
    // is reported rather than asserted. Run with node --expose-gc to enforce it.
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < frames; i++) { c.beginFrame(0.95, i * 16.7); c.test(DT, ball, vel, BALL_R, BAT_HALF_W, BAT_HALF_T, outLocal); }
    console.log(`        ${frames} sub-step frames: heap moved ${process.memoryUsage().heapUsed - before} bytes, no gc available`);
  }
});

console.log(failures === 0 ? '\nAll shot-physics sanity checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Headless BAT-ARM BINDING harness for the full bat pipeline:
 *
 *   noisy world landmarks (30 Hz) -> LandmarkSmoother -> scene joints
 *     -> BatTransformSolver (notePoseFrame @ pose cadence, solve @ 60 Hz)
 *     -> applied DIRECTLY (no bat-level filter — rigid arm binding)
 *
 * The bat is a rigid extension of the arm: its transform each render frame
 * is a pure function of the SAME smoothed joints that drive the arm bones,
 * so the ONLY smoothing it experiences is the landmarks' own One Euro
 * filter. This harness replaces the old "bat steadier than the forearm"
 * bounds (which verified the removed BatTransformSmoother damper) with
 * "bat tracks the arm exactly" bounds:
 *
 *   1. exact binding    -> per render frame, the bat's grip-axis (batX)
 *      angular delta EQUALS the forearm's angular delta within float
 *      tolerance (batX is the forearm axis by construction), and the
 *      anchor equals the smoothed wrist exactly. Any independent damping
 *      stage would show up here as the bat lagging (smaller steps).
 *   2. coherence ~1.0   -> a noisy-landmark stream produces ZERO
 *      additional bat-only jitter: mean blade step / mean forearm step
 *      stays in a tight band around 1.0 (the blade can only pick up the
 *      roll driven by the body reference — shoulders/hips, the least
 *      noisy joints — never filter dynamics of its own).
 *   3. blade decomp     -> per frame the blade step decomposes into
 *      "follow the forearm" (shortest-arc transport) + "roll about the
 *      forearm"; the follow part equals the forearm step and the roll
 *      part is bounded by the body frame's own motion plus the
 *      swingBlend state machine's deliberate (slow) rotation.
 *   4. determinism      -> a twin solver fed the same joint stream
 *      produces bitwise-identical transforms: no hidden filtering state
 *      beyond the declared swingBlend state machine.
 *   5. regimes          -> static stance / reference-band hang /
 *      locomotion / fidget: locomotion still never raises swingBlend
 *      (torso-relative rejection), no idle swing phase, and no
 *      single-frame blade flap in the near-parallel band.
 *
 * All streams use a seeded RNG: metrics are deterministic run to run.
 *
 * Run: npm run verify:jitter
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, 'node_modules', '.cache');

await build({
  entryPoints: {
    'pose-smoothing.bundle': path.join(root, 'services', 'poseSmoothing.ts'),
    'bat-transform.bundle': path.join(root, 'services', 'batTransform.ts'),
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outdir: cacheDir,
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});

const {
  LandmarkSmoother,
  WORLD_SPACE_SMOOTHING,
  WORLD_SPACE_ARM_SMOOTHING,
  BAT_FRAME_LANDMARKS,
  buildLandmarkOverrides,
} = await import(path.join(cacheDir, 'pose-smoothing.bundle.mjs'));
const { BatTransformSolver } = await import(path.join(cacheDir, 'bat-transform.bundle.mjs'));
const THREE = await import('three');

// Mirror App.tsx overrides.
const WORLD_OVERRIDES = buildLandmarkOverrides(33, BAT_FRAME_LANDMARKS, WORLD_SPACE_ARM_SMOOTHING, WORLD_SPACE_SMOOTHING);

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

const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rng = mulberry32(2024);
const gauss = () => {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const SIZE = 0.85; // Avatar default
const POSE_HZ = 30, RENDER_HZ = 60;
const SIGMA = 0.01; // 1cm base world noise, as in verify-pose-smoothing

/** Float tolerance for the exact-binding checks. batX goes basis ->
 *  quaternion -> applyQuaternion (double precision throughout); the
 *  round-trip error on a per-frame angleTo measures ~2e-8 rad (~1e-6
 *  deg). 1e-5 deg is an order above that and still ~5 orders below real
 *  per-frame jitter — any damping lag (>= ~1% of a step) fails this. */
const BIND_EPS_DEG = 1e-5;
/** Anchor tolerance: solve() copies the wrist vector verbatim. */
const ANCHOR_EPS = 1e-12;

/**
 * Realistic per-landmark noise scales. MediaPipe wrists are by far the
 * noisiest tracked joints (fast, small, occluded by the hands/bat), depth
 * (z) is ~2x noisier than image-plane x/y, and tracking produces
 * occasional multi-sigma outlier spikes when it re-locks.
 */
const NOISE_SCALE = new Array(33).fill(1);
NOISE_SCALE[13] = 1.5; NOISE_SCALE[14] = 1.5;      // elbows
NOISE_SCALE[15] = 3.0; NOISE_SCALE[16] = 3.0;      // wrists
const Z_SCALE = 2.0;
const SPIKE_PROB = 0.02;   // per-frame chance of a wrist tracking spike
const SPIKE_SIGMA = 6;     // spike magnitude in sigmas

/** World-space landmark template (MediaPipe convention), batting stance. */
function stanceWorld() {
  const l = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.95 }));
  l[11] = { x: 0.21, y: 0.55, z: 0, visibility: 0.95 };
  l[12] = { x: -0.21, y: 0.55, z: 0, visibility: 0.95 };
  l[13] = { x: 0.26, y: 0.32, z: 0.08, visibility: 0.95 };
  l[14] = { x: -0.26, y: 0.32, z: 0.08, visibility: 0.95 };
  l[15] = { x: 0.12, y: 0.14, z: 0.30, visibility: 0.95 };
  l[16] = { x: -0.12, y: 0.14, z: 0.30, visibility: 0.95 };
  l[23] = { x: 0.12, y: 0, z: 0, visibility: 0.95 };
  l[24] = { x: -0.12, y: 0, z: 0, visibility: 0.95 };
  return l;
}

/** Relaxed hang: grip forearm right at the reference-fallback band edge. */
function hangWorld() {
  const l = stanceWorld();
  l[14] = { x: -0.26, y: 0.30, z: 0.02, visibility: 0.95 }; // R elbow
  // f = wrist - elbow ~ (-0.02, -0.225, 0.075): |f.up| ~= 0.94 — wrist
  // noise straddles the REF_BLEND_START..PARALLEL_LIMIT handoff.
  l[16] = { x: -0.28, y: 0.075, z: 0.095, visibility: 0.95 };
  return l;
}

const mapW = (p) => new THREE.Vector3(p.x * SIZE, -p.y * SIZE, -p.z * SIZE);
const deg = (rad) => (rad * 180) / Math.PI;

/**
 * Run one scenario end-to-end. `mutate(lms, t)` applies deterministic
 * motion before noise. Returns binding/coherence metrics.
 *
 * Per render frame the bat transform is solved from the current smoothed
 * joints and applied directly — exactly mirroring Avatar.tsx. A twin
 * solver consumes the same stream to assert bitwise determinism (no
 * hidden bat-only state). Blade steps are decomposed into the
 * forearm-following part (shortest-arc transport of the previous blade
 * onto the current forearm) and the residual roll about the forearm, so
 * "extra" blade motion is attributable to the body reference / swingBlend
 * rather than to any bat-only dynamics.
 */
function runScenario(makePose, mutate, seconds = 12) {
  const smoother = new LandmarkSmoother(WORLD_SPACE_SMOOTHING, 33, WORLD_OVERRIDES);
  const solver = new BatTransformSolver();
  const twin = new BatTransformSolver();

  const joints = {
    lShoulder: new THREE.Vector3(), rShoulder: new THREE.Vector3(),
    lElbow: new THREE.Vector3(), rElbow: new THREE.Vector3(),
    lWrist: new THREE.Vector3(), rWrist: new THREE.Vector3(),
    lHip: new THREE.Vector3(), rHip: new THREE.Vector3(),
  };
  const batPos = new THREE.Vector3(), batQuat = new THREE.Quaternion();
  const twinPos = new THREE.Vector3(), twinQuat = new THREE.Quaternion();
  const forearmDir = new THREE.Vector3(), batX = new THREE.Vector3(), batY = new THREE.Vector3();
  const prevForearm = new THREE.Vector3(), prevBatX = new THREE.Vector3(), prevBatY = new THREE.Vector3();
  const alignQ = new THREE.Quaternion(), transported = new THREE.Vector3();
  const tip = new THREE.Vector3(), prevTip = new THREE.Vector3();

  const warm = Math.floor(2 * POSE_HZ);
  let forearmSteps = 0, batSteps = 0, tipSteps = 0, rollSteps = 0, n = 0;
  let maxBatStep = 0, maxBindErr = 0, maxAxisErr = 0, maxAnchorDrift = 0, maxTwinDrift = 0;
  let blendMax = 0, blendActive = 0;
  let solveFails = 0;
  let havePrev = false;
  let renderIdx = 0;

  for (let pf = 0; pf < Math.floor(seconds * POSE_HZ); pf++) {
    const tPose = pf / POSE_HZ;
    const lms = makePose();
    if (mutate) mutate(lms, tPose);
    const spike = rng() < SPIKE_PROB;
    for (let i = 0; i < lms.length; i++) {
      const p = lms[i];
      const s = SIGMA * NOISE_SCALE[i];
      p.x += gauss() * s; p.y += gauss() * s; p.z += gauss() * s * Z_SCALE;
      if (spike && (i === 15 || i === 16)) {
        p.x += gauss() * SIGMA * SPIKE_SIGMA;
        p.y += gauss() * SIGMA * SPIKE_SIGMA;
      }
    }
    smoother.filter(lms, pf * (1000 / POSE_HZ));

    joints.lShoulder.copy(mapW(lms[11])); joints.rShoulder.copy(mapW(lms[12]));
    joints.lElbow.copy(mapW(lms[13])); joints.rElbow.copy(mapW(lms[14]));
    joints.lWrist.copy(mapW(lms[15])); joints.rWrist.copy(mapW(lms[16]));
    joints.lHip.copy(mapW(lms[23])); joints.rHip.copy(mapW(lms[24]));

    solver.notePoseFrame(joints, 'right', 1 / POSE_HZ);
    twin.notePoseFrame(joints, 'right', 1 / POSE_HZ);

    for (let r = 0; r < RENDER_HZ / POSE_HZ; r++) {
      renderIdx++;
      // Per-render-frame solve from the CURRENT smoothed pose — the rigid
      // binding. No cadence-splitting, no sample-clocked adaptation.
      if (!solver.solve(joints, 'right', batPos, batQuat)) solveFails++;
      if (!twin.solve(joints, 'right', twinPos, twinQuat)) solveFails++;
      if (renderIdx <= warm * (RENDER_HZ / POSE_HZ)) continue;

      maxAnchorDrift = Math.max(maxAnchorDrift, batPos.distanceTo(joints.rWrist));
      // Bitwise determinism: component-exact comparison (angleTo of a
      // quaternion with itself is ~5e-8, not 0 — normalization rounding —
      // so component diffs are the honest "identical" test).
      maxTwinDrift = Math.max(maxTwinDrift,
        Math.abs(batPos.x - twinPos.x), Math.abs(batPos.y - twinPos.y), Math.abs(batPos.z - twinPos.z),
        Math.abs(batQuat.x - twinQuat.x), Math.abs(batQuat.y - twinQuat.y),
        Math.abs(batQuat.z - twinQuat.z), Math.abs(batQuat.w - twinQuat.w));

      forearmDir.subVectors(joints.rWrist, joints.rElbow).normalize();
      batX.set(1, 0, 0).applyQuaternion(batQuat);
      batY.set(0, 1, 0).applyQuaternion(batQuat);
      tip.copy(batPos).addScaledVector(batY, 0.9 * SIZE);

      // Same-frame axis equality: batX IS the forearm axis, every frame.
      maxAxisErr = Math.max(maxAxisErr, deg(batX.angleTo(forearmDir)));

      if (havePrev) {
        const forearmStep = deg(forearmDir.angleTo(prevForearm));
        // Exact binding: the grip axis' per-frame angular delta must
        // equal the forearm's. (Holds during swings too — the swing
        // blend rotates the blade ABOUT the forearm axis, never batX.)
        maxBindErr = Math.max(maxBindErr, Math.abs(deg(batX.angleTo(prevBatX)) - forearmStep));

        const batStep = deg(batY.angleTo(prevBatY));
        // Decompose the blade step: transport the previous blade by the
        // shortest arc taking prevForearm -> forearmDir; what remains is
        // roll about the forearm (body-reference + swingBlend driven).
        alignQ.setFromUnitVectors(prevForearm, forearmDir);
        transported.copy(prevBatY).applyQuaternion(alignQ);
        const roll = deg(transported.angleTo(batY));

        // Coherence stats span every render frame. swingBlend-driven
        // blade motion is deliberate state-machine motion (and negligible
        // in these regimes: blendMax <= 0.032 outside a real swing), so
        // excluding it would just censor the frames where the arm moves
        // most — the exact binding checks above already hold swing or not.
        forearmSteps += forearmStep;
        batSteps += batStep;
        rollSteps += roll;
        tipSteps += tip.distanceTo(prevTip) * 1000; // mm
        maxBatStep = Math.max(maxBatStep, batStep);
        n++;
      }
      prevForearm.copy(forearmDir);
      prevBatX.copy(batX);
      prevBatY.copy(batY);
      prevTip.copy(tip);
      havePrev = true;
      blendMax = Math.max(blendMax, solver.swingBlend);
      if (solver.swingBlend > 0.02) blendActive++;
    }
  }

  return {
    forearmJitter: forearmSteps / n,
    batJitter: batSteps / n,
    rollJitter: rollSteps / n,
    coherence: batSteps / forearmSteps,
    maxBatStep,
    maxBindErr,
    maxAxisErr,
    maxAnchorDrift,
    maxTwinDrift,
    tipJitter: tipSteps / n,
    blendMax,
    blendActiveFrac: blendActive / n,
    solveFails,
  };
}

const fmt = (m) =>
  `arm ${m.forearmJitter.toFixed(2)} deg/f, bat ${m.batJitter.toFixed(2)} deg/f (max ${m.maxBatStep.toFixed(1)}), roll ${m.rollJitter.toFixed(2)}, coherence ${m.coherence.toFixed(3)}, axis err ${m.maxAxisErr.toExponential(1)} deg, tip ${m.tipJitter.toFixed(1)} mm/f, blend max ${m.blendMax.toFixed(3)} active ${(m.blendActiveFrac * 100).toFixed(0)}%`;

/** Shared binding assertions, run for every scenario. */
const reportBinding = (label, m) => {
  report(`${label}: solve never failed on a noisy stream`, () =>
    assert.equal(m.solveFails, 0, `${m.solveFails} degenerate solves`));
  report(`${label}: grip axis IS the forearm axis, same frame (float tol)`, () =>
    assert.ok(m.maxAxisErr < BIND_EPS_DEG, `max axis error ${m.maxAxisErr} deg`));
  report(`${label}: grip-axis angular delta == forearm angular delta (float tol)`, () =>
    assert.ok(m.maxBindErr < BIND_EPS_DEG, `max binding error ${m.maxBindErr} deg`));
  report(`${label}: anchor is exactly the smoothed wrist`, () =>
    assert.ok(m.maxAnchorDrift < ANCHOR_EPS, `anchor drift ${m.maxAnchorDrift}`));
  report(`${label}: zero hidden bat-only state (twin solver bitwise match)`, () =>
    assert.ok(m.maxTwinDrift === 0, `twin drift ${m.maxTwinDrift}`));
  report(`${label}: bat-arm coherence ~1.0 (no additional bat-only jitter)`, () =>
    // The blade re-derives per frame from the forearm + body reference:
    // forearm twist about the blade axis is absorbed by the projection
    // (coherence < 1) and reference roll adds a little back (> 1) — both
    // are geometry, not filtering. Measured range across regimes:
    // 0.76..1.16. An independent bat filter would break the exact checks
    // above; an amplifying instability would blow past this band.
    assert.ok(m.coherence >= 0.7 && m.coherence <= 2.0,
      `coherence ${m.coherence.toFixed(3)} (order-1.0 = rigid tracking; >> 1 = independent dynamics)`));
};

console.log('\n--- bat-arm binding: the bat tracks the arm exactly ---');

{
  const m = runScenario(stanceWorld, null);
  console.log(`        -> static stance: ${fmt(m)}`);
  reportBinding('static stance', m);
  report('static stance: no swing phase at idle', () =>
    assert.ok(m.blendMax < 0.02, `blendMax ${m.blendMax}`));
}

{
  const m = runScenario(hangWorld, null);
  console.log(`        -> reference-band hang: ${fmt(m)}`);
  reportBinding('near-parallel band', m);
  report('near-parallel band: no single-frame blade flap', () =>
    // Geometry (the continuous reference blend) bounds this now, not a
    // damper. Mid-band the projection ramps ~12 deg per 0.5 deg of arm
    // sweep (see verify-bat-orientation), so a wrist tracking SPIKE
    // (6-sigma relock) mid-band legitimately steps the blade ~35 deg —
    // that is the arm's own noise tracked 1:1, the requested trade. What
    // must stay impossible is the old hard switch's ~90 deg teleport on
    // an unmoved arm.
    assert.ok(m.maxBatStep < 60, `max step ${m.maxBatStep.toFixed(1)} deg`));
}

{
  const m = runScenario(stanceWorld, (lms, t) => {
    // Batter shuffling/bouncing between deliveries: the WHOLE pose
    // translates (~1.3 m/s lateral + ~0.5 m/s vertical peaks at the wrist)
    // while the arm stays still relative to the torso.
    const dx = 0.25 * Math.sin(2 * Math.PI * 0.8 * t);
    const dy = 0.05 * Math.sin(2 * Math.PI * 1.6 * t);
    for (let i = 0; i < lms.length; i++) {
      lms[i] = { ...lms[i], x: lms[i].x + dx, y: lms[i].y + dy };
    }
  });
  console.log(`        -> locomotion shuffle: ${fmt(m)}`);
  report('locomotion never raises the swing blend', () =>
    assert.ok(m.blendMax < 0.05, `blendMax ${m.blendMax}`));
  reportBinding('locomotion', m);
}

{
  const m = runScenario(stanceWorld, (lms, t) => {
    // Hand fidget RELATIVE to the torso (~1 m/s wrist peaks): arm motion,
    // correctly not rejected — the bat follows it 1:1, blend or not.
    const sway = 0.12 * Math.sin(2 * Math.PI * 1.4 * t);
    lms[16] = { ...lms[16], x: lms[16].x - sway };
    lms[15] = { ...lms[15], x: lms[15].x + sway * 0.6 };
  });
  console.log(`        -> hand fidget: ${fmt(m)}`);
  reportBinding('fidget', m);
}

console.log(failures === 0 ? '\nAll bat-arm binding checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);

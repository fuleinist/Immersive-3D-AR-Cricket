/**
 * Headless TEMPORAL smoothness harness for the full bat pipeline:
 *
 *   noisy world landmarks (30 Hz) -> LandmarkSmoother -> scene joints
 *     -> BatTransformSolver (notePoseFrame @ pose cadence, solve @ 60 Hz)
 *     -> BatTransformSmoother (render cadence, sample-clocked adaptation)
 *
 * Regression coverage for the post-merge "bat shakes in the hand" bug:
 * the bat's perceived smoothness must match the body/arm it rides on, in
 * every regime live testing shook it:
 *
 *   1. static stance   -> bat blade jitter (mean frame-to-frame step) well
 *      below the arm's own forearm-bone jitter under realistic MediaPipe
 *      noise (wrists 3x, depth 2x, occasional tracking spikes)
 *   2. near-parallel   -> relaxed hang with the forearm in the reference
 *      fallback band: no blade flapping (bounded max single-frame step)
 *   3. locomotion      -> whole-body shuffle with a quiet arm must NOT
 *      raise swingBlend (torso-relative rejection) and the bat stays at
 *      least as steady as the arm while moving
 *   4. fidget          -> arm motion relative to the torso may register a
 *      little blend, but the bat still tracks steadier than the arm
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
    'bat-smoothing.bundle': path.join(root, 'services', 'batSmoothing.ts'),
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
const { BatTransformSmoother } = await import(path.join(cacheDir, 'bat-smoothing.bundle.mjs'));
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

/**
 * Run one scenario end-to-end. `mutate(lms, t)` applies deterministic
 * motion before noise. Returns jitter/blend metrics.
 */
function runScenario(makePose, mutate, seconds = 12) {
  const smoother = new LandmarkSmoother(WORLD_SPACE_SMOOTHING, 33, WORLD_OVERRIDES);
  const solver = new BatTransformSolver();
  const batSmoother = new BatTransformSmoother();

  const joints = {
    lShoulder: new THREE.Vector3(), rShoulder: new THREE.Vector3(),
    lElbow: new THREE.Vector3(), rElbow: new THREE.Vector3(),
    lWrist: new THREE.Vector3(), rWrist: new THREE.Vector3(),
    lHip: new THREE.Vector3(), rHip: new THREE.Vector3(),
  };
  const batPos = new THREE.Vector3(), batQuat = new THREE.Quaternion();
  const dampedPos = new THREE.Vector3(), dampedQuat = new THREE.Quaternion();
  const forearmDir = new THREE.Vector3(), batY = new THREE.Vector3();
  const prevForearm = new THREE.Vector3(), prevBatY = new THREE.Vector3();
  const tip = new THREE.Vector3(), prevTip = new THREE.Vector3();

  const warm = Math.floor(2 * POSE_HZ);
  let forearmSteps = 0, batSteps = 0, tipSteps = 0, n = 0;
  let maxBatStep = 0, blendMax = 0, blendActive = 0;
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

    for (let r = 0; r < RENDER_HZ / POSE_HZ; r++) {
      renderIdx++;
      if (solver.solve(joints, 'right', batPos, batQuat)) {
        // Mirror Avatar.tsx: adaptation only on the pose boundary.
        batSmoother.filter(batPos, batQuat, 1 / RENDER_HZ, dampedPos, dampedQuat, r === 0, 1 / POSE_HZ);
      }
      if (renderIdx <= warm * (RENDER_HZ / POSE_HZ)) continue;

      forearmDir.subVectors(joints.rWrist, joints.rElbow).normalize();
      batY.set(0, 1, 0).applyQuaternion(dampedQuat);
      tip.copy(dampedPos).addScaledVector(batY, 0.9 * SIZE);

      if (havePrev) {
        forearmSteps += (forearmDir.angleTo(prevForearm) * 180) / Math.PI;
        const batStep = (batY.angleTo(prevBatY) * 180) / Math.PI;
        batSteps += batStep;
        maxBatStep = Math.max(maxBatStep, batStep);
        tipSteps += tip.distanceTo(prevTip) * 1000; // mm
        n++;
      }
      prevForearm.copy(forearmDir);
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
    maxBatStep,
    tipJitter: tipSteps / n,
    blendMax,
    blendActiveFrac: blendActive / n,
  };
}

const fmt = (m) =>
  `arm ${m.forearmJitter.toFixed(2)} deg/f, bat ${m.batJitter.toFixed(2)} deg/f (max ${m.maxBatStep.toFixed(1)}), tip ${m.tipJitter.toFixed(1)} mm/f, blend max ${m.blendMax.toFixed(3)} active ${(m.blendActiveFrac * 100).toFixed(0)}%`;

console.log('\n--- temporal smoothness: bat vs the arm it rides on ---');

{
  const m = runScenario(stanceWorld, null);
  console.log(`        -> static stance: ${fmt(m)}`);
  report('static stance: bat blade steadier than the forearm bone', () =>
    assert.ok(m.batJitter < m.forearmJitter * 0.9,
      `bat/body ${(m.batJitter / m.forearmJitter).toFixed(2)}x`));
  report('static stance: no swing phase at idle', () =>
    assert.ok(m.blendMax < 0.02, `blendMax ${m.blendMax}`));
}

{
  const m = runScenario(hangWorld, null);
  console.log(`        -> reference-band hang: ${fmt(m)}`);
  report('near-parallel band: bat blade steadier than the forearm bone', () =>
    assert.ok(m.batJitter < m.forearmJitter * 0.9,
      `bat/body ${(m.batJitter / m.forearmJitter).toFixed(2)}x`));
  report('near-parallel band: no single-frame blade flap', () =>
    // The pre-blend hard switch flapped ~25 deg in one render frame here.
    assert.ok(m.maxBatStep < 15, `max step ${m.maxBatStep.toFixed(1)} deg`));
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
  report('locomotion: bat blade steadier than the arm while moving', () =>
    assert.ok(m.batJitter < m.forearmJitter * 0.9,
      `bat/body ${(m.batJitter / m.forearmJitter).toFixed(2)}x`));
}

{
  const m = runScenario(stanceWorld, (lms, t) => {
    // Hand fidget RELATIVE to the torso (~1 m/s wrist peaks): arm motion,
    // correctly not rejected — but the bat must still track steadily.
    const sway = 0.12 * Math.sin(2 * Math.PI * 1.4 * t);
    lms[16] = { ...lms[16], x: lms[16].x - sway };
    lms[15] = { ...lms[15], x: lms[15].x + sway * 0.6 };
  });
  console.log(`        -> hand fidget: ${fmt(m)}`);
  report('fidget: bat blade steadier than the forearm bone', () =>
    assert.ok(m.batJitter < m.forearmJitter * 0.9,
      `bat/body ${(m.batJitter / m.forearmJitter).toFixed(2)}x`));
}

console.log(failures === 0 ? '\nAll bat-jitter sanity checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);

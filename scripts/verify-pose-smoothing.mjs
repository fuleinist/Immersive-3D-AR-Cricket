/**
 * Headless sanity check for services/poseSmoothing.ts, the seated
 * adaptation in services/trackingMode.ts, and the per-render-frame bat
 * solve in services/batTransform.ts.
 *
 * Bundles the pure modules with esbuild (already a vite dependency — no new
 * packages) and exercises them with synthetic streams:
 *
 *   1. static pose + gaussian jitter  -> variance reduction (image + world)
 *   2. fast wrist swing over 10 frames -> tracking lag vs truth
 *   3. smooth-then-adapt ordering      -> seated synthetic body de-jittered
 *   4. seated grounding invariant      -> hips at the root plane, feet at
 *      standing depth, root pinned under sway, bat directions preserved
 *   5. irregular timestamps            -> no NaN, sane recovery after gaps
 *   6. 10k-frame micro-benchmark       -> µs/frame (must be trivially
 *      sub-millisecond) + zero per-frame array/object churn
 *
 * The bat transform's temporal guarantees live in verify-bat-jitter.mjs
 * (rigid bat-arm binding); there is deliberately no bat-level filter to
 * test here — the landmark One Euro filters below ARE the bat's only
 * smoothing.
 *
 * Run: npm run verify:smoothing
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
    'tracking-mode.bundle': path.join(root, 'services', 'trackingMode.ts'),
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
  IMAGE_SPACE_SMOOTHING,
  IMAGE_SPACE_ARM_SMOOTHING,
  WORLD_SPACE_SMOOTHING,
  WORLD_SPACE_ARM_SMOOTHING,
  UPPER_BODY_LANDMARKS,
  buildLandmarkOverrides,
} = await import(path.join(cacheDir, 'pose-smoothing.bundle.mjs'));
const {
  adaptSeatedLandmarks,
  SEATED_METRIC_SHOULDER_WIDTH,
  SEATED_METRIC_ANKLE_DEPTH,
} = await import(path.join(cacheDir, 'tracking-mode.bundle.mjs'));
const { BatTransformSolver } = await import(path.join(cacheDir, 'bat-transform.bundle.mjs'));
const THREE = await import('three');

// Mirror App.tsx: arm chain gets the stronger per-landmark profile.
const IMAGE_OVERRIDES = buildLandmarkOverrides(33, UPPER_BODY_LANDMARKS, IMAGE_SPACE_ARM_SMOOTHING, IMAGE_SPACE_SMOOTHING);
const WORLD_OVERRIDES = buildLandmarkOverrides(33, UPPER_BODY_LANDMARKS, WORLD_SPACE_ARM_SMOOTHING, WORLD_SPACE_SMOOTHING);
const makeImageSmoother = () => new LandmarkSmoother(IMAGE_SPACE_SMOOTHING, 33, IMAGE_OVERRIDES);
const makeWorldSmoother = () => new LandmarkSmoother(WORLD_SPACE_SMOOTHING, 33, WORLD_OVERRIDES);

// Deterministic RNG (mulberry32) + Box-Muller gaussian.
const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rng = mulberry32(1337);
const gauss = () => {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const FRAME_MS = 1000 / 30;
const lm = (x, y, z, visibility = 0.95) => ({ x, y, z, visibility });

/** 33-landmark base pose; `space` = 'image' (0..1) or 'world' (meters). */
function basePose(space) {
  const s = space === 'world' ? { sh: 0.2, wristX: 0.25, wristY: -0.25, hipY: 0 } : { sh: 0.1, wristX: 0.35, wristY: 0.45, hipY: 0.62 };
  const l = Array.from({ length: 33 }, (_, i) => lm(0.5 * (space === 'world' ? 0 : 1) + 0, 0.3, 0));
  l[11] = lm(-s.sh / 2, -0.55 * (space === 'world' ? 1 : 0), 0); // L shoulder
  l[12] = lm(s.sh / 2, l[11].y, 0);                              // R shoulder
  l[13] = lm(-s.wristX, -0.3, -0.2); l[14] = lm(s.wristX, -0.3, 0.1);
  l[15] = lm(-s.wristX + (space === 'world' ? 0 : 0.35), s.wristY, -0.4); // L wrist (swing joint)
  l[16] = lm(s.wristX - (space === 'world' ? 0.15 : 0), s.wristY, -0.3);  // R wrist
  l[23] = lm(-0.12, s.hipY, 0); l[24] = lm(0.12, s.hipY, 0);
  return l;
}

/** Deep-copy pose + iid gaussian noise on x/y/z of every landmark. */
function noisyCopy(pose, sigma) {
  return pose.map((p) => lm(p.x + gauss() * sigma, p.y + gauss() * sigma, p.z + gauss() * sigma, p.visibility));
}

const variance = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
};

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

/**
 * Static-pose jitter trial: returns aggregate variance reduction across all
 * 33 landmarks x 3 coords, plus max |mean drift| from truth.
 */
function staticTrial(space, smootherFactory, sigma, frames = 600) {
  const truth = basePose(space);
  const smoother = smootherFactory();
  const rawSeries = []; // per frame: flat [l0x, l0y, l0z, l1x, ...]
  const outSeries = [];
  for (let f = 0; f < frames; f++) {
    const noisy = noisyCopy(truth, sigma);
    const flatRaw = [];
    for (const p of noisy) flatRaw.push(p.x, p.y, p.z);
    rawSeries.push(flatRaw);
    smoother.filter(noisy, f * FRAME_MS); // mutates in place
    const flatOut = [];
    for (const p of noisy) flatOut.push(p.x, p.y, p.z);
    outSeries.push(flatOut);
  }
  // skip 30 warm-up frames
  const warm = 30;
  let rawVarSum = 0, outVarSum = 0, maxDrift = 0;
  const channels = rawSeries[0].length;
  for (let c = 0; c < channels; c++) {
    const raw = rawSeries.slice(warm).map((f) => f[c]);
    const out = outSeries.slice(warm).map((f) => f[c]);
    rawVarSum += variance(raw);
    outVarSum += variance(out);
    const truthVal = [truth[Math.floor(c / 3)].x, truth[Math.floor(c / 3)].y, truth[Math.floor(c / 3)].z][c % 3];
    const outMean = out.reduce((a, b) => a + b, 0) / out.length;
    maxDrift = Math.max(maxDrift, Math.abs(outMean - truthVal));
  }
  return { reduction: 1 - outVarSum / rawVarSum, maxDrift };
}

/**
 * Swing trial: wrist starts static, ramps `amplitude` over `rampFrames`,
 * holds after. Returns lag (frames, via min-MSE time shift vs truth) and
 * 90%-rise lag.
 */
function swingTrial(space, smootherFactory, { amplitude, sigma, rampFrames = 10, holdBefore = 30, holdAfter = 20 }) {
  const truth = basePose(space);
  const WRIST = 15, COORD = 0; // swing L wrist along x
  const startX = truth[WRIST].x;
  const frames = holdBefore + rampFrames + holdAfter;
  const truthAt = (f) => {
    if (f < holdBefore) return startX;
    if (f < holdBefore + rampFrames) return startX + amplitude * ((f - holdBefore + 1) / rampFrames);
    return startX + amplitude;
  };

  const smoother = smootherFactory();
  const outSeries = [];
  for (let f = 0; f < frames; f++) {
    const noisy = noisyCopy(truth, sigma);
    noisy[WRIST] = { ...noisy[WRIST], x: truthAt(f) + gauss() * sigma };
    const smoothed = smoother.filter(noisy, f * FRAME_MS);
    outSeries.push(smoothed[WRIST].x);
  }

  // Lag: time shift k in [0..5] minimizing MSE between output and
  // truth(t-k), evaluated over the swing + settle window.
  const truthSeries = outSeries.map((_, f) => truthAt(f));
  const win = (arr) => arr.slice(holdBefore, holdBefore + rampFrames + 5);
  let bestK = 0, bestMse = Infinity;
  for (let k = 0; k <= 5; k++) {
    const a = win(outSeries);
    const b = win(truthSeries.map((_, i) => truthSeries[Math.max(0, i - k)]));
    const mse = a.reduce((acc, v, i) => acc + (v - b[i]) * (v - b[i]), 0) / a.length;
    if (mse < bestMse - 1e-12) { bestMse = mse; bestK = k; }
  }

  // 90% rise lag: first frame output covers 90% of the step vs truth's.
  const target = startX + amplitude * 0.9;
  const riseOf = (series) => series.findIndex((v, f) => f >= holdBefore && Math.abs(v - startX) >= Math.abs(target - startX));
  const riseLag = riseOf(outSeries) - riseOf(truthSeries);

  // Settle error after the swing.
  const settle = outSeries.slice(-5).reduce((a, b) => a + b, 0) / 5 - (startX + amplitude);
  return { lag: bestK, riseLag, settle: Math.abs(settle) };
}

console.log('\n--- static pose: jitter variance reduction ---');

const imgStatic = staticTrial('image', makeImageSmoother, 0.004); // ~2.5px at 640px
console.log(`        -> image space: variance -${(imgStatic.reduction * 100).toFixed(1)}%, max mean drift ${imgStatic.maxDrift.toFixed(5)}`);
report('image space: static jitter variance reduced >= 92%', () =>
  assert.ok(imgStatic.reduction >= 0.92, `only ${(imgStatic.reduction * 100).toFixed(1)}%`));
report('image space: no systematic drift (< half the noise sigma)', () =>
  assert.ok(imgStatic.maxDrift < 0.002, `drift ${imgStatic.maxDrift}`));

const worldStatic = staticTrial('world', makeWorldSmoother, 0.01); // 1cm
console.log(`        -> world space: variance -${(worldStatic.reduction * 100).toFixed(1)}%, max mean drift ${worldStatic.maxDrift.toFixed(5)}`);
report('world space: static jitter variance reduced >= 90%', () =>
  assert.ok(worldStatic.reduction >= 0.9, `only ${(worldStatic.reduction * 100).toFixed(1)}%`));

console.log('\n--- fast swing: tracking lag ---');

const imgSwing = swingTrial('image', makeImageSmoother, { amplitude: 0.5, sigma: 0.001 }); // 1.5 frame-widths/s
console.log(`        -> image space: lag ${imgSwing.lag} frame(s), 90% rise lag ${imgSwing.riseLag}, settle err ${imgSwing.settle.toFixed(5)}`);
report('image space: swing tracking lag <= 2 frames', () =>
  assert.ok(imgSwing.lag <= 2, `lag ${imgSwing.lag}`));
report('image space: 90% rise within 3 frames of truth', () =>
  assert.ok(imgSwing.riseLag <= 3, `rise lag ${imgSwing.riseLag}`));
report('image space: settles on the new position', () =>
  assert.ok(imgSwing.settle < 0.01, `settle err ${imgSwing.settle}`));

const worldSwing = swingTrial('world', makeWorldSmoother, { amplitude: 1.2, sigma: 0.003 }); // 3.6 m/s
console.log(`        -> world space: lag ${worldSwing.lag} frame(s), 90% rise lag ${worldSwing.riseLag}, settle err ${worldSwing.settle.toFixed(5)}`);
report('world space: swing tracking lag <= 2 frames', () =>
  assert.ok(worldSwing.lag <= 2, `lag ${worldSwing.lag}`));

console.log('\n--- ordering: smooth BEFORE seated adaptation ---');

{
  // Jittery seated upper body; compare synthetic hip-x variance when the
  // adaptation consumes raw vs smoothed landmarks.
  const seated = basePose('image').map((p) => ({ ...p, visibility: 0.95 }));
  const smoother = makeImageSmoother();
  const rawHipX = [], smoothHipX = [];
  for (let f = 0; f < 300; f++) {
    const noisy = noisyCopy(seated, 0.004);
    rawHipX.push(adaptSeatedLandmarks(noisyCopy(seated, 0.004))[23].x);
    smoothHipX.push(adaptSeatedLandmarks(smoother.filter(noisy, f * FRAME_MS))[23].x);
  }
  const rv = variance(rawHipX.slice(30)), sv = variance(smoothHipX.slice(30));
  console.log(`        -> synthetic hip-x variance: raw ${rv.toExponential(2)} vs smoothed ${sv.toExponential(2)} (-${((1 - sv / rv) * 100).toFixed(1)}%)`);
  report('seated adaptation anchored to smoothed shoulders: hip variance halved at least', () =>
    assert.ok(sv < rv * 0.5, `ratio ${(sv / rv).toFixed(2)}`));

  // The adaptation must still anchor exactly to the (smoothed) shoulders:
  // hip x follows the transformed left shoulder, y/z pinned at the root.
  const smoothedOnce = smoother.filter(noisyCopy(seated, 0.004), 300 * FRAME_MS);
  const adapted = adaptSeatedLandmarks(smoothedOnce);
  const lS = smoothedOnce[11], rS = smoothedOnce[12];
  const w = Math.hypot(lS.x - rS.x, lS.y - rS.y, lS.z - rS.z);
  const scale = Math.min(4, Math.max(0.5, SEATED_METRIC_SHOULDER_WIDTH / w));
  const anchorX = (lS.x + rS.x) / 2;
  const expectedHipX = (lS.x - anchorX) * scale * 0.76;
  report('adaptation still anchors exactly to smoothed shoulders', () =>
    assert.ok(Math.abs(adapted[23].x - expectedHipX) < 1e-9, `off by ${Math.abs(adapted[23].x - expectedHipX)}`));
  report('visibility is not smoothed (mode-detection thresholds untouched)', () => {
    const a = noisyCopy(seated, 0.004);
    a[11].visibility = 0.31;
    const before = a[11].visibility;
    smoother.filter(a, 301 * FRAME_MS);
    assert.equal(a[11].visibility, before);
  });
}

console.log('\n--- seated grounding invariant (avatar not half-sunk) ---');
{
  // Realistic seated framing: head+torso in frame, shoulders ~0.2 wide.
  const seated = basePose('image').map((p) => ({ ...p, visibility: 0.95 }));
  seated[11] = lm(0.4, 0.3, 0); seated[12] = lm(0.6, 0.3, 0);
  seated[15] = lm(0.35, 0.45, -0.1); seated[16] = lm(0.65, 0.45, -0.1);
  const adapted = adaptSeatedLandmarks(seated);

  report('synthetic hips sit exactly on the avatar root plane (y=0)', () => {
    for (const i of [23, 24]) assert.ok(Math.abs(adapted[i].y) < 1e-12, `hip ${i} y=${adapted[i].y}`);
  });
  report('feet land at the same depth below the root as the standing default pose', () => {
    for (const i of [27, 28]) assert.ok(Math.abs(adapted[i].y - SEATED_METRIC_ANKLE_DEPTH) < 1e-9, `ankle ${i} y=${adapted[i].y}`);
    // Avatar's standing default pose drops ankles 0.95 below the hip root.
    assert.ok(Math.abs(SEATED_METRIC_ANKLE_DEPTH - 0.95) < 0.02, `depth ${SEATED_METRIC_ANKLE_DEPTH}`);
  });
  report('shoulders sit at standing torso height above the root', () => {
    const shoulderY = (adapted[11].y + adapted[12].y) / 2;
    // Real torso: ~0.55-0.62m shoulder-above-hip (standing world landmarks).
    assert.ok(shoulderY < 0 && Math.abs(-shoulderY - 0.588) < 0.05, `shoulder y ${shoulderY}`);
  });
  report('legs are a standing pose: knees above ankles, heels back, toes forward', () => {
    assert.ok(adapted[25].y > 0 && adapted[25].y < adapted[27].y, 'knee not between hip and ankle');
    assert.ok(adapted[29].z < adapted[27].z, 'heel not behind ankle');
    assert.ok(adapted[31].z > adapted[27].z, 'toes not in front of ankle');
  });
  report('ground anchor is pinned: arm motion cannot move the feet', () => {
    const swung = seated.map((p) => ({ ...p }));
    swung[15] = lm(0.2, 0.25, -0.3); // swing the arms, keep the shoulders
    swung[16] = lm(0.55, 0.2, -0.25);
    const adaptedSwing = adaptSeatedLandmarks(swung);
    for (const i of [23, 24, 25, 26, 27, 28, 29, 30, 31, 32]) {
      for (const c of ['x', 'y', 'z']) {
        assert.ok(Math.abs(adaptedSwing[i][c] - adapted[i][c]) < 1e-9, `index ${i}.${c} moved`);
      }
    }
  });
  report('bat orientation inputs are direction-invariant under the adaptation', () => {
    const dir = (lms) => {
      const sub = (a, b) => new THREE.Vector3(a.x - b.x, a.y - b.y, a.z - b.z);
      const mid = sub(lms[15], lms[16]).multiplyScalar(0).add(lms[15]).add(lms[16]).multiplyScalar(0.5);
      const midShoulder = sub(lms[11], lms[12]).multiplyScalar(0).add(lms[11]).add(lms[12]).multiplyScalar(0.5);
      const wristDiff = sub(lms[15], lms[16]).normalize();
      const forearm = mid.sub(midShoulder).normalize();
      return new THREE.Vector3().crossVectors(wristDiff, forearm).normalize();
    };
    const a = dir(seated), b = dir(adapted);
    assert.ok(a.angleTo(b) < 1e-6, `bat-forward drifted ${a.angleTo(b)} rad`);
  });
}

console.log('\n--- irregular timestamps ---');
{
  const smoother = makeImageSmoother();
  const pose = basePose('image');
  const times = [0, 15, 48, 148, 180, 197, 800]; // includes 100ms + 600ms gaps
  let ok = true;
  times.forEach((t, i) => {
    const out = smoother.filter(noisyCopy(pose, 0.004).map((p, j) => (j === 15 ? { ...p, x: 0.2 + i * 0.05 } : p)), t);
    for (const p of out) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) ok = false;
    }
  });
  report('frame gaps (15ms..600ms): finite output, no NaN/explosion', () => assert.ok(ok));
  report('after a 600ms gap the filter mostly re-acquires (>50% toward input)', () => {
    const before = pose[15].x; // 0.35
    const lastIn = 0.2 + (times.length - 1) * 0.05; // 0.5
    const s2 = makeImageSmoother();
    const f1 = noisyCopy(pose, 0.0001); f1[15] = { ...f1[15], x: before };
    s2.filter(f1, 0);
    const f2 = noisyCopy(pose, 0.0001); f2[15] = { ...f2[15], x: lastIn };
    const out = s2.filter(f2, 600)[15].x;
    assert.ok(Math.abs(out - lastIn) < Math.abs(before - lastIn) * 0.5, `moved to ${out}`);
  });
}

console.log('\n--- hot path: allocation + throughput ---');
{
  const img = makeImageSmoother();
  const world = makeWorldSmoother();
  // The bat work that actually runs per render frame now: one solve()
  // from the smoothed joints (plus notePoseFrame at the pose cadence).
  const solver = new BatTransformSolver();
  const frames = 10_000;
  const imgFrames = Array.from({ length: 256 }, () => noisyCopy(basePose('image'), 0.004));
  const worldFrames = Array.from({ length: 256 }, () => noisyCopy(basePose('world'), 0.01));

  // Identity check: same array + same landmark objects back (zero churn).
  const refBefore = imgFrames[0];
  const lmBefore = imgFrames[0][7];
  const ret = img.filter(refBefore, 0);
  report('filter() returns the same array and mutates landmark objects in place', () => {
    assert.equal(ret, refBefore);
    assert.equal(refBefore[7], lmBefore);
  });

  // Preallocated solver I/O, mirroring Avatar.tsx scratch (zero-alloc
  // hot path): joints filled once from the base world pose and held.
  const SIZE = 0.85;
  const mapW = (p) => new THREE.Vector3(p.x * SIZE, -p.y * SIZE, -p.z * SIZE);
  const wl = basePose('world');
  const batJoints = {
    lShoulder: mapW(wl[11]), rShoulder: mapW(wl[12]),
    lElbow: mapW(wl[13]), rElbow: mapW(wl[14]),
    lWrist: mapW(wl[15]), rWrist: mapW(wl[16]),
    lHip: mapW(wl[23]), rHip: mapW(wl[24]),
  };
  const batOutP = new THREE.Vector3(), batOutQ = new THREE.Quaternion();

  const t0 = process.hrtime.bigint();
  for (let f = 0; f < frames; f++) {
    img.filter(imgFrames[f & 255], f * FRAME_MS);
    world.filter(worldFrames[f & 255], f * FRAME_MS);
    if (f % 2 === 0) solver.notePoseFrame(batJoints, 'right', 1 / 30);
    solver.solve(batJoints, 'right', batOutP, batOutQ);
  }
  const ns = Number(process.hrtime.bigint() - t0);
  const usPerFrame = ns / 1000 / frames; // both landmark streams + bat per pose frame
  console.log(`        -> ${frames.toLocaleString()} frames x (33 landmarks x 3ch x 2 spaces + bat solve): ${(ns / 1e6).toFixed(1)}ms total, ${usPerFrame.toFixed(2)} µs/frame`);
  report('throughput: < 250 µs/frame (budget is trivially sub-millisecond)', () =>
    assert.ok(usPerFrame < 250, `${usPerFrame.toFixed(2)} µs/frame`));
}

console.log(failures === 0 ? '\nAll pose-smoothing sanity checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);

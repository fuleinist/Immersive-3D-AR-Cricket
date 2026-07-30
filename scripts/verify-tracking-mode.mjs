/**
 * Headless sanity check for services/trackingMode.ts.
 *
 * The webcam path can't be tested headless, so this bundles the pure module
 * with esbuild (already a vite dependency — no new packages) and exercises
 * the decision + adaptation functions with synthetic landmark sets:
 *
 *   seated at a desk, seated with hips cropped by the frame, standing,
 *   standing far from camera, standing close (documented false positive),
 *   empty / sparse / mixed windows, and the seated-lower-body adaptation.
 *
 * Run: npm run verify:tracking
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'node_modules', '.cache', 'tracking-mode.bundle.mjs');

await build({
  entryPoints: [path.join(root, 'services', 'trackingMode.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent',
});

const {
  sampleFrame,
  classifyFrame,
  detectTrackingMode,
  adaptSeatedLandmarks,
  MODE_WINDOW_FRAMES,
  SEATED_METRIC_SHOULDER_WIDTH,
  SEATED_METRIC_ANKLE_DEPTH,
} = await import(outfile);

const lm = (x, y, z, visibility) => ({ x, y, z, visibility });

/** 33 normalized landmarks: visible upper body, configurable lower body. */
function makeLandmarks({ upperVis = 0.95, hipVis = 0.9, hipY = 0.62, kneeVis = 0.85, ankleVis = 0.8 } = {}) {
  const l = Array.from({ length: 33 }, () => lm(0.5, 0.3, 0, upperVis));
  l[11] = lm(0.4, 0.3, 0, upperVis);  // L shoulder
  l[12] = lm(0.6, 0.3, 0, upperVis);  // R shoulder
  l[15] = lm(0.35, 0.45, -0.1, upperVis); // L wrist
  l[16] = lm(0.65, 0.45, -0.1, upperVis); // R wrist
  l[23] = lm(0.45, hipY, 0, hipVis);  // L hip
  l[24] = lm(0.55, hipY, 0, hipVis);  // R hip
  l[25] = lm(0.45, hipY + 0.18, 0, kneeVis);
  l[26] = lm(0.55, hipY + 0.18, 0, kneeVis);
  l[27] = lm(0.45, hipY + 0.36, 0, ankleVis);
  l[28] = lm(0.55, hipY + 0.36, 0, ankleVis);
  return l;
}

const windowOf = (landmarks, frames = MODE_WINDOW_FRAMES) =>
  Array.from({ length: frames }, () => sampleFrame(landmarks));

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
const show = (label, d) =>
  console.log(`        -> ${label}: ${d.mode} (confidence ${d.confidence.toFixed(2)}, seated ${(d.seatedFraction * 100).toFixed(0)}%, ${d.frames}f) — ${d.reason}`);

console.log('\n--- windowed detection ---');

const seatedDesk = detectTrackingMode(windowOf(makeLandmarks({ hipVis: 0.2, hipY: 0.9, kneeVis: 0.1, ankleVis: 0.05 })));
show('seated at desk (hips occluded)', seatedDesk);
report('seated at desk -> SITTING', () => assert.equal(seatedDesk.mode, 'SITTING'));

const seatedCropped = detectTrackingMode(windowOf(makeLandmarks({ hipVis: 0.7, hipY: 1.05, kneeVis: 0.5, ankleVis: 0.3 })));
show('seated, hips below frame', seatedCropped);
report('hips below frame -> SITTING', () => assert.equal(seatedCropped.mode, 'SITTING'));

const standing = detectTrackingMode(windowOf(makeLandmarks()));
show('standing, full body visible', standing);
report('standing full body -> STANDING', () => assert.equal(standing.mode, 'STANDING'));

const farUser = detectTrackingMode(windowOf(makeLandmarks({ hipVis: 0.75, hipY: 0.55, kneeVis: 0.65, ankleVis: 0.6 })));
show('standing far from camera', farUser);
report('far user (all visible, lower scores) -> STANDING', () => assert.equal(farUser.mode, 'STANDING'));

const closeStanding = detectTrackingMode(windowOf(makeLandmarks({ hipVis: 0.55, hipY: 1.05, kneeVis: 0.2, ankleVis: 0.1 })));
show('standing close to camera (hips cropped)', closeStanding);
report('close standing -> SITTING (known false positive, override via menu selector)', () =>
  assert.equal(closeStanding.mode, 'SITTING'));

const empty = detectTrackingMode([]);
show('empty window', empty);
report('empty window -> STANDING (insufficient data)', () => assert.equal(empty.mode, 'STANDING'));

const mixed = detectTrackingMode([
  ...windowOf(makeLandmarks({ hipVis: 0.2, hipY: 0.9, kneeVis: 0.1, ankleVis: 0.05 }), 22),
  ...windowOf(makeLandmarks(), 23),
]);
show('mixed 50/50 window', mixed);
report('mixed window -> STANDING (bias)', () => assert.equal(mixed.mode, 'STANDING'));

const mostlyUnknown = detectTrackingMode(
  windowOf(makeLandmarks({ hipVis: 0.55, hipY: 0.6, kneeVis: 0.35, ankleVis: 0.35 }))
);
show('ambiguous visibility (mostly unknown frames)', mostlyUnknown);
report('ambiguous window -> STANDING (insufficient classified)', () => assert.equal(mostlyUnknown.mode, 'STANDING'));

console.log('\n--- frame classification edges ---');
report('sampleFrame null on short arrays', () => {
  assert.equal(sampleFrame(null), null);
  assert.equal(sampleFrame([]), null);
  assert.equal(sampleFrame(makeLandmarks().slice(0, 17)), null);
});
report('classifyFrame: one good knee is enough for standing', () => {
  const s = sampleFrame(makeLandmarks({ kneeVis: 0.5, ankleVis: 0 }));
  assert.equal(classifyFrame(s), 'standing');
});

console.log('\n--- seated adaptation (hip-anchored metric standing pose) ---');
const input = makeLandmarks({ hipVis: 0.1, hipY: 1.2, kneeVis: 0, ankleVis: 0 });
const adapted = adaptSeatedLandmarks(input);

// Expected similitude for the input above: shoulders (0.4,0.3,0)/(0.6,0.3,0)
// -> w = 0.2, scale = 0.42/0.2 = 2.1, anchor = (0.5, 0.3 + 1.4*0.2, 0).
const W = 0.2, SCALE = SEATED_METRIC_SHOULDER_WIDTH / W;
const ANCHOR = { x: 0.5, y: 0.3 + 1.4 * W, z: 0 };
report('upper body re-expressed by the shoulder-anchored similitude', () => {
  for (const i of [0, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]) {
    const p = input[i];
    const expected = {
      x: (p.x - ANCHOR.x) * SCALE,
      y: (p.y - ANCHOR.y) * SCALE,
      z: (p.z - ANCHOR.z) * SCALE,
    };
    assert.ok(Math.abs(adapted[i].x - expected.x) < 1e-9, `index ${i} x: ${adapted[i].x} != ${expected.x}`);
    assert.ok(Math.abs(adapted[i].y - expected.y) < 1e-9, `index ${i} y: ${adapted[i].y} != ${expected.y}`);
    assert.ok(Math.abs(adapted[i].z - expected.z) < 1e-9, `index ${i} z: ${adapted[i].z} != ${expected.z}`);
    assert.equal(adapted[i].visibility, p.visibility, `index ${i} visibility changed`);
  }
});
report('shoulder span is rescaled to the anatomical metric constant', () => {
  const span = Math.hypot(adapted[11].x - adapted[12].x, adapted[11].y - adapted[12].y, adapted[11].z - adapted[12].z);
  assert.ok(Math.abs(span - SEATED_METRIC_SHOULDER_WIDTH) < 1e-9, `span ${span}`);
});
report('lower body replaced with visible synthetic joints', () => {
  for (const i of [23, 24, 25, 26, 27, 28, 29, 30, 31, 32]) {
    assert.notEqual(adapted[i], input[i], `index ${i} not replaced`);
    assert.equal(adapted[i].visibility, 0.9);
  }
});
report('synthetic hips pinned at the root, knees ahead, ankles below at standing depth', () => {
  assert.ok(Math.abs(adapted[23].y) < 1e-12 && Math.abs(adapted[24].y) < 1e-12, 'hips not at root plane');
  assert.ok(adapted[25].y > 0 && adapted[25].y < adapted[27].y, 'knees not between hips and ankles');
  assert.ok(Math.abs(adapted[27].y - SEATED_METRIC_ANKLE_DEPTH) < 1e-9, `ankle depth ${adapted[27].y}`);
  assert.ok(Math.abs(SEATED_METRIC_ANKLE_DEPTH - 0.95) < 0.02, `ankle depth ${SEATED_METRIC_ANKLE_DEPTH} != standing 0.95`);
  assert.ok(adapted[25].z > adapted[23].z, 'knees not toward viewer');
  assert.ok(Math.abs(adapted[27].x) > Math.abs(adapted[23].x), 'stance not wider than hips');
});
report('root stays pinned when the player sways (feet on the ground plane)', () => {
  const shifted = makeLandmarks({ hipVis: 0.1, hipY: 1.2, kneeVis: 0, ankleVis: 0 });
  shifted[11] = { ...shifted[11], x: shifted[11].x + 0.1 };
  shifted[12] = { ...shifted[12], x: shifted[12].x + 0.1 };
  const adaptedShifted = adaptSeatedLandmarks(shifted);
  for (const i of [23, 24, 27, 28]) {
    assert.ok(Math.abs(adaptedShifted[i].y - adapted[i].y) < 1e-9, `index ${i} y moved with sway`);
  }
});
report('bat-relevant directions are invariant under the similitude', () => {
  const dir = (lms) => {
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
    const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
    const norm = (v) => { const n = Math.hypot(v.x, v.y, v.z); return { x: v.x / n, y: v.y / n, z: v.z / n }; };
    const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
    const wristDiff = norm(sub(lms[15], lms[16]));
    const forearm = norm(sub(mid(lms[15], lms[16]), mid(lms[11], lms[12])));
    return norm(cross(wristDiff, forearm));
  };
  const a = dir(input), b = dir(adapted);
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  assert.ok(Math.abs(1 - dot) < 1e-9, `bat-forward direction drifted (dot ${dot})`);
});
report('untracked shoulders -> input returned unchanged', () => {
  const weak = makeLandmarks({ upperVis: 0.2 });
  assert.equal(adaptSeatedLandmarks(weak), weak);
});
report('degenerate shoulder span -> input returned unchanged', () => {
  const degenerate = makeLandmarks({ hipVis: 0.1 });
  degenerate[12] = { ...degenerate[11] };
  assert.equal(adaptSeatedLandmarks(degenerate), degenerate);
});

console.log(failures === 0 ? '\nAll tracking-mode sanity checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);

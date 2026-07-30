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

console.log('\n--- seated adaptation ---');
const input = makeLandmarks({ hipVis: 0.1, hipY: 1.2, kneeVis: 0, ankleVis: 0 });
const adapted = adaptSeatedLandmarks(input);
report('upper-body landmarks keep original references', () => {
  for (const i of [0, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]) {
    assert.equal(adapted[i], input[i], `index ${i} reference changed`);
  }
});
report('lower body replaced with visible synthetic joints', () => {
  for (const i of [23, 24, 25, 26, 27, 28, 29, 30, 31, 32]) {
    assert.notEqual(adapted[i], input[i], `index ${i} not replaced`);
    assert.equal(adapted[i].visibility, 0.9);
  }
});
report('synthetic hips sit below shoulders, knees ahead of hips, ankles below knees', () => {
  const midShoulderY = (input[11].y + input[12].y) / 2;
  assert.ok(adapted[23].y > midShoulderY, 'hips not below shoulders');
  assert.ok(adapted[25].z < adapted[23].z, 'knees not toward camera');
  assert.ok(adapted[27].y > adapted[25].y, 'ankles not below knees');
});
report('synthetic lower body is anchored to live shoulders', () => {
  const shifted = makeLandmarks({ hipVis: 0.1, hipY: 1.2, kneeVis: 0, ankleVis: 0 });
  shifted[11] = { ...shifted[11], x: shifted[11].x + 0.1 };
  shifted[12] = { ...shifted[12], x: shifted[12].x + 0.1 };
  const adaptedShifted = adaptSeatedLandmarks(shifted);
  assert.ok(Math.abs(adaptedShifted[23].x - (adapted[23].x + 0.1)) < 1e-9, 'hip x did not follow shoulder shift');
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

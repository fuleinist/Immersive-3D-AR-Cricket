/**
 * Headless sanity check for services/lateralTracking.ts — the avatar
 * lateral root tracker that lets the avatar drift left/right with the
 * player instead of standing root-locked at the crease.
 *
 * Bundles the pure module with esbuild (already a vite dependency — no new
 * packages) and exercises it with synthetic mid-shoulder-x streams:
 *
 *   1. auto-center   -> first valid frame becomes the neutral center
 *   2. direction     -> user-right (raw image x decreases) maps to +X,
 *      user-left to -X (mirrored-preview convention)
 *   3. clamp         -> full-frame displacement clamps to the mode range
 *   4. seated        -> sit mode clamps to a smaller range
 *   5. degenerate    -> visibility drop / non-finite input HOLDS the last
 *      offset (never snaps back to center)
 *   6. recalibrate   -> calibrate() resets to 0 and re-centers on the
 *      player's current position
 *   7. smoothing     -> a step input is approached gradually (no snap)
 *      and settles on the target
 *
 * Run: npm run verify:lateral
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'node_modules', '.cache', 'lateral-root.bundle.mjs');

await build({
  entryPoints: [path.join(root, 'services', 'lateralTracking.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile,
  logLevel: 'silent',
});

const { LateralRootTracker, LATERAL_ROOT_TUNING } = await import(outfile);

const DT = 1 / 30;
const VIS = 0.95;

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

/** Feed n frames at a fixed mid-shoulder x; return the final offset. */
const run = (tracker, x, frames, vis = VIS) => {
  let off = 0;
  for (let i = 0; i < frames; i++) off = tracker.update(x, vis, DT);
  return off;
};

console.log('\n--- lateral root tracking ---');

report('first valid frame auto-centers (offset starts at 0)', () => {
  const t = new LateralRootTracker();
  const off = t.update(0.48, VIS, DT);
  assert.ok(Math.abs(off) < 1e-12, `offset ${off}`);
});

report('user moving right (raw image x decreases) shifts avatar +X', () => {
  const t = new LateralRootTracker();
  run(t, 0.5, 10); // settle center
  const off = run(t, 0.4, 120); // 10% of frame width to the user's right
  const expected = 0.1 * LATERAL_ROOT_TUNING.scale; // 0.22m
  assert.ok(off > 0, `offset should be positive (${off})`);
  assert.ok(Math.abs(off - expected) < 0.01, `settled at ${off}, expected ~${expected}`);
});

report('user moving left (raw image x increases) shifts avatar -X', () => {
  const t = new LateralRootTracker();
  run(t, 0.5, 10);
  const off = run(t, 0.62, 120);
  assert.ok(off < 0, `offset should be negative (${off})`);
  assert.ok(Math.abs(off + 0.12 * LATERAL_ROOT_TUNING.scale) < 0.01, `settled at ${off}`);
});

report('displacement clamps to the standing range', () => {
  const t = new LateralRootTracker();
  run(t, 0.5, 10);
  const off = run(t, 0.0, 200); // half a frame width — far beyond the range
  assert.ok(Math.abs(off - LATERAL_ROOT_TUNING.rangeStanding) < 0.005,
    `settled at ${off}, expected ~${LATERAL_ROOT_TUNING.rangeStanding}`);
});

report('sit mode clamps to the smaller seated range', () => {
  const t = new LateralRootTracker();
  t.setMode('SITTING');
  run(t, 0.5, 10);
  const off = run(t, 0.0, 200);
  assert.ok(Math.abs(off - LATERAL_ROOT_TUNING.rangeSitting) < 0.005,
    `settled at ${off}, expected ~${LATERAL_ROOT_TUNING.rangeSitting}`);
  assert.ok(LATERAL_ROOT_TUNING.rangeSitting < LATERAL_ROOT_TUNING.rangeStanding,
    'seated range must be smaller');
});

report('shoulder visibility drop HOLDS the last offset (no snap to center)', () => {
  const t = new LateralRootTracker();
  run(t, 0.5, 10);
  const before = run(t, 0.42, 90);
  assert.ok(Math.abs(before) > 0.05, `setup: offset should be non-trivial (${before})`);
  let held = before;
  for (let i = 0; i < 30; i++) held = t.update(0.5, 0.2, DT); // shoulders "lost"
  assert.equal(held, before, `offset moved during occlusion (${held} != ${before})`);
  // recovers to the new center once tracking returns
  const after = run(t, 0.5, 120);
  assert.ok(Math.abs(after) < 0.01, `should re-settle near 0 (${after})`);
});

report('non-finite input holds the last offset', () => {
  const t = new LateralRootTracker();
  run(t, 0.5, 10);
  const before = run(t, 0.45, 60);
  assert.equal(t.update(NaN, VIS, DT), before);
  assert.equal(t.update(Infinity, VIS, DT), before);
});

report('calibrate() resets to 0 and re-centers on the current position', () => {
  const t = new LateralRootTracker();
  run(t, 0.5, 10);
  run(t, 0.4, 90); // player standing right of center
  t.calibrate(); // session start: wherever they are now is neutral
  assert.equal(t.current, 0);
  const off = run(t, 0.4, 60); // same spot reads as neutral now
  assert.ok(Math.abs(off) < 0.01, `should stay near 0 after recalibration (${off})`);
  // and motion relative to the NEW center tracks again
  const moved = run(t, 0.34, 120);
  assert.ok(moved > 0.05, `motion after recalibration should track (${moved})`);
});

report('step input is approached gradually and settles on the target', () => {
  const t = new LateralRootTracker();
  run(t, 0.5, 30);
  const target = 0.06 * LATERAL_ROOT_TUNING.scale;
  const first = t.update(0.44, VIS, DT);
  assert.ok(Math.abs(first) < target * 0.9, `first frame too snappy (${first} of ${target})`);
  const settled = run(t, 0.44, 150);
  assert.ok(Math.abs(settled - target) < 0.005, `settled at ${settled}, expected ~${target}`);
});

console.log(failures === 0 ? '\nAll lateral-root sanity checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);

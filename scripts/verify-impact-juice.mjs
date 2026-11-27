/**
 * Headless sanity check for services/impactJuice.ts - the bat-contact hit-stop
 * and the ball trail (issue #15, contact-juice slice).
 *
 * The failures this harness exists for:
 *  - the ball kept full speed on the frame after contact, so a middled shot had
 *    no impact beat and read as a teleport;
 *  - a trail buffer that accepts every position fills with zero-length
 *    segments when the ball restarts, or grows without a bound on a long shot.
 *
 * Every check would fail on the naive variant: an always-live gate, an
 * unspaced buffer, an unbounded buffer or a constant alpha.
 *
 * Run: npm run verify:juice
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, 'node_modules', '.cache', 'impact-juice');

const SOURCES = ['services/impactJuice.ts'];

/**
 * esbuild is preferred, but its service spawns a child with piped stdio, which
 * some sandboxes refuse (spawn EPERM). The fallback is the TypeScript compiler
 * API, which runs in-process.
 */
async function loadModule(relPath) {
  const outName = (p) => path.basename(p).replace(/\.ts$/, '.mjs');
  const outfile = path.join(cacheDir, outName(relPath));

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
    await fs.mkdir(cacheDir, { recursive: true });
    for (const source of SOURCES) {
      const text = await fs.readFile(path.join(root, source), 'utf8');
      const js = ts
        .transpileModule(text, {
          compilerOptions: { target: 'ES2022', module: 'ESNext' },
        })
        .outputText.replace(/from\s+['"](\.[^'"]*)['"]/g, (_m, spec) => {
          return `from './${path.basename(spec).replace(/\.ts$/, '')}.mjs'`;
        });
      await fs.writeFile(path.join(cacheDir, outName(source)), js);
    }
  }
  return await import(pathToFileURL(outfile).href);
}

const {
  HIT_STOP_MIN_SPEED_MPS,
  HIT_STOP_MAX_SPEED_MPS,
  HIT_STOP_MIN_MS,
  HIT_STOP_MAX_MS,
  HIT_STOP_RELEASE_MS,
  TRAIL_CAPACITY,
  TRAIL_MIN_SPACING_M,
  TRAIL_MAX_AGE_MS,
  hitStopDurationMs,
  HitStopGate,
  BallTrail,
  makeTrailPoints,
} = await loadModule('services/impactJuice.ts');

let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err.message}`);
  }
}

const closeTo = (actual, expected, tolerance, label) => {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} is not within ${tolerance} of ${expected}`,
  );
};

await check('1 duration curve endpoints', async () => {
  assert.equal(hitStopDurationMs(HIT_STOP_MIN_SPEED_MPS), HIT_STOP_MIN_MS, 'the weakest hold is off');
  assert.equal(hitStopDurationMs(HIT_STOP_MAX_SPEED_MPS), HIT_STOP_MAX_MS, 'the strongest hold is off');
  assert.equal(hitStopDurationMs(100), HIT_STOP_MAX_MS, 'a speed above the cap is not clamped');
  assert.equal(hitStopDurationMs(HIT_STOP_MIN_SPEED_MPS - 0.01), 0, 'a slow contact still holds');
  assert.equal(hitStopDurationMs(0), 0, 'a resting contact holds');
  assert.equal(hitStopDurationMs(Number.NaN), 0, 'a non-finite speed holds');
  assert.equal(hitStopDurationMs(Number.POSITIVE_INFINITY), 0, 'an infinite speed holds');
});

await check('2 duration curve is monotonic', async () => {
  const speeds = [8, 12, 20, 30, 40, 45];
  let previous = -1;
  for (const speed of speeds) {
    const value = hitStopDurationMs(speed);
    assert(value > previous, `the curve did not rise at ${speed} m/s (${value})`);
    previous = value;
  }
  closeTo(hitStopDurationMs(26.5), (HIT_STOP_MIN_MS + HIT_STOP_MAX_MS) / 2, 1e-9, 'the midpoint hold');
});

await check('3 gate freezes the ball at contact', async () => {
  const gate = new HitStopGate();
  const speed = 30;
  const now = 1_000;
  const hold = gate.begin(speed, now);

  assert.equal(hold, hitStopDurationMs(speed), 'begin reported a hold the curve does not produce');
  assert(hold > 0, 'a 30 m/s contact produced no hold');
  assert.equal(gate.isActive, true, 'the gate is not active after begin');

  // The whole hold window is a full stop. A gate that returns 1 at once fails here.
  assert.equal(gate.advance(now), 0, 'the ball was not held on the contact frame');
  assert.equal(gate.advance(now + hold * 0.5), 0, 'the ball was not held mid-window');
  assert.equal(gate.advance(now + hold), 0, 'the hold ended before its duration');

  // Evidence the window is real: the same gate is mid-ramp one release half later.
  const mid = gate.advance(now + hold + HIT_STOP_RELEASE_MS / 2);
  assert(mid > 0 && mid < 1, `the release ramp returned ${mid}, not a mid value`);
});

await check('4 gate releases exactly once', async () => {
  const gate = new HitStopGate();
  const now = 5_000;
  const hold = gate.begin(40, now);
  gate.advance(now + hold);

  const scale = gate.advance(now + hold + HIT_STOP_RELEASE_MS);
  assert.equal(scale, 1, 'the gate did not reach full speed at the end of the release');
  assert.equal(gate.isActive, false, 'the gate is still active after the release');

  assert.equal(gate.consumeRelease(), true, 'the release was not reported');
  assert.equal(gate.consumeRelease(), false, 'the release was reported twice');
  assert.equal(gate.advance(now + hold + HIT_STOP_RELEASE_MS + 1_000), 1, 'a spent gate slows the ball');
});

await check('5 a soft contact never holds', async () => {
  const gate = new HitStopGate();
  assert.equal(gate.begin(3, 0), 0, 'a 3 m/s contact armed a hold');
  assert.equal(gate.isActive, false, 'a soft contact left the gate active');
  assert.equal(gate.advance(10), 1, 'a soft contact slowed the ball');
  assert.equal(gate.consumeRelease(), false, 'a soft contact reported a release');
});

await check('6 reset clears the gate', async () => {
  const gate = new HitStopGate();
  const now = 2_000;
  const hold = gate.begin(45, now);
  gate.advance(now + hold * 0.25);
  gate.reset();

  assert.equal(gate.isActive, false, 'reset left the gate active');
  assert.equal(gate.advance(now + hold * 0.25), 1, 'reset still slows the ball');
  assert.equal(gate.consumeRelease(), false, 'reset left a pending release');
});

await check('7 trail drops points that are too close', async () => {
  const trail = new BallTrail();
  assert.equal(TRAIL_MIN_SPACING_M, trail.minSpacing, 'the default spacing moved');

  assert.equal(trail.push(0, 0, 0, 0), true, 'the first point was rejected');
  assert.equal(trail.push(0.1, 0, 0, 10), false, 'a point inside the spacing was stored');
  assert.equal(trail.push(0, 0, 0, 20), false, 'a duplicate position was stored');
  assert.equal(trail.push(0.5, 0, 0, 30), true, 'a point outside the spacing was rejected');

  const points = trail.sample(30);
  assert.equal(points.length, 2, 'the sample carries the skipped point');
  assert.deepEqual(points.map((p) => p.x), [0, 0.5], 'the sample holds the wrong points');
});

await check('8 trail is bounded', async () => {
  const capacity = 4;
  const trail = new BallTrail(capacity, 0.1, 1_000);
  for (let i = 0; i < 10; i += 1) {
    trail.push(i * 0.5, 0, 0, i * 10);
  }

  assert.equal(trail.size, capacity, `the trail holds ${trail.size} points, not ${capacity}`);
  const points = trail.sample(90);
  assert.deepEqual(
    points.map((p) => p.x),
    [3, 3.5, 4, 4.5],
    'the oldest points were not the ones evicted',
  );
});

await check('9 trail fades and expires', async () => {
  const trail = new BallTrail(8, 0.1, 500);
  trail.push(0, 0, 0, 0);
  trail.push(1, 0, 0, 250);
  trail.push(2, 0, 0, 500);

  const live = trail.sample(500);
  assert.equal(live.length, 3, 'a point inside the age window was dropped');
  assert.equal(live[0].alpha, 0, 'the oldest point is not fully faded at the window edge');
  closeTo(live[1].alpha, 0.5, 1e-9, 'a half-aged point alpha');
  assert.equal(live[2].alpha, 1, 'the newest point is not fully lit');
  assert(live[0].alpha < live[1].alpha && live[1].alpha < live[2].alpha, 'alpha does not fall with age');

  // One millisecond past the window the oldest point is gone, not merely dark.
  const aged = trail.sample(501);
  assert.equal(aged.length, 2, 'an expired point survived the sample');
  assert.deepEqual(aged.map((p) => p.x), [1, 2], 'the wrong point expired');
});

await check('10 trail reset clears the buffer', async () => {
  const trail = new BallTrail();
  for (let i = 0; i < 5; i += 1) trail.push(i, 0, 0, i * 10);
  assert(trail.size > 0, 'the trail is empty before reset');

  trail.reset();
  assert.equal(trail.size, 0, 'reset left points behind');
  assert.equal(trail.sample(100).length, 0, 'reset left a drawable sample');
});

await check('11 the same input produces the same sample', async () => {
  const build = () => {
    const trail = new BallTrail(6, 0.2, 400);
    for (let i = 0; i < 8; i += 1) trail.push(i * 0.3, i * 0.1, -i * 0.2, i * 40);
    return trail.sample(300);
  };

  assert.deepEqual(build(), build(), 'two identical trails produced different samples');
});

await check('12 a clock that steps back restarts the trail', async () => {
  const trail = new BallTrail();
  trail.push(0, 0, 0, 1_000);
  trail.push(5, 0, 0, 1_010);
  assert.equal(trail.size, 2, 'the trail did not record the forward points');

  assert.equal(trail.push(-5, 0, 0, 10), true, 'a backwards clock rejected the new point');
  const points = trail.sample(10);
  assert.equal(points.length, 1, 'the stale points survived a backwards clock');
  assert.equal(points[0].x, -5, 'the restarted trail holds the wrong point');
});

await check('13 sampleInto reuses a preallocated target', async () => {
  const trail = new BallTrail(8, 0.2, 400);
  for (let i = 0; i < 5; i += 1) trail.push(i, 0, 0, i * 10);

  // A target smaller than the live set is filled oldest first and capped.
  const target = makeTrailPoints(3);
  const count = trail.sampleInto(target, 40);
  assert.equal(count, 3, `sampleInto returned ${count}, not the target capacity`);
  assert.deepEqual(target.map((p) => p.x), [0, 1, 2], 'sampleInto wrote the wrong slice');

  // The same buffer model covers the whole live set when there is room.
  const full = makeTrailPoints(8);
  assert.equal(trail.sampleInto(full, 40), 5, 'sampleInto did not write the whole live set');
  assert.deepEqual(full.slice(0, 5).map((p) => p.x), [0, 1, 2, 3, 4], 'the full write is out of order');
  assert.equal(makeTrailPoints(4).length, 4, 'makeTrailPoints ignored its capacity');

  const idle = new BallTrail(4);
  const empty = makeTrailPoints(4);
  assert.equal(idle.sampleInto(empty, 0), 0, 'an empty trail reported points');
});

await check('14 declared defaults reach the live path', async () => {
  const trail = new BallTrail();
  assert.equal(trail.capacity, TRAIL_CAPACITY, 'the default capacity is not applied');
  assert.equal(trail.maxAge, TRAIL_MAX_AGE_MS, 'the default max age is not applied');
  assert.equal(trail.minSpacing, TRAIL_MIN_SPACING_M, 'the default spacing is not applied');
});

process.exitCode = failures ? 1 : 0;
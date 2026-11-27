/**
 * Headless sanity check for services/stumpImpact.ts - the pure stump and bail
 * reaction the render loop drives (issue #15, dynamic-stumps slice).
 *
 * The failure this harness exists for: a 160 km/h yorker left three static
 * cylinders standing and the bails never moved, so no contact could ever be
 * shown. These checks fail if the gate test drifts, if the neighbour shatter or
 * the zing threshold change, if the same seed stops producing the same state, if
 * a bail stops flying or never comes to rest, or if a reset leaves a stump
 * toppled.
 *
 * Run: npm run verify:stumps
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, 'node_modules', '.cache', 'stumps');

const SOURCES = [
  'services/shotPhysics.ts',
  'services/stumpImpact.ts',
];

/**
 * esbuild is preferred, but its service spawns a child with piped stdio, which
 * some sandboxes refuse (spawn EPERM). The fallback is the TypeScript compiler
 * API, which runs in-process. Every source is transpiled into one flat cache
 * directory, so a relative specifier is rewritten to its basename plus .mjs.
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
  STUMP_PLANE_Z,
  STUMP_XS,
  STUMP_HEIGHT,
} = await loadModule('services/shotPhysics.ts');

const {
  GROUND_Y,
  MAX_TOPPLE_ANGLE,
  createRestImpactState,
  resolveStumpImpact,
  advanceImpact,
  resetImpact,
  isSettled,
} = await loadModule('services/stumpImpact.ts');

const ZERO = { x: 0, y: 0, z: 0 };

function isZeroVec(v) {
  return v.x === 0 && v.y === 0 && v.z === 0;
}

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

await check('1 rest layout', async () => {
  const state = createRestImpactState();

  assert.equal(state.seed, 0);
  assert.equal(state.speedMps, 0);
  assert.equal(state.elapsed, 0);
  assert.equal(state.stumps.length, 3);
  assert.equal(state.bails.length, 2);

  for (let i = 0; i < 3; i++) {
    const stump = state.stumps[i];
    assert.equal(stump.active, false, `stump ${i} is active at rest`);
    assert.equal(stump.position.x, STUMP_XS[i], `stump ${i} is off its x`);
    assert.equal(stump.position.y, 0, `stump ${i} is not pivoted at the ground`);
    assert.equal(stump.position.z, STUMP_PLANE_Z, `stump ${i} is off the stump plane`);
    assert(isZeroVec(stump.velocity), `stump ${i} has velocity at rest`);
    assert.equal(stump.angle, 0, `stump ${i} has angle at rest`);
    assert.equal(stump.angleVelocity, 0, `stump ${i} has angleVelocity at rest`);
  }

  assert.equal(state.bails[0].position.x, (STUMP_XS[0] + STUMP_XS[1]) / 2, 'bail 0 is not centred on stumps 0-1');
  assert.equal(state.bails[1].position.x, (STUMP_XS[1] + STUMP_XS[2]) / 2, 'bail 1 is not centred on stumps 1-2');

  for (let j = 0; j < 2; j++) {
    const bail = state.bails[j];
    assert.equal(bail.active, false, `bail ${j} is active at rest`);
    assert.equal(bail.position.y, STUMP_HEIGHT, `bail ${j} is not sitting on top of the stumps`);
    assert.equal(bail.position.z, STUMP_PLANE_Z, `bail ${j} is off the stump plane`);
    assert(isZeroVec(bail.velocity), `bail ${j} has velocity at rest`);
    assert.equal(bail.angle, 0, `bail ${j} has angle at rest`);
    assert.equal(bail.angleVelocity, 0, `bail ${j} has angleVelocity at rest`);
  }

  assert.deepEqual(state.struck, [false, false, false], 'struck flags are not all false at rest');
  assert.equal(state.zing, false, 'a resting gate cannot zing');
  assert.equal(isSettled(state), true, 'the rest layout is not settled');
});

await check('2 off stump at 18 m/s', async () => {
  const state = resolveStumpImpact({ x: 0.11, y: 0.35, z: STUMP_PLANE_Z }, 18);

  assert.deepEqual(state.struck, [false, false, true], 'the gate test hit the wrong stump');
  assert.equal(state.zing, true, '18 m/s inside the gate should flash');

  assert.equal(state.stumps[2].active, true, 'the struck stump is not active');
  assert(state.stumps[2].angleVelocity > 0, 'the struck stump has no topple rate');
  assert.equal(state.stumps[0].angleVelocity, 0, 'an unstruck stump gained a topple rate');
  assert.equal(state.stumps[1].angleVelocity, 0, 'an unstruck stump gained a topple rate');
  assert(isZeroVec(state.stumps[0].velocity), 'an unstruck stump gained velocity');
  assert(isZeroVec(state.stumps[1].velocity), 'an unstruck stump gained velocity');

  assert.equal(state.bails[0].active, false, 'bail 0 flew although both of its stumps are unstruck');
  assert(isZeroVec(state.bails[0].velocity), 'bail 0 has velocity while inactive');
  assert.equal(state.bails[1].active, true, 'bail 1 should fly because stump 2 supports it');
  assert(state.bails[1].velocity.y > 0, 'bail 1 has no upward velocity');
});

await check('3 middle at 40 m/s shatters the gate', async () => {
  const state = resolveStumpImpact({ x: 0.0, y: 0.35, z: STUMP_PLANE_Z }, 40);

  assert.deepEqual(state.struck, [true, true, true], 'a 40 m/s middle hit did not shatter the gate');
  assert.equal(state.zing, true, 'a 40 m/s hit should flash');

  for (let i = 0; i < 3; i++) {
    const stump = state.stumps[i];
    assert.equal(stump.active, true, `stump ${i} is inactive after being struck`);
    assert(stump.velocity.y > 0, `stump ${i} has no upward velocity`);
    assert(stump.velocity.z > 0, `stump ${i} has no down-the-pitch velocity`);
    assert(stump.angleVelocity > 0, `stump ${i} has no topple rate`);
  }

  for (let j = 0; j < 2; j++) {
    const bail = state.bails[j];
    assert.equal(bail.active, true, `bail ${j} is inactive after a full-gate hit`);
    assert(bail.velocity.y > 0, `bail ${j} has no upward velocity`);
  }
});

await check('4 a ball outside the gate does nothing', async () => {
  const state = resolveStumpImpact({ x: 2.0, y: 0.35, z: STUMP_PLANE_Z }, 40);

  assert.deepEqual(state.struck, [false, false, false], 'a ball outside the gate struck a stump');
  assert.equal(state.zing, false, 'a ball outside the gate flashed');

  for (let i = 0; i < 3; i++) {
    assert.equal(state.stumps[i].active, false, `stump ${i} is active with no contact`);
    assert(isZeroVec(state.stumps[i].velocity), `stump ${i} has velocity with no contact`);
    assert.equal(state.stumps[i].angleVelocity, 0, `stump ${i} has a topple rate with no contact`);
  }

  for (let j = 0; j < 2; j++) {
    assert.equal(state.bails[j].active, false, `bail ${j} is active with no struck stump`);
    assert(isZeroVec(state.bails[j].velocity), `bail ${j} has velocity with no struck stump`);
  }
});

await check('5 same seed is deterministic', async () => {
  const point = { x: 0.0, y: 0.35, z: STUMP_PLANE_Z };
  const first = resolveStumpImpact(point, 38, 7);
  const second = resolveStumpImpact(point, 38, 7);

  assert.deepEqual(first, second, 'the same arguments produced different states');

  const third = resolveStumpImpact(point, 38, 8);
  assert.notEqual(JSON.stringify(first), JSON.stringify(third), 'a different seed produced the same state');
});

await check('6 bails fly and land', async () => {
  const state = resolveStumpImpact({ x: 0.0, y: 0.35, z: STUMP_PLANE_Z }, 40);

  const peak = [0, 0];
  for (let step = 0; step < 400; step++) {
    advanceImpact(state, 0.05);
    for (let j = 0; j < 2; j++) {
      peak[j] = Math.max(peak[j], state.bails[j].position.y);
    }
  }

  for (let j = 0; j < 2; j++) {
    assert(peak[j] > STUMP_HEIGHT, `bail ${j} never rose above the stumps (peak ${peak[j]})`);
    assert(state.bails[j].position.y <= GROUND_Y + 1e-6, `bail ${j} did not land (y ${state.bails[j].position.y})`);
  }

  assert.equal(isSettled(state), true, 'the gate never came to rest');
  assert(Math.abs(state.elapsed - 20) < 1e-6, `elapsed is ${state.elapsed}, not 20`);
});

await check('7 topple clamps', async () => {
  const state = resolveStumpImpact({ x: 0.0, y: 0.35, z: STUMP_PLANE_Z }, 40);

  for (let step = 0; step < 400; step++) advanceImpact(state, 0.05);

  for (let i = 0; i < 3; i++) {
    if (!state.struck[i]) continue;
    const stump = state.stumps[i];
    assert(Math.abs(stump.angle - MAX_TOPPLE_ANGLE) < 1e-6, `stump ${i} is at ${stump.angle}, not clamped`);
    assert.equal(stump.angleVelocity, 0, `stump ${i} is still spinning`);
  }
});

await check('8 reset restores rest', async () => {
  const state = resolveStumpImpact({ x: 0.0, y: 0.35, z: STUMP_PLANE_Z }, 40);
  for (let step = 0; step < 40; step++) advanceImpact(state, 0.05);

  resetImpact(state);

  assert.deepEqual(state, createRestImpactState(), 'reset did not reproduce the rest layout');

  for (let i = 0; i < 3; i++) {
    assert.equal(state.stumps[i].active, false, `stump ${i} is still active after reset`);
    assert.equal(state.stumps[i].position.y, 0, `stump ${i} is not back at its base pivot`);
    assert(isZeroVec(state.stumps[i].velocity), `stump ${i} still has velocity after reset`);
    assert.equal(state.stumps[i].angle, 0, `stump ${i} is still toppled after reset`);
    assert.equal(state.stumps[i].angleVelocity, 0, `stump ${i} is still spinning after reset`);
  }

  for (let j = 0; j < 2; j++) {
    assert.equal(state.bails[j].active, false, `bail ${j} is still active after reset`);
    assert.equal(state.bails[j].position.y, STUMP_HEIGHT, `bail ${j} is not back on top after reset`);
    assert(isZeroVec(state.bails[j].velocity), `bail ${j} still has velocity after reset`);
  }

  assert.equal(isSettled(state), true, 'the gate is not settled after reset');
});

process.exitCode = failures ? 1 : 0;

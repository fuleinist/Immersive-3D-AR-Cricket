/**
 * Headless sanity check for services/wagonWheel.ts - the chart geometry the
 * innings result card draws from recorded balls (issue #15, wagon-wheel bullet).
 *
 * The failure this harness exists for: the landing point was only used for the
 * distance number on the card, so nothing could be plotted from it. These checks
 * fail if the bearing convention drifts (0 must point at the bowler), if the
 * sector boundaries shift, if a record with no landing point is plotted, or if
 * the chart falls back to the scoreboard's coarse DEFENSE instead of runs.
 *
 * Run: npm run verify:wagon
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, 'node_modules', '.cache', 'wagon-wheel');

const SOURCES = [
  'types.ts',
  'services/shotPhysics.ts',
  'services/fieldingSim.ts',
  'services/shotOutcome.ts',
  'services/wagonWheel.ts',
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

const { ShotResult } = await loadModule('types.ts');
const { resolveShot } = await loadModule('services/shotOutcome.ts');
const {
  SECTOR_COUNT,
  SECTOR_DEG,
  outcomeOf,
  angleDegFor,
  sectorOf,
  wagonWheel,
} = await loadModule('services/wagonWheel.ts');

const DELIVERY = {
  id: 'probe',
  name: 'Probe delivery',
  bowler: 'Probe bowler',
  year: 2000,
  styleTag: 'probe',
  description: '',
  educational: '',
  speedKmh: 140,
  releaseX: 0,
  pace: 0,
  line: 0,
  dip: 0,
  swing: 0,
  spin: [0, 0, 0],
};

const ball = (over) => ({
  delivery: DELIVERY,
  result: ShotResult.DEFENSE,
  runs: 0,
  speed: 0,
  distance: 0,
  ...over,
});

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err.message}`);
  }
}

check('1 sector boundaries', () => {
  assert.equal(SECTOR_COUNT, 8);
  assert.equal(SECTOR_DEG, 45);
  assert.equal(sectorOf(0), 0);
  assert.equal(sectorOf(44.9), 0);
  assert.equal(sectorOf(45), 1);
  // floor semantics: just under a full turn is the last sector; exactly 360 wraps to 0.
  assert.equal(sectorOf(359.9), 7);
  assert.equal(sectorOf(360), 0);
  assert.equal(sectorOf(-10), 7);
});

check('2 bearing convention (0 = down the ground at the bowler)', () => {
  assert.equal(angleDegFor(0, -10), 0);
  assert.equal(angleDegFor(10, 0), 90);
  assert.equal(angleDegFor(0, 10), 180);
  assert.equal(angleDegFor(-10, 0), 270);
});

check('3 outcome mapping', () => {
  assert.equal(outcomeOf(ball({ result: ShotResult.SIX, runs: 6, landingXZ: [0, -60] })), 'SIX');
  assert.equal(outcomeOf(ball({ result: ShotResult.FOUR, runs: 4, landingXZ: [0, -50] })), 'FOUR');
  assert.equal(outcomeOf(ball({ result: ShotResult.DEFENSE, runs: 2, landingXZ: [10, -20] })), 'RUNS');
  assert.equal(outcomeOf(ball({ result: ShotResult.OUT, runs: 0, caughtBy: 'slip-1', landingXZ: [5, -12] })), 'WICKET');
  assert.equal(outcomeOf(ball({ result: ShotResult.DEFENSE, runs: 0, landingXZ: [3, -8] })), 'DOT');
});

check('4 skips records without a landing point and keeps history order', () => {
  const history = [
    ball({ result: ShotResult.SIX, runs: 6, landingXZ: [0, -70] }),
    ball({ result: ShotResult.DEFENSE, runs: 0 }),
    ball({ result: ShotResult.FOUR, runs: 4, landingXZ: [40, -40] }),
  ];
  const shots = wagonWheel(history);
  assert.equal(shots.length, 2);
  assert.equal(shots[0].outcome, 'SIX');
  assert.equal(shots[0].sector, sectorOf(angleDegFor(0, -70)));
  assert.equal(shots[1].outcome, 'FOUR');
  assert.equal(shots[1].sector, sectorOf(angleDegFor(40, -40)));
});

check('5 radius is capped at the boundary', () => {
  const long = ball({ result: ShotResult.SIX, runs: 6, landingXZ: [70, 0] });
  const mid = ball({ result: ShotResult.DEFENSE, runs: 2, landingXZ: [32.5, 0] });
  const shots = wagonWheel([long, mid]);
  assert.equal(shots[0].radius, 1);
  assert.equal(shots[1].radius, 0.5);
});

check('6 a live shot resolves to a plottable landing', () => {
  const contact = { x: 0.2, y: 1.0, z: -0.4 };
  const exit = { x: 9, y: 4, z: -14 };
  const resolved = resolveShot(contact, exit, 'lee-2002');
  assert(Array.isArray(resolved.landingXZ) && resolved.landingXZ.length === 2, 'landingXZ is not a pair');
  const [x, z] = resolved.landingXZ;
  assert(Number.isFinite(x) && Number.isFinite(z), 'landingXZ is not a finite pair');
  const shots = wagonWheel([ball({ result: resolved.result, runs: resolved.runs, landingXZ: resolved.landingXZ })]);
  assert.equal(shots.length, 1);
  assert.equal(shots[0].x, x);
  assert.equal(shots[0].z, z);
  assert.equal(shots[0].sector, sectorOf(angleDegFor(x, z)));
});

process.exitCode = failures ? 1 : 0;

/**
 * Headless sanity check for services/groundLayout.ts - the pure cricket ground
 * layout constants and helpers used by components/CricketGround.tsx.
 *
 * Run: npm run verify:ground
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, 'node_modules', '.cache', 'ground-layout');

const SOURCES = ['services/groundLayout.ts'];

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
  PITCH_LENGTH,
  PITCH_WIDTH,
  BOUNDARY_RADIUS,
  THIRTY_YARD_RADIUS,
  POPPING_CREASE_FROM_STUMPS,
  creaseLines,
  boundaryPoint,
  isInsideBoundary,
} = await loadModule('services/groundLayout.ts');

let total = 0;
let failures = 0;

function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err.message}`);
  }
}

check('1 pitch length and width', () => {
  assert.equal(PITCH_LENGTH, 20.12);
  assert.equal(PITCH_WIDTH, 3.05);
});

check('2 boundary radius', () => {
  assert.equal(BOUNDARY_RADIUS, 65);
});

check('3 thirty-yard radius', () => {
  assert.equal(THIRTY_YARD_RADIUS, 27.43);
});

check('4 exactly 4 crease lines at both ends', () => {
  assert.equal(POPPING_CREASE_FROM_STUMPS, 1.22);
  const lines = creaseLines();
  assert.equal(lines.length, 4);
  for (const line of lines) {
    assert(Number.isFinite(line.x), 'crease x must be finite');
    assert(Number.isFinite(line.z), 'crease z must be finite');
    assert(line.width > 0 && Number.isFinite(line.width), 'crease width must be positive');
    assert(line.depth > 0 && Number.isFinite(line.depth), 'crease depth must be positive');
  }
  const zs = lines.map((l) => l.z).sort((a, b) => a - b);
  const expectedZs = [-10.06, -8.84, 8.84, 10.06];
  for (let i = 0; i < expectedZs.length; i++) {
    assert(Math.abs(zs[i] - expectedZs[i]) < 1e-9, `expected z=${expectedZs[i]}, got ${zs[i]}`);
  }
});

check('5 crease symmetry about the origin', () => {
  const lines = creaseLines();
  for (const line of lines) {
    const mirror = lines.find(
      (other) =>
        Math.abs(other.x + line.x) < 1e-9 &&
        Math.abs(other.z + line.z) < 1e-9 &&
        Math.abs(other.width - line.width) < 1e-9 &&
        Math.abs(other.depth - line.depth) < 1e-9,
    );
    assert(mirror, `no symmetric counterpart found for crease at (${line.x}, ${line.z})`);
  }
});

check('6 boundaryPoint at 0, 90, 180, 270 degrees sits at 65 m', () => {
  const degrees = [0, 90, 180, 270];
  const points = degrees.map((deg) => boundaryPoint((deg * Math.PI) / 180));
  for (let i = 0; i < degrees.length; i++) {
    const { x, z } = points[i];
    const radius = Math.hypot(x, z);
    assert(
      Math.abs(radius - 65) < 1e-9,
      `boundaryPoint(${degrees[i]} deg) radius is ${radius}, expected 65`,
    );
  }
  // Ensure the four cardinal points are distinct.
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dist = Math.hypot(points[i].x - points[j].x, points[i].z - points[j].z);
      assert(dist > 1, `points for ${degrees[i]} and ${degrees[j]} degrees overlap`);
    }
  }
});

check('7 isInsideBoundary at (0,0) and (66,0)', () => {
  assert.equal(isInsideBoundary(0, 0), true);
  assert.equal(isInsideBoundary(66, 0), false);
});

const passed = total - failures;
console.log(`SUMMARY: ${passed}/${total} checks passed`);
process.exitCode = failures ? 1 : 0;

/**
 * Headless sanity check for the fielder presets in services/fieldingSim.ts
 * rendered by components/Fielders.tsx.
 *
 * Run: npm run verify:fielders
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, 'node_modules', '.cache', 'fielders');

const SOURCES = ['services/shotPhysics.ts', 'services/fieldingSim.ts'];

const DELIVERY_IDS = [
  'warne-1993',
  'murali-2004',
  'wasim-1992',
  'lee-2002',
  'bumrah-2019',
];

const BOUNDARY_M = 65;
// Matches PITCH_WIDTH in services/groundLayout.ts (MCC standard 3.05 m).
const PITCH_WIDTH = 3.05;
const MIN_PITCH_CLEARANCE_X = PITCH_WIDTH / 2 + 0.5;

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

const { FIELD_PRESETS, fieldersFor } = await loadModule('services/fieldingSim.ts');

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

for (const deliveryId of DELIVERY_IDS) {
  check(deliveryId, () => {
    assert.ok(FIELD_PRESETS[deliveryId], `preset '${deliveryId}' must exist in FIELD_PRESETS`);
    const fielders = fieldersFor(deliveryId);
    assert.equal(fielders.length, 9, `expected 9 fielders, got ${fielders.length}`);

    const seenIds = new Set();
    for (const fielder of fielders) {
      assert.equal(typeof fielder.id, 'string', 'fielder id must be a string');
      assert.ok(fielder.id.length > 0, 'fielder id must be non-empty');
      assert.ok(!seenIds.has(fielder.id), `duplicate fielder id '${fielder.id}'`);
      seenIds.add(fielder.id);

      assert.ok(
        Number.isFinite(fielder.x) && Number.isFinite(fielder.z),
        `fielder '${fielder.id}' has non-finite coords (${fielder.x}, ${fielder.z})`,
      );

      const radius = Math.hypot(fielder.x, fielder.z);
      assert.ok(
        radius < BOUNDARY_M,
        `fielder '${fielder.id}' at radius ${radius.toFixed(2)} m is not inside ${BOUNDARY_M} m boundary`,
      );

      assert.ok(
        Math.abs(fielder.x) > MIN_PITCH_CLEARANCE_X,
        `fielder '${fielder.id}' at |x|=${Math.abs(fielder.x).toFixed(2)} m encroaches on pitch lane (min ${MIN_PITCH_CLEARANCE_X} m)`,
      );
    }
  });
}

const passed = total - failures;
console.log(`SUMMARY: ${passed}/${total} presets passed`);
process.exitCode = failures ? 1 : 0;

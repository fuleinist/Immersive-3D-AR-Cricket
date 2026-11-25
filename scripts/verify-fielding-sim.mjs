/**
 * Headless sanity check for services/fieldingSim.ts — the pure post-hit fielding
 * model: flight with quadratic drag, the catch window before the first bounce,
 * the rolling phase with rolling friction, the rope, and the fielder closing on
 * the ball. The module is never modified here; if a chosen shot input fails, the
 * input numbers change, not the module.
 *
 * Nine checks:
 *   1. shape         - five presets, nine fielders each, unique ids per preset,
 *                      all radii in (0, 66], a fielder inside 12 m, and
 *                      bumrah-2019 has a fielder beyond 50 m
 *   2. fallback      - fieldersFor('unknown-id') deep-equals FIELD_PRESETS['lee-2002']
 *   3. gap shot      - per preset, the widest gap between adjacent fielders
 *                      (wrap included); a flat 50 m/s ball along its bisector
 *                      must read FOUR or SIX
 *   4. blocked shot  - a flat 26 m/s ball at warne-1993 cover must not read
 *                      FOUR or SIX
 *   5. six           - a lofted ball that clears the rope: SIX, runs 6,
 *                      carryM >= BOUNDARY_M
 *   6. caught        - a slow uppish ball to wasim-1992 slip-1: CAUGHT, runs 0,
 *                      caughtById 'slip-1'
 *   7. thresholds    - the classifyByIntercept boundaries
 *   8. wagon wheel   - a straight shot reads |angleDeg| < 2; a positive x exit
 *                      velocity reads a positive angleDeg
 *   9. determinism   - two identical calls deep-equal
 *
 * Run: npm run verify:fielding
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, 'node_modules', '.cache', 'fielding-sim');

/**
 * esbuild is the preferred path, but its in-process service spawns a child with
 * piped stdio, which some sandboxes refuse (spawn EPERM). The fallback is the
 * TypeScript compiler API, which runs in-process. fieldingSim.ts imports GRAVITY
 * from ./shotPhysics at runtime, so the fallback also transpiles that sibling
 * into the cache dir and gives the specifier the .mjs extension Node ESM needs.
 */
async function transpileToCache(relPath) {
  const ts = await import('typescript');
  const source = await fs.readFile(path.join(root, relPath), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { target: 'ES2022', module: 'ESNext' },
  }).outputText;
  await fs.mkdir(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, path.basename(relPath).replace(/\.ts$/, '.mjs'));
  await fs.writeFile(outfile, js);
  return outfile;
}

async function loadModule(relPath) {
  const outfile = path.join(cacheDir, path.basename(relPath).replace(/\.ts$/, '.mjs'));
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
    await transpileToCache('services/shotPhysics.ts');
    const ts = await import('typescript');
    const source = await fs.readFile(path.join(root, relPath), 'utf8');
    const js = ts
      .transpileModule(source, {
        compilerOptions: { target: 'ES2022', module: 'ESNext' },
      })
      .outputText.replace(/from\s+['"](\.[^'"]*)['"]/g, (_m, spec) => {
        const dep = path.basename(spec).replace(/\.ts$/, '');
        return `from './${dep}.mjs'`;
      });
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(outfile, js);
  }
  return await import(pathToFileURL(outfile).href);
}

const sim = await loadModule('services/fieldingSim.ts');
const { simulateFielding, classifyByIntercept, fieldersFor, FIELD_PRESETS, BOUNDARY_M } = sim;

const CONTACT = { x: 0, y: 0.9, z: -0.2 };

const deg2rad = (d) => (d * Math.PI) / 180;
const normDeg = (a) => {
  let d = a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
};

/* A fielder's bearing as the module places it: x = r sin a, z = -r cos a. */
const angleOf = (f) => (Math.atan2(f.x, -f.z) * 180) / Math.PI;
const radiusOf = (f) => Math.hypot(f.x, f.z);

/* Widest gap between adjacent fielders, wrap across -180/180 included. */
function widestGap(fielders) {
  const angles = fielders.map(angleOf).sort((a, b) => a - b);
  let bestGap = -1;
  let bestBisector = 0;
  for (let i = 0; i < angles.length; i++) {
    const a0 = angles[i];
    const a1 = i + 1 < angles.length ? angles[i + 1] : angles[0] + 360;
    const gap = a1 - a0;
    if (gap > bestGap) {
      bestGap = gap;
      bestBisector = normDeg((a0 + a1) / 2);
    }
  }
  return { gapDeg: bestGap, bisectorDeg: bestBisector };
}

let passed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL ${name}`);
    console.log(e && e.message ? e.message : String(e));
    process.exit(1);
  }
}

/* 1. shape */
check('shape', () => {
  const ids = Object.keys(FIELD_PRESETS);
  assert.equal(ids.length, 5, `expected 5 presets, got ${ids.length}`);

  let anyInside12 = false;
  for (const id of ids) {
    const fielders = FIELD_PRESETS[id];
    assert.equal(fielders.length, 9, `${id}: expected 9 fielders, got ${fielders.length}`);

    const seen = new Set();
    for (const f of fielders) {
      assert.ok(!seen.has(f.id), `${id}: duplicate id ${f.id}`);
      seen.add(f.id);
      const r = radiusOf(f);
      assert.ok(r > 0 && r <= 66, `${id}/${f.id}: radius ${r.toFixed(2)} outside (0, 66]`);
      if (r < 12) anyInside12 = true;
    }
  }
  assert.ok(anyInside12, 'no fielder inside 12 m in any preset');

  const bumrah = FIELD_PRESETS['bumrah-2019'].map(radiusOf);
  assert.ok(
    bumrah.some((r) => r > 50),
    `bumrah-2019 has no fielder beyond 50 m (max ${Math.max(...bumrah).toFixed(2)})`,
  );
});

/* 2. fallback */
check('fallback', () => {
  assert.deepEqual(fieldersFor('unknown-id'), FIELD_PRESETS['lee-2002']);
});

/* 3. gap shot */
check('gap-shot', () => {
  for (const id of Object.keys(FIELD_PRESETS)) {
    const { gapDeg, bisectorDeg } = widestGap(FIELD_PRESETS[id]);
    const a = deg2rad(bisectorDeg);
    const v = { x: 50 * Math.sin(a), y: 0, z: -50 * Math.cos(a) };
    const res = simulateFielding(CONTACT, v, id);
    assert.ok(
      res.outcome === 'FOUR' || res.outcome === 'SIX',
      `${id}: widest gap ${gapDeg.toFixed(1)} deg, bisector ${bisectorDeg.toFixed(1)} deg -> ${res.outcome}`,
    );
  }
});

/* 4. blocked shot */
check('blocked-shot', () => {
  const cover = fieldersFor('warne-1993').find((f) => f.id === 'cover');
  assert.ok(cover, 'warne-1993 has no cover fielder');
  const dx = cover.x - CONTACT.x;
  const dz = cover.z - CONTACT.z;
  const d = Math.hypot(dx, dz);
  const v = { x: 26 * (dx / d), y: 0, z: 26 * (dz / d) };
  const res = simulateFielding(CONTACT, v, 'warne-1993');
  assert.ok(
    res.outcome !== 'FOUR' && res.outcome !== 'SIX',
    `flat 26 m/s at cover read ${res.outcome} (intercept ${res.interceptTimeS})`,
  );
});

/* 5. six - lofted, clears the rope before the first bounce */
check('six', () => {
  const { bisectorDeg } = widestGap(FIELD_PRESETS['lee-2002']);
  const SPEED = 50;
  const ELEVATION = 45;
  const a = deg2rad(bisectorDeg);
  const e = deg2rad(ELEVATION);
  const v = {
    x: SPEED * Math.cos(e) * Math.sin(a),
    y: SPEED * Math.sin(e),
    z: -SPEED * Math.cos(e) * Math.cos(a),
  };
  const res = simulateFielding(CONTACT, v, 'lee-2002');
  assert.ok(
    res.outcome === 'SIX' && res.runs === 6 && res.carryM >= BOUNDARY_M,
    `lofted shot read ${res.outcome}, runs ${res.runs}, carry ${res.carryM.toFixed(2)} m`,
  );
});

/* 6. caught - slow uppish ball to first slip */
check('caught', () => {
  const slip1 = fieldersFor('wasim-1992').find((f) => f.id === 'slip-1');
  assert.ok(slip1, 'wasim-1992 has no slip-1 fielder');
  const dx = slip1.x - CONTACT.x;
  const dz = slip1.z - CONTACT.z;
  const d = Math.hypot(dx, dz);
  const SPEED = 18;
  const LIFT = 4.0;
  const v = { x: SPEED * (dx / d), y: LIFT, z: SPEED * (dz / d) };
  const res = simulateFielding(CONTACT, v, 'wasim-1992');
  assert.ok(
    res.outcome === 'CAUGHT' && res.runs === 0 && res.caughtById === 'slip-1',
    `uppish ball to slip-1 read ${res.outcome}, runs ${res.runs}, caughtById ${res.caughtById}`,
  );
});

/* 7. thresholds */
check('thresholds', () => {
  assert.equal(classifyByIntercept(0.9, 20), 'DEFENSE');
  assert.equal(classifyByIntercept(1.5, 20), 'SINGLE');
  assert.equal(classifyByIntercept(2.5, 20), 'TWO');
  assert.equal(classifyByIntercept(3.8, 20), 'THREE');
  assert.equal(classifyByIntercept(null, null), 'FOUR');
  assert.equal(classifyByIntercept(0.5, 9), 'DEFENSE');
});

/* 8. wagon wheel */
check('wagon-wheel', () => {
  const straight = simulateFielding(CONTACT, { x: 0, y: 0, z: -30 }, 'warne-1993');
  assert.ok(Math.abs(straight.angleDeg) < 2, `straight shot read ${straight.angleDeg.toFixed(2)} deg`);

  const positiveX = simulateFielding(CONTACT, { x: 5, y: 0, z: -20 }, 'warne-1993');
  assert.ok(positiveX.angleDeg > 0, `positive x exit velocity read ${positiveX.angleDeg.toFixed(2)} deg`);
});

/* 9. determinism */
check('determinism', () => {
  const v = { x: 12, y: 3, z: -22 };
  const a = simulateFielding(CONTACT, v, 'bumrah-2019');
  const b = simulateFielding(CONTACT, v, 'bumrah-2019');
  assert.deepEqual(a, b);
});

console.log(`PASS ${passed} checks`);

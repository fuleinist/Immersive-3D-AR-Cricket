/**
 * Headless sanity check for services/shotOutcome.ts - the live scoring adapter
 * that turns a bat-ball exit velocity into runs, a coarse ShotResult and a
 * catching fielder (issue #15, scoring bullet).
 *
 * The failure this harness exists for: services/fieldingSim.ts already modelled
 * singles, twos, threes and catches, but nothing imported it. The live path
 * scored every non-boundary hit as DEFENSE with 0 runs, and a catch could not
 * happen. These checks fail if the adapter is bypassed, if the runs table drifts
 * from the fielding model, or if the App falls back to the old 6/4/0 table when
 * a detail is present.
 *
 * Run: npm run verify:outcome
 * Probe: node scripts/verify-shot-outcome.mjs --probe
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, 'node_modules', '.cache', 'shot-outcome');

const SOURCES = [
  'types.ts',
  'services/shotPhysics.ts',
  'services/fieldingSim.ts',
  'services/shotOutcome.ts',
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

const outcome = await loadModule('services/shotOutcome.ts');
const {
  RUNS_BY_OUTCOME,
  toShotResult,
  resolveShot,
  runsForResult,
  caughtByLabelFor,
} = outcome;

const { fieldersFor, FIELD_PRESETS, BOUNDARY_M } = await loadModule('services/fieldingSim.ts');

const CONTACT = { x: 0, y: 0.9, z: -0.2 };
const deg2rad = (d) => (d * Math.PI) / 180;
const normDeg = (a) => {
  let d = a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
};
const angleOf = (f) => (Math.atan2(f.x, -f.z) * 180) / Math.PI;

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

/** A lofted shot down the widest gap: the proven SIX vector from #19. */
function sixShot(presetId = 'lee-2002') {
  const { bisectorDeg } = widestGap(FIELD_PRESETS[presetId]);
  const a = deg2rad(bisectorDeg);
  const e = deg2rad(45);
  const SPEED = 50;
  return {
    x: SPEED * Math.cos(e) * Math.sin(a),
    y: SPEED * Math.sin(e),
    z: -SPEED * Math.cos(e) * Math.cos(a),
  };
}

/** A slow uppish ball hit straight at first slip: the proven CAUGHT vector. */
function caughtShot(presetId = 'wasim-1992') {
  const slip = fieldersFor(presetId).find((f) => f.id === 'slip-1');
  const dx = slip.x - CONTACT.x;
  const dz = slip.z - CONTACT.z;
  const d = Math.hypot(dx, dz);
  return { x: 18 * (dx / d), y: 4.0, z: 18 * (dz / d) };
}

/** A drive along the widest gap at a given speed and lift. */
function gapShot(presetId, speed, lift = 0) {
  const { bisectorDeg } = widestGap(FIELD_PRESETS[presetId]);
  const a = deg2rad(bisectorDeg);
  return { x: speed * Math.sin(a), y: lift, z: -speed * Math.cos(a) };
}

/** A shot on an explicit bearing: 0 is straight, -180 is behind the batter. */
function angleShot(deg, speed, lift = 0) {
  const a = deg2rad(deg);
  return { x: speed * Math.sin(a), y: lift, z: -speed * Math.cos(a) };
}

/** Gap-drive speed that reaches the rope only after the first bounce. */
const FOUR_SPEED = 30;

/**
 * Ring shots pinned from the probe grid. Each beats the inner ring but stops
 * short of the rope, so it must score real runs on the DEFENSE slot.
 */
const RING_CASES = [
  { label: 'single', presetId: 'lee-2002', v: angleShot(-180, 10, 0), outcome: 'SINGLE', runs: 1 },
  { label: 'two', presetId: 'lee-2002', v: angleShot(-180, 10, 6), outcome: 'TWO', runs: 2 },
  { label: 'three', presetId: 'lee-2002', v: gapShot('lee-2002', 26, 0), outcome: 'THREE', runs: 3 },
];

if (process.argv.includes('--probe')) {
  for (const id of Object.keys(FIELD_PRESETS)) {
    const row = [];
    for (const speed of [14, 18, 22, 26, 30, 36, 42, 50]) {
      const r = resolveShot(CONTACT, gapShot(id, speed), id);
      row.push(`${speed}:${r.fielding.outcome}/r${r.runs}`);
    }
    console.log(`${id} ${row.join(' ')}`);
  }
  const r6 = resolveShot(CONTACT, sixShot(), 'lee-2002');
  console.log(`six vector -> ${r6.fielding.outcome} runs ${r6.runs} dist ${r6.distanceM.toFixed(1)}`);
  const rc = resolveShot(CONTACT, caughtShot(), 'wasim-1992');
  console.log(`caught vector -> ${rc.fielding.outcome} runs ${rc.runs} by ${rc.caughtByLabel}`);
  process.exit(0);
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

/* 1. mapping - every fielding outcome gets the documented result and runs */
check('mapping-all-outcomes', () => {
  const expected = {
    SIX: ['SIX', 6],
    FOUR: ['FOUR', 4],
    THREE: ['DEFENSE', 3],
    TWO: ['DEFENSE', 2],
    SINGLE: ['DEFENSE', 1],
    DEFENSE: ['DEFENSE', 0],
    CAUGHT: ['OUT', 0],
  };
  assert.deepEqual(
    Object.keys(RUNS_BY_OUTCOME).sort(),
    Object.keys(expected).sort(),
    'runs table must cover exactly the seven fielding outcomes',
  );
  for (const [name, [result, runs]] of Object.entries(expected)) {
    assert.equal(toShotResult(name), result, `${name} -> ${toShotResult(name)}, expected ${result}`);
    assert.equal(RUNS_BY_OUTCOME[name], runs, `${name} runs ${RUNS_BY_OUTCOME[name]}, expected ${runs}`);
  }
});

/* 2. six - a ball over the rope on the fly scores 6, not 4 */
check('six-over-the-rope', () => {
  const shot = resolveShot(CONTACT, sixShot(), 'lee-2002');
  assert.equal(shot.fielding.outcome, 'SIX', `lofted shot read ${shot.fielding.outcome}`);
  assert.equal(shot.result, 'SIX');
  assert.equal(shot.runs, 6, `six scored ${shot.runs}`);
  assert.ok(shot.fielding.carryM >= BOUNDARY_M, `carry ${shot.fielding.carryM.toFixed(1)} below the rope`);
  assert.ok(shot.distanceM > BOUNDARY_M, `displayed distance ${shot.distanceM.toFixed(1)} must clear the rope`);
  assert.equal(shot.caught, false);
  assert.equal(shot.caughtByLabel, null);
});

/* 3. four - the same line, lower and slower, must bounce before the rope */
check('four-along-the-ground', () => {
  const shot = resolveShot(CONTACT, gapShot('lee-2002', FOUR_SPEED), 'lee-2002');
  assert.equal(shot.fielding.outcome, 'FOUR', `flat ${FOUR_SPEED} m/s read ${shot.fielding.outcome}`);
  assert.equal(shot.result, 'FOUR');
  assert.equal(shot.runs, 4, `four scored ${shot.runs}`);
  assert.ok(shot.distanceM >= BOUNDARY_M, `four reached ${shot.distanceM.toFixed(1)} m, short of the rope`);
});

/* 4. caught - a hung ball to slip is a wicket with no runs */
check('caught-is-a-wicket', () => {
  const shot = resolveShot(CONTACT, caughtShot(), 'wasim-1992');
  assert.equal(shot.fielding.outcome, 'CAUGHT', `uppish ball read ${shot.fielding.outcome}`);
  assert.equal(shot.caught, true);
  assert.equal(shot.result, 'OUT', 'a catch must report OUT so it counts as a wicket');
  assert.equal(shot.runs, 0, `catch scored ${shot.runs}`);
  assert.equal(shot.caughtByLabel, 'First slip', `caught by ${shot.caughtByLabel}`);
  assert.ok(shot.distanceM > 0, 'the catch distance must be positive');
});

/* 5. singles, twos and threes carry real runs on the DEFENSE slot */
check('ring-runs-are-real', () => {
  const cases = RING_CASES;
  assert.ok(cases.length >= 2, 'need at least two ring vectors pinned from the probe');
  for (const { label, presetId, v, outcome: name, runs } of cases) {
    const shot = resolveShot(CONTACT, v, presetId);
    assert.equal(shot.fielding.outcome, name, `${label} read ${shot.fielding.outcome}`);
    assert.equal(shot.runs, runs, `${label} scored ${shot.runs}, expected ${runs}`);
    assert.equal(shot.result, 'DEFENSE', `${label} must use the DEFENSE slot`);
    assert.ok(shot.runs > 0, `${label} must not be a dot ball`);
  }
});

/* 6. the App rule: a detail wins over the old table, including runs 0 */
check('runs-for-result-rule', () => {
  assert.equal(runsForResult('SIX'), 6, 'no detail, six must stay 6');
  assert.equal(runsForResult('FOUR'), 4, 'no detail, four must stay 4');
  assert.equal(runsForResult('OUT'), 0, 'no detail, out must stay 0');
  assert.equal(runsForResult('DEFENSE'), 0, 'no detail, defense must stay 0');

  // The bug: a single is a DEFENSE result. If the detail is ignored it scores 0.
  assert.equal(
    runsForResult('DEFENSE', { runs: 1, caughtByLabel: null }),
    1,
    'a detail of 1 run must beat the DEFENSE fallback of 0',
  );
  assert.equal(
    runsForResult('OUT', { runs: 0, caughtByLabel: 'First slip' }),
    0,
    'a caught-out detail must not fall through to the table',
  );
  assert.equal(runsForResult('SIX', { runs: 6, caughtByLabel: null }), 6);
});

/* 7. label lookup is total - an unknown id or a preset change cannot throw */
check('label-lookup', () => {
  assert.equal(caughtByLabelFor('wasim-1992', 'slip-1'), 'First slip');
  assert.equal(caughtByLabelFor('wasim-1992', 'no-such-fielder'), null);
  assert.equal(caughtByLabelFor('wasim-1992', null), null);
  // An unknown preset resolves through fieldersFor's lee-2002 fallback, so the
  // id lookup still returns a label rather than throwing.
  assert.equal(caughtByLabelFor('unknown-preset', 'slip-1'), 'First slip');
});

/* 8. determinism - the same shot always scores the same */
check('determinism', () => {
  const v = { x: 12, y: 3, z: -22 };
  assert.deepEqual(resolveShot(CONTACT, v, 'bumrah-2019'), resolveShot(CONTACT, v, 'bumrah-2019'));
});

/* 9. no mutation of the inputs */
check('inputs-untouched', () => {
  const v = { x: 20, y: 6, z: -25 };
  const before = { ...v };
  resolveShot(CONTACT, v, 'warne-1993');
  assert.deepEqual(v, before, 'resolveShot must not mutate the exit velocity');
});

console.log(`PASS ${passed} checks`);
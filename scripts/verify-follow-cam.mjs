/**
 * Headless sanity check for services/followCam.ts - the 1.8 s boundary
 * follow-cam trajectory rendered by components/Scene.tsx (issue #15).
 *
 * Run: npm run verify:follow-cam
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, 'node_modules', '.cache', 'follow-cam');

const SOURCES = ['services/followCam.ts'];

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
  FOLLOW_CAM_DURATION_S,
  BASE_CAMERA,
  followCamPose,
} = await loadModule('services/followCam.ts');

const POSE_KEYS = ['posX', 'posY', 'posZ', 'targetX', 'targetY', 'targetZ'];

function assertExactBase(pose, label) {
  for (const key of POSE_KEYS) {
    assert.ok(
      Object.is(pose[key], BASE_CAMERA[key]),
      `${label}: expected ${key}=${BASE_CAMERA[key]}, got ${pose[key]}`,
    );
  }
}

function assertAllFinite(pose, label) {
  for (const key of POSE_KEYS) {
    assert.ok(
      Number.isFinite(pose[key]),
      `${label}: expected finite ${key}, got ${pose[key]}`,
    );
  }
}

function posDisplacement(pose) {
  return Math.hypot(
    pose.posX - BASE_CAMERA.posX,
    pose.posY - BASE_CAMERA.posY,
    pose.posZ - BASE_CAMERA.posZ,
  );
}

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

check('1 duration constant is 1.8 s', () => {
  assert.equal(FOLLOW_CAM_DURATION_S, 1.8);
});

check('2 elapsed 0 returns BASE_CAMERA exactly', () => {
  const pose = followCamPose(0, 30, -55);
  assertExactBase(pose, 'elapsed 0');
});

check('3 elapsed 1.8 and 5 return BASE_CAMERA exactly', () => {
  assertExactBase(followCamPose(1.8, 30, -55), 'elapsed 1.8');
  assertExactBase(followCamPose(5, 30, -55), 'elapsed 5');
});

check('4 mid-window displacement exceeds 0.1 s and 1.7 s', () => {
  const early = posDisplacement(followCamPose(0.1, 0, -65));
  const mid = posDisplacement(followCamPose(0.9, 0, -65));
  const late = posDisplacement(followCamPose(1.7, 0, -65));
  assert.ok(early > 0, `expected positive displacement at 0.1 s, got ${early}`);
  assert.ok(late > 0, `expected positive displacement at 1.7 s, got ${late}`);
  assert.ok(
    mid > early && mid > late,
    `expected mid (${mid}) > early (${early}) and late (${late})`,
  );
});

check('5 SIX to (0, 65) and FOUR to (65, 0) move camera in different directions', () => {
  const six = followCamPose(0.9, 0, 65);
  const four = followCamPose(0.9, 65, 0);

  const dSix = posDisplacement(six);
  const dFour = posDisplacement(four);
  assert.ok(dSix > 0.5, `expected SIX to move camera, got ${dSix}`);
  assert.ok(dFour > 0.5, `expected FOUR to move camera, got ${dFour}`);

  const sixVec = [
    six.posX - BASE_CAMERA.posX,
    six.posY - BASE_CAMERA.posY,
    six.posZ - BASE_CAMERA.posZ,
  ];
  const fourVec = [
    four.posX - BASE_CAMERA.posX,
    four.posY - BASE_CAMERA.posY,
    four.posZ - BASE_CAMERA.posZ,
  ];
  const dot =
    sixVec[0] * fourVec[0] +
    sixVec[1] * fourVec[1] +
    sixVec[2] * fourVec[2];
  const cosAngle = dot / (dSix * dFour);
  assert.ok(
    cosAngle < 0.95,
    `expected distinct camera movement directions, cosAngle=${cosAngle}`,
  );
  assert.notEqual(six.posX, four.posX, 'expected distinct lateral camera position');
  assert.notEqual(six.targetX, four.targetX, 'expected distinct look-at targetX');
  assert.notEqual(six.targetZ, four.targetZ, 'expected distinct look-at targetZ');
});

check('6 far out-of-bounds landing is clamped to boundary', () => {
  const clamped = followCamPose(0.9, 5000, -5000);
  const onRope = followCamPose(0.9, 65 / Math.SQRT2, -65 / Math.SQRT2);
  assertAllFinite(clamped, 'far landing');

  const camRadius = Math.hypot(clamped.posX, clamped.posZ);
  const targetRadius = Math.hypot(clamped.targetX, clamped.targetZ);
  assert.ok(camRadius < 65, `camera escaped ground: radius=${camRadius}`);
  assert.ok(targetRadius <= 65 + 1e-9, `target escaped boundary: radius=${targetRadius}`);

  for (const key of POSE_KEYS) {
    assert.ok(
      Math.abs(clamped[key] - onRope[key]) < 1e-9,
      `clamped ${key}=${clamped[key]} differs from boundary ${onRope[key]}`,
    );
  }
});

check('7 deterministic output for repeated identical inputs', () => {
  const first = followCamPose(0.73, -42, -48);
  const second = followCamPose(0.73, -42, -48);
  assert.deepEqual(first, second);
});

check('8 passing out reuses the same object reference', () => {
  const buffer = {
    posX: 0,
    posY: 0,
    posZ: 0,
    targetX: 0,
    targetY: 0,
    targetZ: 0,
  };
  const retActive = followCamPose(0.9, 25, -55, buffer);
  assert.equal(retActive, buffer, 'active pose must return out reference');
  const retBase = followCamPose(2.0, 25, -55, buffer);
  assert.equal(retBase, buffer, 'settled pose must return out reference');
  assertExactBase(buffer, 'settled buffer');
});

check('9 no NaN or Infinity across elapsed sweep including negatives', () => {
  const elapsedSamples = [-100, -1, -0.001, -0, 0, 0.001, 0.45, 0.9, 1.35, 1.799, 1.8, 2.5, 100];
  const landingSamples = [
    [0, 0],
    [0, -65],
    [0, 65],
    [65, 0],
    [-65, 0],
    [1e6, -1e6],
    [Number.MAX_VALUE, Number.MAX_VALUE],
  ];
  const out = { posX: 0, posY: 0, posZ: 0, targetX: 0, targetY: 0, targetZ: 0 };
  for (const t of elapsedSamples) {
    for (const [lx, lz] of landingSamples) {
      const pose = followCamPose(t, lx, lz, out);
      assertAllFinite(pose, `t=${t}, landing=(${lx}, ${lz})`);
    }
  }
});

const passed = total - failures;
console.log(`SUMMARY: ${passed}/${total} checks passed`);
process.exitCode = failures ? 1 : 0;

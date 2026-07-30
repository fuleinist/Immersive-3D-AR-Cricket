/**
 * Headless sanity check for services/batTransform.ts — the grip-anchored,
 * forearm-perpendicular bat that replaced the old midWrist + two-wrist
 * cross construction.
 *
 * Bundles the pure module with esbuild (already a vite dependency — no new
 * packages) and exercises the solver with synthetic joint sets:
 *
 *   1. grip anchor   -> bat position == selected wrist, exactly (both hands)
 *   2. 90 degrees    -> blade axis perpendicular to the grip forearm in a
 *      stance, arms-at-sides (forward fallback) and a raised-bat drive
 *   3. correct side  -> grip on the stance side of the body midline;
 *      blade never below horizontal (up-reference side is deterministic)
 *   4. mirror        -> left-handed result == mirror of right-handed on a
 *      symmetric pose (deterministic sign, can never flip to the wrong
 *      side), and switching handedness flips the grip side exactly
 *   5. degenerate    -> collapsed forearm/shoulders/torso, non-finite
 *      joints -> solve() false, outputs untouched
 *   6. pipeline      -> standing world landmarks and seated-adapted
 *      landmarks keep anchor + 90° through the renderer's coordinate map
 *   7. swing         -> synthetic fast-downward wrist motion blends the
 *      blade below horizontal (90° + anchor invariants intact); slow
 *      motion keeps the stance blade; backlift only tilts; seated
 *      threshold scaling; reset and stall release
 *
 * Run: npm run verify:bat
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, 'node_modules', '.cache');

await build({
  entryPoints: {
    'bat-transform.bundle': path.join(root, 'services', 'batTransform.ts'),
    'tracking-mode.bundle': path.join(root, 'services', 'trackingMode.ts'),
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outdir: cacheDir,
  outExtension: { '.js': '.mjs' },
  logLevel: 'silent',
});

const { BatTransformSolver } = await import(path.join(cacheDir, 'bat-transform.bundle.mjs'));
const { adaptSeatedLandmarks } = await import(path.join(cacheDir, 'tracking-mode.bundle.mjs'));
const THREE = await import('three');

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

const v = (x, y, z) => new THREE.Vector3(x, y, z);
const PERP_TOL = 1e-7;
const CLOSE_TOL = 1e-9;
const solver = new BatTransformSolver();

const solve = (joints, hand) => {
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const ok = solver.solve(joints, hand, pos, quat);
  const axis = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(quat);
  return { ok, pos, quat, batX: axis(1, 0, 0), batY: axis(0, 1, 0), batZ: axis(0, 0, 1) };
};

const wristOf = (joints, hand) => (hand === 'right' ? joints.rWrist : joints.lWrist);
const forearmOf = (joints, hand) =>
  new THREE.Vector3().subVectors(
    hand === 'right' ? joints.rWrist : joints.lWrist,
    hand === 'right' ? joints.rElbow : joints.lElbow,
  ).normalize();
const bodyUpOf = (j) =>
  new THREE.Vector3().addVectors(j.lShoulder, j.rShoulder)
    .sub(new THREE.Vector3().addVectors(j.lHip, j.rHip)).normalize();
const closeTo = (a, b, tol = CLOSE_TOL) =>
  Math.abs(a.x - b.x) < tol && Math.abs(a.y - b.y) < tol && Math.abs(a.z - b.z) < tol;

// ---------------------------------------------------------------------------
// Synthetic joint sets, avatar-local space, anatomically consistent:
// anatomical right = +x (landmark 12 side), up = +y, chest = -z.
// stance + arms-at-sides are symmetric about x = 0 for the mirror tests.
// ---------------------------------------------------------------------------

/** Mirror-symmetric batting stance: elbows bent, hands low in front. */
const stanceJoints = () => ({
  lShoulder: v(-0.20, 0.55, 0), rShoulder: v(0.20, 0.55, 0),
  lElbow: v(-0.24, 0.30, -0.06), rElbow: v(0.24, 0.30, -0.06),
  lWrist: v(-0.10, 0.12, -0.28), rWrist: v(0.10, 0.12, -0.28),
  lHip: v(-0.12, 0.0, -0.02), rHip: v(0.12, 0.0, -0.02),
});

/** Symmetric, forearms hanging straight down (up-reference degenerate). */
const armsAtSidesJoints = () => ({
  lShoulder: v(-0.20, 0.55, 0), rShoulder: v(0.20, 0.55, 0),
  lElbow: v(-0.23, 0.30, 0.0), rElbow: v(0.23, 0.30, 0.0),
  lWrist: v(-0.25, 0.06, -0.01), rWrist: v(0.25, 0.06, -0.01),
  lHip: v(-0.12, 0.0, 0.0), rHip: v(0.12, 0.0, 0.0),
});

/** Asymmetric raised-bat drive (right-handed backlift, hands high). */
const driveJoints = () => ({
  lShoulder: v(-0.20, 0.55, 0), rShoulder: v(0.20, 0.55, 0),
  lElbow: v(-0.24, 0.34, -0.10), rElbow: v(0.24, 0.60, 0.02),
  lWrist: v(-0.10, 0.20, -0.26), rWrist: v(0.16, 0.86, 0.18),
  lHip: v(-0.12, 0.0, 0.0), rHip: v(0.12, 0.0, 0.0),
});

const POSES = [
  ['stance', stanceJoints],
  ['arms at sides', armsAtSidesJoints],
  ['raised-bat drive', driveJoints],
];

// ---------------------------------------------------------------------------
console.log('\n--- grip anchor ---');
report('bat position is exactly the selected wrist (both hands, all poses)', () => {
  for (const [, make] of POSES) {
    const j = make();
    for (const hand of ['right', 'left']) {
      const r = solve(j, hand);
      assert.ok(r.ok, `${hand} solve failed`);
      assert.ok(r.pos.distanceTo(wristOf(j, hand)) < 1e-12,
        `${hand}: anchor drift ${r.pos.distanceTo(wristOf(j, hand))}`);
    }
  }
});

console.log('\n--- 90 degrees against the forearm ---');
for (const [name, make] of POSES) {
  report(`${name}: blade axis exactly perpendicular to the grip forearm`, () => {
    for (const hand of ['right', 'left']) {
      const j = make();
      const r = solve(j, hand);
      assert.ok(r.ok, `${hand} solve failed`);
      const dot = r.batY.dot(forearmOf(j, hand));
      assert.ok(Math.abs(dot) < PERP_TOL, `${hand}: |blade.forearm| ${dot}`);
    }
  });
}
report('bat local X axis is the forearm axis (basis construction)', () => {
  const j = stanceJoints();
  for (const hand of ['right', 'left']) {
    const r = solve(j, hand);
    assert.ok(r.batX.distanceTo(forearmOf(j, hand)) < CLOSE_TOL,
      `${hand}: X != forearm`);
  }
});
report('arms at sides: near-vertical forearm falls back to chest-forward blade', () => {
  for (const hand of ['right', 'left']) {
    const j = armsAtSidesJoints();
    const r = solve(j, hand);
    assert.ok(r.ok, `${hand} solve failed`);
    const fwd = new THREE.Vector3().crossVectors(
      bodyUpOf(j),
      new THREE.Vector3().subVectors(j.rShoulder, j.lShoulder).normalize(),
    ).normalize();
    assert.ok(r.batY.dot(fwd) > 0.9, `${hand}: blade not forward (dot ${r.batY.dot(fwd)})`);
  }
});

console.log('\n--- correct side per handedness ---');
report('grip sits on the stance side of the body midline', () => {
  const j = stanceJoints();
  const mid = new THREE.Vector3().addVectors(j.lShoulder, j.rShoulder).multiplyScalar(0.5);
  const side = new THREE.Vector3().subVectors(j.rShoulder, j.lShoulder).normalize(); // anatomical right
  const dR = new THREE.Vector3().subVectors(solve(j, 'right').pos, mid).dot(side);
  const dL = new THREE.Vector3().subVectors(solve(j, 'left').pos, mid).dot(side);
  assert.ok(dR > 0, `right-handed grip not on the right side (${dR})`);
  assert.ok(dL < 0, `left-handed grip not on the left side (${dL})`);
});
report('blade never points below horizontal; plumb in stance and drive', () => {
  for (const [name, make] of POSES) {
    for (const hand of ['right', 'left']) {
      const j = make();
      const r = solve(j, hand);
      const dot = r.batY.dot(bodyUpOf(j));
      assert.ok(dot > -CLOSE_TOL, `${name} ${hand}: blade dips below horizontal (${dot})`);
      if (name !== 'arms at sides') {
        assert.ok(dot > 0.3, `${name} ${hand}: blade not plumb enough (${dot})`);
      }
    }
  }
});

console.log('\n--- mirror determinism ---');
report('left-handed result mirrors right-handed on a symmetric pose', () => {
  const j = stanceJoints(); // symmetric about x = 0
  const R = solve(j, 'right');
  const L = solve(j, 'left');
  // Reflection M = flip x. Polar vectors (anchor, forearm=X, blade=Y)
  // mirror as (-x, y, z); the face normal Z = X x Y picks up the
  // reflection's determinant sign and mirrors as (x, -y, -z).
  const mirrorPolar = (p) => v(-p.x, p.y, p.z);
  const mirrorAxial = (p) => v(p.x, -p.y, -p.z);
  assert.ok(closeTo(L.pos, mirrorPolar(R.pos)), `anchor ${JSON.stringify(L.pos)} vs mirrored ${JSON.stringify(R.pos)}`);
  assert.ok(closeTo(L.batX, mirrorPolar(R.batX)), 'forearm (X)');
  assert.ok(closeTo(L.batY, mirrorPolar(R.batY)), 'blade (Y)');
  assert.ok(closeTo(L.batZ, mirrorAxial(R.batZ)), 'face (Z)');
});
report('switching handedness flips the grip side exactly', () => {
  const j = stanceJoints();
  const R = solve(j, 'right').pos;
  const L = solve(j, 'left').pos;
  assert.ok(R.x > 0 && L.x < 0, `grips not on opposite sides (${R.x}, ${L.x})`);
  assert.ok(Math.abs(R.x + L.x) < 1e-12 && Math.abs(R.y - L.y) < 1e-12 && Math.abs(R.z - L.z) < 1e-12,
    `not an exact flip (${JSON.stringify(R)} vs ${JSON.stringify(L)})`);
});

console.log('\n--- degenerate frames ---');
report('collapsed forearm -> false, outputs untouched', () => {
  const j = stanceJoints();
  j.rWrist = j.rElbow.clone();
  const pos = v(9, 9, 9);
  const quat = new THREE.Quaternion(0.5, 0.5, 0.5, 0.5);
  assert.equal(solver.solve(j, 'right', pos, quat), false);
  assert.ok(pos.equals(v(9, 9, 9)), 'position mutated');
  assert.ok(quat.equals(new THREE.Quaternion(0.5, 0.5, 0.5, 0.5)), 'quaternion mutated');
});
report('non-finite joints -> false', () => {
  const j = stanceJoints();
  j.lShoulder.set(NaN, 0, 0);
  assert.equal(solver.solve(j, 'right', v(0, 0, 0), new THREE.Quaternion()), false);
});
report('collapsed shoulder line -> false', () => {
  const j = stanceJoints();
  j.rShoulder = j.lShoulder.clone();
  assert.equal(solver.solve(j, 'right', v(0, 0, 0), new THREE.Quaternion()), false);
});
report('collapsed torso (midShoulder == midHip) -> false', () => {
  const j = stanceJoints();
  j.lHip = v(-0.16, 0.55, 0);
  j.rHip = v(0.16, 0.55, 0);
  assert.equal(solver.solve(j, 'right', v(0, 0, 0), new THREE.Quaternion()), false);
});

// ---------------------------------------------------------------------------
console.log('\n--- renderer pipeline mapping (standing + seated) ---');
// Mirror Avatar.tsx getPos for 'world'-space frames (x, -y, -z) * size.
const SIZE = 0.85;
const mapWorld = (p) => v(p.x * SIZE, -p.y * SIZE, -p.z * SIZE);
const jointsFromLandmarks = (lms, map) => ({
  lShoulder: map(lms[11]), rShoulder: map(lms[12]),
  lElbow: map(lms[13]), rElbow: map(lms[14]),
  lWrist: map(lms[15]), rWrist: map(lms[16]),
  lHip: map(lms[23]), rHip: map(lms[24]),
});

/** 33 hip-anchored metric landmarks (MediaPipe world convention: anatomical
 *  right = smaller x — the solver derives side from the data either way). */
function worldLandmarks() {
  const l = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.95 }));
  l[11] = { x: 0.21, y: 0.55, z: 0, visibility: 0.95 };   // L shoulder (anatomical left)
  l[12] = { x: -0.21, y: 0.55, z: 0, visibility: 0.95 };  // R shoulder
  l[13] = { x: 0.26, y: 0.32, z: 0.08, visibility: 0.95 };
  l[14] = { x: -0.26, y: 0.32, z: 0.08, visibility: 0.95 };
  l[15] = { x: 0.12, y: 0.14, z: 0.30, visibility: 0.95 };
  l[16] = { x: -0.12, y: 0.14, z: 0.30, visibility: 0.95 };
  l[23] = { x: 0.12, y: 0, z: 0, visibility: 0.95 };
  l[24] = { x: -0.12, y: 0, z: 0, visibility: 0.95 };
  return l;
}

report('standing world landmarks: anchor + 90° survive the renderer mapping', () => {
  const lms = worldLandmarks();
  const j = jointsFromLandmarks(lms, mapWorld);
  for (const hand of ['right', 'left']) {
    const r = solve(j, hand);
    assert.ok(r.ok, `${hand} solve failed`);
    const w = hand === 'right' ? 16 : 15;
    assert.ok(r.pos.distanceTo(mapWorld(lms[w])) < 1e-12, `${hand}: anchor drift`);
    const dot = r.batY.dot(forearmOf(j, hand));
    assert.ok(Math.abs(dot) < PERP_TOL, `${hand}: |blade.forearm| ${dot}`);
  }
});

/** Seated-at-desk frame: normalized image landmarks, lower body occluded. */
function seatedImageLandmarks() {
  const l = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.3, z: 0, visibility: 0.95 }));
  l[11] = { x: 0.40, y: 0.30, z: 0, visibility: 0.95 };
  l[12] = { x: 0.60, y: 0.30, z: 0, visibility: 0.95 };
  l[13] = { x: 0.36, y: 0.42, z: -0.05, visibility: 0.95 };
  l[14] = { x: 0.64, y: 0.42, z: -0.05, visibility: 0.95 };
  l[15] = { x: 0.42, y: 0.52, z: -0.12, visibility: 0.95 };
  l[16] = { x: 0.58, y: 0.52, z: -0.12, visibility: 0.95 };
  l[23] = { x: 0.46, y: 1.20, z: 0, visibility: 0.1 };
  l[24] = { x: 0.54, y: 1.20, z: 0, visibility: 0.1 };
  l[25] = { x: 0.46, y: 1.38, z: 0, visibility: 0 };
  l[26] = { x: 0.54, y: 1.38, z: 0, visibility: 0 };
  l[27] = { x: 0.46, y: 1.56, z: 0, visibility: 0 };
  l[28] = { x: 0.54, y: 1.56, z: 0, visibility: 0 };
  return l;
}

report('seated-adapted landmarks: anchor + 90° + plumb blade survive', () => {
  const adapted = adaptSeatedLandmarks(seatedImageLandmarks());
  const j = jointsFromLandmarks(adapted, mapWorld);
  for (const hand of ['right', 'left']) {
    const r = solve(j, hand);
    assert.ok(r.ok, `${hand} solve failed`);
    const w = hand === 'right' ? 16 : 15;
    assert.ok(r.pos.distanceTo(mapWorld(adapted[w])) < 1e-12, `${hand}: anchor drift`);
    const dot = r.batY.dot(forearmOf(j, hand));
    assert.ok(Math.abs(dot) < PERP_TOL, `${hand}: |blade.forearm| ${dot}`);
    const up = r.batY.dot(bodyUpOf(j));
    assert.ok(up > 0.3, `${hand}: blade not plumb (${up})`);
  }
});

// ---------------------------------------------------------------------------
console.log('\n--- swing-aware blade (velocity-driven down blend) ---');

const DT = 1 / 30;
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Right-handed drive sequence on the stance body: grip elbow fixed, the
 * grip wrist sweeps from `from` to `to` over `frames` pose frames.
 */
const swingSeq = (frames, from, to) => {
  const seq = [];
  for (let f = 0; f < frames; f++) {
    const t = frames === 1 ? 1 : f / (frames - 1);
    const j = stanceJoints();
    j.rElbow = v(0.24, 0.35, -0.05);
    j.rWrist = v(lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t));
    seq.push(j);
  }
  return seq;
};

/** Feed a joint sequence at the pose cadence; collect per-frame results. */
const runSeq = (solver, seq, hand = 'right') => {
  const out = [];
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  for (const j of seq) {
    solver.notePoseFrame(j, hand, DT);
    const ok = solver.solve(j, hand, pos, quat);
    out.push({
      ok,
      pos: pos.clone(),
      batY: new THREE.Vector3(0, 1, 0).applyQuaternion(quat),
      blend: solver.swingBlend,
    });
  }
  return out;
};

report('fast downward wrist motion sweeps the blade below horizontal', () => {
  const s = new BatTransformSolver();
  const seq = swingSeq(8, [0.18, 0.55, -0.30], [0.16, -0.10, -0.34]); // ~2.8 u/s down
  const r = runSeq(s, seq);
  assert.ok(r.every((f) => f.ok), 'solve failed mid-swing');
  for (let i = 0; i < seq.length; i++) {
    const fa = new THREE.Vector3().subVectors(seq[i].rWrist, seq[i].rElbow).normalize();
    assert.ok(Math.abs(r[i].batY.dot(fa)) < PERP_TOL, `frame ${i}: |blade.forearm| ${r[i].batY.dot(fa)}`);
  }
  assert.ok(r[0].batY.y > 0, `first frame blade should start up (${r[0].batY.y})`);
  const last = r[seq.length - 1];
  assert.ok(last.blend > 0.7, `blend should be high by the downswing (${last.blend})`);
  assert.ok(last.batY.y < -0.2, `final blade should point down (${last.batY.y})`);
  assert.ok(last.pos.distanceTo(seq[seq.length - 1].rWrist) < 1e-12, 'anchor drift mid-swing');
});

report('slow/stance motion keeps the blade up and bit-identical to no-swing', () => {
  const s = new BatTransformSolver();
  const seq = swingSeq(90, [0.18, 0.55, -0.30], [0.16, -0.10, -0.34]); // same path over 3s
  const r = runSeq(s, seq);
  const last = r[seq.length - 1];
  assert.equal(last.blend, 0, `blend should stay 0 (${last.blend})`);
  assert.ok(last.batY.y > 0, `blade should stay up (${last.batY.y})`);
  const base = solve(seq[seq.length - 1], 'right'); // shared solver: no swing state
  assert.ok(closeTo(last.batY, base.batY), 'swing-path output drifted from the baseline');
});

report('fast backlift (pure upward wrist) tilts but never drops the blade', () => {
  const s = new BatTransformSolver();
  const seq = swingSeq(8, [0.16, 0.05, -0.30], [0.18, 0.70, -0.28]); // ~2.4 u/s up
  const r = runSeq(s, seq);
  const last = r[seq.length - 1];
  assert.ok(last.blend > 0.1, `speed-only swing should register (${last.blend})`);
  // SPEED_ONLY_CAP in batTransform.ts: speed without downward component
  // can only reach 0.5 blend.
  assert.ok(last.blend <= 0.5 + 1e-9, `backlift blend must stay capped (${last.blend})`);
  assert.ok(last.batY.y > 0, `blade must not point down on a backlift (${last.batY.y})`);
});

report('thresholdScale (seated) makes a slower arm-only swing register more', () => {
  const standing = new BatTransformSolver();
  const rStand = runSeq(standing, swingSeq(9, [0.18, 0.40, -0.30], [0.16, 0.10, -0.32])); // ~1.1 u/s
  const seated = new BatTransformSolver();
  seated.thresholdScale = 0.7;
  const rSit = runSeq(seated, swingSeq(9, [0.18, 0.40, -0.30], [0.16, 0.10, -0.32]));
  const bStand = rStand[rStand.length - 1].blend;
  const bSit = rSit[rSit.length - 1].blend;
  assert.ok(bSit > bStand + 0.02, `seated blend ${bSit} should clearly exceed standing ${bStand}`);
});

report('resetSwing returns to the exact stance baseline', () => {
  const s = new BatTransformSolver();
  const seq = swingSeq(8, [0.18, 0.55, -0.30], [0.16, -0.10, -0.34]);
  runSeq(s, seq);
  s.resetSwing();
  assert.equal(s.swingBlend, 0);
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  assert.ok(s.solve(seq[seq.length - 1], 'right', pos, quat));
  const batY = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
  const base = solve(seq[seq.length - 1], 'right');
  assert.ok(closeTo(batY, base.batY), 'post-reset output drifted from the baseline');
});

report('stalled pose stream (unchanged joints) releases the blend to stance', () => {
  const s = new BatTransformSolver();
  const seq = swingSeq(8, [0.18, 0.55, -0.30], [0.16, -0.10, -0.34]);
  runSeq(s, seq);
  assert.ok(s.swingBlend > 0.5, `setup: blend should be high (${s.swingBlend})`);
  const still = seq[seq.length - 1];
  for (let i = 0; i < 45; i++) s.notePoseFrame(still, 'right', DT); // 1.5s stall
  assert.ok(s.swingBlend < 0.05, `blend should decay (${s.swingBlend})`);
});

report('left-handed swing mirrors: blade also sweeps down', () => {
  const s = new BatTransformSolver();
  const seq = swingSeq(8, [0.18, 0.55, -0.30], [0.16, -0.10, -0.34]).map((j) => ({
    ...j,
    lElbow: v(-j.rElbow.x, j.rElbow.y, j.rElbow.z),
    lWrist: v(-j.rWrist.x, j.rWrist.y, j.rWrist.z),
  }));
  const r = runSeq(s, seq, 'left');
  const last = r[seq.length - 1];
  assert.ok(last.blend > 0.7, `left-handed blend (${last.blend})`);
  assert.ok(last.batY.y < -0.2, `left-handed blade should point down (${last.batY.y})`);
});

console.log(failures === 0 ? '\nAll bat-orientation sanity checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);

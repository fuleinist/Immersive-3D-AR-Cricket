import React, { useRef, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { useBox } from '@react-three/cannon';
import * as THREE from 'three';
import { Landmark, PoseLandmarkFrame, Stance, GameMode, TrackingMode, ResolvedTrackingMode } from '../types';
import { BatTransformSmoother } from '../services/batSmoothing';
import { BatTransformSolver, type BatJoints } from '../services/batTransform';

interface AvatarProps {
  landmarks: React.MutableRefObject<PoseLandmarkFrame | null>;
  stance: Stance;
  gameMode: GameMode;
  size?: number;
  positionOffset?: { x: number; y: number };
  /** Smoothed lateral root offset (world meters), updated per pose frame. */
  lateralOffset: React.MutableRefObject<number>;
  trackingMode: ResolvedTrackingMode;
}

/** Seated players swing arm-only and slower: lower every swing threshold
 *  so the blade's down-blend stays reachable from a chair. */
const SEATED_SWING_THRESHOLD_SCALE = 0.7;

/**
 * Static landmarks for a standard batting stance used during menu calibration.
 */
const GET_DEFAULT_POSE = (isRight: boolean): Landmark[] => {
  const l: any = Array(33).fill({ x: 0, y: 0, z: 0 });
  // Pelvis
  l[23] = { x: -0.12, y: 0, z: 0 }; // L Hip
  l[24] = { x: 0.12, y: 0, z: 0 };  // R Hip
  // Legs
  l[25] = { x: -0.18, y: 0.45, z: 0.1 }; // L Knee
  l[26] = { x: 0.18, y: 0.45, z: 0.1 };  // R Knee
  l[27] = { x: -0.18, y: 0.95, z: 0 };   // L Ankle
  l[28] = { x: 0.18, y: 0.95, z: 0 };    // R Ankle
  // Torso
  l[11] = { x: -0.2, y: -0.55, z: 0 }; // L Shoulder
  l[12] = { x: 0.2, y: -0.55, z: 0 };  // R Shoulder
  l[0] = { x: 0, y: -0.85, z: 0 };     // Head
  // Batting arms
  if (isRight) {
    l[13] = { x: -0.3, y: -0.3, z: -0.2 }; // L Elbow
    l[15] = { x: -0.2, y: -0.1, z: -0.4 }; // L Wrist
    l[14] = { x: 0.2, y: -0.3, z: 0.1 };   // R Elbow
    l[16] = { x: 0.1, y: -0.1, z: -0.3 };  // R Wrist
  } else {
    l[14] = { x: 0.3, y: -0.3, z: -0.2 };  // R Elbow
    l[16] = { x: 0.2, y: -0.1, z: -0.4 };  // R Wrist
    l[13] = { x: -0.2, y: -0.3, z: 0.1 };  // L Elbow
    l[15] = { x: -0.1, y: -0.1, z: -0.3 }; // L Wrist
  }
  return l;
};

export const Avatar: React.FC<AvatarProps> = ({
  landmarks,
  stance,
  gameMode,
  size = 0.85,
  positionOffset = { x: 0, y: 0 },
  lateralOffset,
  trackingMode
}) => {
  const jointsRef = useRef<{ [key: string]: THREE.Mesh | null }>({});
  const rootRef = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Mesh>(null);
  const torsoRef = useRef<THREE.Mesh>(null);
  const lUpperArmRef = useRef<THREE.Mesh>(null);
  const lForearmRef = useRef<THREE.Mesh>(null);
  const rUpperArmRef = useRef<THREE.Mesh>(null);
  const rForearmRef = useRef<THREE.Mesh>(null);
  const lThighRef = useRef<THREE.Mesh>(null);
  const rThighRef = useRef<THREE.Mesh>(null);
  const lShinRef = useRef<THREE.Mesh>(null);
  const rShinRef = useRef<THREE.Mesh>(null);
  const visualBatRef = useRef<THREE.Group>(null);

  // Bat physics dimensions
  const batWidth = gameMode === GameMode.EASY ? 0.35 : 0.12;
  const batHeight = 1.1;
  const batDepth = 0.1;

  const [batPhysRef, batApi] = useBox(() => ({
    type: 'Kinematic',
    args: [batWidth * size, batHeight * size, batDepth * size],
    position: [0, -10, 0],
    onCollide: (e) => {
        // Handled in Ball.tsx
    }
  }));

  const defaultPose = useMemo(() => GET_DEFAULT_POSE(stance === Stance.RIGHT), [stance]);
  const lateralBase = stance === Stance.RIGHT ? 0.45 : -0.45;
  const creaseZ = 1.35;

  // Preallocated per-frame scratch: the pose update runs every render frame,
  // so nothing in the hot path may allocate.
  const scratch = useMemo(() => ({
    headPos: new THREE.Vector3(),
    lShoulder: new THREE.Vector3(), rShoulder: new THREE.Vector3(),
    lElbow: new THREE.Vector3(), rElbow: new THREE.Vector3(),
    lWrist: new THREE.Vector3(), rWrist: new THREE.Vector3(),
    lHip: new THREE.Vector3(), rHip: new THREE.Vector3(),
    lKnee: new THREE.Vector3(), rKnee: new THREE.Vector3(),
    lAnkle: new THREE.Vector3(), rAnkle: new THREE.Vector3(),
    midShoulder: new THREE.Vector3(), midHip: new THREE.Vector3(),
    batPos: new THREE.Vector3(),
    boneDir: new THREE.Vector3(),
    targetQuat: new THREE.Quaternion(),
    dampedPos: new THREE.Vector3(), dampedQuat: new THREE.Quaternion(),
    worldPos: new THREE.Vector3(), worldQuat: new THREE.Quaternion(),
    euler: new THREE.Euler(),
    up: new THREE.Vector3(0, 1, 0),
  }), []);

  // Grip-anchored bat solver + derived-level damper. The solver computes
  // the bat transform from the scratch joints (aliases, zero churn); the
  // smoother damps that transform itself, which landmark smoothing alone
  // cannot steady because the perpendicular projection amplifies
  // orientation noise.
  const batSolver = useMemo(() => new BatTransformSolver(), []);
  const batSmoother = useMemo(() => new BatTransformSmoother(), []);
  const batJoints = useMemo<BatJoints>(() => ({
    lShoulder: scratch.lShoulder, rShoulder: scratch.rShoulder,
    lElbow: scratch.lElbow, rElbow: scratch.rElbow,
    lWrist: scratch.lWrist, rWrist: scratch.rWrist,
    lHip: scratch.lHip, rHip: scratch.rHip,
  }), [scratch]);

  // Switching stance moves the grip to the other wrist — reset the damper
  // so the bat snaps to the new side instead of sweeping across the body,
  // and drop any swing phase built up on the old side.
  useEffect(() => { batSmoother.reset(); batSolver.resetSwing(); }, [stance, batSmoother, batSolver]);

  // Seated swings are arm-only and slower: scale the swing thresholds and
  // restart phase detection whenever the tracking mode changes.
  useEffect(() => {
    batSolver.thresholdScale = trackingMode === TrackingMode.SITTING ? SEATED_SWING_THRESHOLD_SCALE : 1;
    batSolver.resetSwing();
  }, [trackingMode, batSolver]);

  // Pose-stream cadence marker for swing velocity: the landmarks only
  // change when the pose callback stamps a new timeMs, so velocity must be
  // estimated on that clock, not the (faster, variable) render clock.
  const lastPoseTimeRef = useRef(-1);

  const poseJoint = (key: string, pos: THREE.Vector3, radius: number) => {
    const mesh = jointsRef.current[key];
    if (mesh) {
      mesh.position.copy(pos);
      mesh.scale.setScalar(radius * size);
    }
  };

  const poseBone = (mesh: THREE.Mesh | null, p1: THREE.Vector3, p2: THREE.Vector3, thickness: number) => {
    if (!mesh) return;
    const direction = scratch.boneDir.subVectors(p2, p1);
    const length = direction.length();
    if (length < 0.01) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    mesh.scale.set(thickness * size, length, thickness * size);
    mesh.position.copy(p1).addScaledVector(direction, 0.5);
    mesh.quaternion.setFromUnitVectors(scratch.up, direction.divideScalar(length));
  };

  useFrame((_, delta) => {
    const frame = landmarks.current;
    const hasPose = !!frame && frame.landmarks.length >= 33;
    const l = hasPose ? frame.landmarks : defaultPose;

    // Lateral root tracking: the smoothed per-pose-frame offset slides the
    // whole avatar group in world X only — y/z stay on the JSX base, so the
    // feet-planted ground-plane invariant is untouched by construction.
    if (rootRef.current) {
      rootRef.current.position.x = lateralBase + positionOffset.x + lateralOffset.current;
    }

    // The pipeline tags every frame with its coordinate space — the avatar
    // never guesses. The default pose is authored in world convention.
    const space = hasPose ? frame.space : 'world';
    const {
      headPos, lShoulder, rShoulder, lElbow, rElbow, lWrist, rWrist,
      lHip, rHip, lKnee, rKnee, lAnkle, rAnkle, midShoulder, midHip,
      batPos, targetQuat, dampedPos, dampedQuat, worldPos, worldQuat, euler,
    } = scratch;

    const getPos = (idx: number, out: THREE.Vector3) => {
      const raw = l[idx];
      if (space === 'world') {
        out.set(raw.x * size, -raw.y * size, -raw.z * size);
      } else {
        out.set((raw.x - 0.5) * 1.8 * size, (0.5 - raw.y) * 2.2 * size, -raw.z * size);
      }
    };

    getPos(0, headPos);
    getPos(11, lShoulder); getPos(12, rShoulder);
    getPos(13, lElbow); getPos(14, rElbow);
    getPos(15, lWrist); getPos(16, rWrist);
    getPos(23, lHip); getPos(24, rHip);
    getPos(25, lKnee); getPos(26, rKnee);
    getPos(27, lAnkle); getPos(28, rAnkle);

    if (headRef.current) headRef.current.position.copy(headPos);

    midShoulder.addVectors(lShoulder, rShoulder).multiplyScalar(0.5);
    midHip.addVectors(lHip, rHip).multiplyScalar(0.5);

    poseBone(torsoRef.current, midShoulder, midHip, 0.18);
    poseBone(lUpperArmRef.current, lShoulder, lElbow, 0.045);
    poseBone(lForearmRef.current, lElbow, lWrist, 0.035);
    poseBone(rUpperArmRef.current, rShoulder, rElbow, 0.045);
    poseBone(rForearmRef.current, rElbow, rWrist, 0.035);
    poseBone(lThighRef.current, lHip, lKnee, 0.06);
    poseBone(lShinRef.current, lKnee, lAnkle, 0.05);
    poseBone(rThighRef.current, rHip, rKnee, 0.06);
    poseBone(rShinRef.current, rKnee, rAnkle, 0.05);

    poseJoint('lShoulder', lShoulder, 0.06);
    poseJoint('rShoulder', rShoulder, 0.06);
    poseJoint('lElbow', lElbow, 0.05);
    poseJoint('rElbow', rElbow, 0.05);
    poseJoint('lWrist', lWrist, 0.045);
    poseJoint('rWrist', rWrist, 0.045);
    poseJoint('lHip', lHip, 0.07);
    poseJoint('rHip', rHip, 0.07);
    poseJoint('lKnee', lKnee, 0.06);
    poseJoint('rKnee', rKnee, 0.06);
    poseJoint('lAnkle', lAnkle, 0.05);
    poseJoint('rAnkle', rAnkle, 0.05);
    poseJoint('midShoulder', midShoulder, 0.06);
    poseJoint('midHip', midHip, 0.07);

    // Grip-anchored bat transform: hang the bat off the SELECTED wrist
    // (right/left per stance), blade exactly 90° against that forearm —
    // never the old two-wrist cross, which floated the grip between the
    // arms and could mirror the blade toward the wrong side. Then damp the
    // derived transform (adaptive 1€ position, slerp orientation). Shot
    // detection reads this same damped transform via the kinematic body
    // below, so swing physics inherits the corrected anchor and the
    // damping. A degenerate frame keeps the last good transform.
    const hand = stance === Stance.RIGHT ? ('right' as const) : ('left' as const);

    // Swing phase detection runs on the POSE clock (frame.timeMs), not the
    // render clock: the landmarks only change per pose frame, so diffing
    // per render frame would alias a fast swing into alternating v/0
    // readings and underestimate proportionally to the display rate. The
    // bat damper's adaptive cutoff updates on the same boundary (it would
    // sawtooth if re-derived per render frame from a stepped target) —
    // poseAdvanced/poseDt carry the sample clock to both.
    let poseAdvanced = false;
    let poseDt = 1 / 30;
    const poseTime = hasPose && typeof frame.timeMs === 'number' ? frame.timeMs : -1;
    if (poseTime >= 0) {
      const prevTime = lastPoseTimeRef.current;
      if (poseTime !== prevTime) {
        lastPoseTimeRef.current = poseTime;
        poseAdvanced = true;
        if (prevTime < 0) {
          // First real pose frame after the menu default pose: prime the
          // velocity estimate — diffing against the default stance would
          // read the teleport as a phantom swing.
          batSolver.resetSwing();
          batSolver.notePoseFrame(batJoints, hand, poseDt);
        } else {
          poseDt = (poseTime - prevTime) / 1000;
          if (poseDt < 1 / 240) poseDt = 1 / 240;
          else if (poseDt > 0.5) poseDt = 0.5;
          batSolver.notePoseFrame(batJoints, hand, poseDt);
        }
      }
    } else if (lastPoseTimeRef.current >= 0) {
      // Pose stream lost (back on the default pose): no swing phase.
      lastPoseTimeRef.current = -1;
      batSolver.resetSwing();
    }

    if (batSolver.solve(batJoints, hand, batPos, targetQuat)) {
      batSmoother.filter(batPos, targetQuat, delta, dampedPos, dampedQuat, poseAdvanced, poseDt);
    }

    if (visualBatRef.current) {
      visualBatRef.current.position.copy(dampedPos);
      visualBatRef.current.quaternion.copy(dampedQuat);

      visualBatRef.current.getWorldPosition(worldPos);
      visualBatRef.current.getWorldQuaternion(worldQuat);
      batApi.position.set(worldPos.x, worldPos.y, worldPos.z);
      euler.setFromQuaternion(worldQuat);
      batApi.rotation.set(euler.x, euler.y, euler.z);
    }
  });

  const bodyMat = <meshStandardMaterial color="#f8fafc" metalness={0.1} roughness={0.6} />;
  const jointMat = <meshStandardMaterial color="#cbd5e1" metalness={0.2} roughness={0.4} />;
  const gloveMat = <meshStandardMaterial color="#2563eb" metalness={0.4} roughness={0.3} />;

  const jointKeys = ['lShoulder','rShoulder','lElbow','rElbow','lWrist','rWrist','lHip','rHip','lKnee','rKnee','lAnkle','rAnkle','midShoulder','midHip'];

  return (
    <group ref={rootRef} position={[lateralBase + positionOffset.x, 1.0 * size + positionOffset.y, creaseZ]} rotation={[0, Math.PI, 0]}>
      <mesh ref={headRef} castShadow><sphereGeometry args={[0.095 * size, 24, 24]} />{bodyMat}</mesh>
      <mesh ref={torsoRef} castShadow><boxGeometry args={[1, 1, 0.8]} />{bodyMat}</mesh>
      <mesh ref={lUpperArmRef} castShadow><cylinderGeometry args={[1, 1, 1, 12]} />{bodyMat}</mesh>
      <mesh ref={lForearmRef} castShadow><cylinderGeometry args={[1, 1, 1, 12]} />{bodyMat}</mesh>
      <mesh ref={rUpperArmRef} castShadow><cylinderGeometry args={[1, 1, 1, 12]} />{bodyMat}</mesh>
      <mesh ref={rForearmRef} castShadow><cylinderGeometry args={[1, 1, 1, 12]} />{bodyMat}</mesh>
      <mesh ref={lThighRef} castShadow><cylinderGeometry args={[1, 1, 1, 12]} />{bodyMat}</mesh>
      <mesh ref={lShinRef} castShadow><cylinderGeometry args={[1, 1, 1, 12]} />{bodyMat}</mesh>
      <mesh ref={rThighRef} castShadow><cylinderGeometry args={[1, 1, 1, 12]} />{bodyMat}</mesh>
      <mesh ref={rShinRef} castShadow><cylinderGeometry args={[1, 1, 1, 12]} />{bodyMat}</mesh>

      {jointKeys.map(k => (
        <mesh key={k} ref={el => jointsRef.current[k] = el} castShadow>
          <sphereGeometry args={[1, 16, 16]} />
          {k.includes('Wrist') ? gloveMat : jointMat}
        </mesh>
      ))}

      <group ref={visualBatRef}>
        <mesh position={[0, 0.4 * size, 0]} castShadow>
          <boxGeometry args={[0.13 * size, 0.8 * size, 0.08 * size]} />
          <meshStandardMaterial color="#eab308" roughness={0.3} />
        </mesh>
        <mesh position={[0, -0.15 * size, 0]} castShadow>
          <cylinderGeometry args={[0.025 * size, 0.025 * size, 0.35 * size, 12]} />
          <meshStandardMaterial color="#111111" metalness={0.8} />
        </mesh>
        {/* Invisible hitbox visualizer for EASY mode debugging */}
        {gameMode === GameMode.EASY && (
            <mesh position={[0, 0.25 * size, 0]}>
                <boxGeometry args={[batWidth * size, batHeight * size, batDepth * size]} />
                <meshBasicMaterial color="#34d399" wireframe transparent opacity={0.1} />
            </mesh>
        )}
      </group>

      <mesh ref={batPhysRef as any} name="bat" visible={false}>
        <boxGeometry args={[batWidth * size, batHeight * size, batDepth * size]} />
      </mesh>
    </group>
  );
};
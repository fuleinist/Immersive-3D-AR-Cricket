import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { useBox } from '@react-three/cannon';
import * as THREE from 'three';
import { Landmark, Stance, GameMode } from '../types';

interface AvatarProps {
  landmarks: React.MutableRefObject<Landmark[] | null>;
  stance: Stance;
  gameMode: GameMode;
  size?: number;
  positionOffset?: { x: number; y: number };
}

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
  positionOffset = { x: 0, y: 0 } 
}) => {
  const jointsRef = useRef<{ [key: string]: THREE.Mesh | null }>({});
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

  const poseJoint = (key: string, pos: THREE.Vector3, radius: number) => {
    const mesh = jointsRef.current[key];
    if (mesh) {
      mesh.position.copy(pos);
      mesh.scale.setScalar(radius * size);
    }
  };

  const poseBone = (mesh: THREE.Mesh | null, p1: THREE.Vector3, p2: THREE.Vector3, thickness: number) => {
    if (!mesh) return;
    const direction = new THREE.Vector3().subVectors(p2, p1);
    const length = direction.length();
    if (length < 0.01) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    mesh.scale.set(thickness * size, length, thickness * size);
    mesh.position.copy(p1).add(direction.clone().multiplyScalar(0.5));
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
  };

  useFrame(() => {
    const l = (landmarks.current && landmarks.current.length >= 33) ? landmarks.current : defaultPose;
    
    const getPos = (idx: number) => {
      const raw = l[idx];
      const isWorld = Math.abs(raw.x) < 5 && Math.abs(raw.y) < 5 && (Math.abs(raw.x) > 0.001 || Math.abs(raw.y) > 0.001);
      if (isWorld) {
        return new THREE.Vector3(raw.x * size, -raw.y * size, -raw.z * size);
      } else {
        return new THREE.Vector3((raw.x - 0.5) * 1.8 * size, (0.5 - raw.y) * 2.2 * size, -raw.z * size);
      }
    };

    const headPos = getPos(0);
    const lShoulder = getPos(11);
    const rShoulder = getPos(12);
    const lElbow = getPos(13);
    const rElbow = getPos(14);
    const lWrist = getPos(15);
    const rWrist = getPos(16);
    const lHip = getPos(23);
    const rHip = getPos(24);
    const lKnee = getPos(25);
    const rKnee = getPos(26);
    const lAnkle = getPos(27);
    const rAnkle = getPos(28);

    if (headRef.current) headRef.current.position.copy(headPos);

    const midShoulder = new THREE.Vector3().addVectors(lShoulder, rShoulder).multiplyScalar(0.5);
    const midHip = new THREE.Vector3().addVectors(lHip, rHip).multiplyScalar(0.5);

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

    const midWrist = new THREE.Vector3().addVectors(lWrist, rWrist).multiplyScalar(0.5);
    const wristDiff = new THREE.Vector3().subVectors(lWrist, rWrist).normalize();
    const forearmDir = new THREE.Vector3().subVectors(midWrist, midShoulder).normalize();
    const batForward = new THREE.Vector3().crossVectors(wristDiff, forearmDir).normalize();
    const batToeDir = new THREE.Vector3().crossVectors(wristDiff, batForward).normalize();

    if (visualBatRef.current) {
      visualBatRef.current.position.copy(midWrist);
      const matrix = new THREE.Matrix4();
      const batX = new THREE.Vector3().crossVectors(batToeDir, batForward).normalize();
      matrix.makeBasis(batX, batToeDir, batForward);
      visualBatRef.current.quaternion.setFromRotationMatrix(matrix);

      const worldPos = new THREE.Vector3();
      const worldQuat = new THREE.Quaternion();
      visualBatRef.current.getWorldPosition(worldPos);
      visualBatRef.current.getWorldQuaternion(worldQuat);
      batApi.position.set(worldPos.x, worldPos.y, worldPos.z);
      const euler = new THREE.Euler().setFromQuaternion(worldQuat);
      batApi.rotation.set(euler.x, euler.y, euler.z);
    }
  });

  const bodyMat = <meshStandardMaterial color="#f8fafc" metalness={0.1} roughness={0.6} />;
  const jointMat = <meshStandardMaterial color="#cbd5e1" metalness={0.2} roughness={0.4} />;
  const gloveMat = <meshStandardMaterial color="#2563eb" metalness={0.4} roughness={0.3} />;

  const jointKeys = ['lShoulder','rShoulder','lElbow','rElbow','lWrist','rWrist','lHip','rHip','lKnee','rKnee','lAnkle','rAnkle','midShoulder','midHip'];

  return (
    <group position={[lateralBase + positionOffset.x, 1.0 * size + positionOffset.y, creaseZ]} rotation={[0, Math.PI, 0]}>
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
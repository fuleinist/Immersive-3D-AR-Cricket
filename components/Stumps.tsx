import React, { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useCylinder } from '@react-three/cannon';
import type { Group, Mesh, MeshStandardMaterial } from 'three';
import {
  STUMP_HEIGHT,
  STUMP_PLANE_Z,
  STUMP_RADIUS,
  STUMP_XS,
} from '../services/shotPhysics';
import {
  advanceImpact,
  isSettled,
  resetImpact,
  type StumpImpactState,
} from '../services/stumpImpact';

interface StumpsProps {
  impact: StumpImpactState | null;
  /** Bumped when a new impact is resolved, so frame 0 shows the hit. */
  impactKey: number;
  resetTrigger: number;
}

const STUMP_ARGS: [number, number, number, number] = [
  STUMP_RADIUS,
  STUMP_RADIUS,
  STUMP_HEIGHT,
  8,
];

/** Rest centres of the two bails, used as the JSX starting transform. */
const BAIL_REST = [0, 1].map((j) => ({
  x: (STUMP_XS[j] + STUMP_XS[j + 1]) / 2,
  y: STUMP_HEIGHT,
  z: STUMP_PLANE_Z,
}));

/**
 * The static colliders are kept exactly as they were: the ball still collides
 * with them, so a bowled dismissal is still detected by physics. What is new is
 * the visible layer, which is driven by the pure model in services/stumpImpact.ts
 * rather than by the physics bodies. Nothing here reads the clock or Math.random;
 * the state is the only source of truth, so the harness can reproduce it.
 */
export const Stumps: React.FC<StumpsProps> = ({ impact, impactKey, resetTrigger }) => {
  // Invisible static colliders, one per stump. They keep the existing
  // ball-versus-stump collision.
  const [collider0] = useCylinder(() => ({
    name: 'stump',
    args: STUMP_ARGS,
    position: [STUMP_XS[0], STUMP_HEIGHT / 2, STUMP_PLANE_Z],
    type: 'Static',
  }));
  const [collider1] = useCylinder(() => ({
    name: 'stump',
    args: STUMP_ARGS,
    position: [STUMP_XS[1], STUMP_HEIGHT / 2, STUMP_PLANE_Z],
    type: 'Static',
  }));
  const [collider2] = useCylinder(() => ({
    name: 'stump',
    args: STUMP_ARGS,
    position: [STUMP_XS[2], STUMP_HEIGHT / 2, STUMP_PLANE_Z],
    type: 'Static',
  }));

  const colliders = [collider0, collider1, collider2];

  const stumpRefs = useRef<(Group | null)[]>([null, null, null]);
  const bailRefs = useRef<(Mesh | null)[]>([null, null]);

  /** Copy the model state into the meshes. Called every frame and on any event. */
  const applyState = (state: StumpImpactState) => {
    for (let i = 0; i < state.stumps.length; i++) {
      const body = state.stumps[i];
      const node = stumpRefs.current[i];
      if (!node) continue;
      node.position.set(body.position.x, body.position.y, body.position.z);
      node.rotation.set(body.angle, 0, 0);
    }

    for (let j = 0; j < state.bails.length; j++) {
      const body = state.bails[j];
      const node = bailRefs.current[j];
      if (!node) continue;
      node.position.set(body.position.x, body.position.y, body.position.z);
      node.rotation.set(0, 0, body.angle);

      const material = node.material as MeshStandardMaterial;
      material.emissiveIntensity = state.zing && state.elapsed < 1.2 ? 3.5 : 0;
    }
  };

  useEffect(() => {
    if (!impact) return;
    applyState(impact);
  }, [impactKey]);

  useEffect(() => {
    if (!impact) return;
    resetImpact(impact);
    applyState(impact);
  }, [resetTrigger]);

  useFrame((_, delta) => {
    if (!impact || isSettled(impact)) return;
    advanceImpact(impact, Math.min(delta, 0.05));
    applyState(impact);
  });

  return (
    <group>
      {colliders.map((ref, index) => (
        <mesh key={`collider-${index}`} ref={ref as any} name="stump" visible={false} />
      ))}

      {STUMP_XS.map((x, index) => (
        <group
          key={`stump-${index}`}
          ref={(node) => {
            stumpRefs.current[index] = node;
          }}
          position={[x, 0, STUMP_PLANE_Z]}
          rotation={[0, 0, 0]}
        >
          <mesh name="stump" position={[0, STUMP_HEIGHT / 2, 0]} castShadow>
            <cylinderGeometry args={STUMP_ARGS} />
            <meshStandardMaterial color="#eeeeee" roughness={0.1} />
          </mesh>
        </group>
      ))}

      {BAIL_REST.map((rest, index) => (
        <mesh
          key={`bail-${index}`}
          ref={(node) => {
            bailRefs.current[index] = node;
          }}
          name="bail"
          position={[rest.x, rest.y, rest.z]}
          rotation={[0, 0, 0]}
        >
          <boxGeometry args={[STUMP_XS[index + 1] - STUMP_XS[index] + 2 * STUMP_RADIUS, 0.02, 0.02]} />
          <meshStandardMaterial color="#cc0000" emissive="#ff1e1e" emissiveIntensity={0} />
        </mesh>
      ))}
    </group>
  );
};

import React, { useLayoutEffect, useRef } from 'react';
import {
  CapsuleGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  SphereGeometry,
} from 'three';
import { fieldersFor } from '../services/fieldingSim';

interface FieldersProps {
  deliveryId: string;
}

// Stylized ~1.80 m cricketer proportions: capsule torso resting at y = 0 with a
// sphere head sitting cleanly on top. Wide enough to remain legible at 60 m.
const BODY_RADIUS = 0.24;
const BODY_LENGTH = 0.98;
const BODY_HEIGHT = BODY_LENGTH + 2 * BODY_RADIUS; // 1.46 m
const BODY_CENTER_Y = BODY_HEIGHT / 2; // 0.73 m
const HEAD_RADIUS = 0.17; // 0.34 m diameter -> 1.80 m total height
const HEAD_CENTER_Y = BODY_HEIGHT + HEAD_RADIUS; // 1.63 m

// Shared across all nine figures and across preset switches (2 draw calls total).
const BODY_GEOMETRY = new CapsuleGeometry(BODY_RADIUS, BODY_LENGTH, 6, 12);
const HEAD_GEOMETRY = new SphereGeometry(HEAD_RADIUS, 12, 10);
const BODY_MATERIAL = new MeshStandardMaterial({
  color: '#f3efe2',
  roughness: 0.85,
  metalness: 0,
});
const HEAD_MATERIAL = new MeshStandardMaterial({
  color: '#3b2e26',
  roughness: 0.8,
  metalness: 0,
});
const INSTANCE_MATRIX = new Matrix4();

/**
 * Visual-only fielders for the current delivery preset.
 *
 * Uses two InstancedMesh objects (bodies + heads) with module-scope geometry
 * and materials, costing 2 draw calls for all nine figures with zero per-frame
 * allocation and no physics bodies.
 */
export const Fielders: React.FC<FieldersProps> = ({ deliveryId }) => {
  const fielders = fieldersFor(deliveryId);
  const bodyRef = useRef<InstancedMesh | null>(null);
  const headRef = useRef<InstancedMesh | null>(null);

  useLayoutEffect(() => {
    const bodyMesh = bodyRef.current;
    const headMesh = headRef.current;
    if (!bodyMesh || !headMesh) return;

    bodyMesh.count = fielders.length;
    headMesh.count = fielders.length;

    for (let i = 0; i < fielders.length; i++) {
      const { x, z } = fielders[i];
      INSTANCE_MATRIX.makeTranslation(x, BODY_CENTER_Y, z);
      bodyMesh.setMatrixAt(i, INSTANCE_MATRIX);
      INSTANCE_MATRIX.makeTranslation(x, HEAD_CENTER_Y, z);
      headMesh.setMatrixAt(i, INSTANCE_MATRIX);
    }

    bodyMesh.instanceMatrix.needsUpdate = true;
    headMesh.instanceMatrix.needsUpdate = true;
  }, [fielders]);

  return (
    <group name="fielders">
      <instancedMesh
        ref={bodyRef}
        args={[BODY_GEOMETRY, BODY_MATERIAL, fielders.length]}
        castShadow={false}
        receiveShadow={false}
        frustumCulled={false}
        dispose={null}
      />
      <instancedMesh
        ref={headRef}
        args={[HEAD_GEOMETRY, HEAD_MATERIAL, fielders.length]}
        castShadow={false}
        receiveShadow={false}
        frustumCulled={false}
        dispose={null}
      />
    </group>
  );
};

import React, { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { BufferAttribute, BufferGeometry, Line, LineBasicMaterial } from 'three';
import {
  BallTrail as BallTrailModel,
  makeTrailPoints,
  TRAIL_CAPACITY,
} from '../services/impactJuice';

interface BallTrailProps {
  /** Shared trail model. components/Ball.tsx pushes into it every live frame. */
  trail: BallTrailModel;
  resetTrigger: number;
}

/** Warm colour of the newest point; older points fade to black. */
const HEAD_COLOR = { r: 1, g: 0.62, b: 0.18 };

/**
 * Draws the recent flight path as one preallocated line. The geometry and the
 * colour buffer are created once, so a frame only writes numbers into the
 * existing arrays. Nothing here allocates per frame and nothing reads the clock
 * for anything but the sample time.
 */
export const BallTrail: React.FC<BallTrailProps> = ({ trail, resetTrigger }) => {
  const view = useMemo(() => {
    const points = makeTrailPoints(TRAIL_CAPACITY);
    const geometry = new BufferGeometry();
    const positions = new Float32Array(TRAIL_CAPACITY * 3);
    const colors = new Float32Array(TRAIL_CAPACITY * 3);
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    geometry.setDrawRange(0, 0);
    const material = new LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });
    const line = new Line(geometry, material);
    line.frustumCulled = false;
    return { points, geometry, material, line, positions, colors };
  }, []);

  useEffect(() => {
    trail.reset();
    view.geometry.setDrawRange(0, 0);
  }, [resetTrigger, trail, view]);

  useEffect(
    () => () => {
      view.geometry.dispose();
      view.material.dispose();
    },
    [view],
  );

  useFrame(() => {
    const count = trail.sampleInto(view.points, performance.now());
    for (let i = 0; i < count; i += 1) {
      const point = view.points[i];
      const offset = i * 3;
      view.positions[offset] = point.x;
      view.positions[offset + 1] = point.y;
      view.positions[offset + 2] = point.z;
      // Squared alpha keeps the tail dark; the head stays readable.
      const fade = point.alpha * point.alpha;
      view.colors[offset] = HEAD_COLOR.r * fade;
      view.colors[offset + 1] = HEAD_COLOR.g * fade;
      view.colors[offset + 2] = HEAD_COLOR.b * fade;
    }
    const positionAttribute = view.geometry.getAttribute('position') as BufferAttribute;
    const colorAttribute = view.geometry.getAttribute('color') as BufferAttribute;
    positionAttribute.needsUpdate = true;
    colorAttribute.needsUpdate = true;
    view.geometry.setDrawRange(0, count >= 2 ? count : 0);
  });

  return <primitive object={view.line} />;
};
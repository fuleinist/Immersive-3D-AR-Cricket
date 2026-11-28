import React from 'react';
import {
  BOUNDARY_RADIUS,
  PITCH_LENGTH,
  PITCH_WIDTH,
  THIRTY_YARD_RADIUS,
  creaseLines,
} from '../services/groundLayout';

const CREASE_LINES = creaseLines();
const TURF_SEGMENTS = 72;
const RING_SEGMENTS = 96;
const RING_HALF_WIDTH = 0.075;
const ROPE_TUBE_RADIUS = 0.08;
const ROPE_RADIAL_SEGMENTS = 12;
const ROPE_TUBULAR_SEGMENTS = 96;

/**
 * Visual-only cricket ground: 65 m turf oval, 20.12 m x 3.05 m pitch strip,
 * white crease lines, 30-yard fielding circle, and 65 m boundary rope.
 *
 * All geometry is static with zero per-frame allocations (8 draw calls total).
 * The cannon physics ground plane lives separately in Scene.tsx.
 */
export const CricketGround: React.FC = () => {
  return (
    <group name="cricket-ground">
      {/* 65 m oval/round turf */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <circleGeometry args={[BOUNDARY_RADIUS, TURF_SEGMENTS]} />
        <meshStandardMaterial color="#3a6b35" roughness={0.92} metalness={0} />
      </mesh>

      {/* 20.12 m x 3.05 m pitch strip along z, sitting just above turf */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]} receiveShadow>
        <planeGeometry args={[PITCH_WIDTH, PITCH_LENGTH]} />
        <meshStandardMaterial color="#c8b07a" roughness={0.95} metalness={0} />
      </mesh>

      {/* White bowling and popping creases at both ends */}
      {CREASE_LINES.map((line, index) => (
        <mesh
          key={`crease-${index}`}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[line.x, 0.01, line.z]}
        >
          <planeGeometry args={[line.width, line.depth]} />
          <meshStandardMaterial color="#f5f5f5" roughness={0.6} metalness={0} />
        </mesh>
      ))}

      {/* 30-yard fielding circle */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]}>
        <ringGeometry
          args={[
            THIRTY_YARD_RADIUS - RING_HALF_WIDTH,
            THIRTY_YARD_RADIUS + RING_HALF_WIDTH,
            RING_SEGMENTS,
          ]}
        />
        <meshStandardMaterial color="#f0f0f0" roughness={0.7} metalness={0} />
      </mesh>

      {/* 65 m boundary rope */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, ROPE_TUBE_RADIUS, 0]}>
        <torusGeometry
          args={[
            BOUNDARY_RADIUS,
            ROPE_TUBE_RADIUS,
            ROPE_RADIAL_SEGMENTS,
            ROPE_TUBULAR_SEGMENTS,
          ]}
        />
        <meshStandardMaterial color="#f5f5f5" roughness={0.6} metalness={0} />
      </mesh>
    </group>
  );
};

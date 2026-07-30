import React, { useEffect, useRef, useState } from 'react';
import { useSphere } from '@react-three/cannon';
import { useFrame } from '@react-three/fiber';
import { Vector3 } from 'three';
import { GameState, DeliveryScript } from '../types';

interface BallProps {
  gameState: GameState;
  delivery: DeliveryScript;
  onHit: (velocity: Vector3, position: Vector3) => void;
  onMiss: () => void;
  resetTrigger: number;
}

export const Ball: React.FC<BallProps> = ({ gameState, delivery, onHit, onMiss, resetTrigger }) => {
  // Realistic physics radius (standard cricket ball is ~0.036m radius)
  // We use a consistent radius for ball vs stumps/bat to avoid "teleporting" collisions
  const physicsRadius = 0.05; 
  const visualRadius = 0.08;

  const [ref, api] = useSphere(() => ({
    mass: 0.16,
    position: [0, 2.2, -20],
    args: [physicsRadius],
    linearDamping: 0.05,
    angularDamping: 0.1,
    material: { friction: 0.2, restitution: 0.7 },
    onCollide: (e) => {
      if (hasHit) return; // Only process first major impact

      if (e.body.name === 'bat') {
        const ev = e as any;
        const impactSpeed = ev.impactVelocity || 12;
        const normal = ev.contactNormal || [0, 0, 1];
        
        // Calculate the return vector. Higher speed for cleaner hits.
        const velocity = new Vector3(
            normal[0] * impactSpeed * 1.5,
            Math.abs(normal[1]) * impactSpeed * 0.5 + 2, // Slight lift
            normal[2] * impactSpeed * 1.5
        );
        
        const position = new Vector3(
            ev.contactPoint[0],
            ev.contactPoint[1],
            ev.contactPoint[2]
        );
        
        setHasHit(true);
        onHit(velocity, position);
      } else if (e.body.name === 'stump') {
        setHasHit(true);
        onMiss(); // Bowled!
      } else if (!pitchedRef.current) {
        // First contact with anything else = the ball pitching on the strip
        pitchedRef.current = true;
      }
    }
  }));

  const [hasHit, setHasHit] = useState(false);
  const [bowled, setBowled] = useState(false);
  const pos = useRef(new Vector3());
  const vel = useRef(new Vector3());
  const pitchedRef = useRef(false);

  useEffect(() => {
    const unsubscribe = api.position.subscribe((v) => pos.current.set(v[0], v[1], v[2]));
    return unsubscribe;
  }, [api.position]);

  useEffect(() => {
    const unsubscribe = api.velocity.subscribe((v) => vel.current.set(v[0], v[1], v[2]));
    return unsubscribe;
  }, [api.velocity]);

  useEffect(() => {
    setHasHit(false);
    setBowled(false);
    pitchedRef.current = false;
    
    api.position.set(0, 2.2, -20);
    api.velocity.set(0, 0, 0);
    api.angularVelocity.set(0, 0, 0);

    if (gameState === GameState.BATTING) {
        const timer = setTimeout(() => {
            bowl();
        }, 1200);
        return () => clearTimeout(timer);
    }
  }, [resetTrigger, gameState, delivery]);

  const bowl = () => {
    setBowled(true);

    // Fully scripted: line, length, pace and spin come from the delivery script
    api.velocity.set(delivery.line, delivery.dip, delivery.pace);
    api.angularVelocity.set(delivery.spin[0], delivery.spin[1], delivery.spin[2]);
  };

  useFrame((_, delta) => {
    // In-flight drift (swing) — applied only before the ball pitches
    if (bowled && !hasHit && !pitchedRef.current && delivery.swing !== 0) {
      const step = delivery.swing * Math.min(delta, 0.05);
      api.velocity.set(vel.current.x + step, vel.current.y, vel.current.z);
    }

    // Check for "Beat the bat" miss
    if (bowled && !hasHit && pos.current.z > 3.0) {
        onMiss();
        setBowled(false);
    }

    if (pos.current.z > 60 || pos.current.z < -40 || Math.abs(pos.current.x) > 20 || pos.current.y < -5) {
      setBowled(false);
    }
  });

  return (
    <mesh ref={ref as any} castShadow>
      <sphereGeometry args={[visualRadius, 32, 32]} />
      <meshStandardMaterial color="#b91c1c" roughness={0.3} metalness={0.2} />
    </mesh>
  );
};

import React, { useEffect, useRef, useState } from 'react';
import { useSphere } from '@react-three/cannon';
import { useFrame } from '@react-three/fiber';
import { Vector3 } from 'three';
import { GameState, GameMode } from '../types';

interface BallProps {
  gameState: GameState;
  gameMode: GameMode;
  onHit: (velocity: Vector3, position: Vector3) => void;
  onMiss: () => void;
  resetTrigger: number;
}

export const Ball: React.FC<BallProps> = ({ gameState, gameMode, onHit, onMiss, resetTrigger }) => {
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
      }
    }
  }));

  const [hasHit, setHasHit] = useState(false);
  const [bowled, setBowled] = useState(false);
  const pos = useRef(new Vector3());

  useEffect(() => {
    const unsubscribe = api.position.subscribe((v) => pos.current.set(v[0], v[1], v[2]));
    return unsubscribe;
  }, [api.position]);

  useEffect(() => {
    setHasHit(false);
    setBowled(false);
    
    api.position.set(0, 2.2, -20);
    api.velocity.set(0, 0, 0);
    api.angularVelocity.set(0, 0, 0);

    if (gameState === GameState.BATTING) {
        const timer = setTimeout(() => {
            bowl();
        }, 1200);
        return () => clearTimeout(timer);
    }
  }, [resetTrigger, gameState]);

  const bowl = () => {
    setBowled(true);
    const isEasy = gameMode === GameMode.EASY;
    
    // Line & Length Logic: Targeting the stumps more accurately to ensure 50% hit rate
    const zSpeed = isEasy ? 14 : 22;
    const randomX = (Math.random() - 0.5) * (isEasy ? 0.3 : 0.7); 
    
    // Target bounce: We want the ball to hit the pitch before the stumps
    const lengthFactor = isEasy ? -1.4 : -2.0;
    
    api.velocity.set(randomX, lengthFactor, zSpeed); 
    
    const rotMagnitude = isEasy ? 5 : 20;
    api.angularVelocity.set(
      (Math.random() - 0.5) * rotMagnitude, 
      (Math.random() - 0.5) * rotMagnitude, 
      (Math.random() - 0.5) * rotMagnitude
    );
  };

  useFrame(() => {
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
    <mesh ref={ref} castShadow>
      <sphereGeometry args={[visualRadius, 32, 32]} />
      <meshStandardMaterial color="#b91c1c" roughness={0.3} metalness={0.2} />
    </mesh>
  );
};
import React, { useRef, useMemo, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import * as THREE from 'three';
import { createNoise3D } from 'simplex-noise';

const EMOTION_COLORS = {
  neutral: new THREE.Color('#94a3b8'), 
  angry: new THREE.Color('#ef4444'),   
  happy: new THREE.Color('#eab308'),   
  sad: new THREE.Color('#3b82f6'),     
  calm: new THREE.Color('#06b6d4'),    
  fear: new THREE.Color('#8b5cf6'),    
  disgust: new THREE.Color('#22c55e'), 
  surprise: new THREE.Color('#f97316'),
  disconnected: new THREE.Color('#334155') 
};

function CoreSphere({ emotion, stream }) {
  const meshRef = useRef();
  const noise3D = useMemo(() => createNoise3D(), []);
  const targetColor = useMemo(() => new THREE.Color(), []);
  
  const analyserRef = useRef(null);
  const dataArrayRef = useRef(null);

  // RESPONSIVE 3D SIZING: Detect viewport and scale down on mobile
  const { viewport } = useThree();
  const isMobile = viewport.width < 5; 
  const scaleFactor = isMobile ? 0.65 : 1; // 35% smaller on phones

  const geometry = useMemo(() => {
    const geo = new THREE.IcosahedronGeometry(1.75, 32); 
    geo.computeVertexNormals();
    return geo;
  }, []);

  const basePositions = useMemo(() => {
    return new Float32Array(geometry.attributes.position.array);
  }, [geometry]);

  useEffect(() => {
    if (!stream) return;
    
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);
    
    analyserRef.current = analyser;
    dataArrayRef.current = new Uint8Array(analyser.frequencyBinCount);

    return () => {
      audioCtx.close();
      analyserRef.current = null;
    };
  }, [stream]);

  useFrame((state, delta) => {
    if (!meshRef.current) return;

    const safeEmotion = emotion ? emotion.toLowerCase() : 'disconnected';
    targetColor.copy(EMOTION_COLORS[safeEmotion] || EMOTION_COLORS.neutral);
    meshRef.current.material.color.lerp(targetColor, delta * 3);

    let audioPulse = 0.05;
    if (analyserRef.current && dataArrayRef.current) {
      analyserRef.current.getByteFrequencyData(dataArrayRef.current);
      const sum = dataArrayRef.current.reduce((a, b) => a + b, 0);
      audioPulse = (sum / dataArrayRef.current.length) / 255.0; 
    }

    const positions = meshRef.current.geometry.attributes.position;
    const time = state.clock.getElapsedTime();

    for (let i = 0; i < positions.count; i++) {
      const x = basePositions[i * 3];
      const y = basePositions[i * 3 + 1];
      const z = basePositions[i * 3 + 2];
      const vertex = new THREE.Vector3(x, y, z).normalize();

      const noise = noise3D(
        vertex.x * 1.5 + time * 0.4,
        vertex.y * 1.5 + time * 0.4,
        vertex.z * 1.5
      );
      
      const displacement = 1.1 * noise * audioPulse;
      const finalRadius = 1.75 + displacement; 

      positions.setXYZ(i, vertex.x * finalRadius, vertex.y * finalRadius, vertex.z * finalRadius);
    }
    
    positions.needsUpdate = true;
  });

  return (
    <mesh ref={meshRef} geometry={geometry} scale={[scaleFactor, scaleFactor, scaleFactor]}>
      <meshBasicMaterial wireframe={true} transparent={true} opacity={0.6} />
    </mesh>
  );
}

export default function SentientCore({ emotion, stream }) {
  return (
    <div className="absolute inset-0 w-full h-full flex items-center justify-center pointer-events-none">
      <Canvas camera={{ position: [0, 0, 6], fov: 45 }}>
        <CoreSphere emotion={emotion} stream={stream} />
        <EffectComposer>
          <Bloom luminanceThreshold={0.1} luminanceSmoothing={0.9} intensity={2.5} mipmapBlur />
        </EffectComposer>
      </Canvas>
    </div>
  );
}
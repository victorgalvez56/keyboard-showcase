"use client";

import { Canvas } from "@react-three/fiber";
import {
  OrbitControls,
  Environment,
  useGLTF,
  ContactShadows,
} from "@react-three/drei";
import { Suspense, useEffect, useRef } from "react";
import * as THREE from "three";

function Keyboard() {
  const { scene } = useGLTF("/keyboard.glb");
  const ref = useRef<THREE.Group>(null);

  useEffect(() => {
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;

      const name = child.name;

      // Case (root.0) and plate (root.1) — translucent orange
      if (name === "root0" || name === "root_0" || name === "root.0" ||
          name === "root1" || name === "root_1" || name === "root.1") {
        child.material = new THREE.MeshPhysicalMaterial({
          color: new THREE.Color("#FF6B2B"),
          roughness: 0.25,
          transmission: 0.3,
          ior: 1.49,
          thickness: 0.8,
          clearcoat: 0.1,
          clearcoatRoughness: 0.3,
          envMapIntensity: 0.5,
        });
      }
      // ANTHROPIC text
      else if (name.toLowerCase().includes("text")) {
        child.material = new THREE.MeshStandardMaterial({
          color: new THREE.Color("#F0E8D0"),
          roughness: 0.4,
        });
      }
      // Keycaps — everything else
      else {
        child.material = new THREE.MeshStandardMaterial({
          color: new THREE.Color("#1a1a1a"),
          roughness: 1.0,
          metalness: 0.0,
          envMapIntensity: 0.0,
        });
      }
    });
  }, [scene]);

  return (
    <primitive
      ref={ref}
      object={scene}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.5, 0]}
      scale={2.5}
    />
  );
}

function Loader() {
  return (
    <mesh rotation={[0, 0, 0]}>
      <torusGeometry args={[0.5, 0.1, 16, 32]} />
      <meshStandardMaterial color="#FF6B2B" wireframe />
    </mesh>
  );
}

export default function Home() {
  return (
    <div className="h-screen w-screen relative" style={{ background: "#fafafa" }}>
      <Canvas
        camera={{ position: [0, 0, 5], fov: 35 }}
        gl={{
          antialias: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.0,
        }}
      >
        <color attach="background" args={["#fafafa"]} />

        <Suspense fallback={<Loader />}>
          <Keyboard />

          <ContactShadows
            position={[0, -0.5, 0]}
            opacity={0.35}
            scale={10}
            blur={2.5}
            far={2}
          />

          <Environment preset="studio" />
        </Suspense>

        <OrbitControls
          enablePan={false}
          enableZoom={false}
          minDistance={2.5}
          maxDistance={10}
          target={[0, 0.5, 0]}
          enableDamping
          dampingFactor={0.05}
        />
      </Canvas>

      {/* Title overlay */}
      <div className="absolute top-8 left-8 pointer-events-none select-none">
        <h1 className="text-3xl font-bold text-zinc-800 tracking-tight font-mono">
          ANTHROPIC
        </h1>
        <p className="text-zinc-400 text-sm mt-1">Space Invader Macro Pad</p>
      </div>

      {/* Controls hint */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-zinc-400 text-xs pointer-events-none select-none tracking-wide">
        DRAG TO ROTATE
      </div>
    </div>
  );
}

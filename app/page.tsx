"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, useGLTF, ContactShadows } from "@react-three/drei";
import { Suspense, useEffect, useRef, useCallback } from "react";
import * as THREE from "three";

function Keyboard() {
  const { scene } = useGLTF("/keyboard.glb");
  const ref = useRef<THREE.Group>(null);
  const isDragging = useRef(false);
  const previousX = useRef(0);
  const yRotation = useRef(0);
  const { gl } = useThree();

  useEffect(() => {
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;

      const name = child.name.toLowerCase();

      const isCase =
        name.includes("case") ||
        name.includes("root") ||
        name.includes("plate");
      const isAnthropicText = name === "text"; // ANTHROPIC_Text exports as "Text"
      const isLabel =
        !isAnthropicText &&
        (name.includes("text") ||
        name.includes("legend") ||
        name.includes("label"));

      if (isCase) {
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
      } else if (isAnthropicText) {
        child.material = new THREE.MeshStandardMaterial({
          color: new THREE.Color("#1a1a1a"),
          roughness: 0.5,
        });
      } else if (isLabel) {
        child.material = new THREE.MeshStandardMaterial({
          color: new THREE.Color("#F0E8D0"),
          roughness: 0.4,
        });
      } else {
        child.material = new THREE.MeshStandardMaterial({
          color: new THREE.Color("#1a1a1a"),
          roughness: 1.0,
          metalness: 0.0,
          envMapIntensity: 0.0,
        });
      }
    });
  }, [scene]);

  const onPointerDown = useCallback((e: PointerEvent) => {
    isDragging.current = true;
    previousX.current = e.clientX;
    gl.domElement.setPointerCapture(e.pointerId);
  }, [gl]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!isDragging.current) return;
    const dx = e.clientX - previousX.current;
    yRotation.current += dx * 0.005;
    previousX.current = e.clientX;
  }, []);

  const onPointerUp = useCallback((e: PointerEvent) => {
    isDragging.current = false;
    gl.domElement.releasePointerCapture(e.pointerId);
  }, [gl]);

  useEffect(() => {
    const canvas = gl.domElement;
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
    };
  }, [gl, onPointerDown, onPointerMove, onPointerUp]);

  useFrame(({ clock }) => {
    if (ref.current) {
      const t = clock.getElapsedTime();
      // Float up and down
      ref.current.position.y = -1.6 + Math.sin(t * 1.2) * 0.08;
      // Drag Y rotation
      ref.current.rotation.y = yRotation.current;
    }
  });

  return (
    <group ref={ref} position={[0, -0.5, 0]}>
      <primitive
        object={scene}
        rotation={[0, 0, 0]}
        scale={2.5}
      />
    </group>
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
        camera={{ position: [0, 0, 6.5], fov: 35 }}
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
            position={[0, -1.2, 0]}
            opacity={0.35}
            scale={10}
            blur={2.5}
            far={2}
          />

          <Environment preset="studio" />
        </Suspense>
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

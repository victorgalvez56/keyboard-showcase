"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, useGLTF, ContactShadows } from "@react-three/drei";
import { Suspense, useEffect, useRef, useCallback } from "react";
import * as THREE from "three";

// Track pressed keys and their animations
// Map keyboard keys to GLB mesh names
const KEY_TO_MESH: Record<string, string> = {
  ArrowUp: "key_arrow_up",
  ArrowDown: "key_arrow_down",
  ArrowLeft: "key_arrow_left",
  ArrowRight: "key_arrow_right",
  Enter: "key_enter",
};

interface KeyState {
  mesh: THREE.Mesh;
  label: THREE.Mesh | null;
  originalZ: number;
  labelOriginalZ: number;
  pressed: boolean;
  currentOffset: number;
}

const PRESS_DEPTH = 0.015;
const PRESS_SPEED = 12;
const RELEASE_SPEED = 8;

// Preload key click sound
let keyClickBuffer: AudioBuffer | null = null;
let audioCtx: AudioContext | null = null;

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  fetch("/keyclick.mp3")
    .then((res) => res.arrayBuffer())
    .then((buf) => audioCtx!.decodeAudioData(buf))
    .then((decoded) => {
      keyClickBuffer = decoded;
    });
}

function playKeyClick() {
  if (!audioCtx) initAudio();
  if (!audioCtx || !keyClickBuffer) return;
  if (audioCtx.state === "suspended") audioCtx.resume();
  const source = audioCtx.createBufferSource();
  source.buffer = keyClickBuffer;
  source.connect(audioCtx.destination);
  source.start();
}

function isKeycap(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith("cube.") &&
    !lower.includes("eye") &&
    !lower.includes("root") &&
    !lower.includes("plate")
  );
}

function isLabel(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("text.") ||
    lower.includes("legend")
  );
}

function Keyboard() {
  const { scene } = useGLTF("/keyboard.glb");
  const ref = useRef<THREE.Group>(null);
  const isDragging = useRef(false);
  const previousX = useRef(0);
  const yRotation = useRef(0);
  const keyStates = useRef<Map<string, KeyState>>(new Map());
  const { gl, raycaster, pointer, camera } = useThree();

  useEffect(() => {
    const keycaps: THREE.Mesh[] = [];
    const labels: THREE.Mesh[] = [];

    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;

      const name = child.name.toLowerCase();

      const isCasePart =
        name.includes("case") ||
        name.includes("root") ||
        name.includes("plate");
      const isAnthropicText = name === "text";
      const isLabelPart =
        !isAnthropicText &&
        (name.includes("text") ||
        name.includes("legend") ||
        name.includes("label"));

      if (isCasePart) {
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
        // Push ANTHROPIC text into the case (permanently recessed)
        child.position.y -= 0.12;
        child.scale.y *= 0.3;
      } else if (isLabelPart) {
        child.material = new THREE.MeshStandardMaterial({
          color: new THREE.Color("#F0E8D0"),
          roughness: 0.4,
        });
        labels.push(child);
      } else {
        child.material = new THREE.MeshStandardMaterial({
          color: new THREE.Color("#1a1a1a"),
          roughness: 1.0,
          metalness: 0.0,
          envMapIntensity: 0.0,
        });
        keycaps.push(child);
      }
    });

    // Build key states — pair keycaps with their labels by proximity
    keycaps.forEach((mesh) => {
      const box = new THREE.Box3().setFromObject(mesh);
      const center = new THREE.Vector3();
      box.getCenter(center);

      // Find closest label
      let closestLabel: THREE.Mesh | null = null;
      let closestDist = Infinity;
      labels.forEach((label) => {
        const labelBox = new THREE.Box3().setFromObject(label);
        const labelCenter = new THREE.Vector3();
        labelBox.getCenter(labelCenter);
        const dist = center.distanceTo(labelCenter);
        if (dist < closestDist) {
          closestDist = dist;
          closestLabel = label;
        }
      });

      keyStates.current.set(mesh.name, {
        mesh,
        label: closestDist < 0.5 ? closestLabel : null,
        originalZ: mesh.position.z,
        labelOriginalZ: closestLabel ? closestLabel.position.z : 0,
        pressed: false,
        currentOffset: 0,
      });
    });
  }, [scene]);

  // Handle key press via raycasting
  const onPointerDown = useCallback(
    (e: PointerEvent) => {
      // Raycast to check if we hit a keycap
      const rect = gl.domElement.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(new THREE.Vector2(x, y), camera);

      const keycapMeshes = Array.from(keyStates.current.values()).map(
        (ks) => ks.mesh
      );
      const intersects = raycaster.intersectObjects(keycapMeshes, false);

      if (intersects.length > 0) {
        const hit = intersects[0].object as THREE.Mesh;
        const state = keyStates.current.get(hit.name);
        if (state) {
          state.pressed = true;
          playKeyClick();
          e.stopPropagation();
          return;
        }
      }

      // Init audio on first interaction (browser policy)
      initAudio();

      // No keycap hit — start drag rotation
      isDragging.current = true;
      previousX.current = e.clientX;
      gl.domElement.setPointerCapture(e.pointerId);
    },
    [gl, raycaster, camera]
  );

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!isDragging.current) return;
    const dx = e.clientX - previousX.current;
    yRotation.current += dx * 0.005;
    previousX.current = e.clientX;
  }, []);

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      isDragging.current = false;
      gl.domElement.releasePointerCapture(e.pointerId);

      // Release all pressed keys
      keyStates.current.forEach((state) => {
        state.pressed = false;
      });
    },
    [gl]
  );

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

  // Keyboard events — arrow keys and Enter
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const meshName = KEY_TO_MESH[e.key];
      if (!meshName) return;
      e.preventDefault();
      initAudio();
      const state = keyStates.current.get(meshName);
      if (state && !state.pressed) {
        state.pressed = true;
        playKeyClick();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const meshName = KEY_TO_MESH[e.key];
      if (!meshName) return;
      e.preventDefault();
      const state = keyStates.current.get(meshName);
      if (state) {
        state.pressed = false;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useFrame(({ clock }, delta) => {
    if (ref.current) {
      const t = clock.getElapsedTime();
      ref.current.position.y = -1.6 + Math.sin(t * 1.2) * 0.08;
      ref.current.rotation.y = yRotation.current;
    }

    // Animate key presses
    keyStates.current.forEach((state) => {
      const target = state.pressed ? PRESS_DEPTH : 0;
      const speed = state.pressed ? PRESS_SPEED : RELEASE_SPEED;
      state.currentOffset += (target - state.currentOffset) * Math.min(speed * delta, 1);

      // Apply offset in local Z (into the case body — Blender Y maps to glTF -Z)
      state.mesh.position.z = state.originalZ - state.currentOffset;
      if (state.label) {
        state.label.position.z = state.labelOriginalZ - state.currentOffset;
      }
    });
  });

  return (
    <group ref={ref} position={[0, -0.5, 0]}>
      <primitive object={scene} rotation={[0, 0, 0]} scale={2.5} />
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
    <div
      className="h-screen w-screen relative"
      style={{ background: "#fafafa" }}
    >
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
        DRAG TO ROTATE · CLICK KEYS TO PRESS
      </div>
    </div>
  );
}

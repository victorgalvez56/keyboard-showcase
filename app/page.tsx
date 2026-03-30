"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, useGLTF, ContactShadows, Html, Line } from "@react-three/drei";
import {
  Suspense,
  useEffect,
  useRef,
  useCallback,
  useState,
  createContext,
  useContext,
} from "react";
import * as THREE from "three";

// ─── Event bus for keyboard→UI communication ───
type KeyAction =
  | "arrow_up"
  | "arrow_down"
  | "arrow_left"
  | "arrow_right"
  | "enter"
  | "reject"
  | "mic"
  | "allow_once"
  | "allow_always";

type KeyListener = (action: KeyAction) => void;
const keyListeners = new Set<KeyListener>();
function emitKeyAction(action: KeyAction) {
  keyListeners.forEach((fn) => fn(action));
}

// ─── Claude Code terminal simulation ───
interface TerminalLine {
  type: "prompt" | "thinking" | "tool" | "tool-result" | "text" | "permission" | "result";
  text: string;
  delay: number; // ms before showing this line
}

const TERMINAL_SEQUENCES: TerminalLine[][] = [
  [
    { type: "prompt", text: "> add auth middleware with rate limiting", delay: 0 },
    { type: "thinking", text: "I'll add authentication middleware with rate limiting to protect your API endpoints.", delay: 800 },
    { type: "tool", text: "Read src/middleware/index.ts", delay: 1500 },
    { type: "tool-result", text: "  12 lines | src/middleware/index.ts", delay: 2200 },
    { type: "tool", text: "Edit src/middleware/auth.ts", delay: 3000 },
    { type: "permission", text: "Allow Edit to src/middleware/auth.ts?", delay: 3800 },
  ],
  [
    { type: "result", text: "Created auth middleware with JWT validation and 100 req/min rate limit.", delay: 0 },
    { type: "tool", text: "Edit src/server.ts (+3 -1)", delay: 800 },
    { type: "permission", text: "Allow Edit to src/server.ts?", delay: 1600 },
  ],
  [
    { type: "result", text: "Wired up middleware in server.ts.", delay: 0 },
    { type: "tool", text: "Bash npm test", delay: 600 },
    { type: "permission", text: "Allow Bash: npm test?", delay: 1400 },
  ],
  [
    { type: "tool-result", text: "  PASS  src/__tests__/auth.test.ts (4 tests)", delay: 0 },
    { type: "tool-result", text: "  PASS  src/__tests__/rate-limit.test.ts (6 tests)", delay: 300 },
    { type: "text", text: "All 10 tests passing. Auth middleware is ready.", delay: 1000 },
    { type: "prompt", text: "> fix the N+1 query in dashboard loader", delay: 3000 },
    { type: "thinking", text: "Let me look at the dashboard data loader to find the N+1 query.", delay: 3800 },
    { type: "tool", text: "Read src/loaders/dashboard.ts", delay: 4500 },
    { type: "tool-result", text: "  47 lines | src/loaders/dashboard.ts", delay: 5200 },
    { type: "thinking", text: "Found it — fetching user details inside a loop. I'll batch this with a single JOIN.", delay: 5800 },
    { type: "tool", text: "Edit src/loaders/dashboard.ts (+8 -12)", delay: 6800 },
    { type: "permission", text: "Allow Edit to src/loaders/dashboard.ts?", delay: 7600 },
  ],
  [
    { type: "result", text: "Replaced N+1 with a single batched query using JOIN.", delay: 0 },
    { type: "tool", text: "Bash npm run benchmark -- --filter dashboard", delay: 800 },
    { type: "permission", text: "Allow Bash: npm run benchmark?", delay: 1600 },
  ],
  [
    { type: "tool-result", text: "  dashboard.load: 340ms → 12ms (28x faster)", delay: 0 },
    { type: "text", text: "Query optimized. Dashboard loads 28x faster now.", delay: 1000 },
    { type: "prompt", text: "> deploy to staging", delay: 3000 },
    { type: "thinking", text: "I'll run the deploy script for the staging environment.", delay: 3800 },
    { type: "tool", text: "Bash ./scripts/deploy.sh --env staging", delay: 4500 },
    { type: "permission", text: "Allow Bash: ./scripts/deploy.sh --env staging?", delay: 5300 },
  ],
  [
    { type: "tool-result", text: "  Building... done (14s)", delay: 0 },
    { type: "tool-result", text: "  Deploying to staging-api.example.com...", delay: 800 },
    { type: "tool-result", text: "  Health check passed. Deploy complete.", delay: 2000 },
    { type: "text", text: "Deployed to staging successfully. All health checks green.", delay: 3000 },
    { type: "prompt", text: "> _", delay: 5000 },
  ],
];

// Track pressed keys and their animations
// Map keyboard keys to GLB mesh names
const KEY_TO_MESH: Record<string, string> = {
  ArrowUp: "key_arrow_up",
  ArrowDown: "key_arrow_down",
  ArrowLeft: "key_arrow_left",
  ArrowRight: "key_arrow_right",
  Enter: "key_enter",
};

const MESH_TO_ACTION: Record<string, KeyAction> = {
  key_arrow_up: "arrow_up",
  key_arrow_down: "arrow_down",
  key_arrow_left: "arrow_left",
  key_arrow_right: "arrow_right",
  key_enter: "enter",
  key_reject: "reject",
  key_mic: "mic",
  key_allow_once: "allow_once",
  key_allow_always: "allow_always",
};

interface KeyState {
  mesh: THREE.Mesh;
  label: THREE.Mesh | null;
  originalZ: number;
  labelOriginalZ: number;
  pressed: boolean;
  currentOffset: number;
  glowIntensity: number;
}

const PRESS_DEPTH = 0.015;
const PRESS_SPEED = 12;
const RELEASE_SPEED = 8;
const GLOW_COLOR = new THREE.Color("#FF6B2B");
const GLOW_SPEED = 10;
const GLOW_FADE_SPEED = 5;

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

function Keyboard({ autoRotate = false, sound = true, glow = true, exploded = false, xray = false, showLabels = true, showDimensions = false, caseColor = "#FF6B2B", keycapColor = "#1a1a1a", labelColor = "#F0E8D0", pressAll = false, resetView = 0 }: { autoRotate?: boolean; sound?: boolean; glow?: boolean; exploded?: boolean; xray?: boolean; showLabels?: boolean; showDimensions?: boolean; caseColor?: string; keycapColor?: string; labelColor?: string; pressAll?: boolean; resetView?: number }) {
  const { scene } = useGLTF("/keyboard.glb");
  const ref = useRef<THREE.Group>(null);
  const isDragging = useRef(false);
  const previousX = useRef(0);
  const yRotation = useRef(0);
  const keyStates = useRef<Map<string, KeyState>>(new Map());
  const explodedParts = useRef<{ mesh: THREE.Mesh; originalPos: THREE.Vector3; direction: THREE.Vector3 }[]>([]);
  const caseMeshes = useRef<THREE.Mesh[]>([]);
  const labelMeshes = useRef<THREE.Mesh[]>([]);
  const caseMaterials = useRef<Map<THREE.Mesh, THREE.Material>>(new Map());
  const keycapMeshes = useRef<THREE.Mesh[]>([]);
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
      const isAnthropicText = name === "anthropic_text";
      const isLabelPart =
        !isAnthropicText &&
        (name.includes("text") ||
        name.includes("legend") ||
        name.includes("label"));

      if (isCasePart) {
        const mat = new THREE.MeshPhysicalMaterial({
          color: new THREE.Color("#FF6B2B"),
          roughness: 0.25,
          transmission: 0.3,
          ior: 1.49,
          thickness: 0.8,
          clearcoat: 0.1,
          clearcoatRoughness: 0.3,
          envMapIntensity: 0.5,
        });
        child.material = mat;
        caseMeshes.current.push(child);
        caseMaterials.current.set(child, mat);
      } else if (isAnthropicText) {
        child.material = new THREE.MeshStandardMaterial({
          color: new THREE.Color("#1a1a1a"),
          roughness: 0.5,
        });
      } else if (name.includes("eye")) {
        child.material = new THREE.MeshStandardMaterial({
          color: new THREE.Color("#1a1a1a"),
          roughness: 0.8,
          metalness: 0.0,
        });
      } else if (isLabelPart) {
        child.material = new THREE.MeshStandardMaterial({
          color: new THREE.Color("#F0E8D0"),
          roughness: 0.4,
        });
        labels.push(child);
        labelMeshes.current.push(child);
      } else {
        child.material = new THREE.MeshStandardMaterial({
          color: new THREE.Color("#1a1a1a"),
          roughness: 1.0,
          metalness: 0.0,
          envMapIntensity: 0.0,
        });
        keycaps.push(child);
        keycapMeshes.current.push(child);
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
        labelOriginalZ: closestLabel ? (closestLabel as THREE.Mesh).position.z : 0,
        pressed: false,
        currentOffset: 0,
        glowIntensity: 0,
      });
    });

    // Build exploded view data
    // First, build a map of keycap name → direction so labels can follow
    const allMeshes: THREE.Mesh[] = [];
    const sceneCenter = new THREE.Vector3();
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh) allMeshes.push(child);
    });
    const tempBox = new THREE.Box3();
    allMeshes.forEach((m) => {
      tempBox.setFromObject(m);
      const c = new THREE.Vector3();
      tempBox.getCenter(c);
      sceneCenter.add(c);
    });
    sceneCenter.divideScalar(allMeshes.length || 1);

    // Compute directions for keycaps first
    const keycapDirs = new Map<string, THREE.Vector3>();
    keycaps.forEach((mesh) => {
      const box2 = new THREE.Box3().setFromObject(mesh);
      const center2 = new THREE.Vector3();
      box2.getCenter(center2);
      const dir = center2.clone().sub(sceneCenter).normalize();
      keycapDirs.set(mesh.name, dir);
    });

    explodedParts.current = allMeshes.map((mesh) => {
      const box2 = new THREE.Box3().setFromObject(mesh);
      const center2 = new THREE.Vector3();
      box2.getCenter(center2);
      let dir = center2.clone().sub(sceneCenter).normalize();
      const name = mesh.name.toLowerCase();

      const isCase = name.includes("case") || name.includes("root") || name.includes("plate");
      const isLabel = name.includes("text.") || name.includes("legend") || name.includes("label_");
      const isEye = name.includes("eye");
      const isAnthropicText = name === "anthropic_text";

      if (isCase) {
        dir.multiplyScalar(0.3);
      } else if (isLabel) {
        // Find the closest keycap and use its direction
        let closestDir: THREE.Vector3 | null = null;
        let closestDist = Infinity;
        keycaps.forEach((kc) => {
          const kcBox = new THREE.Box3().setFromObject(kc);
          const kcCenter = new THREE.Vector3();
          kcBox.getCenter(kcCenter);
          const dist = center2.distanceTo(kcCenter);
          if (dist < closestDist) {
            closestDist = dist;
            closestDir = keycapDirs.get(kc.name) || null;
          }
        });
        if (closestDir) dir = (closestDir as THREE.Vector3).clone();
      } else if (isAnthropicText) {
        dir.multiplyScalar(1.5);
      } else if (isEye) {
        dir.multiplyScalar(0.6);
      }

      return {
        mesh,
        originalPos: mesh.position.clone(),
        direction: dir,
      };
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
        const intersection = intersects[0];
        const hit = intersection.object as THREE.Mesh;
        // Only allow press from the front face (normal facing camera)
        if (intersection.face) {
          const normal = intersection.face.normal.clone();
          normal.transformDirection(hit.matrixWorld);
          const dot = normal.dot(raycaster.ray.direction);
          // dot < 0 means normal faces toward camera (front face)
          if (dot >= 0) {
            // Hit from behind — ignore
          } else {
            const state = keyStates.current.get(hit.name);
            if (state) {
              state.pressed = true;
              if (sound) playKeyClick();
              const action = MESH_TO_ACTION[hit.name];
              if (action) emitKeyAction(action);
              e.stopPropagation();
              return;
            }
          }
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
        if (sound) playKeyClick();
        const action = MESH_TO_ACTION[meshName];
        if (action) emitKeyAction(action);
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

  // Press All Keys effect
  useEffect(() => {
    if (!pressAll) return;
    keyStates.current.forEach((state) => {
      state.pressed = true;
    });
    if (sound) playKeyClick();
    const t = setTimeout(() => {
      keyStates.current.forEach((state) => {
        state.pressed = false;
      });
    }, 350);
    return () => clearTimeout(t);
  }, [pressAll, sound]);

  // Reset View effect
  useEffect(() => {
    if (resetView === 0) return;
    yRotation.current = 0;
  }, [resetView]);

  useFrame(({ clock }, delta) => {
    if (ref.current) {
      const t = clock.getElapsedTime();
      ref.current.position.y = -1.6 + Math.sin(t * 1.2) * 0.08;
      if (autoRotate) yRotation.current += delta * 0.3;
      ref.current.rotation.y = yRotation.current;
    }

    // Animate key presses and glow
    keyStates.current.forEach((state) => {
      const target = state.pressed ? PRESS_DEPTH : 0;
      const speed = state.pressed ? PRESS_SPEED : RELEASE_SPEED;
      state.currentOffset += (target - state.currentOffset) * Math.min(speed * delta, 1);

      // Apply offset in local Z (into the case body — Blender Y maps to glTF -Z)
      state.mesh.position.z = state.originalZ - state.currentOffset;
      if (state.label) {
        state.label.position.z = state.labelOriginalZ - state.currentOffset;
      }

      // Glow effect
      if (glow) {
        const glowTarget = state.pressed ? 1 : 0;
        const glowSpeed = state.pressed ? GLOW_SPEED : GLOW_FADE_SPEED;
        state.glowIntensity += (glowTarget - state.glowIntensity) * Math.min(glowSpeed * delta, 1);
        const mat = state.mesh.material as THREE.MeshStandardMaterial;
        mat.emissive = new THREE.Color(caseColor);
        mat.emissiveIntensity = state.glowIntensity * 0.6;
      } else {
        const mat = state.mesh.material as THREE.MeshStandardMaterial;
        mat.emissiveIntensity = 0;
      }
    });

    // Exploded view animation
    const explodeAmount = exploded ? 0.8 : 0;
    explodedParts.current.forEach((part) => {
      const target = part.originalPos.clone().addScaledVector(part.direction, explodeAmount);
      part.mesh.position.lerp(target, 0.08);
      // Snap to original when close enough
      if (!exploded && part.mesh.position.distanceTo(part.originalPos) < 0.001) {
        part.mesh.position.copy(part.originalPos);
      }
    });

    // Zoom out camera when exploded
    const targetZ = exploded ? 13 : 7.5;
    camera.position.z += (targetZ - camera.position.z) * 0.05;

    // X-Ray — make case transparent + update case color
    const targetColor = new THREE.Color(caseColor);
    caseMeshes.current.forEach((mesh) => {
      const mat = mesh.material as THREE.MeshPhysicalMaterial;
      const targetOpacity = xray ? 0.12 : 1;
      mat.transparent = true;
      mat.opacity += (targetOpacity - mat.opacity) * 0.1;
      mat.transmission = xray ? 0.95 : 0.3;
      mat.depthWrite = !xray;
      mat.color.lerp(targetColor, 0.1);
    });

    // Labels visibility
    labelMeshes.current.forEach((mesh) => {
      mesh.visible = showLabels;
    });

    // Keycap color
    const targetKeycapColor = new THREE.Color(keycapColor);
    keycapMeshes.current.forEach((mesh) => {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.color.lerp(targetKeycapColor, 0.1);
    });

    // Label color
    const targetLabelColor = new THREE.Color(labelColor);
    labelMeshes.current.forEach((mesh) => {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.color.lerp(targetLabelColor, 0.1);
    });
  });

  // Dimensions in mm (real-world scale of the macro pad)
  const dims = { width: 190, height: 140, depth: 28 };
  // Scene-space positions at scale 2.2
  const sw = 1.9 * 2.2 / 2; // half width
  const sh = 1.4 * 2.2 / 2; // half height
  const sd = 0.28 * 2.2 / 2; // half depth

  return (
    <group ref={ref} position={[0, -0.5, 0]}>
      <primitive object={scene} rotation={[0, 0, 0]} scale={2.2} />

      {/* Dimension lines */}
      {showDimensions && (
        <group>
          {/* Width — horizontal line below */}
          <Line
            points={[[-sw, -sh - 0.3, 0], [sw, -sh - 0.3, 0]]}
            color="#FF6B2B"
            lineWidth={1.5}
          />
          <Line points={[[-sw, -sh - 0.15, 0], [-sw, -sh - 0.45, 0]]} color="#FF6B2B" lineWidth={1} />
          <Line points={[[sw, -sh - 0.15, 0], [sw, -sh - 0.45, 0]]} color="#FF6B2B" lineWidth={1} />
          <Html position={[0, -sh - 0.3, 0]} center style={{ pointerEvents: "none" }}>
            <span className="text-orange-400 text-[10px] font-mono bg-black/70 px-1.5 py-0.5 rounded whitespace-nowrap">
              {dims.width}mm
            </span>
          </Html>

          {/* Height — vertical line on right */}
          <Line
            points={[[sw + 0.3, -sh, 0], [sw + 0.3, sh, 0]]}
            color="#FF6B2B"
            lineWidth={1.5}
          />
          <Line points={[[sw + 0.15, -sh, 0], [sw + 0.45, -sh, 0]]} color="#FF6B2B" lineWidth={1} />
          <Line points={[[sw + 0.15, sh, 0], [sw + 0.45, sh, 0]]} color="#FF6B2B" lineWidth={1} />
          <Html position={[sw + 0.3, 0, 0]} center style={{ pointerEvents: "none" }}>
            <span className="text-orange-400 text-[10px] font-mono bg-black/70 px-1.5 py-0.5 rounded whitespace-nowrap">
              {dims.height}mm
            </span>
          </Html>

          {/* Depth — side line */}
          <Line
            points={[[-sw - 0.3, 0, -sd], [-sw - 0.3, 0, sd]]}
            color="#FF6B2B"
            lineWidth={1.5}
          />
          <Line points={[[-sw - 0.15, 0, -sd], [-sw - 0.45, 0, -sd]]} color="#FF6B2B" lineWidth={1} />
          <Line points={[[-sw - 0.15, 0, sd], [-sw - 0.45, 0, sd]]} color="#FF6B2B" lineWidth={1} />
          <Html position={[-sw - 0.3, 0, 0]} center style={{ pointerEvents: "none" }}>
            <span className="text-orange-400 text-[10px] font-mono bg-black/70 px-1.5 py-0.5 rounded whitespace-nowrap">
              {dims.depth}mm
            </span>
          </Html>
        </group>
      )}
    </group>
  );
}


function ResponsiveCamera() {
  const { camera, size } = useThree();
  useEffect(() => {
    // Only zoom out on small screens (mobile)
    if (size.width < 1024) {
      camera.position.z = 10;
    } else {
      camera.position.z = 7.5;
    }
  }, [camera, size.width]);
  return null;
}

function Loader() {
  return (
    <Html center>
      <div className="flex flex-col items-center gap-4 select-none">
        <div className="w-10 h-10 border-2 border-orange-400/30 border-t-orange-400 rounded-full animate-spin" />
        <div className="font-mono text-[11px] text-zinc-400 tracking-widest uppercase">
          Loading model...
        </div>
      </div>
    </Html>
  );
}

// ─── Claude Code Terminal (matches real CLI UI) ───
function ClaudeTerminal() {
  const [phase, setPhase] = useState<"welcome" | "coding">("welcome");
  const [lines, setLines] = useState<{ type: string; text: string }[]>([]);
  const [seqIndex, setSeqIndex] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; color: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<NodeJS.Timeout[]>([]);
  const feedbackTimeout = useRef<NodeJS.Timeout>(undefined);

  // Transition from welcome to coding after 3s
  useEffect(() => {
    const t = setTimeout(() => setPhase("coding"), 3500);
    return () => clearTimeout(t);
  }, []);

  const playSequence = useCallback((idx: number) => {
    const seq = TERMINAL_SEQUENCES[idx];
    if (!seq) return;
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    seq.forEach((line) => {
      const timer = setTimeout(() => {
        if (line.type === "permission") setWaiting(true);
        setLines((prev) => [...prev, { type: line.type, text: line.text }].slice(-24));
      }, line.delay);
      timersRef.current.push(timer);
    });
  }, []);

  useEffect(() => {
    if (phase === "coding") playSequence(0);
    return () => timersRef.current.forEach(clearTimeout);
  }, [phase, playSequence]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines]);

  const showFeedback = useCallback((text: string, color: string) => {
    if (feedbackTimeout.current) clearTimeout(feedbackTimeout.current);
    setFeedback({ text, color });
    feedbackTimeout.current = setTimeout(() => setFeedback(null), 1000);
  }, []);

  const handleAction = useCallback(
    (action: string) => {
      if (!waiting) return;
      let fbText = "";
      let fbColor = "";
      switch (action) {
        case "allow_once":
          fbText = "ALLOWED ONCE"; fbColor = "#22c55e"; break;
        case "allow_always":
          fbText = "ALLOWED ALWAYS"; fbColor = "#3b82f6"; break;
        case "reject":
          fbText = "REJECTED"; fbColor = "#ef4444";
          setLines((prev) => [...prev, { type: "rejected", text: "Operation rejected by user." }]);
          setWaiting(false);
          showFeedback(fbText, fbColor);
          setTimeout(() => {
            const next = (seqIndex + 2) % TERMINAL_SEQUENCES.length;
            setSeqIndex(next);
            playSequence(next);
          }, 1500);
          return;
        case "enter":
          fbText = "ALLOWED"; fbColor = "#22c55e"; break;
        default: return;
      }
      showFeedback(fbText, fbColor);
      setWaiting(false);
      const next = (seqIndex + 1) % TERMINAL_SEQUENCES.length;
      setSeqIndex(next);
      setTimeout(() => playSequence(next), 500);
    },
    [waiting, seqIndex, playSequence, showFeedback]
  );

  useEffect(() => {
    const listener: KeyListener = (action) => {
      if (["allow_once", "allow_always", "reject", "enter"].includes(action)) {
        handleAction(action);
      }
    };
    keyListeners.add(listener);
    return () => { keyListeners.delete(listener); };
  }, [handleAction]);

  // ─── Welcome screen (matches Claude Code CLI) ───
  if (phase === "welcome") {
    return (
      <div className="absolute top-6 right-6 w-[480px] pointer-events-none select-none font-mono">
        <div style={{ background: "#1a1a1a" }} className="rounded-lg overflow-hidden shadow-2xl">
          {/* Shell prompt line */}
          <div className="px-4 pt-3 text-[11px]">
            <span className="text-zinc-500">v22.20.0 ~/project git:(main) </span>
            <span className="text-zinc-600">3 files changed, 93 insertions(+), 42 deletions(-)</span>
          </div>
          <div className="px-4 pb-2 text-[13px] text-zinc-200 font-bold">claude</div>

          {/* Claude Code box with orange borders */}
          <div className="mx-3 mb-3">
            {/* Header */}
            <div className="flex items-center gap-2 text-[11px] text-zinc-500 mb-0">
              <span className="text-orange-400">──</span>
              <span className="text-zinc-300">Claude Code</span>
              <span className="text-zinc-500">v2.1.87</span>
              <span className="text-orange-400 flex-1">{'─'.repeat(30)}</span>
            </div>

            {/* Main box */}
            <div className="border border-orange-400/50 rounded-sm flex">
              {/* Left panel */}
              <div className="flex-1 p-4 text-center border-r border-orange-400/30">
                <div className="text-zinc-200 font-bold text-sm mb-3">Welcome back Victor!</div>
                {/* Pixel mascot */}
                <div className="text-orange-400 text-2xl mb-3">
                  <pre className="inline-block text-[8px] leading-[9px]">{`  ╭━━━━━╮\n ╭┃ ● ● ┃╮\n ┃┃     ┃┃\n  ╰┳━━━┳╯\n   ┃   ┃`}</pre>
                </div>
                <div className="text-zinc-400 text-[10px]">
                  Opus 4.6 (1M context) · Claude Max
                </div>
                <div className="text-zinc-500 text-[10px]">
                  victor.galvez56@gmail.com&apos;s Organization
                </div>
                <div className="text-zinc-500 text-[10px]">
                  ~/Documents/me/keyboard-showcase
                </div>
              </div>

              {/* Right panel */}
              <div className="flex-1 p-4">
                <div className="text-orange-400 font-bold text-[11px] mb-1">Tips for getting started</div>
                <div className="text-zinc-400 text-[10px] mb-3">
                  Use the macro pad to approve or reject actions
                </div>
                <div className="border-t border-zinc-700 my-2" />
                <div className="text-orange-400 font-bold text-[11px] mb-1">Recent activity</div>
                <div className="text-zinc-500 text-[10px]">Starting vibecoding session...</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Coding phase ───
  const renderLine = (line: { type: string; text: string }, i: number) => {
    switch (line.type) {
      case "prompt":
        return (
          <div key={i} className="mt-3 flex gap-2">
            <span className="text-orange-400 shrink-0">❯</span>
            <span className="text-zinc-200">{line.text}</span>
          </div>
        );
      case "thinking":
        return (
          <div key={i} className="text-zinc-400 mt-1 pl-4 flex gap-2">
            <span className="text-zinc-600 shrink-0">●</span>
            <span>{line.text}</span>
          </div>
        );
      case "tool":
        return (
          <div key={i} className="flex items-center gap-2 mt-1 pl-4">
            <span className="text-orange-400 text-[10px] font-bold border border-orange-400/30 px-1.5 py-0.5 rounded shrink-0">
              {line.text.split(" ")[0]}
            </span>
            <span className="text-zinc-300 text-[11px]">{line.text.split(" ").slice(1).join(" ")}</span>
          </div>
        );
      case "tool-result":
        return (
          <div key={i} className="text-zinc-600 pl-4 text-[11px]">{line.text}</div>
        );
      case "text":
        return (
          <div key={i} className="text-zinc-300 pl-4 mt-1">{line.text}</div>
        );
      case "result":
        return (
          <div key={i} className="text-green-400 pl-4 mt-1 flex gap-2">
            <span className="shrink-0">✓</span>
            <span>{line.text}</span>
          </div>
        );
      case "rejected":
        return (
          <div key={i} className="text-red-400 pl-4 mt-1 flex gap-2">
            <span className="shrink-0">✗</span>
            <span>{line.text}</span>
          </div>
        );
      case "permission":
        return (
          <div key={i} className="mt-2 ml-4 mr-2 border border-orange-400/40 rounded-sm overflow-hidden">
            <div className="bg-orange-400/10 px-3 py-1.5 border-b border-orange-400/20 flex items-center justify-between">
              <span className="text-orange-400 text-[10px] font-bold tracking-wider">PERMISSION REQUEST</span>
              <span className={`text-[9px] ${waiting ? "text-orange-400 animate-pulse" : "text-zinc-600"}`}>
                {waiting ? "● awaiting" : ""}
              </span>
            </div>
            <div className="px-3 py-2">
              <div className="text-zinc-200 text-[11px]">{line.text}</div>
              <div className="flex gap-3 mt-2 text-[9px]">
                <span className="text-green-500 border border-green-500/30 px-1.5 py-0.5 rounded">ALLOW ONCE</span>
                <span className="text-blue-400 border border-blue-400/30 px-1.5 py-0.5 rounded">ALLOW ALWAYS</span>
                <span className="text-red-400 border border-red-400/30 px-1.5 py-0.5 rounded">REJECT</span>
                <span className="text-zinc-500 border border-zinc-600 px-1.5 py-0.5 rounded">ENTER</span>
              </div>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="absolute top-6 right-6 w-[480px] pointer-events-none select-none font-mono">
      <div style={{ background: "#1a1a1a" }} className="rounded-lg overflow-hidden shadow-2xl">
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <span className="text-orange-400 text-[11px] font-bold">Claude Code</span>
            <span className="text-zinc-600 text-[10px]">v2.1.87</span>
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-1.5 h-1.5 rounded-full ${waiting ? "bg-orange-400 animate-pulse" : "bg-green-500"}`} />
            <span className="text-zinc-600 text-[10px]">{waiting ? "awaiting input" : "running"}</span>
          </div>
        </div>

        {/* Terminal body */}
        <div
          ref={scrollRef}
          className="px-4 py-3 text-xs leading-relaxed h-[300px] overflow-y-auto"
          style={{ scrollbarWidth: "none" }}
        >
          {lines.map((line, i) => renderLine(line, i))}
          {!waiting && (
            <div className="mt-1 pl-4">
              <span className="inline-block w-1.5 h-3 bg-orange-400/70 animate-pulse" />
            </div>
          )}
        </div>

        {/* Bottom bar */}
        <div className="px-4 py-1.5 border-t border-zinc-800 flex items-center justify-between text-[9px] text-zinc-600">
          <span>~/Documents/me/keyboard-showcase</span>
          <span>macro pad connected</span>
        </div>
      </div>

      {/* Feedback toast */}
      {feedback && (
        <div
          className="mt-3 text-center font-mono text-sm font-bold tracking-wider"
          style={{ color: feedback.color }}
        >
          {feedback.text}
        </div>
      )}
    </div>
  );
}

// ─── Color presets ───
const CASE_COLORS = [
  { name: "Orange", hex: "#FF6B2B" },
  { name: "Blue", hex: "#2B7FFF" },
  { name: "Purple", hex: "#8B5CF6" },
  { name: "Red", hex: "#EF4444" },
  { name: "Green", hex: "#22C55E" },
  { name: "Pink", hex: "#EC4899" },
  { name: "Cyan", hex: "#06B6D4" },
  { name: "White", hex: "#E4E4E7" },
];

const KEYCAP_COLORS = [
  { name: "Black", hex: "#1a1a1a" },
  { name: "White", hex: "#f5f5f5" },
  { name: "Gray", hex: "#71717a" },
  { name: "Cream", hex: "#F0E8D0" },
  { name: "Navy", hex: "#1e3a5f" },
  { name: "Olive", hex: "#4a5e3a" },
];

const LABEL_COLORS = [
  { name: "Cream", hex: "#F0E8D0" },
  { name: "White", hex: "#f5f5f5" },
  { name: "Black", hex: "#1a1a1a" },
  { name: "Orange", hex: "#FF6B2B" },
  { name: "Cyan", hex: "#06B6D4" },
  { name: "Green", hex: "#22C55E" },
];

const ENV_PRESETS = ["studio", "sunset", "city", "warehouse", "forest", "apartment", "lobby", "night"] as const;

// ─── Toggle button component ───
function ToggleBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-3 py-1.5 rounded text-[11px] font-mono transition-colors ${
        active
          ? "bg-orange-400/10 text-orange-400 border border-orange-400/30"
          : "bg-zinc-900 text-zinc-500 border border-zinc-800 hover:border-zinc-700"
      }`}
    >
      <span>{label}</span>
      <span className={`w-2 h-2 rounded-full ${active ? "bg-orange-400" : "bg-zinc-700"}`} />
    </button>
  );
}

// ─── Action button component ───
function ActionBtn({ label, onClick, color = "zinc" }: { label: string; onClick: () => void; color?: string }) {
  const colors: Record<string, string> = {
    zinc: "bg-zinc-900 text-zinc-400 border-zinc-800 hover:border-zinc-600 hover:text-zinc-300",
    orange: "bg-orange-400/10 text-orange-400 border-orange-400/30 hover:bg-orange-400/20",
    red: "bg-red-400/10 text-red-400 border-red-400/30 hover:bg-red-400/20",
  };
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-2 py-1.5 rounded text-[10px] font-mono border transition-colors ${colors[color]}`}
    >
      {label}
    </button>
  );
}

export default function Home() {
  const [autoRotate, setAutoRotate] = useState(false);
  const [darkBg, setDarkBg] = useState(false);
  const [sound, setSound] = useState(true);
  const [glow, setGlow] = useState(true);
  const [exploded, setExploded] = useState(false);
  const [xray, setXray] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [showDimensions, setShowDimensions] = useState(false);
  const [caseColor, setCaseColor] = useState("#FF6B2B");
  const [keycapColor, setKeycapColor] = useState("#1a1a1a");
  const [labelColor, setLabelColor] = useState("#F0E8D0");
  const [envPreset, setEnvPreset] = useState<typeof ENV_PRESETS[number]>("studio");
  const [pressAll, setPressAll] = useState(false);
  const [resetView, setResetView] = useState(0);
  const [mobilePanel, setMobilePanel] = useState(false);

  const bgColor = darkBg ? "#111111" : "#fafafa";

  const handleReset = () => {
    setAutoRotate(false);
    setDarkBg(false);
    setSound(true);
    setGlow(true);
    setExploded(false);
    setXray(false);
    setShowLabels(true);
    setShowDimensions(false);
    setCaseColor("#FF6B2B");
    setKeycapColor("#1a1a1a");
    setLabelColor("#F0E8D0");
    setEnvPreset("studio");
    setPressAll(false);
    setResetView((v) => v + 1);
  };

  const handleRandom = () => {
    // Pick a random case color and matching dark bg preference
    const color = CASE_COLORS[Math.floor(Math.random() * CASE_COLORS.length)];
    const env = ENV_PRESETS[Math.floor(Math.random() * ENV_PRESETS.length)];
    const dark = Math.random() > 0.5;

    setCaseColor(color.hex);
    setKeycapColor(KEYCAP_COLORS[Math.floor(Math.random() * KEYCAP_COLORS.length)].hex);
    setLabelColor(LABEL_COLORS[Math.floor(Math.random() * LABEL_COLORS.length)].hex);
    setEnvPreset(env);
    setDarkBg(dark);
    setAutoRotate(Math.random() > 0.6);
    setGlow(true); // always looks good
    setSound(true);
    setShowLabels(true);
    // Only one "special" mode at a time
    const special = Math.random();
    setExploded(special < 0.25);
    setXray(special >= 0.25 && special < 0.4);
    setShowDimensions(special >= 0.4 && special < 0.5);
  };

  const handlePressAll = () => {
    setPressAll(true);
    setTimeout(() => setPressAll(false), 400);
  };

  // Shared controls content
  const controlsContent = (
    <>
      {/* Toggles */}
      <div>
        <div className="text-zinc-600 text-[10px] font-mono tracking-widest uppercase mb-2">Display</div>
        <div className="grid grid-cols-2 lg:grid-cols-1 gap-1.5">
          <ToggleBtn label="Auto Rotate" active={autoRotate} onClick={() => setAutoRotate(!autoRotate)} />
          <ToggleBtn label="Dark Background" active={darkBg} onClick={() => setDarkBg(!darkBg)} />
          <ToggleBtn label="Key Glow" active={glow} onClick={() => setGlow(!glow)} />
          <ToggleBtn label="Key Sound" active={sound} onClick={() => setSound(!sound)} />
          <ToggleBtn label="Exploded View" active={exploded} onClick={() => setExploded(!exploded)} />
          <ToggleBtn label="X-Ray" active={xray} onClick={() => setXray(!xray)} />
          <ToggleBtn label="Key Labels" active={showLabels} onClick={() => setShowLabels(!showLabels)} />
          <ToggleBtn label="Dimensions" active={showDimensions} onClick={() => setShowDimensions(!showDimensions)} />
        </div>
      </div>

      {/* Colors row */}
      <div className="grid grid-cols-3 lg:grid-cols-1 gap-3 lg:gap-4">
        <div>
          <div className="text-zinc-600 text-[10px] font-mono tracking-widest uppercase mb-2">Case</div>
          <div className="flex gap-1.5 flex-wrap">
            {CASE_COLORS.map((c) => (
              <button key={c.hex} onClick={() => setCaseColor(c.hex)}
                className={`w-5 h-5 lg:w-6 lg:h-6 rounded-full border-2 transition-transform hover:scale-110 ${caseColor === c.hex ? "border-white scale-110" : "border-zinc-700"}`}
                style={{ background: c.hex }} title={c.name} />
            ))}
          </div>
        </div>
        <div>
          <div className="text-zinc-600 text-[10px] font-mono tracking-widest uppercase mb-2">Keycap</div>
          <div className="flex gap-1.5 flex-wrap">
            {KEYCAP_COLORS.map((c) => (
              <button key={c.hex} onClick={() => setKeycapColor(c.hex)}
                className={`w-5 h-5 lg:w-6 lg:h-6 rounded-full border-2 transition-transform hover:scale-110 ${keycapColor === c.hex ? "border-white scale-110" : "border-zinc-700"}`}
                style={{ background: c.hex }} title={c.name} />
            ))}
          </div>
        </div>
        <div>
          <div className="text-zinc-600 text-[10px] font-mono tracking-widest uppercase mb-2">Label</div>
          <div className="flex gap-1.5 flex-wrap">
            {LABEL_COLORS.map((c) => (
              <button key={c.hex} onClick={() => setLabelColor(c.hex)}
                className={`w-5 h-5 lg:w-6 lg:h-6 rounded-full border-2 transition-transform hover:scale-110 ${labelColor === c.hex ? "border-white scale-110" : "border-zinc-700"}`}
                style={{ background: c.hex }} title={c.name} />
            ))}
          </div>
        </div>
      </div>

      {/* Lighting */}
      <div>
        <div className="text-zinc-600 text-[10px] font-mono tracking-widest uppercase mb-2">Lighting</div>
        <div className="flex gap-1 flex-wrap">
          {ENV_PRESETS.map((preset) => (
            <button key={preset} onClick={() => setEnvPreset(preset)}
              className={`px-2 py-1 rounded text-[9px] font-mono capitalize border transition-colors ${
                envPreset === preset ? "bg-orange-400/10 text-orange-400 border-orange-400/30" : "bg-zinc-900 text-zinc-600 border-zinc-800 hover:border-zinc-700"
              }`}>{preset}</button>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div>
        <div className="text-zinc-600 text-[10px] font-mono tracking-widest uppercase mb-2">Actions</div>
        <div className="flex gap-1.5">
          <ActionBtn label="Press All" onClick={handlePressAll} color="orange" />
          <ActionBtn label="Random" onClick={handleRandom} color="zinc" />
          <ActionBtn label="Reset View" onClick={() => setResetView((v) => v + 1)} color="zinc" />
          <ActionBtn label="Default" onClick={handleReset} color="red" />
        </div>
      </div>
    </>
  );

  return (
    <div className="w-screen flex flex-col lg:flex-row overflow-hidden" style={{ height: "100dvh" }}>
      {/* Desktop left panel */}
      <div
        className="hidden lg:flex lg:w-[340px] xl:w-[380px] shrink-0 flex-col justify-between p-8 select-none overflow-y-auto"
        style={{ background: "#0d0d0d", scrollbarWidth: "none" }}
      >
        <div className="shrink-0">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2 h-2 rounded-full" style={{ background: caseColor }} />
            <span className="text-zinc-600 text-[10px] font-mono tracking-widest uppercase">Anthropic Hardware</span>
          </div>
          <h1 className="text-3xl font-bold text-white tracking-tight font-mono leading-tight mt-3">
            SPACE<br />INVADER
          </h1>
          <p style={{ color: caseColor }} className="font-mono text-xs mt-1 tracking-wide">Macro Pad</p>
          <p className="text-zinc-500 text-[11px] mt-3 leading-relaxed max-w-[280px]">
            Nine keys. Zero code reviews. Pure vibecoding.
          </p>
        </div>

        <div className="space-y-4 my-4">{controlsContent}</div>

        <div className="flex items-center justify-between shrink-0">
          <p className="text-zinc-700 text-[10px] font-mono">Click keys or ↑↓←→ + Enter</p>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
            <span className="text-zinc-600 text-[10px] font-mono">Interactive</span>
          </div>
        </div>
      </div>

      {/* 3D canvas — top half on mobile, right side on desktop */}
      <div className="h-[50dvh] lg:h-auto flex-none lg:flex-1 relative" style={{ background: bgColor, transition: "background 0.5s" }}>
        <Canvas
          camera={{ position: [0, 0, 7.5], fov: 35 }}
          gl={{
            antialias: true,
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 1.0,
          }}
        >
          <color attach="background" args={[bgColor]} />
          <ResponsiveCamera />
          <Suspense fallback={<Loader />}>
            <Keyboard
              autoRotate={autoRotate} sound={sound} glow={glow} exploded={exploded}
              xray={xray} showLabels={showLabels} showDimensions={showDimensions}
              caseColor={caseColor} keycapColor={keycapColor} labelColor={labelColor}
              pressAll={pressAll} resetView={resetView}
            />
            <ContactShadows position={[0, -2.2, 0]} opacity={0.35} scale={10} blur={2.5} far={2} />
            <Environment preset={envPreset} />
          </Suspense>
        </Canvas>

        {/* Mobile header */}
        <div className="absolute top-3 left-4 lg:hidden pointer-events-none select-none">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full" style={{ background: caseColor }} />
            <span style={{ color: darkBg ? "#a1a1aa" : "#71717a" }} className="text-[10px] font-mono tracking-widest uppercase">Anthropic</span>
          </div>
          <h1 className="text-lg font-bold tracking-tight font-mono leading-tight mt-0.5" style={{ color: darkBg ? "#fff" : "#27272a" }}>
            SPACE INVADER
          </h1>
          <p style={{ color: caseColor }} className="font-mono text-[10px] tracking-wide">Macro Pad</p>
        </div>

        {/* Drag hint */}
        <div className={`absolute bottom-2 lg:bottom-6 left-1/2 -translate-x-1/2 text-[10px] pointer-events-none select-none tracking-widest font-mono uppercase ${darkBg ? "text-zinc-600" : "text-zinc-400"}`}>
          Drag to rotate
        </div>
      </div>

      {/* Mobile bottom panel — scrollable config */}
      <div
        className="h-[50dvh] lg:hidden overflow-y-auto p-4 select-none space-y-4"
        style={{ paddingBottom: "calc(2rem + env(safe-area-inset-bottom))", scrollbarWidth: "none", background: "#0d0d0d" }}
      >
        {controlsContent}
      </div>
    </div>
  );
}

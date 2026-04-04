"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, useGLTF, ContactShadows } from "@react-three/drei";
import { Suspense, useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";


// ─── Constants ───
const MESH_TO_ACTION: Record<string, string> = {
  key_arrow_up: "arrow_up", key_arrow_down: "arrow_down",
  key_arrow_left: "arrow_left", key_arrow_right: "arrow_right",
  key_enter: "enter", key_reject: "reject", key_mic: "mic",
  key_allow_once: "allow_once", key_allow_always: "allow_always",
};
const PRESS_DEPTH = 0.015;
const PRESS_SPEED = 12;
const RELEASE_SPEED = 8;
const GLOW_SPEED = 10;
const GLOW_FADE_SPEED = 5;
const GRAB_DISTANCE = 0.35;
const REST_POS = new THREE.Vector3(0, 0.78, -0.3);
const REST_QUAT = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.4, 0, 0));

// ─── Audio ───
let audioCtx: AudioContext | null = null;
let keyClickBuffer: AudioBuffer | null = null;
function initAudio() {
  if (audioCtx) return;
  audioCtx = new AudioContext();
  fetch("/keyclick.mp3")
    .then((r) => r.arrayBuffer())
    .then((b) => audioCtx!.decodeAudioData(b))
    .then((d) => { keyClickBuffer = d; });
}
function playClick() {
  if (!audioCtx || !keyClickBuffer) return;
  if (audioCtx.state === "suspended") audioCtx.resume();
  const s = audioCtx.createBufferSource();
  s.buffer = keyClickBuffer;
  s.connect(audioCtx.destination);
  s.start();
}

// ─── Key state ───
interface KS {
  mesh: THREE.Mesh;
  label: THREE.Mesh | null;
  origZ: number;
  labelOrigZ: number;
  pressed: boolean;
  offset: number;
  glow: number;
}

// ─── VR Keyboard — the physical object ───
function VRKeyboard() {
  const { scene } = useGLTF("/keyboard.glb");
  const ref = useRef<THREE.Group>(null);
  const { gl, raycaster, camera } = useThree();

  const keys = useRef<Map<string, KS>>(new Map());
  const caseMeshes = useRef<THREE.Mesh[]>([]);
  const keycapMeshes = useRef<THREE.Mesh[]>([]);
  const labelMeshes = useRef<THREE.Mesh[]>([]);

  // Desktop drag
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const rotTarget = useRef({ x: -0.4, y: 0 });
  const didDrag = useRef(false);

  // VR grab
  const grabHands = useRef<Map<string, { src: XRInputSource; offset: THREE.Matrix4 }>>(new Map());
  const isGrabbed = useRef(false);
  const springBack = useRef(false);
  const twoHandDist0 = useRef(0);
  const twoHandScale0 = useRef(0.11);
  const curScale = useRef(0.11);

  const SCALE = 0.11;

  // ─── Setup materials ───
  useEffect(() => {
    const caps: THREE.Mesh[] = [];
    const lbls: THREE.Mesh[] = [];
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const n = child.name.toLowerCase();
      const isCase = n.includes("case") || n.includes("root") || n.includes("plate");
      const isAntText = n === "anthropic_text";
      const isLbl = !isAntText && (n.includes("text") || n.includes("legend") || n.includes("label"));
      if (isCase) {
        child.material = new THREE.MeshStandardMaterial({ color: "#FF6B2B", roughness: 0.25, transparent: true, opacity: 0.85 });
        caseMeshes.current.push(child);
      } else if (isAntText) {
        child.material = new THREE.MeshStandardMaterial({ color: "#1a1a1a", roughness: 0.5 });
      } else if (n.includes("eye")) {
        child.material = new THREE.MeshStandardMaterial({ color: "#1a1a1a", roughness: 0.8 });
      } else if (isLbl) {
        child.material = new THREE.MeshStandardMaterial({ color: "#F0E8D0", roughness: 0.4 });
        lbls.push(child);
        labelMeshes.current.push(child);
      } else {
        child.material = new THREE.MeshStandardMaterial({ color: "#1a1a1a", roughness: 1, metalness: 0, envMapIntensity: 0 });
        caps.push(child);
        keycapMeshes.current.push(child);
      }
    });
    // Pair keycaps with labels
    caps.forEach((mesh) => {
      const c = new THREE.Vector3();
      new THREE.Box3().setFromObject(mesh).getCenter(c);
      let bestL: THREE.Mesh | null = null, bestD = Infinity;
      lbls.forEach((l) => {
        const lc = new THREE.Vector3();
        new THREE.Box3().setFromObject(l).getCenter(lc);
        const d = c.distanceTo(lc);
        if (d < bestD) { bestD = d; bestL = l; }
      });
      keys.current.set(mesh.name, {
        mesh, label: bestD < 0.5 ? bestL : null,
        origZ: mesh.position.z, labelOrigZ: bestL ? (bestL as THREE.Mesh).position.z : 0,
        pressed: false, offset: 0, glow: 0,
      });
    });
  }, [scene]);

  // ─── Press a key ───
  const pressKey = useCallback((name: string) => {
    const k = keys.current.get(name);
    if (k && !k.pressed) {
      k.pressed = true;
      playClick();
      setTimeout(() => { k.pressed = false; }, 300);
    }
  }, []);

  // ─── Desktop: drag to rotate, click to press keys, scroll to zoom ───
  useEffect(() => {
    const c = gl.domElement;
    const down = (e: PointerEvent) => {
      dragging.current = true; didDrag.current = false;
      dragStart.current = { x: e.clientX, y: e.clientY };
      c.setPointerCapture(e.pointerId);
      initAudio();
    };
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - dragStart.current.x, dy = e.clientY - dragStart.current.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag.current = true;
      if (didDrag.current) {
        rotTarget.current.y += dx * 0.005;
        rotTarget.current.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 3, rotTarget.current.x + dy * 0.005));
        dragStart.current = { x: e.clientX, y: e.clientY };
      }
    };
    const up = (e: PointerEvent) => {
      dragging.current = false;
      c.releasePointerCapture(e.pointerId);
      if (!didDrag.current) {
        const rect = c.getBoundingClientRect();
        const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
        const hits = raycaster.intersectObjects(Array.from(keys.current.values()).map((k) => k.mesh), false);
        if (hits.length > 0 && hits[0].face) {
          const norm = hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld);
          if (norm.dot(raycaster.ray.direction) < 0) pressKey(hits[0].object.name);
        }
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      camera.position.z = Math.max(0.6, Math.min(4, camera.position.z + e.deltaY * 0.002));
    };
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
    c.addEventListener("wheel", wheel, { passive: false });
    return () => { c.removeEventListener("pointerdown", down); c.removeEventListener("pointermove", move); c.removeEventListener("pointerup", up); c.removeEventListener("wheel", wheel); };
  }, [gl, raycaster, camera, pressKey]);

  // ─── Desktop: keyboard arrow keys ───
  useEffect(() => {
    const map: Record<string, string> = { ArrowUp: "key_arrow_up", ArrowDown: "key_arrow_down", ArrowLeft: "key_arrow_left", ArrowRight: "key_arrow_right", Enter: "key_enter" };
    const kd = (e: KeyboardEvent) => { const m = map[e.key]; if (m) { e.preventDefault(); pressKey(m); } };
    window.addEventListener("keydown", kd);
    return () => window.removeEventListener("keydown", kd);
  }, [pressKey]);

  // ─── VR: squeeze to grab ───
  useEffect(() => {
    const onStart = (e: XRInputSourceEvent) => {
      if (!ref.current) return;
      const src = e.inputSource;
      const h = src.handedness;
      if (h !== "left" && h !== "right") return;
      const frame = gl.xr.getFrame?.();
      const rs = gl.xr.getReferenceSpace();
      if (!frame || !rs || !src.gripSpace) return;
      const pose = frame.getPose(src.gripSpace, rs);
      if (!pose) return;
      const gp = v3FromPose(pose);
      const kp = new THREE.Vector3();
      ref.current.getWorldPosition(kp);
      if (gp.distanceTo(kp) > GRAB_DISTANCE) return;

      const gm = matFromPose(pose);
      const offset = gm.clone().invert().multiply(ref.current.matrixWorld.clone());
      grabHands.current.set(h, { src, offset });
      isGrabbed.current = true;
      springBack.current = false;
      curScale.current = ref.current.scale.x;

      // Two-hand baseline
      if (grabHands.current.size === 2) {
        const [a, b] = Array.from(grabHands.current.values());
        const pa = gripPos(frame, rs, a.src), pb = gripPos(frame, rs, b.src);
        if (pa && pb) { twoHandDist0.current = pa.distanceTo(pb); twoHandScale0.current = ref.current.scale.x; }
      }
      haptic(src, 0.4, 80);
    };
    const onEnd = (e: XRInputSourceEvent) => {
      grabHands.current.delete(e.inputSource.handedness);
      if (grabHands.current.size === 0) { isGrabbed.current = false; springBack.current = true; }
      else {
        // Recalc offset for remaining hand
        const rem = Array.from(grabHands.current.values())[0];
        const frame = gl.xr.getFrame?.();
        const rs = gl.xr.getReferenceSpace();
        if (frame && rs && rem.src.gripSpace && ref.current) {
          const p = frame.getPose(rem.src.gripSpace, rs);
          if (p) rem.offset = matFromPose(p).clone().invert().multiply(ref.current.matrixWorld.clone());
        }
      }
      haptic(e.inputSource, 0.2, 40);
    };

    const bind = () => {
      const s = gl.xr.getSession();
      if (!s) return;
      s.addEventListener("squeezestart", onStart as EventListener);
      s.addEventListener("squeezeend", onEnd as EventListener);
    };
    bind();
    gl.xr.addEventListener("sessionstart", bind);
    return () => {
      gl.xr.removeEventListener("sessionstart", bind);
      const s = gl.xr.getSession?.();
      if (s) { s.removeEventListener("squeezestart", onStart as EventListener); s.removeEventListener("squeezeend", onEnd as EventListener); }
    };
  }, [gl]);

  // ─── VR: trigger to press keys ───
  useEffect(() => {
    const onSelect = (e: XRInputSourceEvent) => {
      const frame = gl.xr.getFrame?.();
      const rs = gl.xr.getReferenceSpace();
      if (!frame || !rs) return;
      const src = e.inputSource;
      const space = src.targetRaySpace;
      const pose = frame.getPose(space, rs);
      if (!pose) return;

      const origin = v3FromPose(pose);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(quatFromPose(pose));
      const rc = new THREE.Raycaster(origin, dir, 0, 2);
      const caps = Array.from(keys.current.values()).map((k) => k.mesh);
      const hits = rc.intersectObjects(caps, false);
      if (hits.length > 0) {
        pressKey(hits[0].object.name);
        haptic(src, 0.6, 50);
      }
    };
    const bind = () => {
      const s = gl.xr.getSession();
      if (!s) return;
      s.addEventListener("select", onSelect as EventListener);
    };
    bind();
    gl.xr.addEventListener("sessionstart", bind);
    return () => {
      gl.xr.removeEventListener("sessionstart", bind);
      const s = gl.xr.getSession?.();
      if (s) s.removeEventListener("select", onSelect as EventListener);
    };
  }, [gl, pressKey]);

  // ─── Frame loop ───
  useFrame((state, delta) => {
    if (!ref.current) return;

    // VR grab tracking
    if (isGrabbed.current && grabHands.current.size > 0) {
      const frame = state.gl.xr.getFrame?.();
      const rs = state.gl.xr.getReferenceSpace();
      if (frame && rs) {
        const hands = Array.from(grabHands.current.values());
        if (hands.length === 1) {
          const p = hands[0].src.gripSpace ? frame.getPose(hands[0].src.gripSpace, rs) : null;
          if (p) {
            const tm = matFromPose(p).multiply(hands[0].offset);
            const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
            tm.decompose(pos, quat, scl);
            ref.current.position.lerp(pos, 0.5);
            ref.current.quaternion.slerp(quat, 0.5);
          }
        } else {
          const p0 = gripPos(frame, rs, hands[0].src), p1 = gripPos(frame, rs, hands[1].src);
          if (p0 && p1) {
            // Position = midpoint
            ref.current.position.lerp(p0.clone().add(p1).multiplyScalar(0.5), 0.4);
            // Scale from hand distance
            const d = p0.distanceTo(p1);
            if (twoHandDist0.current > 0.01) {
              const ts = Math.max(0.04, Math.min(0.25, twoHandScale0.current * (d / twoHandDist0.current)));
              curScale.current += (ts - curScale.current) * 0.3;
              ref.current.scale.setScalar(curScale.current);
            }
            // Rotation from hand axis
            const axis = p1.clone().sub(p0).normalize();
            const ang = Math.atan2(axis.z, axis.x);
            const tq = new THREE.Quaternion().setFromEuler(new THREE.Euler(ref.current.rotation.x, -ang + Math.PI / 2, 0));
            ref.current.quaternion.slerp(tq, 0.3);
          }
        }
      }
    }
    // Desktop rotation
    else if (!springBack.current) {
      ref.current.rotation.x += (rotTarget.current.x - ref.current.rotation.x) * 0.1;
      ref.current.rotation.y += (rotTarget.current.y - ref.current.rotation.y) * 0.1;
    }

    // Spring return
    if (springBack.current && !isGrabbed.current) {
      ref.current.position.lerp(REST_POS, 0.06);
      ref.current.quaternion.slerp(REST_QUAT, 0.06);
      curScale.current += (SCALE - curScale.current) * 0.06;
      ref.current.scale.setScalar(curScale.current);
      if (ref.current.position.distanceTo(REST_POS) < 0.002) {
        ref.current.position.copy(REST_POS);
        ref.current.quaternion.copy(REST_QUAT);
        ref.current.scale.setScalar(SCALE);
        curScale.current = SCALE;
        springBack.current = false;
        rotTarget.current = { x: REST_POS.y, y: 0 };
      }
    }

    // Key animations
    keys.current.forEach((k) => {
      const t = k.pressed ? PRESS_DEPTH : 0;
      k.offset += (t - k.offset) * Math.min((k.pressed ? PRESS_SPEED : RELEASE_SPEED) * delta, 1);
      k.mesh.position.z = k.origZ - k.offset;
      if (k.label) k.label.position.z = k.labelOrigZ - k.offset;
      const gt = k.pressed ? 1 : 0;
      k.glow += (gt - k.glow) * Math.min((k.pressed ? GLOW_SPEED : GLOW_FADE_SPEED) * delta, 1);
      const mat = k.mesh.material as THREE.MeshStandardMaterial;
      mat.emissive = new THREE.Color("#FF6B2B");
      mat.emissiveIntensity = k.glow * 0.6;
    });
  });

  return (
    <group ref={ref} position={[REST_POS.x, REST_POS.y, REST_POS.z]} rotation={[-0.4, 0, 0]}>
      <primitive object={scene} scale={SCALE} />
    </group>
  );
}

// ─── Helpers ───
function v3FromPose(p: XRPose) { return new THREE.Vector3(p.transform.position.x, p.transform.position.y, p.transform.position.z); }
function quatFromPose(p: XRPose) { const o = p.transform.orientation; return new THREE.Quaternion(o.x, o.y, o.z, o.w); }
function matFromPose(p: XRPose) { return new THREE.Matrix4().compose(v3FromPose(p), quatFromPose(p), new THREE.Vector3(1, 1, 1)); }
function gripPos(frame: XRFrame, rs: XRReferenceSpace, src: XRInputSource) {
  if (!src.gripSpace) return null;
  const p = frame.getPose(src.gripSpace, rs);
  return p ? v3FromPose(p) : null;
}
function haptic(src: XRInputSource, intensity: number, ms: number) {
  const ha = src.gamepad?.hapticActuators?.[0];
  if (ha) (ha as unknown as { pulse: (v: number, d: number) => void }).pulse(intensity, ms);
}

// ─── XR module (pre-loaded) ───
let xrModule: typeof import("@react-three/xr") | null = null;
let xrStore: ReturnType<typeof import("@react-three/xr")["createXRStore"]> | null = null;
let xrModulePromise: Promise<typeof import("@react-three/xr")> | null = null;

function ensureXRLoaded() {
  if (!xrModulePromise && typeof window !== "undefined") {
    xrModulePromise = import("@react-three/xr").then((mod) => { xrModule = mod; return mod; });
  }
  return xrModulePromise;
}

function getOrCreateStore() {
  if (!xrModule) return null;
  if (!xrStore) {
    xrStore = xrModule.createXRStore({ hand: true, controller: true });
  }
  return xrStore;
}

// Pre-load
ensureXRLoaded();

// ─── XR Wrapper (always mounted inside Canvas) ───
function XRLayer({ children, onStoreReady }: { children: React.ReactNode; onStoreReady: (store: NonNullable<typeof xrStore>) => void }) {
  const [ready, setReady] = useState(!!xrModule);

  useEffect(() => {
    if (xrModule) { setReady(true); return; }
    ensureXRLoaded()?.then(() => setReady(true));
  }, []);

  useEffect(() => {
    if (ready) {
      const store = getOrCreateStore();
      if (store) onStoreReady(store);
    }
  }, [ready, onStoreReady]);

  if (!ready || !xrModule) return <>{children}</>;
  const store = getOrCreateStore()!;
  const { XR, XROrigin } = xrModule;
  return (
    <XR store={store}>
      <XROrigin position={[0, -0.5, 0.8]} />
      {children}
    </XR>
  );
}

// ─── VR Scene ───
function VRScene() {
  return (
    <Suspense fallback={null}>
      <VRKeyboard />
      <Environment preset="warehouse" background />
      <ambientLight intensity={0.6} />
      <directionalLight position={[2, 4, 2]} intensity={1.2} />
      {/* Desk */}
      <mesh position={[0, 0.72, -0.3]} receiveShadow>
        <boxGeometry args={[1.4, 0.04, 0.9]} />
        <meshStandardMaterial color="#5c3d1e" roughness={0.7} />
      </mesh>
      {/* Desk legs */}
      {[[-0.6, 0.36, -0.7], [0.6, 0.36, -0.7], [-0.6, 0.36, 0.1], [0.6, 0.36, 0.1]].map((p, i) => (
        <mesh key={i} position={p as [number, number, number]}>
          <boxGeometry args={[0.04, 0.72, 0.04]} />
          <meshStandardMaterial color="#3d2810" roughness={0.9} />
        </mesh>
      ))}
      {/* Floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[20, 20]} />
        <meshStandardMaterial color="#333333" roughness={0.9} />
      </mesh>
      <ContactShadows position={[0, 0.01, 0]} opacity={0.4} scale={5} blur={2} far={3} />
    </Suspense>
  );
}

// ─── Page ───
export default function VRPage() {
  const [vrStarted, setVrStarted] = useState(false);
  const storeRef = useRef<NonNullable<typeof xrStore>>(null);

  const onStoreReady = useCallback((store: NonNullable<typeof xrStore>) => {
    storeRef.current = store;
  }, []);

  const enterVR = useCallback(() => {
    initAudio();
    if (storeRef.current) {
      storeRef.current.enterVR();
      setVrStarted(true);
    }
  }, []);

  return (
    <div className="w-screen relative" style={{ height: "100dvh", background: "#0a0a0a" }}>
      {/* UI Overlay */}
      <div className="absolute inset-0 z-10 pointer-events-none">
        <div className="absolute top-6 left-6 pointer-events-auto">
          <a href="/" className="text-zinc-500 hover:text-zinc-300 text-xs font-mono transition-colors">&larr; Back to showcase</a>
          <div className="flex items-center gap-2 mt-3">
            <div className="w-2 h-2 rounded-full bg-orange-400" />
            <span className="text-zinc-600 text-[10px] font-mono tracking-widest uppercase">Anthropic Hardware</span>
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight font-mono leading-tight mt-1">SPACE INVADER</h1>
          <p className="text-orange-400 font-mono text-xs mt-0.5 tracking-wide">VR Experience</p>
        </div>

        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-3 pointer-events-auto">
          {!vrStarted && (
            <button onClick={enterVR}
              className="px-8 py-4 rounded-xl font-mono text-sm font-bold tracking-wider uppercase transition-all hover:scale-105 active:scale-95"
              style={{ background: "linear-gradient(135deg, #FF6B2B 0%, #FF8F5E 100%)", boxShadow: "0 0 30px rgba(255,107,43,0.3), 0 4px 20px rgba(0,0,0,0.5)" }}>
              <span className="text-white">Enter VR</span>
              <span className="block text-orange-200/70 text-[10px] mt-0.5 font-normal normal-case tracking-normal">Put on your headset</span>
            </button>
          )}
          {vrStarted && (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-green-400 text-xs font-mono">VR session active</span>
            </div>
          )}
        </div>

        <div className="absolute bottom-8 right-6 text-right pointer-events-none">
          <div className="text-zinc-700 text-[10px] font-mono space-y-1">
            <p><span className="text-zinc-500">Drag</span> Rotate</p>
            <p><span className="text-zinc-500">Click</span> Press keys</p>
            <p><span className="text-zinc-500">Scroll</span> Zoom</p>
            <p className="border-t border-zinc-800 pt-1 mt-1"><span className="text-zinc-500">Grip</span> Grab keyboard</p>
            <p><span className="text-zinc-500">Both grips</span> Move + scale</p>
            <p><span className="text-zinc-500">Trigger</span> Press keys</p>
          </div>
        </div>
      </div>

      {/* 3D Canvas */}
      <Canvas
        camera={{ position: [0, 1.3, 1.2], fov: 50 }}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.0 }}
        style={{ position: "absolute", inset: 0 }}
      >
        <XRLayer onStoreReady={onStoreReady}>
          <VRScene />
        </XRLayer>
      </Canvas>
    </div>
  );
}

// The 3D stage that sits behind the whole UI: a holographic round table with every player seated
// around it. Avatars bounce when they talk, fall when voted out, can be clicked to vote, and the bot
// glitches into the middle of the table at the reveal. One persistent <Canvas> for all screens.
import { Float, Html, MeshDistortMaterial, Sparkles, Stars } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { ChatMsg, PublicPlayer, RoomView } from '../../shared/types';

export type StageMode = 'home' | 'lobby' | 'game' | 'reveal' | 'stats';

const COLORS = ['#7cf7c5', '#b28cff', '#ffb35c', '#5cc8ff', '#ff7eb6', '#d4f75c', '#ff8f5c', '#9aa8ff'];
const PHASE_COLOR = { lobby: '#b28cff', chat: '#7cf7c5', vote: '#ff5c7a', reveal: '#ffb35c' } as const;
const TABLE_R = 1.9;
const SEAT_R = 2.75;

// How the scene is framed per screen: space reserved for UI panels on the right (px), vertical lift
// (fraction of the visible height) and scale. Mobile stacks the UI under the stage instead.
const FRAMING: Record<StageMode, { rightPx: number; up: number; scale: number; mUp: number; mScale: number }> = {
  home: { rightPx: 520, up: -0.1, scale: 1, mUp: 0.37, mScale: 0.45 },
  lobby: { rightPx: 520, up: -0.04, scale: 0.9, mUp: 0.3, mScale: 0.45 },
  game: { rightPx: 740, up: 0.06, scale: 0.78, mUp: 0.3, mScale: 0.5 },
  reveal: { rightPx: 0, up: 0.1, scale: 0.6, mUp: 0.16, mScale: 0.42 },
  stats: { rightPx: 0, up: 0.05, scale: 1, mUp: 0.1, mScale: 0.6 },
};

export default function Stage({ view, mode, coinKey, onVote }: { view: RoomView | null; mode: StageMode; coinKey: number; onVote: (id: string) => void }) {
  return (
    <div className={`stage3d ${mode === 'stats' ? 'dim' : ''}`}>
      <Canvas dpr={[1, 1.75]} camera={{ position: [0, 4.4, 9], fov: 42 }} gl={{ antialias: true, powerPreference: 'high-performance' }}>
        <color attach="background" args={['#070912']} />
        <fog attach="fog" args={['#070912', 11, 28]} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[4, 8, 5]} intensity={1.3} />
        <pointLight position={[-6, 3, -4]} color="#b28cff" intensity={45} />
        <pointLight position={[6, 2, -2]} color="#7cf7c5" intensity={32} />
        <Stars radius={60} depth={30} count={2200} factor={3} fade speed={0.6} />
        <Sparkles count={90} scale={[16, 6, 16]} size={2.4} speed={0.3} color="#b28cff" opacity={0.6} position={[0, 2.6, 0]} />
        <Rig mode={mode}>
          <Floor />
          {view ? <TableScene view={view} coinKey={coinKey} onVote={onVote} /> : <Hero />}
        </Rig>
      </Canvas>
    </div>
  );
}

/** Frames the scene for the current screen and adds a little mouse parallax. */
function Rig({ mode, children }: { mode: StageMode; children: React.ReactNode }) {
  const g = useRef<THREE.Group>(null!);
  useFrame((s, dt) => {
    const f = FRAMING[mode];
    const wide = s.size.width > 900;
    const k = 1 - Math.exp(-dt * 3.5);
    const tx = wide ? -(s.viewport.width * Math.min(0.6, f.rightPx / s.size.width)) / 2 : 0;
    const ty = s.viewport.height * (wide ? f.up : f.mUp);
    const ts = wide ? f.scale * (s.size.width < 1250 && f.rightPx > 600 ? 0.8 : 1) : f.mScale;
    g.current.position.x = THREE.MathUtils.lerp(g.current.position.x, tx, k);
    g.current.position.y = THREE.MathUtils.lerp(g.current.position.y, ty, k);
    g.current.scale.setScalar(THREE.MathUtils.lerp(g.current.scale.x, ts, k));
    s.camera.position.x = THREE.MathUtils.lerp(s.camera.position.x, s.pointer.x * 0.6, k);
    s.camera.position.y = THREE.MathUtils.lerp(s.camera.position.y, 4.4 + s.pointer.y * 0.35, k);
    s.camera.lookAt(0, 0.9, 0);
  });
  return <group ref={g}>{children}</group>;
}

function Floor() {
  return (
    <group position={[0, -0.72, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[14, 64]} />
        <meshStandardMaterial color="#0b0e1c" roughness={0.9} metalness={0.3} />
      </mesh>
      <gridHelper args={[28, 42, '#2a2f55', '#161a33']} position={[0, 0.01, 0]} />
    </group>
  );
}

// ---------- home / stats: the masked bot ----------

function Hero() {
  const eyes = useRef<THREE.Group>(null!);
  const shell = useRef<THREE.Mesh>(null!);
  const coins = useRef<THREE.Group>(null!);
  useFrame((s, dt) => {
    eyes.current.position.x = THREE.MathUtils.lerp(eyes.current.position.x, s.pointer.x * 0.22, 0.08);
    eyes.current.position.y = THREE.MathUtils.lerp(eyes.current.position.y, s.pointer.y * 0.14, 0.08);
    const blink = Math.sin(s.clock.elapsedTime * 0.8) > 0.992 ? 0.1 : 1;
    eyes.current.scale.y = THREE.MathUtils.lerp(eyes.current.scale.y, blink, 0.4);
    shell.current.rotation.y += dt * 0.25;
    shell.current.rotation.x += dt * 0.1;
    coins.current.rotation.y -= dt * 0.6;
  });
  return (
    <group position={[0, 1.7, 0]}>
      <Float speed={2} rotationIntensity={0.35} floatIntensity={0.9}>
        <mesh>
          <sphereGeometry args={[1.25, 64, 64]} />
          <MeshDistortMaterial color="#1b1547" emissive="#3a1f8a" emissiveIntensity={0.55} roughness={0.25} metalness={0.7} distort={0.28} speed={2.2} />
        </mesh>
        <mesh position={[0, 0.1, 1.02]} scale={[1.05, 0.42, 0.5]}>
          <sphereGeometry args={[0.8, 32, 32]} />
          <meshStandardMaterial color="#05060d" roughness={0.15} metalness={0.9} />
        </mesh>
        <group ref={eyes} position={[0, 0.1, 1.36]}>
          {[-0.3, 0.3].map((x) => (
            <mesh key={x} position={[x, 0.02, 0]}>
              <sphereGeometry args={[0.1, 24, 24]} />
              <meshBasicMaterial color="#7cf7c5" toneMapped={false} />
            </mesh>
          ))}
        </group>
      </Float>
      <mesh ref={shell}>
        <icosahedronGeometry args={[2.1, 1]} />
        <meshBasicMaterial color="#b28cff" wireframe transparent opacity={0.22} />
      </mesh>
      <group ref={coins}>
        {Array.from({ length: 7 }, (_, i) => {
          const a = (i / 7) * Math.PI * 2;
          return <Coin key={i} position={[Math.cos(a) * 2.7, Math.sin(a * 2) * 0.45, Math.sin(a) * 2.7]} spin={1.5 + i * 0.2} />;
        })}
      </group>
    </group>
  );
}

function Coin({ position, spin }: { position: [number, number, number]; spin: number }) {
  const m = useRef<THREE.Mesh>(null!);
  useFrame((_, dt) => {
    m.current.rotation.y += dt * spin;
  });
  return (
    <mesh ref={m} position={position} rotation={[Math.PI / 2, 0, 0.3]}>
      <cylinderGeometry args={[0.2, 0.2, 0.05, 28]} />
      <meshStandardMaterial color="#ffc94d" emissive="#ff9d1f" emissiveIntensity={0.35} metalness={0.55} roughness={0.3} />
    </mesh>
  );
}

// ---------- the table ----------

function TableScene({ view, coinKey, onVote }: { view: RoomView; coinKey: number; onVote: (id: string) => void }) {
  const offset = useMemo(() => view.serverNow - Date.now(), [view.serverNow]);
  const n = view.players.length;
  const myIndex = Math.max(0, view.players.findIndex((p) => p.id === view.me.id));
  const reveal = view.reveal;
  const color = view.phase === 'reveal' ? (reveal?.winner === 'humans' ? '#7cf7c5' : '#ff5c7a') : PHASE_COLOR[view.phase];

  // Latest chat line per player, for speech bubbles.
  const lastMsg = useMemo(() => {
    const m = new Map<string, ChatMsg>();
    for (const msg of view.messages) if (msg.kind === 'chat' && msg.playerId) m.set(msg.playerId, msg);
    return m;
  }, [view.messages]);

  const seat = (i: number): [number, number, number] => {
    const a = ((i - myIndex) / n) * Math.PI * 2 + Math.PI / 2; // "me" sits closest to the camera
    return [Math.cos(a) * SEAT_R, 0, Math.sin(a) * SEAT_R];
  };
  const mySeat = seat(myIndex);
  const canVote = view.phase === 'vote' && view.me.alive;

  return (
    <group>
      <Table color={color} phase={view.phase} />
      {(view.phase === 'chat' || view.phase === 'vote') && <TimerRing endsAt={view.phaseEndsAt} duration={view.phaseDuration} offset={offset} color={color} />}
      {view.phase !== 'reveal' && <Hologram color={color} fast={view.phase === 'vote'} />}
      {view.players.map((p, i) => (
        <Avatar
          key={p.id}
          p={p}
          color={COLORS[i % COLORS.length]}
          seat={seat(i)}
          isMe={p.id === view.me.id}
          msg={lastMsg.get(p.id)}
          clickable={canVote && p.alive && p.id !== view.me.id}
          voted={view.myVote === p.id && view.phase === 'vote'}
          unmasked={reveal?.botId === p.id}
          caught={reveal?.botId === p.id && reveal.winner === 'humans'}
          defeated={!!reveal && reveal.winner === 'bot' && reveal.botId !== p.id}
          celebrating={!!reveal && reveal.winner === 'humans' && reveal.botId !== p.id}
          onVote={onVote}
        />
      ))}
      <CoinBurst trigger={coinKey} origin={[mySeat[0], 1.2, mySeat[2]]} />
      {reveal?.winner === 'humans' && <Confetti />}
      {reveal?.winner === 'bot' && <Confetti gold />}
      {reveal && <Sparkles count={50} scale={[2.6, 2.6, 2.6]} size={6} speed={1.6} color={reveal.winner === 'humans' ? '#ff5c7a' : '#ffc94d'} position={[0, 1.2, 0]} />}
    </group>
  );
}

function Table({ color, phase }: { color: string; phase: RoomView['phase'] }) {
  const ring = useRef<THREE.MeshBasicMaterial>(null!);
  useFrame((s) => {
    const pulse = phase === 'vote' ? 0.6 + 0.4 * Math.sin(s.clock.elapsedTime * 6) : 0.75 + 0.25 * Math.sin(s.clock.elapsedTime * 1.5);
    ring.current.opacity = pulse;
  });
  return (
    <group>
      <mesh position={[0, 0, 0]}>
        <cylinderGeometry args={[TABLE_R, TABLE_R * 0.92, 0.16, 64]} />
        <meshStandardMaterial color="#12162b" roughness={0.25} metalness={0.85} />
      </mesh>
      <mesh position={[0, -0.4, 0]}>
        <cylinderGeometry args={[0.35, 0.7, 0.65, 32]} />
        <meshStandardMaterial color="#0d1022" roughness={0.4} metalness={0.8} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.07, 0]}>
        <torusGeometry args={[TABLE_R, 0.035, 12, 96]} />
        <meshBasicMaterial ref={ring} color={color} toneMapped={false} transparent />
      </mesh>
      <pointLight position={[0, 1.2, 0]} color={color} intensity={14} distance={7} />
    </group>
  );
}

function TimerRing({ endsAt, duration, offset, color }: { endsAt: number; duration: number; offset: number; color: string }) {
  const STEPS = 72;
  const [step, setStep] = useState(STEPS);
  useFrame(() => {
    const left = Math.max(0, endsAt - (Date.now() + offset));
    const s = duration > 0 ? Math.round(STEPS * Math.min(1, left / (duration * 1000))) : 0;
    if (s !== step) setStep(s);
  });
  if (step <= 0) return null;
  return (
    <mesh rotation={[-Math.PI / 2, 0, Math.PI / 2]} position={[0, 0.09, 0]}>
      <ringGeometry args={[1.5, 1.66, 96, 1, 0, (step / STEPS) * Math.PI * 2]} />
      <meshBasicMaterial color={color} toneMapped={false} transparent opacity={0.85} side={THREE.DoubleSide} />
    </mesh>
  );
}

function Hologram({ color, fast }: { color: string; fast: boolean }) {
  const m = useRef<THREE.Group>(null!);
  useFrame((s, dt) => {
    m.current.rotation.y += dt * (fast ? 2.6 : 0.7);
    m.current.position.y = 1.05 + Math.sin(s.clock.elapsedTime * 1.4) * 0.08;
    m.current.scale.setScalar(fast ? 1 + 0.12 * Math.sin(s.clock.elapsedTime * 8) : 1);
  });
  return (
    <group ref={m} position={[0, 1.05, 0]}>
      <mesh>
        <octahedronGeometry args={[0.42, 0]} />
        <meshBasicMaterial color={color} wireframe toneMapped={false} />
      </mesh>
      <mesh>
        <octahedronGeometry args={[0.2, 0]} />
        <meshBasicMaterial color={color} toneMapped={false} transparent opacity={0.7} />
      </mesh>
    </group>
  );
}

// ---------- players ----------

interface AvatarProps {
  p: PublicPlayer;
  color: string;
  seat: [number, number, number];
  isMe: boolean;
  msg?: ChatMsg;
  clickable: boolean;
  voted: boolean;
  unmasked: boolean; // this player is the bot and the game is over
  caught: boolean; // the unmasked bot lost: dumped on the table, sparking and powering down
  defeated: boolean; // a human at a table the bot just beat: slumps in their seat
  celebrating: boolean;
  onVote: (id: string) => void;
}

function Avatar({ p, color, seat, isMe, msg, clickable, voted, unmasked, caught, defeated, celebrating, onVote }: AvatarProps) {
  const root = useRef<THREE.Group>(null!);
  const inner = useRef<THREE.Group>(null!);
  const eyes = useRef<THREE.Group>(null!);
  const bounce = useRef(0);
  const [hover, setHover] = useState(false);
  const [bubble, setBubble] = useState<string | null>(null);
  const phase = useMemo(() => Math.random() * 10, []);
  const ghost = !p.alive && !unmasked; // a human who was voted out

  // New chat line -> hop + speech bubble for a few seconds.
  useEffect(() => {
    if (!msg || Date.now() - msg.ts > 15_000) return;
    bounce.current = 1;
    setBubble(msg.text);
    const t = setTimeout(() => setBubble(null), 4500);
    return () => clearTimeout(t);
  }, [msg?.id]);

  useEffect(() => {
    document.body.style.cursor = hover && clickable ? 'pointer' : '';
    return () => {
      document.body.style.cursor = '';
    };
  }, [hover, clickable]);

  useFrame((s, dt) => {
    const k = 1 - Math.exp(-dt * 4);
    const t = s.clock.elapsedTime + phase;
    // A winning bot towers over the table; a caught one is dumped on top of it.
    const target = unmasked ? [0, caught ? 0.5 : 0.95, 0] : seat;
    root.current.position.x = THREE.MathUtils.lerp(root.current.position.x, target[0], k);
    root.current.position.y = THREE.MathUtils.lerp(root.current.position.y, target[1], k);
    root.current.position.z = THREE.MathUtils.lerp(root.current.position.z, target[2], k);
    // Humans face the middle of the table. The winning bot spins in triumph; the caught one twitches.
    const face = Math.atan2(-seat[0], -seat[2]);
    if (!unmasked) root.current.rotation.y = THREE.MathUtils.lerp(root.current.rotation.y, face, k);
    else if (caught) root.current.rotation.y = Math.sin(t * 2.5) * 0.6;
    else root.current.rotation.y += dt * 2.2;
    const scale = unmasked ? (caught ? 1.3 : 1.55) : hover && clickable ? 1.12 : 1;
    root.current.scale.setScalar(THREE.MathUtils.lerp(root.current.scale.x, scale, k));

    bounce.current = Math.max(0, bounce.current - dt * 1.6);
    const hop = Math.abs(Math.sin(bounce.current * Math.PI * 2)) * bounce.current * 0.45;
    const party = celebrating && p.alive ? Math.abs(Math.sin(t * 5)) * 0.3 : 0;
    const idle = Math.sin(t * 1.6) * 0.035;
    inner.current.position.y = THREE.MathUtils.lerp(inner.current.position.y, ghost ? -0.42 : idle + hop + party - (defeated ? 0.1 : 0), ghost ? k : 1);
    inner.current.rotation.z = THREE.MathUtils.lerp(inner.current.rotation.z, ghost ? 1.35 : caught ? 0.55 : 0, k) + (caught ? Math.sin(t * 26) * 0.02 : 0);
    inner.current.rotation.x = THREE.MathUtils.lerp(inner.current.rotation.x, defeated && !ghost ? 0.55 : 0, k); // slump
    inner.current.position.x = unmasked ? (Math.random() - 0.5) * (caught ? 0.1 : 0.04) : 0; // glitch jitter
    eyes.current.scale.y = Math.sin(t * 0.9) > 0.985 ? 0.1 : 1;
    eyes.current.visible = caught ? Math.sin(t * 31) > -0.25 : true; // power flicker
  });

  const body = ghost ? '#3b4058' : defeated ? '#6d7290' : color;
  const eye = unmasked ? '#ff3355' : ghost ? '#59607d' : '#eafff7';
  return (
    <group ref={root} position={seat}>
      <group
        ref={inner}
        onClick={(e) => {
          if (!clickable) return;
          e.stopPropagation();
          onVote(p.id);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
        }}
        onPointerOut={() => setHover(false)}
      >
        <mesh position={[0, 0.02, 0]}>
          <capsuleGeometry args={[0.3, 0.42, 8, 20]} />
          <meshStandardMaterial color={unmasked ? '#2a0a14' : body} roughness={0.35} metalness={0.25} transparent opacity={ghost ? 0.4 : 1} emissive={unmasked ? '#ff1f4b' : body} emissiveIntensity={unmasked ? 0.9 : ghost ? 0 : 0.12} />
        </mesh>
        <mesh position={[0, 0.78, 0]}>
          <sphereGeometry args={[0.31, 28, 28]} />
          <meshStandardMaterial color={unmasked ? '#2a0a14' : body} roughness={0.3} metalness={0.25} transparent opacity={ghost ? 0.4 : 1} emissive={unmasked ? '#ff1f4b' : body} emissiveIntensity={unmasked ? 0.9 : ghost ? 0 : 0.12} />
        </mesh>
        {/* visor + eyes */}
        <mesh position={[0, 0.8, 0.2]} scale={[1, 0.5, 0.6]}>
          <sphereGeometry args={[0.25, 24, 24]} />
          <meshStandardMaterial color="#070912" roughness={0.15} metalness={0.9} transparent opacity={ghost ? 0.5 : 1} />
        </mesh>
        <group ref={eyes} position={[0, 0.81, 0.345]}>
          {[-0.085, 0.085].map((x) => (
            <mesh key={x} position={[x, 0, 0]}>
              <sphereGeometry args={[0.038, 12, 12]} />
              <meshBasicMaterial color={eye} toneMapped={false} />
            </mesh>
          ))}
        </group>
        {unmasked && (
          <mesh position={[0, 0.4, 0]}>
            <icosahedronGeometry args={[0.85, 1]} />
            <meshBasicMaterial color={caught ? '#7cf7c5' : '#ff3355'} wireframe transparent opacity={0.45} toneMapped={false} />
          </mesh>
        )}
        {(voted || (hover && clickable)) && <Reticle solid={voted} />}
      </group>
      {isMe && p.alive && !unmasked && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.68, 0]}>
          <ringGeometry args={[0.42, 0.5, 40]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.55} toneMapped={false} />
        </mesh>
      )}
      <Html center position={[0, unmasked ? 1.5 : 1.38, 0]} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <div className={`tag3d ${isMe ? 'me' : ''} ${ghost ? 'dead' : ''} ${unmasked ? 'botTag' : ''}`}>
          {unmasked ? `🤖 ${p.name}` : p.name}
          {isMe && !unmasked && <i> you</i>}
        </div>
        {bubble && !ghost && !unmasked && <div className="bubble3d">{bubble}</div>}
      </Html>
    </group>
  );
}

function Reticle({ solid }: { solid: boolean }) {
  const m = useRef<THREE.Mesh>(null!);
  useFrame((_, dt) => {
    m.current.rotation.z += dt * 2.5;
  });
  return (
    <mesh ref={m} rotation={[Math.PI / 2, 0, 0]} position={[0, 0.78, 0]}>
      <torusGeometry args={[0.5, 0.025, 8, 6]} />
      <meshBasicMaterial color="#ff5c7a" toneMapped={false} transparent opacity={solid ? 1 : 0.55} />
    </mesh>
  );
}

const CONFETTI = ['#7cf7c5', '#b28cff', '#ffc94d', '#5cc8ff', '#ff7eb6', '#ffffff'];

/** Endless confetti when the humans win; a rain of gold coins onto the bot when it wins. */
function Confetti({ gold }: { gold?: boolean }) {
  const N = gold ? 46 : 110;
  const g = useRef<THREE.Group>(null!);
  const parts = useMemo(
    () =>
      Array.from({ length: N }, (_, i) => ({
        x: (Math.random() - 0.5) * (gold ? 3.2 : 9),
        z: (Math.random() - 0.5) * (gold ? 3.2 : 9),
        y: Math.random() * 7,
        v: 1 + Math.random() * 1.8,
        spin: 2 + Math.random() * 6,
        color: CONFETTI[i % CONFETTI.length],
      })),
    [N, gold],
  );
  useFrame((s, dt) => {
    g.current.children.forEach((c, i) => {
      const p = parts[i];
      p.y -= p.v * dt;
      if (p.y < -0.6) p.y = 6.5;
      c.position.set(p.x + Math.sin(s.clock.elapsedTime * 1.3 + i) * 0.15, p.y, p.z);
      c.rotation.x += dt * p.spin;
      c.rotation.z += dt * p.spin * 0.6;
    });
  });
  return (
    <group ref={g}>
      {parts.map((p, i) =>
        gold ? (
          <mesh key={i}>
            <cylinderGeometry args={[0.1, 0.1, 0.03, 16]} />
            <meshStandardMaterial color="#ffc94d" emissive="#ff9d1f" emissiveIntensity={0.5} metalness={0.55} roughness={0.3} />
          </mesh>
        ) : (
          <mesh key={i}>
            <planeGeometry args={[0.12, 0.2]} />
            <meshBasicMaterial color={p.color} side={THREE.DoubleSide} toneMapped={false} />
          </mesh>
        ),
      )}
    </group>
  );
}

/** Gold coins that erupt over your avatar when a bribe or bounty lands in your wallet. */
function CoinBurst({ trigger, origin }: { trigger: number; origin: [number, number, number] }) {
  const N = 18;
  const group = useRef<THREE.Group>(null!);
  const start = useRef(-1);
  const parts = useMemo(
    () => Array.from({ length: N }, () => ({ vx: (Math.random() - 0.5) * 3, vy: 3 + Math.random() * 3, vz: (Math.random() - 0.5) * 3, spin: 4 + Math.random() * 8 })),
    [trigger],
  );
  useEffect(() => {
    if (trigger > 0) start.current = performance.now();
  }, [trigger]);
  useFrame(() => {
    const t = start.current < 0 ? 99 : (performance.now() - start.current) / 1000;
    group.current.visible = t < 2.4;
    if (!group.current.visible) return;
    group.current.children.forEach((c, i) => {
      const p = parts[i];
      c.position.set(origin[0] + p.vx * t, origin[1] + p.vy * t - 4.9 * t * t, origin[2] + p.vz * t);
      c.rotation.set(t * p.spin, t * p.spin * 0.7, 0);
    });
  });
  return (
    <group ref={group} visible={false}>
      {parts.map((_, i) => (
        <mesh key={i}>
          <cylinderGeometry args={[0.11, 0.11, 0.03, 20]} />
          <meshStandardMaterial color="#ffc94d" emissive="#ff9d1f" emissiveIntensity={0.5} metalness={0.55} roughness={0.3} />
        </mesh>
      ))}
    </group>
  );
}

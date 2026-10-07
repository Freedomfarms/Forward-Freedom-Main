import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import * as THREE from "three";
import {
  FIELD_ANCHORS,
  FIELD_LINKS,
  FIELD_STRATA,
  GLASS_PANELS,
  PRESENCE_ORIGIN,
  createAtmospherePositions,
  createAtmosphereSeeds,
  placeEntity,
} from "./chiefWorldField.js";
import { phaseWeights } from "./chiefWorldPhase.js";

const VOID = "#05060a";
const ATMOSPHERE_COUNT = 72;
const ENTITY_POOL = 4;

const GROUND_VERTEX = `
  varying vec3 vPos;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPos = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const GROUND_FRAGMENT = `
  precision highp float;
  varying vec3 vPos;
  uniform float uEnergy;
  void main() {
    float dist = length(vPos.xz);
    float fade = smoothstep(16.0, 1.6, dist);
    float gx = abs(fract(vPos.x * 0.42) - 0.5);
    float gz = abs(fract(vPos.z * 0.42) - 0.5);
    float line = 1.0 - smoothstep(0.0, 0.016, min(gx, gz));
    float horizon = smoothstep(0.4, 7.0, -vPos.z);
    float wash = exp(-pow(vPos.x * 0.16, 2.0)) * horizon * (0.03 + uEnergy * 0.055);
    vec3 color = mix(vec3(0.74, 0.72, 0.78), vec3(0.58, 0.5, 0.74), uEnergy);
    float alpha = line * fade * 0.065 + wash;
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

const SHAFT_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SHAFT_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform float uPresence;
  uniform float uTime;
  void main() {
    float x = (vUv.x - 0.5) * 2.0;
    float y = (vUv.y - 0.5) * 2.0;
    float breathe = 0.94 + 0.06 * sin(uTime * 0.55);
    float pinch = 8.2 - uPresence * 1.4;
    float column = exp(-pow(x * pinch, 2.0));
    float vertical = smoothstep(-1.08, -0.2, y) * (1.0 - smoothstep(0.62, 1.18, y));
    float core = exp(-pow(x * 24.0, 2.0)) * smoothstep(-0.15, 0.45, y) * (1.0 - smoothstep(0.82, 1.15, y));
    float alpha = (column * 0.2 + core * 0.62) * vertical * breathe * (0.35 + uPresence * 0.65);
    vec3 cool = vec3(0.82, 0.8, 0.86);
    vec3 violet = vec3(0.62, 0.52, 0.8);
    vec3 hot = vec3(0.97, 0.95, 0.92);
    vec3 color = mix(cool, violet, uPresence * 0.72);
    color = mix(color, hot, core);
    gl_FragColor = vec4(color, alpha);
  }
`;

const DUST_VERTEX = `
  attribute float aSeed;
  uniform float uTime;
  uniform float uDrift;
  uniform float uDpr;
  varying float vFade;
  void main() {
    vec3 pos = position;
    pos.y += sin(uTime * 0.13 + aSeed) * 0.07 * uDrift;
    pos.x += cos(uTime * 0.07 + aSeed) * 0.045 * uDrift;
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    float depth = clamp((-mv.z - 2.0) / 12.0, 0.0, 1.0);
    vFade = 1.0 - depth;
    gl_PointSize = uDpr * 2.15 * vFade * (8.0 / max(-mv.z, 0.001));
  }
`;

const DUST_FRAGMENT = `
  precision highp float;
  varying float vFade;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float alpha = smoothstep(0.5, 0.08, d) * 0.42 * vFade;
    gl_FragColor = vec4(vec3(0.9, 0.88, 0.94), alpha);
  }
`;

function damp(current, target, lambda, dt) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

function pointOn(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function WorldRig({ phaseRef, entitiesRef, levelRef, motionRef, parallaxRef }) {
  const rig = useRef(null);
  const panels = useRef([]);
  const filament = useRef(null);
  const strata = useRef(null);
  const shaft = useRef(null);
  const ground = useRef(null);
  const dust = useRef(null);
  const courier = useRef(null);
  const courierMaterial = useRef(null);
  const linkMaterial = useRef(null);
  const linkGeom = useRef(null);
  const entityGroups = useRef([]);
  const weights = useRef({ idle: 1, listen: 0, think: 0, work: 0, respond: 0 });
  const clock = useRef(0);

  const dustPositions = useMemo(() => createAtmospherePositions(ATMOSPHERE_COUNT), []);
  const dustSeeds = useMemo(() => createAtmosphereSeeds(ATMOSPHERE_COUNT), []);
  const strataPositions = useMemo(() => {
    const positions = new Float32Array(FIELD_STRATA.length * 6);
    FIELD_STRATA.forEach((line, index) => {
      const offset = index * 6;
      positions[offset] = -line.width / 2;
      positions[offset + 1] = line.y;
      positions[offset + 2] = line.z;
      positions[offset + 3] = line.width / 2;
      positions[offset + 4] = line.y;
      positions[offset + 5] = line.z;
    });
    return positions;
  }, []);
  const linkPositions = useMemo(() => {
    const positions = new Float32Array(ENTITY_POOL * 6);
    for (let index = 0; index < ENTITY_POOL; index += 1) {
      positions[index * 6 + 1] = -10;
      positions[index * 6 + 4] = -10;
    }
    return positions;
  }, []);
  const filamentPositions = useMemo(() => {
    const positions = new Float32Array(FIELD_LINKS.length * 6);
    FIELD_LINKS.forEach(([from, to], index) => {
      const start = FIELD_ANCHORS[from];
      const end = FIELD_ANCHORS[to];
      const offset = index * 6;
      positions[offset] = start[0];
      positions[offset + 1] = start[1];
      positions[offset + 2] = start[2];
      positions[offset + 3] = end[0];
      positions[offset + 4] = end[1];
      positions[offset + 5] = end[2];
    });
    return positions;
  }, []);

  useFrame((state, dt) => {
    const step = Math.min(dt, 0.05);
    const motion = motionRef.current;
    const moving = motion !== "off";
    if (moving) clock.current += step * (motion === "low" ? 0.45 : 1);
    const time = clock.current;
    const target = phaseWeights(phaseRef.current);
    const current = weights.current;
    const pace = moving ? 2.4 : 18;
    current.idle = damp(current.idle, target.idle, pace, step);
    current.listen = damp(current.listen, target.listen, pace, step);
    current.think = damp(current.think, target.think, pace, step);
    current.work = damp(current.work, target.work, pace, step);
    current.respond = damp(current.respond, target.respond, pace, step);

    const level = listeningLevel(levelRef);
    const presence =
      current.idle * 0.28 +
      current.listen * (0.92 + level * 0.18) +
      current.think * 0.6 +
      current.work * 0.72 +
      current.respond * 0.16;
    const energy =
      current.idle * 0.12 +
      current.listen * 0.7 +
      current.think * 0.42 +
      current.work * 0.5 +
      current.respond * 0.08;
    const filaments =
      current.idle * 0.045 +
      current.listen * 0.14 +
      current.think * 0.5 +
      current.work * 0.32 +
      current.respond * 0.035;

    if (shaft.current) {
      shaft.current.uniforms.uPresence.value = presence;
      shaft.current.uniforms.uTime.value = moving ? time : 0;
    }
    if (ground.current) ground.current.uniforms.uEnergy.value = energy;
    if (dust.current) {
      dust.current.uniforms.uTime.value = moving ? time : 0;
      dust.current.uniforms.uDrift.value = motion === "off" ? 0 : motion === "low" ? 0.35 : 1;
    }
    if (filament.current) filament.current.opacity = filaments;
    if (strata.current)
      strata.current.opacity = 0.08 + current.listen * 0.05 + current.think * 0.04;

    const parallax = parallaxRef.current;
    const sway = current.respond > 0.5 ? 0.25 : 1;
    const drift = moving ? Math.sin(time * 0.12) * (motion === "low" ? 0.012 : 0.028) : 0;
    if (rig.current) {
      rig.current.rotation.y = damp(
        rig.current.rotation.y,
        parallax.x * 0.045 * sway + drift,
        1.6,
        step
      );
      rig.current.rotation.x = damp(rig.current.rotation.x, parallax.y * -0.02 * sway, 1.6, step);
      rig.current.position.y = damp(rig.current.position.y, drift * 0.8, 1.2, step);
    }

    const breathe = moving ? Math.sin(time * 0.2) * (motion === "low" ? 0.004 : 0.012) : 0;
    GLASS_PANELS.forEach((panel, index) => {
      const group = panels.current[index];
      if (!group) return;
      const gather = current.listen * 0.08 + current.think * 0.35;
      group.position.x = damp(
        group.position.x,
        panel.position[0] + panel.shift[0] * gather,
        1.5,
        step
      );
      group.position.y = damp(
        group.position.y,
        panel.position[1] + panel.shift[1] * gather + breathe,
        1.5,
        step
      );
      group.position.z = damp(
        group.position.z,
        panel.position[2] + panel.shift[2] * current.think,
        1.5,
        step
      );
      group.rotation.y = damp(
        group.rotation.y,
        panel.rotation[1] * (1 - current.listen * 0.35),
        1.4,
        step
      );
    });

    const entities = Array.isArray(entitiesRef.current) ? entitiesRef.current : [];
    const positions = linkGeom.current?.getAttribute("position");
    let primary = null;
    for (let index = 0; index < ENTITY_POOL; index += 1) {
      const placed = index < entities.length ? placeEntity(entities[index]) : null;
      const group = entityGroups.current[index];
      const visible = Boolean(placed) && current.work > 0.08;
      if (group) {
        group.visible = visible;
        if (placed) group.position.set(placed[0], placed[1], placed[2]);
        const bar = group.children[0];
        if (bar?.material) bar.material.opacity = Math.min(0.9, current.work);
      }
      if (positions) {
        if (visible && placed) {
          positions.setXYZ(index * 2, PRESENCE_ORIGIN[0], PRESENCE_ORIGIN[1], PRESENCE_ORIGIN[2]);
          positions.setXYZ(index * 2 + 1, placed[0], placed[1] + 0.18, placed[2]);
          if (!primary) primary = placed;
        } else {
          positions.setXYZ(index * 2, 0, -10, 0);
          positions.setXYZ(index * 2 + 1, 0, -10, 0);
        }
      }
    }
    if (positions) positions.needsUpdate = true;
    if (linkMaterial.current) linkMaterial.current.opacity = current.work * 0.55;

    if (courier.current && courierMaterial.current) {
      const travel = moving ? (time * (current.work > current.think ? 0.28 : 0.18)) % 1 : 0.5;
      let from = FIELD_ANCHORS[1];
      let to = FIELD_ANCHORS[4];
      if (current.work > current.think && primary) {
        from = PRESENCE_ORIGIN;
        to = [primary[0], primary[1] + 0.18, primary[2]];
      } else if (current.think > 0.2) {
        const link = FIELD_LINKS[Math.floor(time * 0.15) % FIELD_LINKS.length];
        from = FIELD_ANCHORS[link[0]];
        to = FIELD_ANCHORS[link[1]];
      }
      const at = pointOn(from, to, travel);
      courier.current.position.set(at[0], at[1], at[2]);
      courier.current.lookAt(to[0], to[1], to[2]);
      const signal = Math.max(current.think, current.work);
      courier.current.visible = moving && signal > 0.2;
      courierMaterial.current.opacity = signal * 0.9;
    }
  });

  return (
    <group ref={rig}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, -2]}>
        <planeGeometry args={[40, 40, 1, 1]} />
        <shaderMaterial
          ref={ground}
          transparent
          depthWrite={false}
          toneMapped={false}
          uniforms={{ uEnergy: { value: 0.12 } }}
          vertexShader={GROUND_VERTEX}
          fragmentShader={GROUND_FRAGMENT}
        />
      </mesh>

      <mesh position={[PRESENCE_ORIGIN[0], 1.05, PRESENCE_ORIGIN[2]]}>
        <planeGeometry args={[0.55, 3.5]} />
        <shaderMaterial
          ref={shaft}
          transparent
          depthWrite={false}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
          uniforms={{
            uPresence: { value: 0.28 },
            uTime: { value: 0 },
          }}
          vertexShader={SHAFT_VERTEX}
          fragmentShader={SHAFT_FRAGMENT}
        />
      </mesh>

      {GLASS_PANELS.map((panel, index) => (
        <GlassPanel
          key={panel.position.join(":")}
          panel={panel}
          register={(node) => {
            panels.current[index] = node;
          }}
        />
      ))}

      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[filamentPositions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial
          ref={filament}
          transparent
          depthWrite={false}
          color="#d9d3e4"
          opacity={0.045}
        />
      </lineSegments>

      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[strataPositions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial
          ref={strata}
          transparent
          depthWrite={false}
          color="#cfc8dc"
          opacity={0.08}
        />
      </lineSegments>

      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[dustPositions, 3]} />
          <bufferAttribute attach="attributes-aSeed" args={[dustSeeds, 1]} />
        </bufferGeometry>
        <shaderMaterial
          ref={dust}
          transparent
          depthWrite={false}
          toneMapped={false}
          blending={THREE.AdditiveBlending}
          uniforms={{
            uTime: { value: 0 },
            uDrift: { value: 1 },
            uDpr: {
              value: Math.min(
                1.5,
                typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1
              ),
            },
          }}
          vertexShader={DUST_VERTEX}
          fragmentShader={DUST_FRAGMENT}
        />
      </points>

      <lineSegments>
        <bufferGeometry ref={linkGeom}>
          <bufferAttribute attach="attributes-position" args={[linkPositions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial
          ref={linkMaterial}
          transparent
          depthWrite={false}
          color="#e7e2f1"
          opacity={0}
        />
      </lineSegments>

      {Array.from({ length: ENTITY_POOL }, (_, index) => (
        <group
          key={index}
          ref={(node) => {
            entityGroups.current[index] = node;
          }}
          visible={false}
        >
          <mesh position={[0, 0.22, 0]}>
            <boxGeometry args={[0.012, 0.46, 0.012]} />
            <meshBasicMaterial transparent depthWrite={false} color="#f4f1ea" opacity={0} />
          </mesh>
          <mesh position={[0, 0.02, 0]}>
            <boxGeometry args={[0.16, 0.008, 0.008]} />
            <meshBasicMaterial transparent depthWrite={false} color="#c4b6e0" opacity={0.45} />
          </mesh>
        </group>
      ))}

      <mesh ref={courier} visible={false}>
        <boxGeometry args={[0.01, 0.01, 0.2]} />
        <meshBasicMaterial
          ref={courierMaterial}
          transparent
          depthWrite={false}
          color="#f7f4ef"
          opacity={0}
        />
      </mesh>

      <ambientLight intensity={0.35} />
      <directionalLight position={[2.5, 4.5, 3]} intensity={0.55} color="#f4f1ea" />
      <pointLight position={[0.1, 1.4, -1.2]} intensity={0.35} distance={9} color="#b7a6d6" />
    </group>
  );
}

function GlassPanel({ panel, register }) {
  const geometry = useMemo(
    () => new THREE.BoxGeometry(panel.size[0], panel.size[1], 0.012),
    [panel.size]
  );
  const edges = useMemo(() => new THREE.EdgesGeometry(geometry), [geometry]);
  return (
    <group ref={register} position={panel.position} rotation={panel.rotation}>
      <mesh geometry={geometry}>
        <meshStandardMaterial
          transparent
          depthWrite={false}
          color="#14131a"
          roughness={0.28}
          metalness={0.04}
          opacity={0.14}
        />
      </mesh>
      <lineSegments geometry={edges}>
        <lineBasicMaterial transparent depthWrite={false} color="#efeaf6" opacity={0.28} />
      </lineSegments>
    </group>
  );
}

function listeningLevel(levelRef) {
  const value = Number(levelRef?.current?.current ?? levelRef?.current);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function ChiefWorldScene({ phaseRef, entitiesRef, levelRef, motionRef, parallaxRef }) {
  return (
    <Canvas
      className="chief-world-canvas"
      dpr={[1, 1.5]}
      camera={{ position: [0, 1.22, 6.35], fov: 38, near: 0.1, far: 40 }}
      gl={{
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.05,
      }}
      onCreated={({ camera }) => camera.lookAt(0, 0.72, -1.4)}
    >
      <color attach="background" args={[VOID]} />
      <fog attach="fog" args={[VOID, 8, 18]} />
      <WorldRig
        phaseRef={phaseRef}
        entitiesRef={entitiesRef}
        levelRef={levelRef}
        motionRef={motionRef}
        parallaxRef={parallaxRef}
      />
      <EffectComposer multisampling={0}>
        <Bloom intensity={0.22} luminanceThreshold={0.78} luminanceSmoothing={0.28} mipmapBlur />
      </EffectComposer>
    </Canvas>
  );
}

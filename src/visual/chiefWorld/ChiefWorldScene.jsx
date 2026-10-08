import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import * as THREE from "three";
import {
  FIELD_ANCHORS,
  FIELD_LINKS,
  FIELD_STRATA,
  GLASS_PANELS,
  LIGHT_SEAMS,
  PRESENCE_ORIGIN,
  createAtmospherePositions,
  createAtmosphereSeeds,
  placeEntity,
} from "./chiefWorldField.js";
import { phaseWeights } from "./chiefWorldPhase.js";

const VOID = "#05060a";
const ATMOSPHERE_COUNT = 120;
const ENTITY_POOL = 4;
const LAYER_GAIN = Object.freeze({ far: 0.05, mid: 0.14, near: 0.34 });

const HORIZON_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const HORIZON_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform float uEnergy;
  void main() {
    float band = exp(-pow((vUv.y - 0.46) * 3.4, 2.0));
    float lateral = exp(-pow((vUv.x - 0.5) * 1.8, 2.0));
    float alpha = band * lateral * (0.045 + uEnergy * 0.14);
    vec3 color = mix(vec3(0.78, 0.76, 0.82), vec3(0.55, 0.46, 0.72), uEnergy);
    gl_FragColor = vec4(color, alpha);
  }
`;

const FLOOR_VERTEX = `
  varying vec3 vPos;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPos = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FLOOR_FRAGMENT = `
  precision highp float;
  varying vec3 vPos;
  uniform float uEnergy;
  void main() {
    float dist = length(vPos.xz);
    float fade = smoothstep(14.0, 1.4, dist);
    float depth = smoothstep(0.2, 8.0, -vPos.z);
    float lane = exp(-pow(vPos.x * 0.22, 2.0));
    float alpha = fade * depth * lane * (0.025 + uEnergy * 0.04);
    if (alpha < 0.002) discard;
    vec3 color = mix(vec3(0.62, 0.6, 0.66), vec3(0.48, 0.4, 0.62), uEnergy);
    gl_FragColor = vec4(color, alpha);
  }
`;

const SEAM_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SEAM_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform float uPresence;
  uniform float uTime;
  void main() {
    float x = (vUv.x - 0.5) * 2.0;
    float y = (vUv.y - 0.5) * 2.0;
    float breathe = 0.94 + 0.06 * sin(uTime * 0.45);
    float seam = exp(-pow(x * 9.0, 2.0));
    float vertical = smoothstep(-1.05, -0.2, y) * (1.0 - smoothstep(0.55, 1.12, y));
    float hot = exp(-pow(x * 28.0, 2.0)) * smoothstep(-0.2, 0.35, y);
    float alpha = (seam * 0.34 + hot * 0.7) * vertical * breathe * (0.12 + uPresence * 0.7);
    vec3 color = mix(vec3(0.86, 0.84, 0.9), vec3(0.62, 0.5, 0.8), uPresence * 0.65);
    color = mix(color, vec3(0.97, 0.95, 0.92), hot);
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
    pos.y += sin(uTime * 0.11 + aSeed) * 0.06 * uDrift;
    pos.x += cos(uTime * 0.06 + aSeed) * 0.04 * uDrift;
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    float depth = clamp((-mv.z - 1.5) / 14.0, 0.0, 1.0);
    vFade = 1.0 - depth;
    gl_PointSize = uDpr * 1.7 * vFade * (7.0 / max(-mv.z, 0.001));
  }
`;

const DUST_FRAGMENT = `
  precision highp float;
  varying float vFade;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float alpha = smoothstep(0.5, 0.12, d) * 0.32 * vFade;
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
  const layers = useRef({ far: null, mid: null, near: null });
  const panels = useRef([]);
  const filament = useRef(null);
  const strata = useRef(null);
  const horizon = useRef(null);
  const floor = useRef(null);
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
  const stationGeometry = useMemo(() => new THREE.BoxGeometry(0.02, 0.92, 0.26), []);
  const stationEdges = useMemo(() => new THREE.EdgesGeometry(stationGeometry), [stationGeometry]);
  const presenceRef = useRef(0.22);
  const timeRef = useRef(0);

  useFrame((_, dt) => {
    const step = Math.min(dt, 0.05);
    const motion = motionRef.current;
    const moving = motion !== "off";
    if (moving) clock.current += step * (motion === "low" ? 0.45 : 1);
    const time = clock.current;
    const target = phaseWeights(phaseRef.current);
    const current = weights.current;
    const pace = moving ? 2.1 : 18;
    current.idle = damp(current.idle, target.idle, pace, step);
    current.listen = damp(current.listen, target.listen, pace, step);
    current.think = damp(current.think, target.think, pace, step);
    current.work = damp(current.work, target.work, pace, step);
    current.respond = damp(current.respond, target.respond, pace, step);

    const level = listeningLevel(levelRef);
    const presence =
      current.idle * 0.22 +
      current.listen * (0.86 + level * 0.16) +
      current.think * 0.58 +
      current.work * 0.7 +
      current.respond * 0.12;
    const energy =
      current.idle * 0.16 +
      current.listen * 0.62 +
      current.think * 0.4 +
      current.work * 0.48 +
      current.respond * 0.08;
    const filaments =
      current.idle * 0.03 +
      current.listen * 0.1 +
      current.think * 0.48 +
      current.work * 0.28 +
      current.respond * 0.02;

    presenceRef.current = presence;
    timeRef.current = moving ? time : 0;
    if (horizon.current) horizon.current.uniforms.uEnergy.value = energy;
    if (floor.current) floor.current.uniforms.uEnergy.value = energy;
    if (dust.current) {
      dust.current.uniforms.uTime.value = moving ? time : 0;
      dust.current.uniforms.uDrift.value = motion === "off" ? 0 : motion === "low" ? 0.35 : 1;
    }
    if (filament.current) filament.current.opacity = filaments;
    if (strata.current)
      strata.current.opacity = 0.06 + current.listen * 0.04 + current.think * 0.05;

    const parallax = parallaxRef.current;
    const sway = current.respond > 0.55 ? 0.22 : 1;
    const drift = moving ? Math.sin(time * 0.1) * (motion === "low" ? 0.01 : 0.022) : 0;
    for (const key of Object.keys(LAYER_GAIN)) {
      const group = layers.current[key];
      if (!group) continue;
      const gain = LAYER_GAIN[key];
      group.position.x = damp(
        group.position.x,
        (parallax.x * gain + drift * gain) * sway,
        1.8,
        step
      );
      group.position.y = damp(group.position.y, -parallax.y * gain * 0.4 * sway, 1.8, step);
    }

    const breathe = moving ? Math.sin(time * 0.18) * (motion === "low" ? 0.004 : 0.01) : 0;
    const gather = current.listen * 0.12 + current.think * 0.55;
    GLASS_PANELS.forEach((panel, index) => {
      const group = panels.current[index];
      if (!group) return;
      group.position.x = damp(
        group.position.x,
        panel.position[0] + panel.shift[0] * gather,
        1.4,
        step
      );
      group.position.y = damp(
        group.position.y,
        panel.position[1] + panel.shift[1] * gather + breathe,
        1.4,
        step
      );
      group.position.z = damp(
        group.position.z,
        panel.position[2] + panel.shift[2] * current.think,
        1.4,
        step
      );
      group.rotation.y = damp(
        group.rotation.y,
        panel.rotation[1] * (1 - current.listen * 0.28),
        1.3,
        step
      );
    });

    const entities = Array.isArray(entitiesRef.current) ? entitiesRef.current : [];
    const positions = linkGeom.current?.getAttribute("position");
    let primary = null;
    for (let index = 0; index < ENTITY_POOL; index += 1) {
      const placed = index < entities.length ? placeEntity(entities[index]) : null;
      const group = entityGroups.current[index];
      const visible = Boolean(placed) && current.work > 0.06;
      if (group) {
        group.visible = visible;
        if (placed) group.position.set(placed[0], placed[1], placed[2]);
        const slab = group.children[0];
        const edge = group.children[1];
        if (slab?.material) slab.material.opacity = Math.min(0.34, current.work * 0.4);
        if (edge?.material) edge.material.opacity = Math.min(0.85, current.work);
      }
      if (positions) {
        if (visible && placed) {
          positions.setXYZ(index * 2, PRESENCE_ORIGIN[0], PRESENCE_ORIGIN[1], PRESENCE_ORIGIN[2]);
          positions.setXYZ(index * 2 + 1, placed[0], placed[1] + 0.35, placed[2]);
          if (!primary) primary = placed;
        } else {
          positions.setXYZ(index * 2, 0, -10, 0);
          positions.setXYZ(index * 2 + 1, 0, -10, 0);
        }
      }
    }
    if (positions) positions.needsUpdate = true;
    if (linkMaterial.current) linkMaterial.current.opacity = current.work * 0.62;

    if (courier.current && courierMaterial.current) {
      const travel = moving ? (time * (current.work > current.think ? 0.26 : 0.16)) % 1 : 0.5;
      let from = FIELD_ANCHORS[1];
      let to = FIELD_ANCHORS[4];
      if (current.work > current.think && primary) {
        from = PRESENCE_ORIGIN;
        to = [primary[0], primary[1] + 0.35, primary[2]];
      } else if (current.think > 0.2) {
        const link = FIELD_LINKS[Math.floor(time * 0.12) % FIELD_LINKS.length];
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

  const panelsByDepth = { far: [], mid: [], near: [] };
  GLASS_PANELS.forEach((panel, index) => {
    panelsByDepth[panel.depth].push({ panel, index });
  });

  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.04, -1]}>
        <planeGeometry args={[36, 36, 1, 1]} />
        <shaderMaterial
          ref={floor}
          transparent
          depthWrite={false}
          toneMapped={false}
          uniforms={{ uEnergy: { value: 0.16 } }}
          vertexShader={FLOOR_VERTEX}
          fragmentShader={FLOOR_FRAGMENT}
        />
      </mesh>

      <group
        ref={(node) => {
          layers.current.far = node;
        }}
      >
        <mesh position={[0, 1.35, -8.2]}>
          <planeGeometry args={[16, 5]} />
          <shaderMaterial
            ref={horizon}
            transparent
            depthWrite={false}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
            uniforms={{ uEnergy: { value: 0.16 } }}
            vertexShader={HORIZON_VERTEX}
            fragmentShader={HORIZON_FRAGMENT}
          />
        </mesh>
        {panelsByDepth.far.map(({ panel, index }) => (
          <GlassPanel
            key={panel.position.join(":")}
            panel={panel}
            register={(node) => {
              panels.current[index] = node;
            }}
          />
        ))}
        <Seams depth="far" presenceRef={presenceRef} timeRef={timeRef} />
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[strataPositions, 3]} />
          </bufferGeometry>
          <lineBasicMaterial
            ref={strata}
            transparent
            depthWrite={false}
            color="#cfc8dc"
            opacity={0.06}
          />
        </lineSegments>
      </group>

      <group
        ref={(node) => {
          layers.current.mid = node;
        }}
      >
        {panelsByDepth.mid.map(({ panel, index }) => (
          <GlassPanel
            key={panel.position.join(":")}
            panel={panel}
            register={(node) => {
              panels.current[index] = node;
            }}
          />
        ))}
        <Seams depth="mid" presenceRef={presenceRef} timeRef={timeRef} />
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[filamentPositions, 3]} />
          </bufferGeometry>
          <lineBasicMaterial
            ref={filament}
            transparent
            depthWrite={false}
            color="#d9d3e4"
            opacity={0.03}
          />
        </lineSegments>
        <lineSegments>
          <bufferGeometry ref={linkGeom}>
            <bufferAttribute attach="attributes-position" args={[linkPositions, 3]} />
          </bufferGeometry>
          <lineBasicMaterial
            ref={linkMaterial}
            transparent
            depthWrite={false}
            color="#f4f1ea"
            opacity={0}
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
        {Array.from({ length: ENTITY_POOL }, (_, index) => (
          <group
            key={index}
            ref={(node) => {
              entityGroups.current[index] = node;
            }}
            visible={false}
          >
            <mesh geometry={stationGeometry} position={[0, 0.46, 0]}>
              <meshStandardMaterial
                transparent
                depthWrite={false}
                color="#16141c"
                roughness={0.3}
                metalness={0.06}
                opacity={0}
              />
            </mesh>
            <lineSegments geometry={stationEdges} position={[0, 0.46, 0]}>
              <lineBasicMaterial transparent depthWrite={false} color="#f4f1ea" opacity={0} />
            </lineSegments>
          </group>
        ))}
        <mesh ref={courier} visible={false}>
          <boxGeometry args={[0.008, 0.008, 0.18]} />
          <meshBasicMaterial
            ref={courierMaterial}
            transparent
            depthWrite={false}
            color="#f7f4ef"
            opacity={0}
          />
        </mesh>
      </group>

      <group
        ref={(node) => {
          layers.current.near = node;
        }}
      >
        {panelsByDepth.near.map(({ panel, index }) => (
          <GlassPanel
            key={panel.position.join(":")}
            panel={panel}
            register={(node) => {
              panels.current[index] = node;
            }}
          />
        ))}
      </group>

      <ambientLight intensity={0.4} />
      <directionalLight position={[3, 5, 4]} intensity={0.5} color="#f4f1ea" />
      <pointLight position={[-1.4, 1.6, -1.5]} intensity={0.22} distance={8} color="#b7a6d6" />
      <pointLight position={[1.8, 1.4, -2.4]} intensity={0.16} distance={7} color="#d9d3e4" />
    </>
  );
}

function Seams({ depth, presenceRef, timeRef }) {
  return LIGHT_SEAMS.filter((seam) => seam.depth === depth).map((seam) => (
    <Seam
      key={seam.position.join(":")}
      position={seam.position}
      presenceRef={presenceRef}
      timeRef={timeRef}
    />
  ));
}

function Seam({ position, presenceRef, timeRef }) {
  const material = useRef(null);
  useFrame(() => {
    const current = material.current;
    if (!current) return;
    current.uniforms.uPresence.value = presenceRef.current;
    current.uniforms.uTime.value = timeRef.current;
  });
  return (
    <mesh position={position}>
      <planeGeometry args={[0.42, 2.6]} />
      <shaderMaterial
        ref={material}
        transparent
        depthWrite={false}
        toneMapped={false}
        blending={THREE.AdditiveBlending}
        uniforms={{
          uPresence: { value: 0.22 },
          uTime: { value: 0 },
        }}
        vertexShader={SEAM_VERTEX}
        fragmentShader={SEAM_FRAGMENT}
      />
    </mesh>
  );
}

function GlassPanel({ panel, register }) {
  const depth = panel.size[2] || 0.016;
  const geometry = useMemo(
    () => new THREE.BoxGeometry(panel.size[0], panel.size[1], depth),
    [panel.size, depth]
  );
  const edges = useMemo(() => new THREE.EdgesGeometry(geometry), [geometry]);
  return (
    <group ref={register} position={panel.position} rotation={panel.rotation}>
      <mesh geometry={geometry}>
        <meshStandardMaterial
          transparent
          depthWrite={false}
          color="#121118"
          roughness={0.24}
          metalness={0.08}
          opacity={0.22}
        />
      </mesh>
      <lineSegments geometry={edges}>
        <lineBasicMaterial transparent depthWrite={false} color="#f3efe8" opacity={0.32} />
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
      camera={{ position: [0, 1.08, 5.7], fov: 42, near: 0.1, far: 40 }}
      gl={{
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.04,
      }}
      onCreated={({ camera }) => camera.lookAt(0, 0.95, -2.2)}
    >
      <color attach="background" args={[VOID]} />
      <fog attach="fog" args={[VOID, 6.5, 16]} />
      <WorldRig
        phaseRef={phaseRef}
        entitiesRef={entitiesRef}
        levelRef={levelRef}
        motionRef={motionRef}
        parallaxRef={parallaxRef}
      />
      <EffectComposer multisampling={0}>
        <Bloom intensity={0.18} luminanceThreshold={0.82} luminanceSmoothing={0.3} mipmapBlur />
      </EffectComposer>
    </Canvas>
  );
}

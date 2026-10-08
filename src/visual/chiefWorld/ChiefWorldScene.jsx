import { useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import * as THREE from "three";
import { FIELD_ANCHORS, PRESENCE_ORIGIN, placeEntity } from "./chiefWorldField.js";
import { phaseWeights } from "./chiefWorldPhase.js";

const VOID = "#05060a";

const FIELD_VERTEX = `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

// A volume of light. No mesh reads as an object.
// Idle is a dim, uneven field. Listening draws it forward.
// Thinking reveals the latent links. A real activity adds one pool of light.
const FIELD_FRAGMENT = `
  precision highp float;

  varying vec3 vWorld;
  uniform float uTime;
  uniform float uIdle;
  uniform float uListen;
  uniform float uThink;
  uniform float uWork;
  uniform float uRespond;
  uniform float uLevel;
  uniform float uMotion;
  uniform float uCount;
  uniform vec3 uActivity[4];
  uniform vec3 uOrigin;
  uniform vec3 uAnchors[6];

  float pool(vec3 q, vec3 radius) {
    vec3 s = q / radius;
    return exp(-dot(s, s));
  }

  float thread(vec3 p, vec3 a, vec3 b, float radius) {
    vec3 pa = p - a;
    vec3 ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
    float dist = length(pa - ba * h);
    return exp(-pow(dist / radius, 2.0));
  }

  float workAt(vec3 p, vec3 at) {
    return pool(p - at, vec3(1.25, 0.7, 1.15)) * 1.2
      + thread(p, uOrigin, at, 1.05) * 0.48;
  }

  void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorld - ro);
    float tmax = length(vWorld - ro);

    float motion = clamp(uMotion, 0.0, 1.0);
    float tt = uTime * motion;
    float breathe = motion > 0.001 ? 0.97 + 0.03 * sin(tt * 0.28) : 1.0;
    float state = 0.48 * uIdle + 0.7 * uListen + 0.82 * uThink + 0.58 * uWork + 0.2 * uRespond;

    vec3 gather = vec3(0.1, 1.78, -2.7);
    vec3 w0 = vec3(-4.1, 2.65, -4.0);
    vec3 w1 = vec3(4.6, 0.85, -8.8);
    vec3 w2 = vec3(-1.4, 3.4, -13.5);
    float drift = motion * (1.0 - uListen * 0.75);
    w0 += vec3(sin(tt * 0.15), cos(tt * 0.11), sin(tt * 0.09)) * 0.14 * drift;
    w1 += vec3(cos(tt * 0.1), sin(tt * 0.08), 0.0) * 0.18 * motion;
    w0 = mix(w0, gather + vec3(-0.7, 0.12, -0.15), uListen * 0.5);
    w1 = mix(w1, gather + vec3(1.05, -0.2, -1.5), uListen * 0.26);

    vec3 flow = normalize(vec3(0.32, 0.06, -1.0));
    vec3 lightDir = normalize(vec3(-0.34, 0.88, 0.24));
    float scatter = 0.7 + 0.3 * dot(rd, lightDir);

    vec3 col = vec3(0.0);
    float alpha = 0.0;

    for (int i = 0; i < 24; i++) {
      float t = 0.2 + (tmax - 0.2) * (float(i) + 0.5) / 24.0;
      vec3 p = ro + rd * t;

      vec3 q0 = p - w0;
      vec3 q1 = p - w1;
      q0 += flow * dot(q0, flow) * uThink * 0.42;
      q1 += flow * dot(q1, flow) * uThink * 0.28;

      float dens = 0.0;
      dens += pool(q0, vec3(3.1, 1.85, 2.6)) * 0.9;
      dens += pool(q1, vec3(4.2, 2.2, 3.5)) * 0.42;
      dens += pool(p - w2, vec3(6.8, 3.1, 4.8)) * 0.14;

      float uneven = sin(p.x * 0.33 + tt * 0.04) * sin(p.y * 0.29 - tt * 0.03) * sin(p.z * 0.21 + 1.4);
      dens *= 0.88 + 0.12 * uneven;
      dens *= smoothstep(0.05, 1.25, p.y);
      float quiet = pool(p - vec3(0.05, 1.2, -1.35), vec3(2.1, 1.45, 2.4));
      dens *= 1.0 - quiet * (0.82 - uListen * 0.28 - uThink * 0.22);

      float front = dot(p, flow) - tt * 0.28;
      dens += exp(-pow(front * 0.62, 2.0)) * exp(-abs(p.y - 1.5) * 0.5) * uThink * 0.18;
      dens += pool(p - gather, vec3(1.45, 1.05, 1.6)) * uListen * (0.14 + uLevel * 0.1);

      float organize = 0.0;
      organize += thread(p, uAnchors[0], uAnchors[1], 0.78);
      organize += thread(p, uAnchors[1], uAnchors[4], 0.78);
      organize += thread(p, uAnchors[1], uAnchors[2], 0.7);
      organize += thread(p, uAnchors[2], uAnchors[3], 0.7);
      organize += thread(p, uAnchors[4], uAnchors[5], 0.78);
      organize += thread(p, uAnchors[5], uAnchors[0], 0.7);
      organize += thread(p, uAnchors[1], uAnchors[3], 0.64);
      dens += organize * uThink * 0.07;
      dens *= mix(1.0, 0.5, uWork);

      if (uCount > 0.5) dens += workAt(p, uActivity[0]) * uWork;
      if (uCount > 1.5) dens += workAt(p, uActivity[1]) * uWork * 0.85;
      if (uCount > 2.5) dens += workAt(p, uActivity[2]) * uWork * 0.7;
      if (uCount > 3.5) dens += workAt(p, uActivity[3]) * uWork * 0.6;

      dens *= state * breathe;

      float depth = clamp(t / 18.0, 0.0, 1.0);
      float lit = dens * scatter * exp(-t * 0.015);
      vec3 cool = vec3(0.58, 0.6, 0.64);
      vec3 deep = vec3(0.16, 0.11, 0.22);
      vec3 energy = vec3(0.4, 0.2, 0.55);
      vec3 rgb = mix(cool, deep, depth);
      float energyMix = smoothstep(0.1, 0.45, dens) * (uThink * 0.5 + uWork * 0.7 + uListen * 0.16);
      rgb = mix(rgb, energy, clamp(energyMix, 0.0, 0.62));

      float spec = pool(p - w0 - vec3(0.22, 0.04, 0.08), vec3(0.36, 0.12, 0.48));
      rgb += vec3(0.92, 0.93, 0.95) * spec * dens * (0.05 + uListen * 0.1 + uThink * 0.18) * (1.0 - uRespond);

      float glow = 1.0 - exp(-max(lit, 0.0) * 1.7);
      col += rgb * glow * 0.28 * (1.0 - alpha);
      alpha += glow * 0.34 * (1.0 - alpha);
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

const VEIL_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const VEIL_FRAGMENT = `
  precision highp float;
  varying vec2 vUv;
  uniform float uListen;
  uniform float uRespond;
  void main() {
    vec2 p = (vUv - vec2(0.5, 0.62)) * vec2(1.2, 1.0);
    float edge = smoothstep(0.22, 1.05, length(p));
    float lower = smoothstep(0.55, 0.0, vUv.y);
    float alpha = edge * 0.055 + lower * (0.18 + uRespond * 0.22);
    alpha *= 1.0 - uListen * 0.12;
    vec3 color = mix(vec3(0.62, 0.64, 0.68), vec3(0.02, 0.022, 0.028), lower);
    gl_FragColor = vec4(color, alpha);
  }
`;

function anchorVectors() {
  return FIELD_ANCHORS.map((point) => new THREE.Vector3(point[0], point[1], point[2]));
}

function activityVectors() {
  return [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
}

function IntelligenceField({ presenceRef, timeRef, signalRef }) {
  const materialRef = useRef(null);

  useFrame(() => {
    const material = materialRef.current;
    if (!material) return;
    const presence = presenceRef.current;
    const signal = signalRef.current;
    const uniforms = material.uniforms;
    uniforms.uTime.value = timeRef.current;
    uniforms.uIdle.value = presence.idle;
    uniforms.uListen.value = presence.listen;
    uniforms.uThink.value = presence.think;
    uniforms.uWork.value = presence.work;
    uniforms.uRespond.value = presence.respond;
    uniforms.uLevel.value = signal.level;
    uniforms.uMotion.value = signal.motion;
    uniforms.uCount.value = signal.count;
    for (let index = 0; index < 4; index += 1) {
      uniforms.uActivity.value[index].copy(signal.points[index]);
    }
  });

  return (
    <mesh position={[0.15, 1.7, -5]} scale={[24, 13, 24]} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <shaderMaterial
        ref={materialRef}
        side={THREE.BackSide}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
        uniforms={{
          uTime: { value: 0 },
          uIdle: { value: 1 },
          uListen: { value: 0 },
          uThink: { value: 0 },
          uWork: { value: 0 },
          uRespond: { value: 0 },
          uLevel: { value: 0 },
          uMotion: { value: 1 },
          uCount: { value: 0 },
          uActivity: { value: activityVectors() },
          uOrigin: { value: new THREE.Vector3(...PRESENCE_ORIGIN) },
          uAnchors: { value: anchorVectors() },
        }}
        vertexShader={FIELD_VERTEX}
        fragmentShader={FIELD_FRAGMENT}
      />
    </mesh>
  );
}

function NearVeil({ presenceRef }) {
  const materialRef = useRef(null);

  useFrame(() => {
    const material = materialRef.current;
    if (!material) return;
    material.uniforms.uListen.value = presenceRef.current.listen;
    material.uniforms.uRespond.value = presenceRef.current.respond;
  });

  return (
    <mesh frustumCulled={false} renderOrder={2}>
      <planeGeometry args={[1, 1]} />
      <shaderMaterial
        ref={materialRef}
        transparent
        depthWrite={false}
        depthTest={false}
        toneMapped={false}
        uniforms={{
          uListen: { value: 0 },
          uRespond: { value: 0 },
        }}
        vertexShader={VEIL_VERTEX}
        fragmentShader={VEIL_FRAGMENT}
      />
    </mesh>
  );
}

function listeningLevel(levelRef) {
  const value = Number(levelRef?.current?.current ?? levelRef?.current);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function motionScale(motion) {
  if (motion === "off") return 0;
  if (motion === "low") return 0.4;
  return 1;
}

function WorldRig({ phaseRef, entitiesRef, levelRef, motionRef, parallaxRef }) {
  const presenceRef = useRef({ idle: 1, listen: 0, think: 0, work: 0, respond: 0 });
  const timeRef = useRef(0);
  const signalRef = useRef({
    level: 0,
    motion: 1,
    count: 0,
    points: activityVectors(),
  });
  const veilRef = useRef(null);
  const sway = useRef({ x: 0, y: 0 });

  useFrame(({ camera }, delta) => {
    const weights = phaseWeights(phaseRef.current);
    const presence = presenceRef.current;
    const damp = 1 - Math.exp(-delta * 1.35);
    presence.idle += (weights.idle - presence.idle) * damp;
    presence.listen += (weights.listen - presence.listen) * damp;
    presence.think += (weights.think - presence.think) * damp;
    presence.work += (weights.work - presence.work) * damp;
    presence.respond += (weights.respond - presence.respond) * damp;

    const motion = motionScale(motionRef.current);
    if (motion > 0) timeRef.current += delta;

    const levelTarget = presence.listen > 0.04 ? listeningLevel(levelRef) : 0;
    const signal = signalRef.current;
    signal.level += (levelTarget - signal.level) * (1 - Math.exp(-delta * 5));
    signal.motion = motion;

    const entities = entitiesRef.current || [];
    let count = 0;
    for (let index = 0; index < entities.length && count < 4; index += 1) {
      const at = placeEntity(entities[index]);
      if (!at) continue;
      signal.points[count].set(at[0], at[1], at[2]);
      count += 1;
    }
    if (count > 0) signal.count = count;
    else if (presence.work < 0.02) signal.count = 0;

    const pointer = parallaxRef.current || { x: 0, y: 0 };
    const follow = 1 - Math.exp(-delta * 1.5);
    sway.current.x += (pointer.x * motion - sway.current.x) * follow;
    sway.current.y += (pointer.y * motion - sway.current.y) * follow;
    const calm = (1 - presence.respond * 0.8) * motion;
    const breath = Math.sin(timeRef.current * 0.2) * 0.03 * presence.idle * motion;

    camera.position.set(
      sway.current.x * 0.2 * calm + breath,
      0.78 - sway.current.y * 0.05 * calm,
      4.15
    );
    camera.lookAt(0.12 + breath * 0.35, 1.7, -12);

    const veil = veilRef.current;
    if (!veil) return;
    const distance = 1.12;
    const height = 2 * Math.tan((camera.fov * Math.PI) / 360) * distance;
    veil.position.copy(camera.position);
    veil.quaternion.copy(camera.quaternion);
    veil.translateZ(-distance);
    veil.translateX(sway.current.x * 0.14 * calm);
    veil.translateY(sway.current.y * -0.07 * calm);
    veil.scale.set(height * camera.aspect * 1.15, height * 1.15, 1);
  });

  return (
    <>
      <IntelligenceField presenceRef={presenceRef} timeRef={timeRef} signalRef={signalRef} />
      <group ref={veilRef}>
        <NearVeil presenceRef={presenceRef} />
      </group>
    </>
  );
}

export function ChiefWorldScene({ phaseRef, entitiesRef, levelRef, motionRef, parallaxRef }) {
  return (
    <Canvas
      className="chief-world-canvas"
      dpr={[1, 1.5]}
      camera={{ position: [0, 0.78, 4.15], fov: 48, near: 0.1, far: 40 }}
      gl={{
        antialias: true,
        alpha: false,
        premultipliedAlpha: false,
        powerPreference: "high-performance",
        toneMapping: THREE.NoToneMapping,
      }}
      onCreated={({ camera, gl }) => {
        camera.lookAt(0.12, 1.7, -12);
        gl.setClearColor(VOID, 1);
      }}
    >
      <color attach="background" args={[VOID]} />
      <WorldRig
        phaseRef={phaseRef}
        entitiesRef={entitiesRef}
        levelRef={levelRef}
        motionRef={motionRef}
        parallaxRef={parallaxRef}
      />
      <EffectComposer multisampling={0}>
        <Bloom intensity={0.14} luminanceThreshold={0.9} luminanceSmoothing={0.28} mipmapBlur />
      </EffectComposer>
    </Canvas>
  );
}

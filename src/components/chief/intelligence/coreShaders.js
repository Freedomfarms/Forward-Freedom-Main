// GLSL for the CHIEF intelligence core. Three.js rewrites attribute/varying
// and gl_FragColor for WebGL2. Shaders output premultiplied alpha.

export const volumeVertex = /* glsl */ `
  varying vec3 vLocal;
  void main() {
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const volumeFragment = /* glsl */ `
  uniform vec3 uCameraLocal;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uGlow;
  uniform float uDensity;
  uniform float uWave;
  uniform float uFlicker;
  varying vec3 vLocal;

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash13(i), hash13(i + vec3(1.0, 0.0, 0.0)), f.x),
          mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
      mix(mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x),
          mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
      f.z
    );
  }

  float fbm(vec3 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int octave = 0; octave < 4; octave += 1) {
      value += amplitude * noise(p);
      p = p * 2.03 + vec3(1.7, 9.2, 3.4);
      amplitude *= 0.5;
    }
    return value;
  }

  vec3 spinY(vec3 p, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  }

  float filament(vec3 p, vec3 axis) {
    vec3 direction = normalize(axis);
    float along = dot(p, direction);
    float radial = length(p - direction * along);
    return exp(-along * along * 4.2) * exp(-radial * radial * 42.0);
  }

  void main() {
    vec3 rayOrigin = vLocal;
    vec3 rayDir = normalize(vLocal - uCameraLocal);
    float travel = max(0.0, -2.0 * dot(rayOrigin, rayDir));
    if (travel < 0.001) discard;

    float clock = uTime * (0.14 + uSpeed * 0.055);
    const int STEPS = 52;
    float stepLen = travel / float(STEPS);
    float cursor = hash13(vec3(gl_FragCoord.xy, 1.7)) * stepLen;
    vec3 accum = vec3(0.0);
    float alpha = 0.0;
    float flick = 1.0 + uFlicker * 0.09 * smoothstep(0.8, 0.97, noise(vec3(floor(uTime * 1.5), 0.4, 2.2)));

    for (int step = 0; step < STEPS; step += 1) {
      if (cursor >= travel || alpha > 0.97) break;
      vec3 samplePos = rayOrigin + rayDir * min(cursor + stepLen * 0.5, travel);
      float warp = noise(samplePos * 1.7 + vec3(0.0, clock * 0.6, 0.3));
      vec3 q = spinY(samplePos * (1.0 + (warp - 0.5) * 0.06), clock * 0.22);
      float radius = length(q);
      float field = fbm(q * 2.4 + vec3(0.0, clock, -clock * 0.35));
      float grain = fbm(q * 5.8 + vec3(clock * 0.45, 1.4, -clock * 0.2));
      float core = exp(-pow(radius / 0.33, 2.0));
      float body = exp(-pow(radius / 0.74, 2.0));
      float veil = smoothstep(1.02, 0.8, radius);
      vec3 axisA = spinY(vec3(0.16, 1.0, 0.08), clock * 0.32);
      vec3 axisB = spinY(vec3(0.9, 0.22, 0.28), -clock * 0.24);
      float streams = (filament(q, axisA) + filament(q, axisB) * 0.7) * smoothstep(0.72, 0.15, radius);
      float density = (body * (0.16 + field * 0.1) + core * 3.1 + streams * uWave * 0.2) * veil * uDensity;

      vec3 deep = vec3(0.16, 0.04, 0.32);
      vec3 violet = vec3(0.72, 0.34, 1.05);
      vec3 white = vec3(1.2, 1.16, 1.25);
      vec3 emit = mix(deep, violet, smoothstep(0.98, 0.62, radius));
      emit = mix(emit, white, clamp(core, 0.0, 1.0));
      float mid = smoothstep(0.12, 0.32, radius) * smoothstep(0.88, 0.42, radius);
      emit *= 0.78 + field * 0.55 + grain * 0.18 + (field - 0.45) * mid * 0.7;
      emit += white * streams * 0.55;
      emit += white * smoothstep(0.84, 0.97, noise(q * 16.0 + clock)) * body * 0.18;
      emit *= flick * (0.82 + uGlow * 0.55);

      float absorb = 1.0 - exp(-density * stepLen * 6.4);
      accum += (1.0 - alpha) * emit * absorb;
      alpha += (1.0 - alpha) * absorb;
      cursor += stepLen;
    }

    if (alpha < 0.015) discard;
    gl_FragColor = vec4(accum, alpha);
  }
`;

export const heartVertex = /* glsl */ `
  varying vec3 vLocal;
  void main() {
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const heartFragment = /* glsl */ `
  uniform float uGlow;
  varying vec3 vLocal;
  void main() {
    float radius = length(vLocal);
    float glow = pow(smoothstep(1.0, 0.0, radius), 1.65);
    vec3 color = mix(vec3(0.7, 0.4, 1.0), vec3(1.0, 0.98, 1.0), pow(glow, 0.8));
    float alpha = glow * (0.55 + uGlow * 0.45);
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

export const fieldVertex = /* glsl */ `
  varying vec3 vLocal;
  void main() {
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const fieldFragment = /* glsl */ `
  uniform float uGlow;
  varying vec3 vLocal;
  void main() {
    float radius = length(vLocal);
    float alpha = smoothstep(1.0, 0.2, radius) * 0.045 * (0.55 + uGlow);
    vec3 color = vec3(0.32, 0.08, 0.58);
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

export const shellVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelMatrix) * normal);
    vView = cameraPosition - world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

export const shellFragment = /* glsl */ `
  uniform float uGlow;
  uniform float uAlpha;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float fresnel = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.1);
    float alpha = fresnel * uAlpha * (0.65 + uGlow * 0.35);
    vec3 color = mix(vec3(0.22, 0.05, 0.42), vec3(0.82, 0.68, 1.0), fresnel);
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

export const particleVertex = /* glsl */ `
  attribute vec3 aDir;
  attribute float aRadius;
  attribute vec4 aSeed;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uActivity;
  uniform float uOutflow;
  uniform float uOrganize;
  uniform float uPixelRatio;
  varying float vAlpha;
  varying float vHeat;

  void main() {
    float rate = aSeed.z * (0.04 + uSpeed * 0.022);
    float phase = fract(aSeed.x + uTime * rate);
    float ping = abs(phase * 2.0 - 1.0);
    float travel = mix(ping, phase, clamp(uOutflow, 0.0, 1.0));
    float radius = mix(0.012, aRadius, travel);
    float angle = uTime * aSeed.y * (0.12 + uSpeed * 0.05) * mix(1.0, 0.22, clamp(uOrganize, 0.0, 1.0));
    float c = cos(angle);
    float s = sin(angle);
    vec3 dir = normalize(vec3(c * aDir.x + s * aDir.z, aDir.y, -s * aDir.x + c * aDir.z));
    float jitter = (1.0 - clamp(uOrganize, 0.0, 1.0)) * 0.04 * aRadius;
    vec3 pos = dir * radius + vec3(
      sin(uTime * 0.65 + aSeed.x * 18.0),
      cos(uTime * 0.52 + aSeed.y * 14.0),
      sin(uTime * 0.48 + aSeed.z * 11.0)
    ) * jitter;
    vec4 viewPos = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * viewPos;
    float dist = max(0.85, -viewPos.z);
    float near = smoothstep(max(aRadius, 0.05), 0.0, radius);
    gl_PointSize = clamp((0.7 + near * 0.65) * uPixelRatio * (4.0 / dist), 1.0, 2.15);
    float shellFade = aSeed.w < 0.5 ? 1.0 : (aSeed.w < 1.5 ? 0.34 : 0.12);
    float release = mix(1.0, smoothstep(0.0, 0.07, phase) * smoothstep(1.0, 0.86, phase), clamp(uOutflow, 0.0, 1.0));
    vAlpha = shellFade * release * (0.32 + uActivity * 0.45) * (0.45 + near * 0.4);
    vHeat = near;
  }
`;

export const particleFragment = /* glsl */ `
  varying float vAlpha;
  varying float vHeat;
  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float dist = length(uv);
    if (dist > 0.5) discard;
    float falloff = smoothstep(0.5, 0.0, dist);
    vec3 color = mix(vec3(0.64, 0.4, 1.0), vec3(1.0, 0.97, 1.0), vHeat);
    float alpha = falloff * vAlpha;
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

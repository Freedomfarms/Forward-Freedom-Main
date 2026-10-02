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
  uniform float uOrganize;
  uniform float uOutflow;
  uniform float uContract;
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

  float organicWobble(vec3 n, float time) {
    float breathe = 0.65 + 0.35 * sin(time * 0.23 + 0.8);
    float shape =
      sin(n.y * 3.1 + time * 0.53) * 0.028 +
      sin(n.x * 2.4 - time * 0.37 + 1.15) * 0.02 +
      sin(n.z * 4.2 + time * 0.29 + n.x) * 0.016 +
      sin(n.y * 2.8 + time * 1.05) * sin(n.z * 2.2 - time * 0.72) * 0.014;
    return shape * breathe;
  }

  void main() {
    vec3 rayOrigin = vLocal;
    vec3 rayDir = normalize(vLocal - uCameraLocal);
    float travel = max(0.0, -2.0 * dot(rayOrigin, rayDir));
    if (travel < 0.001) discard;

    float clock = uTime * (0.1 + uSpeed * 0.045);
    float nucleusLive = 0.78 + 0.22 * sin(uTime * 0.19 + 2.05);
    float ordered = clamp(uOrganize, 0.0, 1.0);
    const int STEPS = 52;
    float stepLen = travel / float(STEPS);
    float cursor = hash13(vec3(gl_FragCoord.xy, 1.7)) * stepLen;
    vec3 accum = vec3(0.0);
    float alpha = 0.0;
    float flick = 1.0 + uFlicker * 0.07 * smoothstep(0.82, 0.97, noise(vec3(floor(uTime * 1.4), 0.4, 2.2)));

    for (int step = 0; step < STEPS; step += 1) {
      if (cursor >= travel || alpha > 0.96) break;
      vec3 samplePos = rayOrigin + rayDir * min(cursor + stepLen * 0.5, travel);
      float bound = length(samplePos);
      vec3 normal = samplePos / max(bound, 0.001);
      float tighten = 1.0 + clamp(uContract, 0.0, 1.0) * 0.07;
      float shellR = bound / (1.0 + organicWobble(normal, uTime)) * tighten;
      vec3 flow = vec3(
        sin(samplePos.y * 2.8 + clock * 1.25),
        sin(samplePos.z * 2.35 - clock * 1.05),
        sin(samplePos.x * 2.6 + clock * 0.9)
      );
      vec3 q = samplePos + flow * (0.07 + (1.0 - ordered) * 0.05);
      float radius = length(q);
      float field = fbm(q * 2.3 + vec3(0.0, clock * 0.8, -clock * 0.3));
      float grain = fbm(q * 5.4 + vec3(clock * 0.4, 1.2, 0.0));
      float stream = pow(1.0 - abs(fbm(q * 2.7 + flow * 0.35) * 2.0 - 1.0), 2.2);
      stream *= smoothstep(0.9, 0.22, radius);
      float pocket = smoothstep(0.7, 0.9, noise(q * 1.7 + vec3(clock * 0.22, 1.4, -clock * 0.16)));
      pocket *= smoothstep(0.78, 0.18, radius);

      float nucleus = exp(-pow(radius / 0.15, 2.0));
      float hot = exp(-pow(radius / 0.32, 2.0));
      float body = exp(-pow(shellR / 0.8, 2.0));
      float veil = smoothstep(1.08, 0.78, shellR);
      float pull = clamp(uContract, 0.0, 1.0);
      float outerFade = mix(1.0, smoothstep(1.02, 0.4, shellR), pull);
      float density =
        (body * (0.14 + field * 0.08) * outerFade + hot * 0.28 + nucleus * 2.6 + stream * uWave * 0.28) *
        veil *
        uDensity;

      vec3 deep = vec3(0.08, 0.015, 0.16);
      vec3 violet = vec3(0.4, 0.12, 0.74);
      vec3 energy = vec3(0.66, 0.28, 1.0);
      vec3 pink = vec3(0.98, 0.58, 0.9);
      vec3 white = vec3(1.0, 0.97, 1.0);
      vec3 emit = mix(deep, violet, smoothstep(1.02, 0.58, shellR));
      emit = mix(emit, energy, clamp(stream * 0.9 + body * 0.25, 0.0, 1.0));
      emit = mix(emit, pink, clamp(hot * 0.55 + pocket * 0.7, 0.0, 1.0));
      emit = mix(emit, white, clamp(nucleus * nucleusLive, 0.0, 0.88));
      emit += energy * stream * (0.25 + uOutflow * 0.45) * smoothstep(0.12, 0.55, radius);
      emit += pink * pocket * 0.22;
      emit *= mix(1.0, 0.62 + 0.38 * outerFade, pull);
      emit *= flick * (0.78 + uGlow * 0.4) * (0.9 + grain * 0.16);
      emit *= mix(1.0, 0.82 + field * 0.28, ordered);

      float absorb = 1.0 - exp(-density * stepLen * 6.0);
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
  uniform float uTime;
  varying vec3 vLocal;
  void main() {
    float live = 0.78 + 0.22 * sin(uTime * 0.19 + 2.05);
    vec3 p = vLocal;
    float warp =
      sin(p.y * 5.5 + uTime * 0.85) * 0.09 + sin(p.x * 4.6 - uTime * 0.6) * 0.07;
    float radius = length(p + vec3(warp, sin(uTime * 0.47) * 0.06, warp * 0.55));
    float knot = 0.55 + 0.45 * sin(p.x * 4.2 + uTime * 0.95) * sin(p.z * 3.4 - uTime * 0.62);
    float glow = pow(smoothstep(1.05, 0.08, radius), 1.85);
    vec3 pink = vec3(0.92, 0.5, 0.88);
    vec3 white = vec3(1.0, 0.97, 1.0);
    vec3 color = mix(pink, white, clamp(pow(glow, 1.7) * live, 0.0, 0.8));
    color *= 0.8 + knot * 0.35;
    float alpha = glow * live * (0.28 + uGlow * 0.22);
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
    float alpha = smoothstep(1.0, 0.25, radius) * 0.04 * (0.5 + uGlow);
    vec3 color = vec3(0.28, 0.06, 0.5);
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

export const shellVertex = /* glsl */ `
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec3 n = normalize(position);
    float breathe = 0.65 + 0.35 * sin(uTime * 0.23 + 0.8);
    float wobble =
      (sin(n.y * 3.1 + uTime * 0.53) * 0.028 +
        sin(n.x * 2.4 - uTime * 0.37 + 1.15) * 0.02 +
        sin(n.z * 4.2 + uTime * 0.29 + n.x) * 0.016 +
        sin(n.y * 2.8 + uTime * 1.05) * sin(n.z * 2.2 - uTime * 0.72) * 0.014) *
      breathe;
    vec3 displaced = position * (1.0 + wobble);
    vec4 world = modelMatrix * vec4(displaced, 1.0);
    vNormal = normalize(mat3(modelMatrix) * normalize(displaced));
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
    float fresnel = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.4);
    float alpha = fresnel * uAlpha * (0.45 + uGlow * 0.25);
    vec3 color = mix(vec3(0.16, 0.03, 0.32), vec3(0.62, 0.36, 0.9), fresnel);
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
  uniform float uContract;
  uniform float uPixelRatio;
  varying float vAlpha;
  varying float vHeat;
  varying float vFront;

  vec3 curl(vec3 p, float t) {
    return vec3(
      sin(p.y * 2.8 + t * 1.25) - cos(p.z * 2.1 - t * 0.7),
      sin(p.z * 2.35 - t * 1.05) - cos(p.x * 2.6 + t * 0.5),
      sin(p.x * 2.6 + t * 0.9) - cos(p.y * 2.2 + t * 0.55)
    );
  }

  void main() {
    float speed = 0.07 + uSpeed * 0.055;
    float loop = fract(aSeed.x + uTime * aSeed.z * speed);
    float home = aRadius;
    float idleRadial = home * (0.76 + 0.24 * sin(loop * 6.28318));
    float gather = clamp(uOrganize, 0.0, 1.0);
    float converge = mix(home, 0.1 + home * 0.32, gather);
    float release = mix(0.04, min(home * 1.08, 0.9), loop);
    float radial = mix(mix(idleRadial, converge, gather), release, clamp(uOutflow, 0.0, 1.0));
    radial *= mix(1.0, 0.68, clamp(uContract, 0.0, 1.0));

    float angle = uTime * aSeed.y * speed * mix(1.0, 0.4, gather);
    float c = cos(angle);
    float s = sin(angle);
    vec3 dir = vec3(c * aDir.x + s * aDir.z, aDir.y, -s * aDir.x + c * aDir.z);
    vec3 pos = dir * radial;
    pos += curl(pos, uTime * (0.32 + uSpeed * 0.22)) * (0.11 * radial + 0.02) * mix(1.0, 0.45, gather);

    vec4 viewPos = modelViewMatrix * vec4(pos, 1.0);
    vec4 centerView = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float front = viewPos.z > centerView.z ? 1.0 : 0.0;
    gl_Position = projectionMatrix * viewPos;
    float dist = max(0.85, -viewPos.z);
    float near = smoothstep(0.72, 0.04, radial);
    float size = (0.8 + near * 0.75) * mix(0.72, 1.12, front);
    gl_PointSize = clamp(size * uPixelRatio * (4.1 / dist), 1.0, 2.5);
    float shellFade = aSeed.w < 0.5 ? 1.0 : (aSeed.w < 1.5 ? 0.36 : 0.14);
    vAlpha = shellFade * mix(0.4, 1.0, front) * (0.32 + uActivity * 0.48) * (0.55 + near * 0.4);
    vHeat = near;
    vFront = front;
  }
`;

export const particleFragment = /* glsl */ `
  uniform float uPass;
  varying float vAlpha;
  varying float vHeat;
  varying float vFront;
  void main() {
    if (uPass < 0.5 && vFront > 0.5) discard;
    if (uPass > 0.5 && vFront < 0.5) discard;
    vec2 uv = gl_PointCoord - vec2(0.5);
    float dist = length(uv);
    if (dist > 0.5) discard;
    float falloff = smoothstep(0.5, 0.0, dist);
    vec3 deep = vec3(0.38, 0.12, 0.68);
    vec3 pink = vec3(0.95, 0.58, 0.92);
    vec3 white = vec3(1.0, 0.96, 1.0);
    vec3 color = mix(deep, pink, vHeat);
    color = mix(color, white, vHeat * vHeat * 0.65);
    float alpha = falloff * vAlpha;
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

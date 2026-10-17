// CHIEF Draft 4 public-entry renderer, ported from
// design-references/chief-draft-4/chief-intro.js (the approved prototype:
// Draft 1 choreography + lightning-blue palette + Draft 2 sphere design).
// Every geometric constant, color, easing, and timing value is kept from the
// prototype. Only the lifecycle changed: the standalone IIFE became a factory
// a React host mounts once and destroys on unmount, and the demo-only
// interactions (dock submit, detail dialog, duration <select>) moved to the
// host component, which calls the returned controller instead.
//
// One 2D canvas, one requestAnimationFrame loop. Frame-by-frame state never
// touches React.

export const CHIEF_INTRO_DEFAULT_MS = 5800;
export const CHIEF_INTRO_SLOW_MS = 8000;

export const CHIEF_INTRO_PHASES = Object.freeze([
  { until: 0.18, label: "AWAKENING" },
  { until: 0.37, label: "INTELLIGENCE TAKING SHAPE" },
  { until: 0.76, label: "CAPABILITIES UNFOLDING" },
  { until: 1, label: "WELCOME TO FREEDOM OS" },
  { until: Infinity, label: "YOUR SPACE TO THINK" },
]);

export function chiefIntroPhaseLabel(progress) {
  for (const phase of CHIEF_INTRO_PHASES) {
    if (progress < phase.until) return phase.label;
  }
  return CHIEF_INTRO_PHASES[CHIEF_INTRO_PHASES.length - 1].label;
}

export function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

export function smoothstep(x) {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

// Deterministic LCG with the prototype's seed, so the filament sphere and
// star field are the exact arrangement that was approved.
function createRand(seed = 81) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function buildIntroGeometry() {
  const rand = createRand(81);
  const stars = Array.from({ length: 100 }, () => ({
    x: rand(),
    y: rand(),
    r: 0.3 + rand() * 1.1,
    a: 0.1 + rand() * 0.5,
    phase: rand() * 6.28,
  }));
  // Draft 2 sphere geometry, composed at Draft 1's fixed center.
  const sphere = Array.from({ length: 52 }, (_, j) => {
    const a = rand() * 6.283;
    const b = rand() * 6.283;
    const rad = 0.86 + rand() * 0.14;
    const pts = [];
    for (let k = 0; k <= 42; k++) {
      const v = (k / 42) * Math.PI * 1.7 + j * 0.37;
      const x = Math.cos(v) * rad;
      const y = Math.sin(v) * rad;
      const z = 0.025 * Math.sin(v * 8 + j);
      const yy = y * Math.cos(a) - z * Math.sin(a);
      const zz = y * Math.sin(a) + z * Math.cos(a);
      pts.push([x * Math.cos(b) + zz * Math.sin(b), yy, -x * Math.sin(b) + zz * Math.cos(b)]);
    }
    return pts;
  });
  const bolt = [
    [0.25, -0.94],
    [0.04, -0.63],
    [-0.13, -0.34],
    [0.13, -0.38],
    [-0.27, 0.12],
    [0.02, 0.06],
    [-0.25, 0.56],
    [-0.38, 0.97],
  ];
  const branches = [
    {
      p: [
        [-0.12, -0.34],
        [-0.38, -0.4],
        [-0.49, -0.25],
        [-0.65, -0.32],
      ],
      at: 0.29,
    },
    {
      p: [
        [0.05, -0.62],
        [0.37, -0.57],
        [0.44, -0.73],
        [0.58, -0.78],
      ],
      at: 0.17,
    },
    {
      p: [
        [-0.24, 0.12],
        [-0.44, 0.23],
        [-0.37, 0.43],
        [-0.62, 0.52],
      ],
      at: 0.55,
    },
    {
      p: [
        [-0.03, 0.16],
        [0.27, 0.27],
        [0.38, 0.2],
        [0.56, 0.35],
      ],
      at: 0.63,
    },
  ];
  return { stars, sphere, bolt, branches };
}

/**
 * Mount the Draft 4 intro renderer on a prepared DOM subtree.
 *
 * Required inside `root`: one `.fc-stage` containing one `.fc-canvas`.
 * Optional (homepage composition): `.fc-panel` buttons, `.fc-phase-text`,
 * `.fc-dock`, `.fc-skip`. The renderer drives progress through CSS custom
 * properties on `root` (`--awaken`, `--ignition`, `--progress`),
 * `root.dataset.ready`, and direct panel transforms, exactly like the
 * prototype did.
 */
export function createChiefIntroRenderer(root, options = {}) {
  if (!root) return null;
  const stage = root.querySelector(".fc-stage");
  const canvas = root.querySelector(".fc-canvas");
  const ctx = canvas ? canvas.getContext("2d") : null;
  if (!stage || !canvas || !ctx) return null;

  const panels = [...root.querySelectorAll(".fc-panel")];
  const phaseText = root.querySelector(".fc-phase-text");
  const dock = root.querySelector(".fc-dock");
  const skipButton = root.querySelector(".fc-skip");

  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = media.matches;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let last = performance.now();
  let elapsed = 0;
  let duration = Number(options.duration) || CHIEF_INTRO_DEFAULT_MS;
  let raf = 0;
  let dead = false;
  let ready = false;
  let frameCount = 0;
  let slow = 0;
  let quality = 1;
  let visible = true;
  let pointerX = 0;
  let pointerY = 0;
  let driftX = 0;
  let driftY = 0;
  let lastPhase = "";
  const onReady = typeof options.onReady === "function" ? options.onReady : null;

  const { stars, sphere, bolt, branches } = buildIntroGeometry();

  function resize() {
    const r = stage.getBoundingClientRect();
    width = r.width;
    height = r.height;
    dpr = Math.min(window.devicePixelRatio || 1, 1.5) * quality;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (reduced) draw(1, 0);
  }

  function strokePath(points, reveal, color, lineWidth, glow) {
    if (reveal <= 0) return;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    const end = (points.length - 1) * clamp01(reveal);
    const whole = Math.floor(end);
    for (let i = 1; i <= whole; i++) ctx.lineTo(points[i][0], points[i][1]);
    if (whole < points.length - 1) {
      const f = end - whole;
      ctx.lineTo(
        points[whole][0] + (points[whole + 1][0] - points[whole][0]) * f,
        points[whole][1] + (points[whole + 1][1] - points[whole][1]) * f
      );
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.shadowColor = color;
    ctx.shadowBlur = glow;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function draw(progress, time) {
    if (!width) return;
    ctx.clearRect(0, 0, width, height);
    const mobile = width <= 580;
    const cx = width * 0.5 + driftX;
    const cy = (mobile ? 180 : 245) + driftY;
    const r = mobile ? 104 : Math.min(151, width * 0.165);
    const awaken = smoothstep(progress / 0.28);
    const ignite = smoothstep((progress - 0.15) / 0.24);
    const settle = smoothstep((progress - 0.7) / 0.3);
    const rotation = time * 0.00009;

    const g = ctx.createRadialGradient(cx, cy, 10, cx, cy, r * 2.3);
    g.addColorStop(0, `rgba(44,120,183,${0.24 * awaken})`);
    g.addColorStop(0.43, `rgba(31,77,114,${0.17 * awaken})`);
    g.addColorStop(1, "rgba(5,9,12,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);

    for (const s of stars) {
      ctx.beginPath();
      ctx.fillStyle = `rgba(166,196,220,${s.a * awaken * (0.7 + 0.3 * Math.sin(time * 0.0004 + s.phase))})`;
      ctx.arc(
        s.x * width,
        (s.y * height - time * 0.001 * (s.r + 0.2) + height * 10) % height,
        s.r,
        0,
        6.283
      );
      ctx.fill();
    }

    // Ground plane: very faint perspective rays rather than a competing halo.
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = `rgba(113,163,204,${awaken * 0.085})`;
    for (let i = -5; i <= 5; i++) {
      ctx.beginPath();
      ctx.moveTo(cx + i * 25, cy + r * 0.85);
      ctx.lineTo(cx + i * 180, height);
      ctx.stroke();
    }

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // Draft 2's luminous globe and paired tilted contours. Its outer
    // silhouette stays within Draft 1's original radius and fixed composition.
    const sphereRadius = r / 1.17;
    const angle = rotation;
    const count = quality < 0.8 ? 34 : sphere.length;
    for (let j = 0; j < count; j++) {
      const pts = sphere[j];
      const screenPoints = [];
      ctx.beginPath();
      let front = 0;
      for (let i = 0; i < pts.length; i++) {
        const v = pts[i];
        const x = v[0] * Math.cos(angle) + v[2] * Math.sin(angle);
        const z = -v[0] * Math.sin(angle) + v[2] * Math.cos(angle);
        const depth = 3.8 / (3.8 - z);
        front += z;
        const sx = cx + x * sphereRadius * depth;
        const sy = cy + (v[1] * 0.97 - z * 0.15) * sphereRadius * depth;
        screenPoints.push([sx, sy]);
        if (i) ctx.lineTo(sx, sy);
        else ctx.moveTo(sx, sy);
      }
      const alpha = (j % 4 === 0 ? 0.65 : 0.22) + clamp01(front / pts.length) * 0.16;
      ctx.strokeStyle = `rgba(${j % 3 === 0 ? "153,228,255" : "62,157,250"},${alpha * awaken})`;
      ctx.lineWidth = j % 4 === 0 ? 0.8 : 0.55;
      ctx.stroke();
      // Draft 1's traveling filament light, at its original speed.
      if (ignite > 0.1 && j % 3 === 0) {
        const index = Math.floor(((time * 0.00012 + j * 0.618) % 1) * 37);
        ctx.beginPath();
        for (let k = index; k < index + 5; k++) {
          if (k === index) ctx.moveTo(screenPoints[k][0], screenPoints[k][1]);
          else ctx.lineTo(screenPoints[k][0], screenPoints[k][1]);
        }
        ctx.strokeStyle = `rgba(155,218,255,${ignite * 0.62})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // The bright central heart.
    ctx.beginPath();
    ctx.arc(cx, cy, 2.8 * (0.86 + 0.14 * Math.sin(time * 0.0018)), 0, 6.283);
    ctx.fillStyle = `rgba(222,249,255,${ignite})`;
    ctx.shadowBlur = 18;
    ctx.shadowColor = "#69cfff";
    ctx.fill();
    ctx.shadowBlur = 0;

    // Two tilted orbital contours.
    for (let i = 0; i < 2; i++) {
      ctx.beginPath();
      ctx.ellipse(
        cx,
        cy,
        sphereRadius * 1.17,
        sphereRadius * 0.34,
        angle * (i ? -0.5 : 0.7) + i * 1.8,
        0,
        6.283
      );
      ctx.strokeStyle = `rgba(127,212,255,${0.32 * awaken})`;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }

    // Bolt: stable silhouette, depth offset, branching arcs, traveling reveal.
    const reveal = smoothstep((progress - 0.17) / 0.26);
    const br = r * 0.71;
    const boltPts = bolt.map((p) => [cx + p[0] * br, cy + p[1] * br]);
    const pulse = 0.86 + 0.14 * Math.sin(time * 0.0018);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    strokePath(
      boltPts.map((p) => [p[0] + 4, p[1] + 2]),
      reveal,
      `rgba(80,160,240,${0.25 * ignite})`,
      2,
      10
    );
    strokePath(boltPts, reveal, `rgba(62,164,247,${0.18 * pulse})`, 16, 25);
    strokePath(boltPts, reveal, `rgba(119,194,255,${0.58 * pulse})`, 6, 17);
    strokePath(boltPts, reveal, `rgba(223,241,255,${0.95 * pulse})`, 2.1, 7);
    strokePath(boltPts, reveal, "rgba(255,252,255,.94)", 0.8, 0);
    for (const b of branches) {
      const pts = b.p.map((p) => [cx + p[0] * br, cy + p[1] * br]);
      strokePath(
        pts,
        smoothstep((reveal - b.at) * 3),
        `rgba(123,190,244,${(0.36 + 0.14 * Math.sin(time * 0.0015 + b.at * 8)) * ignite})`,
        1,
        6
      );
    }

    const sparkCount = quality < 0.8 ? 18 : 32;
    for (let j = 0; j < sparkCount; j++) {
      const a = j * 2.399 + rotation * 0.4;
      const rr = r * (1.08 + 0.1 * Math.sin(time * 0.0005 + j));
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr * 0.93;
      ctx.fillStyle = `rgba(166,209,245,${ignite * (0.2 + 0.35 * Math.pow(Math.sin(j + time * 0.0007), 2))})`;
      ctx.fillRect(x, y, j % 4 === 0 ? 1.8 : 1, j % 4 === 0 ? 1.8 : 1);
    }

    // One slow energy wave at ignition; no strobing.
    const wave = clamp01((progress - 0.27) / 0.24);
    if (wave > 0 && wave < 1) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, r * (0.7 + wave * 0.8), r * (0.7 + wave * 0.8), 0, 0, 6.283);
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = `rgba(131,194,245,${Math.sin(wave * Math.PI) * 0.19})`;
      ctx.stroke();
    }
    ctx.restore();

    // Thin leaders attach the composed capability panels to the core.
    if (!mobile && panels.length === 6) {
      ctx.strokeStyle = `rgba(134,182,221,${settle * 0.2})`;
      ctx.lineWidth = 0.6;
      for (const side of [-1, 1]) {
        for (let row = 0; row < 3; row++) {
          const y = 138 + row * 131;
          const edge =
            side < 0
              ? panels[row * 2].offsetLeft + panels[row * 2].offsetWidth
              : panels[row * 2 + 1].offsetLeft;
          ctx.beginPath();
          ctx.moveTo(edge + side * -6, y);
          ctx.lineTo(cx + side * (r + 24), y);
          ctx.lineTo(cx + side * r * 0.84, cy + (row - 1) * r * 0.65);
          ctx.stroke();
        }
      }
    }
  }

  function paintUI(p) {
    root.style.setProperty("--awaken", smoothstep(p / 0.25));
    root.style.setProperty("--ignition", smoothstep((p - 0.18) / 0.22));
    root.style.setProperty("--progress", p);
    panels.forEach((el, i) => {
      const v = smoothstep((p - (0.34 + i * 0.055)) / 0.25);
      const side = i % 2 === 0 ? 1 : -1;
      el.style.opacity = v;
      el.style.transform = `translate3d(${side * (1 - v) * 100}px,${(1 - v) * 25}px,${-(1 - v) * 180}px) rotateY(${side * (1 - v) * 22}deg) scale(${0.86 + 0.14 * v})`;
      el.inert = v < 0.98;
    });
    const phase = chiefIntroPhaseLabel(p < 1 ? p : Infinity);
    if (phaseText && phase !== lastPhase) {
      phaseText.textContent = phase;
      lastPhase = phase;
    }
    if (p >= 1 && !ready) {
      ready = true;
      root.dataset.ready = "true";
      if (dock) dock.inert = false;
      if (skipButton) skipButton.hidden = true;
      panels.forEach((el) => {
        el.style.willChange = "auto";
      });
      onReady?.();
    }
  }

  function loop(now) {
    raf = 0;
    if (dead || !visible || document.hidden) return;
    if (!root.isConnected) {
      destroy();
      return;
    }
    const dt = Math.min(now - last, 70);
    last = now;
    if (!reduced) elapsed += dt;
    const p = reduced ? 1 : clamp01(elapsed / duration);
    driftX += (pointerX - driftX) * 0.025;
    driftY += (pointerY - driftY) * 0.025;
    if (!ready) paintUI(p);
    draw(p, reduced ? 0 : elapsed);
    frameCount++;
    if (frameCount > 40 && dt > 28) slow++;
    else slow = Math.max(0, slow - 1);
    if (slow > 35 && quality === 1) {
      quality = 0.7;
      resize();
      slow = 0;
    }
    if (!reduced) raf = requestAnimationFrame(loop);
  }

  function schedule() {
    if (!raf && !dead && visible && !document.hidden) {
      last = performance.now();
      raf = requestAnimationFrame(loop);
    }
  }

  function restart() {
    elapsed = 0;
    ready = false;
    root.dataset.ready = "false";
    if (dock) dock.inert = true;
    if (skipButton) skipButton.hidden = reduced;
    panels.forEach((el) => {
      el.style.willChange = "transform,opacity";
    });
    paintUI(reduced ? 1 : 0);
    schedule();
  }

  function skip() {
    elapsed = duration;
    paintUI(1);
    draw(1, reduced ? 0 : elapsed);
    schedule();
  }

  const listeners = [];
  function on(el, type, fn) {
    el.addEventListener(type, fn);
    listeners.push(() => el.removeEventListener(type, fn));
  }

  on(stage, "pointermove", (e) => {
    if (reduced) return;
    const b = stage.getBoundingClientRect();
    pointerX = ((e.clientX - b.left) / b.width - 0.5) * 7;
    pointerY = ((e.clientY - b.top) / b.height - 0.5) * 5;
  });
  on(stage, "pointerleave", () => {
    pointerX = 0;
    pointerY = 0;
  });
  on(document, "visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else {
      schedule();
    }
  });
  on(media, "change", (e) => {
    reduced = e.matches;
    if (reduced) {
      cancelAnimationFrame(raf);
      raf = 0;
      skip();
    }
    schedule();
  });

  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  const io = new IntersectionObserver(
    (entries) => {
      visible = entries[0].isIntersecting;
      if (visible) {
        schedule();
      } else {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    },
    { threshold: 0 }
  );
  io.observe(root);

  function destroy() {
    if (dead) return;
    dead = true;
    cancelAnimationFrame(raf);
    raf = 0;
    ro.disconnect();
    io.disconnect();
    listeners.forEach((remove) => remove());
  }
  on(window, "pagehide", destroy);

  resize();
  if (options.startSettled) {
    root.dataset.ready = "false";
    if (dock) dock.inert = true;
    skip();
  } else {
    restart();
  }

  return {
    destroy,
    replay: restart,
    skip,
    setDuration(ms) {
      const next = Number(ms);
      if (!Number.isFinite(next) || next <= 0) return;
      duration = next;
      restart();
    },
    renderAt(ms) {
      const p = clamp01(ms / duration);
      paintUI(p);
      draw(p, reduced ? 0 : ms);
    },
    inspect: () => ({ elapsed, duration, ready, reduced, quality, raf, width, height }),
  };
}

// Frontier sphere. Seeded allocation, 52 paths, bolt, and orbits match
// design-references/chief-frontier/chief.js. One animation loop, torn down on destroy.

const BOLT = [
  [0.25, -0.94],
  [0.04, -0.63],
  [-0.13, -0.34],
  [0.13, -0.38],
  [-0.27, 0.12],
  [0.02, 0.06],
  [-0.25, 0.56],
  [-0.38, 0.97],
];

const BRANCHES = [
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

const ENERGY = Object.freeze({
  idle: 0.15,
  listening: 0.5,
  thinking: 0.85,
  responding: 0.65,
});

function clamp(x, a = 0, b = 1) {
  return Math.max(a, Math.min(b, x));
}

function smooth(x) {
  const t = clamp(x);
  return t * t * (3 - 2 * t);
}

function mix(a, b, p) {
  return a + (b - a) * p;
}

export function createFrontierGeometry() {
  let seed = 81;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const stars = Array.from({ length: 100 }, () => ({
    x: rand(),
    y: rand(),
    r: 0.3 + rand() * 1.1,
    a: 0.1 + rand() * 0.5,
    phase: rand() * 6.28,
  }));
  const sphere = Array.from({ length: 52 }, (_, j) => {
    const a = rand() * 6.283;
    const b = rand() * 6.283;
    const rad = 0.86 + rand() * 0.14;
    const pts = [];
    for (let k = 0; k <= 42; k += 1) {
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
  return { stars, sphere, bolt: BOLT, branches: BRANCHES };
}

export function createFrontierScene({
  canvas,
  anchor,
  stage,
  root,
  reduced = false,
  paused = false,
}) {
  const ctx = canvas.getContext("2d", { alpha: false });
  const geometry = createFrontierGeometry();
  const { stars, sphere, bolt, branches } = geometry;
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reducedMotion = Boolean(reduced || media.matches);
  let isPaused = false;
  let w = 1;
  let h = 1;
  let mobile = false;
  let quality = 1;
  let dpr = 1;
  let raf = 0;
  let lastTime = 0;
  let lastDraw = 0;
  let clock = 0;
  let dirty = true;
  let resizePending = true;
  let frames = 0;
  let slow = 0;
  let boot = 0;
  let spinPhase = 0;
  const drift = { x: 0, y: 0 };
  const pointer = { x: 0, y: 0 };
  let corePosition = { x: 0, y: 0, r: 140 };
  let stageBox = { left: 0, right: 0 };
  let activity = "idle";
  let energy = ENERGY.idle;
  let targetEnergy = ENERGY.idle;
  let destroyed = false;

  function measure() {
    const bounds = root.getBoundingClientRect();
    w = Math.max(1, bounds.width);
    h = Math.max(1, bounds.height);
    mobile = w <= 780;
    dpr = Math.min(window.devicePixelRatio || 1, mobile ? 1.35 : 1.5) * quality;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const rect = anchor.getBoundingClientRect();
    const scene = stage.getBoundingClientRect();
    corePosition = {
      x: rect.x - bounds.x + rect.width * 0.5,
      y: rect.y - bounds.y + rect.height * 0.5,
      r: Math.max(24, Math.min(rect.width * 0.5, scene.height * 0.31)),
    };
    stageBox = {
      left: scene.left - bounds.left,
      right: scene.right - bounds.left,
    };
    resizePending = false;
    dirty = true;
  }

  function path(points, reveal, color, width, glow = 0) {
    if (!ctx || reveal <= 0 || points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    const end = (points.length - 1) * clamp(reveal);
    const whole = Math.floor(end);
    for (let i = 1; i <= whole; i += 1) ctx.lineTo(points[i][0], points[i][1]);
    if (whole < points.length - 1) {
      const f = end - whole;
      ctx.lineTo(
        mix(points[whole][0], points[whole + 1][0], f),
        mix(points[whole][1], points[whole + 1][1], f)
      );
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.shadowColor = color;
    ctx.shadowBlur = glow;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function environment(t) {
    const c = corePosition;
    ctx.fillStyle = "#03080e";
    ctx.fillRect(0, 0, w, h);
    const glow = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, Math.max(c.r * 2.9, 350));
    glow.addColorStop(0, `rgba(26,76,118,${0.22 + energy * 0.04})`);
    glow.addColorStop(0.42, "rgba(12,40,65,.15)");
    glow.addColorStop(1, "rgba(3,8,14,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    for (const s of stars) {
      ctx.beginPath();
      ctx.fillStyle = `rgba(176,208,233,${s.a * 0.43 * (0.72 + 0.28 * Math.sin(t * 0.0004 + s.phase))})`;
      ctx.arc(
        s.x * w + drift.x * (s.r + 0.2),
        (s.y * h - t * 0.0005 + h * 100) % h,
        s.r * (mobile ? 0.65 : 0.8),
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
    const horizon = c.y + c.r * 1.07;
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = "rgba(100,170,220,.045)";
    for (let i = -10; i <= 10; i += 1) {
      ctx.beginPath();
      ctx.moveTo(c.x + i * 18, horizon);
      ctx.lineTo(c.x + i * w * 0.12, h);
      ctx.stroke();
    }
    for (let i = 1; i <= 8; i += 1) {
      const yy = horizon + (h - horizon) * ((i + ((t * 0.000018) % 1)) / 9) ** 2;
      if (yy > h) continue;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(w, yy);
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(c.x, horizon);
    ctx.scale(1, 0.14);
    const localFloor = ctx.createRadialGradient(0, 0, 0, 0, 0, c.r * 2.1);
    localFloor.addColorStop(0, "rgba(81,165,226,.17)");
    localFloor.addColorStop(1, "rgba(81,165,226,0)");
    ctx.fillStyle = localFloor;
    ctx.beginPath();
    ctx.arc(0, 0, c.r * 2.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    for (let i = 0; i < 3; i += 1) {
      ctx.beginPath();
      ctx.ellipse(c.x, horizon, c.r * (1.4 + i * 0.2), c.r * (0.12 + i * 0.026), 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(102,176,230,${0.12 - i * 0.025})`;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
    const theta = t * 0.00014;
    ctx.beginPath();
    ctx.ellipse(c.x, horizon, c.r * 1.6, c.r * 0.146, 0, theta, theta + 0.65);
    ctx.strokeStyle = "rgba(162,218,255,.3)";
    ctx.lineWidth = 0.85;
    ctx.stroke();
  }

  function conduits(t) {
    if (mobile || !ctx) return;
    const c = corePosition;
    ctx.save();
    ctx.globalAlpha = boot;
    [-1, 1].forEach((side, i) => {
      const yy = c.y + (i ? 1 : -1) * c.r * 0.32;
      const edge = side < 0 ? stageBox.left + 10 : stageBox.right - 10;
      const pts = [
        [c.x + side * c.r * 0.92, yy],
        [c.x + side * c.r * 1.24, yy + side * 17],
        [edge, yy + side * 17],
      ];
      path(pts, 1, "rgba(137,199,244,.13)", 0.6);
      const p = (t * 0.00009 + i * 0.5) % 1;
      const index = p < 0.4 ? 0 : 1;
      const f = index === 0 ? p / 0.4 : (p - 0.4) / 0.6;
      const x = mix(pts[index][0], pts[index + 1][0], f);
      const y = mix(pts[index][1], pts[index + 1][1], f);
      ctx.beginPath();
      ctx.arc(x, y, 1.35, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(177,224,255,.65)";
      ctx.shadowBlur = 7;
      ctx.shadowColor = "#86ceff";
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(edge, yy + side * 17, 2, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(145,205,247,.3)";
      ctx.stroke();
    });
    ctx.restore();
  }

  function core(t) {
    const c = corePosition;
    const cx = c.x + drift.x;
    const cy = c.y + drift.y;
    const breath = 1 + Math.sin(t * 0.0011) * 0.008 + energy * 0.012 * Math.sin(t * 0.0034);
    const r = c.r * breath;
    const rotation = spinPhase;
    const scale = clamp(r / 151, 0.4, 1.9);
    ctx.save();
    ctx.globalAlpha = boot;
    ctx.globalCompositeOperation = "lighter";
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.8);
    g.addColorStop(0, `rgba(63,154,220,${0.2 + energy * 0.1})`);
    g.addColorStop(0.4, "rgba(31,85,132,.11)");
    g.addColorStop(1, "rgba(3,8,14,0)");
    ctx.fillStyle = g;
    ctx.fillRect(cx - r * 2, cy - r * 2, r * 4, r * 4);
    const sr = r / 1.17;
    const count = quality < 0.8 ? 34 : sphere.length;
    for (let j = 0; j < count; j += 1) {
      const pts = sphere[j];
      const screen = [];
      ctx.beginPath();
      let front = 0;
      for (let i = 0; i < pts.length; i += 1) {
        const v = pts[i];
        const x = v[0] * Math.cos(rotation) + v[2] * Math.sin(rotation);
        const z = -v[0] * Math.sin(rotation) + v[2] * Math.cos(rotation);
        const depth = 3.8 / (3.8 - z);
        front += z;
        const sx = cx + x * sr * depth;
        const sy = cy + (v[1] * 0.97 - z * 0.15) * sr * depth;
        screen.push([sx, sy]);
        if (i) ctx.lineTo(sx, sy);
        else ctx.moveTo(sx, sy);
      }
      const alpha =
        ((j % 4 === 0 ? 0.65 : 0.22) + clamp(front / pts.length) * 0.16) * (1 + energy * 0.17);
      ctx.strokeStyle = `rgba(${j % 3 === 0 ? "153,228,255" : "62,157,250"},${alpha})`;
      ctx.lineWidth = (j % 4 === 0 ? 0.8 : 0.55) * scale;
      ctx.stroke();
      if (j % 3 === 0) {
        const index = Math.floor(((t * (0.00012 + energy * 0.00004) + j * 0.618) % 1) * 37);
        ctx.beginPath();
        for (let k = index; k < index + 5; k += 1) {
          const point = screen[k];
          if (!point) continue;
          if (k === index) ctx.moveTo(point[0], point[1]);
          else ctx.lineTo(point[0], point[1]);
        }
        ctx.strokeStyle = "rgba(155,218,255,.70)";
        ctx.lineWidth = 1.1 * scale;
        ctx.stroke();
      }
    }
    ctx.beginPath();
    ctx.arc(cx, cy, 2.8 * (0.86 + 0.14 * Math.sin(t * 0.0018)) * scale, 0, Math.PI * 2);
    ctx.fillStyle = "#def9ff";
    ctx.shadowBlur = 18;
    ctx.shadowColor = "#69cfff";
    ctx.fill();
    ctx.shadowBlur = 0;
    for (let i = 0; i < 2; i += 1) {
      ctx.beginPath();
      ctx.ellipse(
        cx,
        cy,
        sr * 1.17,
        sr * 0.34,
        rotation * (i ? -0.5 : 0.7) + i * 1.8,
        0,
        Math.PI * 2
      );
      ctx.strokeStyle = "rgba(127,212,255,.32)";
      ctx.lineWidth = 0.6 * scale;
      ctx.stroke();
    }
    const br = r * 0.71;
    const bp = bolt.map((p) => [cx + p[0] * br, cy + p[1] * br]);
    const pulse = 0.9 + 0.1 * Math.sin(t * 0.0018);
    const reveal = reducedMotion || isPaused ? 1 : smooth(clock / 1700);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    path(
      bp.map((p) => [p[0] + 4, p[1] + 2]),
      reveal,
      "rgba(80,160,240,.25)",
      2 * scale,
      10
    );
    path(bp, reveal, `rgba(62,164,247,${0.18 * pulse})`, 16 * scale, 25);
    path(bp, reveal, `rgba(119,194,255,${0.58 * pulse})`, 6 * scale, 17);
    path(bp, reveal, `rgba(223,241,255,${0.95 * pulse})`, 2.1 * scale, 7);
    path(bp, reveal, "rgba(255,252,255,.94)", 0.8 * scale);
    for (const b of branches) {
      path(
        b.p.map((p) => [cx + p[0] * br, cy + p[1] * br]),
        smooth((reveal - b.at) * 3),
        `rgba(123,190,244,${0.32 + 0.1 * Math.sin(t * 0.0015 + b.at * 8)})`,
        scale * 0.7,
        4
      );
    }
    for (let j = 0; j < (quality < 0.8 ? 18 : 32); j += 1) {
      const a = j * 2.399 + rotation * 0.4;
      const rr = r * (1.08 + 0.1 * Math.sin(t * 0.0005 + j));
      ctx.fillStyle = `rgba(166,209,245,${0.18 + 0.35 * Math.sin(j + t * 0.0007) ** 2})`;
      ctx.fillRect(
        cx + Math.cos(a) * rr,
        cy + Math.sin(a) * rr * 0.93,
        j % 4 === 0 ? 1.8 : 1,
        j % 4 === 0 ? 1.8 : 1
      );
    }
    for (let band = 0; band < 2; band += 1) {
      const rr = r * (1.24 + band * 0.07);
      const angle = t * (band ? -0.00004 : 0.00006);
      for (let sector = 0; sector < 3; sector += 1) {
        const start = angle + (sector * Math.PI * 2) / 3;
        ctx.beginPath();
        ctx.arc(cx, cy, rr, start, start + 0.52 + band * 0.24);
        ctx.strokeStyle = band ? "rgba(96,173,230,.13)" : "rgba(153,217,255,.22)";
        ctx.lineWidth = band ? 0.5 : 0.7;
        ctx.stroke();
        if (sector === 0) {
          ctx.beginPath();
          ctx.arc(cx + Math.cos(start) * rr, cy + Math.sin(start) * rr, 1.65, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(192,232,255,.65)";
          ctx.fill();
        }
      }
    }
    ctx.strokeStyle = "rgba(113,176,226,.19)";
    ctx.lineWidth = 0.65;
    for (let i = 0; i < 60; i += 1) {
      if (i % 5 !== 0 && i % 3 !== 0) continue;
      const a = (i / 60) * Math.PI * 2 + rotation * 0.1;
      const rr = r * 1.28;
      const len = i % 5 === 0 ? 6 : 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      ctx.lineTo(cx + Math.cos(a) * (rr + len), cy + Math.sin(a) * (rr + len));
      ctx.stroke();
    }
    if (activity === "listening" || activity === "responding") {
      const amplitude = activity === "listening" ? 0.08 : 0.05;
      for (let i = 0; i < 2; i += 1) {
        const p = (t * 0.00024 + i * 0.5) % 1;
        const rr = r * (1.05 + p * 0.38);
        ctx.beginPath();
        ctx.arc(cx, cy, rr, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(133,211,255,${amplitude * (1 - p)})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function frame(now) {
    raf = 0;
    if (destroyed || document.hidden) return;
    const raw = lastTime ? now - lastTime : 16;
    const dt = Math.min(raw, 60);
    lastTime = now;
    if (!isPaused) {
      clock += dt;
      spinPhase += dt * (0.000065 + energy * 0.00004);
    }
    if (resizePending) measure();
    if (dirty || now - lastDraw >= 30) {
      boot = reducedMotion || isPaused ? 1 : smooth(clock / 1100);
      if (isPaused) {
        drift.x = 0;
        drift.y = 0;
        energy = targetEnergy;
      } else {
        drift.x += (pointer.x - drift.x) * 0.055;
        drift.y += (pointer.y - drift.y) * 0.055;
        energy += (targetEnergy - energy) * 0.05;
      }
      if (ctx) {
        environment(clock);
        conduits(clock);
        core(clock);
      }
      lastDraw = now;
      dirty = false;
    }
    if (!isPaused) {
      frames += 1;
      if (frames > 120) {
        slow = raw > 50 && raw < 200 ? slow + 1 : Math.max(0, slow - 2);
        if (slow > 32 && quality === 1) {
          quality = 0.75;
          resizePending = true;
          slow = 0;
        }
      }
      raf = requestAnimationFrame(frame);
    }
  }

  function schedule() {
    if (!destroyed && !raf && !document.hidden) raf = requestAnimationFrame(frame);
  }

  function onResize() {
    resizePending = true;
    schedule();
  }

  function onPointer(event) {
    if (isPaused || mobile) return;
    const bounds = root.getBoundingClientRect();
    pointer.x = ((event.clientX - bounds.left) / w - 0.5) * 6;
    pointer.y = ((event.clientY - bounds.top) / h - 0.5) * 4;
  }

  function onLeave() {
    pointer.x = 0;
    pointer.y = 0;
  }

  function onVisibility() {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
      return;
    }
    lastTime = 0;
    dirty = true;
    schedule();
  }

  function onMedia(event) {
    reducedMotion = Boolean(reduced || event.matches);
    dirty = true;
    schedule();
  }

  const unsubscribers = [];
  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    unsubscribers.push(() => target.removeEventListener(type, handler, options));
  }

  listen(window, "resize", onResize, { passive: true });
  if (window.visualViewport) listen(window.visualViewport, "resize", onResize, { passive: true });
  listen(window, "pointermove", onPointer, { passive: true });
  listen(document, "pointerleave", onLeave);
  listen(document, "visibilitychange", onVisibility);
  if (typeof media.addEventListener === "function") listen(media, "change", onMedia);
  let observer = null;
  if (typeof ResizeObserver === "function") {
    observer = new ResizeObserver(onResize);
    observer.observe(root);
    // The transcript card changes the stage height without resizing the shell.
    observer.observe(stage);
    observer.observe(anchor);
  }

  function setActivity(next) {
    activity = ENERGY[next] ? next : "idle";
    targetEnergy = ENERGY[activity];
    dirty = true;
    schedule();
  }

  function setPaused(next) {
    const value = Boolean(next);
    if (value && !isPaused) clock = Math.max(clock, 1800);
    if (!value) lastTime = 0;
    isPaused = value;
    dirty = true;
    schedule();
  }

  function setReduced(next) {
    reduced = Boolean(next);
    reducedMotion = Boolean(reduced || media.matches);
    dirty = true;
    schedule();
  }

  setPaused(Boolean(paused || reducedMotion));
  setActivity("idle");

  return {
    setActivity,
    setPaused,
    setReduced,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      raf = 0;
      observer?.disconnect();
      observer = null;
      while (unsubscribers.length) unsubscribers.pop()();
    },
  };
}

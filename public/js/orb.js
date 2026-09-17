/**
 * orb.js — the desk's single light source, drawn on one canvas.
 *
 * Everything the HUD animates is a state, not a flourish:
 *   listening → the ring tightens and a waveform breathes;
 *   routing   → particles travel orb → seat, then back with the answer;
 *   speaking  → radius and glow follow the voice's own amplitude;
 *   veto      → the seat flashes red and its connector turns dashed;
 *   focus     → everything else dims to 22%, the way a real operator's eye works.
 *
 * It is also the input surface: seat clicks focus, arrow keys cycle, and the
 * hand tracker (hands.js) writes to `steer()` with the same normalized
 * coordinates a mouse produces. One geometry, three input devices.
 */

const TAU = Math.PI * 2;
const STATE_COLORS = { idle: [255, 203, 82], listening: [255, 110, 120], thinking: [255, 203, 82], speaking: [53, 240, 166], done: [120, 170, 255], error: [255, 77, 94] };

export class Orb {
  constructor(canvas, { onSeat, onSteerSeat } = {}) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.seats = [];
    this.states = new Map();
    this.masterState = 'idle';
    this.focusId = null;
    this.hoverId = null;
    this.level = 0.06;
    this.targetLevel = 0.06;
    this.pulses = [];   // traveling particles: {seat, dir, t}
    this.steerV = { x: 0, y: 0, at: 0 };
    this.flash = new Map();
    this.onSeat = onSeat;
    this.onSteerSeat = onSteerSeat;
    this.t = 0;
    this.dpr = 1;
    this.resize();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement || canvas);
  }

  configure({ master, seats }) {
    this.master = master;
    this.seats = seats.map((s, i) => ({ ...s, angle: -Math.PI / 2 + (i * TAU) / seats.length }));
  }

  setState(id, state) {
    this.states.set(id, state);
    if (state === 'error' || state === 'veto') this.flash.set(id, this.t);
  }

  setLevel(v) {
    this.targetLevel = Math.max(0.02, Math.min(1, Number(v) || 0.02));
  }

  focus(id) {
    this.focusId = id;
  }

  /** Fire a routing pulse: out to the seats, back when the answer lands. */
  route(ids, back = false) {
    for (const id of ids) this.pulses.push({ seat: id, dir: back ? -1 : 1, t: 0, speed: 0.016 + Math.random() * 0.004 });
  }

  steer(nx, ny) {
    this.steerV = { x: nx, y: ny, at: performance.now() };
    if (!this.seats.length) return;
    const ang = Math.atan2(ny, nx);
    let best = null;
    let bestD = 9;
    for (const s of this.seats) {
      let d = Math.abs(((s.angle - ang + Math.PI * 3) % TAU) - Math.PI);
      d = Math.abs(Math.PI - d);
      if (d < bestD) { bestD = d; best = s.id; }
    }
    if (best && bestD < 0.65 && best !== this._lastSteer) {
      this._lastSteer = best;
      this.onSteerSeat?.(best);
    }
  }

  resize() {
    const parent = this.c.parentElement;
    if (!parent) return;
    const r = parent.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.c.width = Math.max(320, Math.floor(r.width * this.dpr));
    this.c.height = Math.max(280, Math.floor(r.height * this.dpr));
    this.w = this.c.width;
    this.h = this.c.height;
  }

  geo() {
    const cx = this.w / 2 + this.steerV.x * this.w * 0.02;
    const cy = this.h * 0.46 + this.steerV.y * this.h * 0.02;
    const R = Math.min(this.w, this.h) * 0.155;
    const rx = Math.min(this.w * 0.40, this.h * 0.62);
    const ry = Math.min(this.h * 0.335, this.w * 0.34);
    return { cx, cy, R, rx, ry };
  }

  seatAt(s, g) {
    return { x: g.cx + Math.cos(s.angle) * g.rx, y: g.cy + Math.sin(s.angle) * g.ry };
  }

  hit(x, y) {
    const g = this.geo();
    for (const s of this.seats) {
      const p = this.seatAt(s, g);
      if (Math.hypot(x - p.x, y - p.y) < 26 * this.dpr) return s.id;
    }
    return null;
  }

  loop(now) {
    const dt = Math.min(50, now - (this._last ?? now));
    this._last = now;
    this.t += dt / 1000;
    this._dt = dt || 16.7;
    this.level += (this.targetLevel - this.level) * 0.18;
    if (this.masterState !== 'listening') this.targetLevel += (0.06 - this.targetLevel) * 0.02;
    this.draw();
    requestAnimationFrame(this.loop);
  }

  draw() {
    const { ctx, w, h, t } = this;
    const g = this.geo();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const masterHue = this.master?.hue ?? 44;
    const focused = this.seats.find((s) => s.id === this.focusId);
    const dim = (id) => (this.focusId && this.focusId !== id ? 0.22 : 1);
    const amp = this.level;

    // ── ambient halo: the one light source in the room
    const halo = ctx.createRadialGradient(g.cx, g.cy, g.R * 0.2, g.cx, g.cy, g.R * (4.1 + amp * 2.4));
    const haloHue = focused ? focused.hue : masterHue;
    halo.addColorStop(0, `hsla(${haloHue} 100% 70% / ${0.2 + amp * 0.22})`);
    halo.addColorStop(0.35, `hsla(${haloHue} 90% 55% / ${0.07 + amp * 0.06})`);
    halo.addColorStop(1, 'hsla(220 60% 40% / 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, h);

    // ── orbit path (perspective ellipse)
    ctx.save();
    ctx.strokeStyle = `hsla(${masterHue} 90% 70% / .16)`;
    ctx.lineWidth = 1 * this.dpr;
    ctx.setLineDash([3 * this.dpr, 7 * this.dpr]);
    ctx.lineDashOffset = -t * 12 * this.dpr;
    ctx.beginPath();
    ctx.ellipse(g.cx, g.cy, g.rx, g.ry, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();

    // ── second, steeper orbit: the "two planes of work" motif
    ctx.save();
    ctx.strokeStyle = `hsla(${masterHue} 90% 70% / .08)`;
    ctx.lineWidth = 1 * this.dpr;
    ctx.beginPath();
    ctx.ellipse(g.cx, g.cy, g.rx * 0.78, g.ry * 1.16, Math.sin(t * 0.12) * 0.25, 0, TAU);
    ctx.stroke();
    ctx.restore();

    // ── connectors + routing particles
    for (const s of this.seats) {
      const st = this.states.get(s.id) ?? 'idle';
      const p = this.seatAt(s, g);
      const active = st === 'thinking' || st === 'speaking' || st === 'error';
      const a = dim(s.id) * (active ? 0.85 : st === 'done' ? 0.4 : 0.14);
      const col = STATE_COLORS[st] ?? STATE_COLORS.idle;
      ctx.save();
      ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${a})`;
      ctx.lineWidth = (active ? 1.9 : 1) * this.dpr;
      if (st === 'error') ctx.setLineDash([5 * this.dpr, 5 * this.dpr]);
      ctx.beginPath();
      ctx.moveTo(g.cx, g.cy);
      const mx = (g.cx + p.x) / 2 + (p.y - g.cy) * 0.16;
      const my = (g.cy + p.y) / 2 - (p.x - g.cx) * 0.16;
      ctx.quadraticCurveTo(mx, my, p.x, p.y);
      ctx.stroke();
      ctx.restore();
    }

    // ── pulses travelling along the connectors
    this.pulses = this.pulses.filter((pulse) => {
      pulse.t += pulse.speed * (this._dt / 16.7);
      if (pulse.t > 1) return false;
      const s = this.seats.find((x) => x.id === pulse.seat);
      if (!s) return false;
      const p = this.seatAt(s, g);
      const k = pulse.dir > 0 ? pulse.t : 1 - pulse.t;
      const mx = (g.cx + p.x) / 2 + (p.y - g.cy) * 0.16;
      const my = (g.cy + p.y) / 2 - (p.x - g.cx) * 0.16;
      const x = (1 - k) ** 2 * g.cx + 2 * (1 - k) * k * mx + k ** 2 * p.x;
      const y = (1 - k) ** 2 * g.cy + 2 * (1 - k) * k * my + k ** 2 * p.y;
      const col = STATE_COLORS[this.states.get(s.id) ?? 'idle'] ?? STATE_COLORS.thinking;
      const dot = ctx.createRadialGradient(x, y, 0, x, y, 9 * this.dpr);
      dot.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},.95)`);
      dot.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`);
      ctx.fillStyle = dot;
      ctx.beginPath();
      ctx.arc(x, y, 9 * this.dpr, 0, TAU);
      ctx.fill();
      return true;
    });

    // ── seats
    for (const s of this.seats) {
      this.drawSeat(s, g, dim(s.id), amp);
    }

    // ── the orb itself
    const r = g.R * (1 + amp * 0.26);
    const sph = ctx.createRadialGradient(g.cx - r * 0.32, g.cy - r * 0.42, r * 0.05, g.cx, g.cy, r);
    sph.addColorStop(0, `hsla(${haloHue} 100% 96% / ${0.96})`);
    sph.addColorStop(0.32, `hsla(${haloHue} 96% 72% / .92)`);
    sph.addColorStop(0.72, `hsla(${haloHue - 12} 84% 44% / .8)`);
    sph.addColorStop(1, `hsla(${haloHue - 20} 70% 18% / .9)`);
    ctx.fillStyle = sph;
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, r, 0, TAU);
    ctx.fill();

    // speech rings
    const speaking = this.masterState === 'speaking' || [...this.states.values()].includes('speaking');
    if (speaking || amp > 0.14) {
      for (let i = 0; i < 3; i++) {
        const k = (t * 1.6 + i * 0.33) % 1;
        ctx.beginPath();
        ctx.strokeStyle = `hsla(${haloHue} 100% 78% / ${(1 - k) * 0.34})`;
        ctx.lineWidth = (1 + (1 - k) * 2) * this.dpr;
        ctx.arc(g.cx, g.cy, r * (1.06 + k * (0.5 + amp)), 0, TAU);
        ctx.stroke();
      }
    }

    // listening waveform
    if (this.masterState === 'listening') {
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 110, 120, .8)';
      ctx.lineWidth = 1.4 * this.dpr;
      for (let i = 0; i < 26; i++) {
        const a = -Math.PI / 2 + (i / 25) * TAU;
        const n = Math.abs(Math.sin(t * 7 + i * 1.7)) * r * (0.16 + amp * 0.5);
        ctx.beginPath();
        ctx.moveTo(g.cx + Math.cos(a) * (r * 1.12), g.cy + Math.sin(a) * (r * 1.12));
        ctx.lineTo(g.cx + Math.cos(a) * (r * 1.12 + n), g.cy + Math.sin(a) * (r * 1.12 + n));
        ctx.stroke();
      }
      ctx.restore();
    }

    // core sparks
    const sparks = 34;
    for (let i = 0; i < sparks; i++) {
      const a = t * (0.24 + (i % 5) * 0.05) + i * 2.399;
      const rr = r * (1.25 + ((i * 37) % 60) / 60 + Math.sin(t * 0.7 + i) * 0.1);
      const x = g.cx + Math.cos(a) * rr;
      const y = g.cy + Math.sin(a) * rr * 0.66;
      ctx.fillStyle = `hsla(${haloHue} 100% ${70 + (i % 3) * 8}% / ${0.05 + 0.5 - Math.abs(Math.sin(a / 2)) * 0.3})`;
      ctx.beginPath();
      ctx.arc(x, y, (0.9 + (i % 3) * 0.5) * this.dpr, 0, TAU);
      ctx.fill();
    }
  }

  drawSeat(s, g, dimK, amp) {
    const { ctx, t } = this;
    const p = this.seatAt(s, g);
    const st = this.states.get(s.id) ?? 'idle';
    const focused = this.focusId === s.id;
    const hovered = this.hoverId === s.id;
    const base = 13.5 * this.dpr * (focused || hovered ? 1.16 : 1);
    const flash = this.flash.get(s.id) ? Math.max(0, 1 - (t - this.flash.get(s.id)) / 1.6) : 0;
    if (flash <= 0 && (st === 'error' || st === 'done')) this.flash.delete(s.id);

    const hue = s.hue ?? 44;
    const active = st === 'thinking' || st === 'speaking' || focused;
    const a = dimK * (active ? 1 : 0.72);

    // glow
    const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, base * (3 + amp * 1.2));
    glow.addColorStop(0, `hsla(${hue} 100% 62% / ${(0.3 + (flash ? 0.5 : 0)) * a})`);
    glow.addColorStop(1, `hsla(${hue} 100% 50% / 0)`);
    ctx.fillStyle = flash > 0 ? `hsla(355 100% 60% / ${0.45 * flash * a})` : glow;
    ctx.beginPath();
    ctx.arc(p.x, p.y, base * (3 + amp * 1.2), 0, TAU);
    ctx.fill();
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(p.x, p.y, base * 2.4, 0, TAU);
    ctx.fill();

    // disc
    const disc = ctx.createRadialGradient(p.x - base * 0.3, p.y - base * 0.4, 0, p.x, p.y, base);
    disc.addColorStop(0, `hsla(${hue} 100% 84% / ${0.95 * a})`);
    disc.addColorStop(0.6, `hsla(${hue} 82% 46% / ${0.86 * a})`);
    disc.addColorStop(1, `hsla(${hue} 60% 16% / ${0.9 * a})`);
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(p.x, p.y, base, 0, TAU);
    ctx.fill();

    // ring: state
    ctx.lineWidth = 1.4 * this.dpr;
    ctx.strokeStyle = st === 'speaking'
      ? `rgba(53,240,166,${0.9 * a})`
      : st === 'thinking'
        ? `hsla(${hue} 100% 78% / ${0.9 * a})`
        : st === 'error'
          ? `rgba(255,77,94,${0.9 * a})`
          : `hsla(${hue} 60% 70% / ${0.34 * a})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, base + 4 * this.dpr, 0, TAU);
    ctx.stroke();

    if (st === 'thinking') {
      ctx.strokeStyle = `hsla(${hue} 100% 80% / .95)`;
      ctx.lineWidth = 2 * this.dpr;
      const sweep = (t * 2.2) % TAU;
      ctx.beginPath();
      ctx.arc(p.x, p.y, base + 7 * this.dpr, sweep, sweep + 1.1);
      ctx.stroke();
    }
    if (st === 'veto' || flash > 0) {
      ctx.strokeStyle = `rgba(255,77,94,${0.7 + 0.3 * Math.sin(t * 9)})`;
      ctx.lineWidth = 2 * this.dpr;
      ctx.beginPath();
      ctx.arc(p.x, p.y, base + 9 * this.dpr, 0, TAU);
      ctx.stroke();
    }

    // glyph
    ctx.fillStyle = `rgba(6,10,18,${0.86 * a})`;
    ctx.font = `${11 * this.dpr}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.glyph ?? '·', p.x, p.y + 0.5 * this.dpr);

    // labels
    const labelY = p.y + base + 13 * this.dpr;
    ctx.fillStyle = `rgba(232,238,252,${(focused ? 1 : 0.8) * a})`;
    ctx.font = `700 ${9.4 * this.dpr}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.fillText(s.name.toUpperCase(), p.x, labelY);
    ctx.fillStyle = `hsla(${hue} 70% 74% / ${0.8 * a})`;
    ctx.font = `600 ${7.6 * this.dpr}px ui-monospace, monospace`;
    ctx.fillText((s.title ?? s.role ?? '').toUpperCase(), p.x, labelY + 9.6 * this.dpr);

    s._p = p;
    s._r = base + 6 * this.dpr;
  }

  /** Convenience for hit-testing after a pointer event. */
  seatFromEvent(evt) {
    const rect = this.c.getBoundingClientRect();
    const x = (evt.clientX - rect.left) * (this.c.width / rect.width);
    const y = (evt.clientY - rect.top) * (this.c.height / rect.height);
    return this.hit(x, y);
  }

  setMasterState(state) {
    this.masterState = state;
    if (state === 'listening') this.targetLevel = 0.22 + Math.random() * 0.1;
    if (state === 'idle') this.targetLevel = 0.06;
  }
}

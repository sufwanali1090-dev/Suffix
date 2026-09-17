/**
 * voices.js — nine distinct voices, plus the ears.
 *
 * Two engines, same queue:
 *   • `bridge` — an HTTP TTS server (Voicebox/Kokoro, or ElevenLabs behind a
 *     shim). Set TTS_BRIDGE_URL. Real audio → a Web Audio analyser drives the
 *     orb, so the orb pulses on the actual waveform.
 *   • `browser` — speechSynthesis, no install, no key, no network. Each agent
 *     gets a mapped system voice plus its own pitch/rate from the roster; if the
 *     machine is missing a matching name we still guarantee distinctness by
 *     rotating through whatever voices exist.
 *
 * Modes: master-only (the desk speaks as one) → all seats (each specialist reads
 * its own line) → muted. The operator picks how much personality they want.
 */
export const MODES = ['master', 'all', 'muted'];

export class Voices {
  constructor({ seats, master, onLevel, onSpeaking, onState } = {}) {
    this.seats = seats ?? [];
    this.master = master;
    this.onLevel = onLevel;
    this.onSpeaking = onSpeaking;
    this.onState = onState;
    this.mode = localStorage.getItem('desk.voice.mode') || 'master';
    this.voices = [];
    this.engine = 'browser';
    this.queue = [];
    this.busy = false;
    this.audio = null;
    this.ctx = null;
    this.analyser = null;
    this._level = 0;
    this.rec = null;
    this.bridge = false;
  }

  async init() {
    if ('speechSynthesis' in window) {
      this.voices = window.speechSynthesis.getVoices();
      if (!this.voices.length) {
        await new Promise((res) => {
          const to = setTimeout(res, 1200);
          window.speechSynthesis.onvoiceschanged = () => {
            clearTimeout(to);
            this.voices = window.speechSynthesis.getVoices();
            res();
          };
        });
      }
    }
    const probe = await fetch('/api/desk').then((r) => r.json()).catch(() => null);
    this.bridge = Boolean(probe?.config?.ttsBridge);
    this.engine = this.bridge ? 'bridge' : this.voices.length ? 'browser-speech' : 'silent';
    // Assign a distinct voice to every seat up front so the mapping is stable.
    const pool = this.voices.length ? this.voices : [];
    this.seats.forEach((s, i) => {
      const hint = s.voice?.voiceHint;
      const named = pool.find((v) => hint && v.name.toLowerCase().includes(hint.toLowerCase().split(' ')[0]));
      this.assign(s.id, named ?? pool[(i * 3 + 1) % Math.max(1, pool.length)] ?? null);
    });
    return { engine: this.engine, voices: pool.length, mode: this.mode };
  }

  assign(id, voice) {
    this.map = this.map || new Map();
    this.map.set(id, voice);
  }

  seatFor(id) {
    return this.seats.find((s) => s.id === id) ?? (id === 'friday' ? this.master : null) ?? { id, voice: {} };
  }

  cycleMode() {
    const i = MODES.indexOf(this.mode);
    this.mode = MODES[(i + 1) % MODES.length];
    localStorage.setItem('desk.voice.mode', this.mode);
    if (this.mode === 'muted') this.stop();
    return this.mode;
  }

  /**
   * @param {{agent:string,text:string}[]} lines
   */
  async enqueue(lines) {
    if (this.mode === 'muted') return { spoken: 0, muted: true };
    const wanted =
      this.mode === 'master'
        ? lines.filter((l) => l.agent === 'friday').slice(0, 1)
        : lines.filter((l) => l.text).slice(0, 1 + this.seats.length);
    this.queue.push(...wanted);
    if (!this.busy) this.drain();
    return { spoken: wanted.length, mode: this.mode };
  }

  async drain() {
    this.busy = true;
    while (this.queue.length) {
      const line = this.queue.shift();
      await this.speak(line.agent, line.text);
      await wait(140);
    }
    this.busy = false;
    this.onSpeaking?.(null);
    this.onLevel?.(0.06);
  }

  async speak(agentId, text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const seat = this.seatFor(agentId);
    const profile = seat?.voice ?? {};
    this.onSpeaking?.(agentId);
    this.onState?.(agentId, 'speaking');
    try {
      if (this.bridge) {
        await this.speakViaBridge(agentId, clean);
      } else if ('speechSynthesis' in window) {
        await this.speakViaBrowser(agentId, clean, profile);
      } else {
        // No TTS at all: the HUD still captions the reply, visibly.
        await wait(Math.min(2600, 220 + clean.length * 16));
      }
    } finally {
      this.onState?.(agentId, 'done');
    }
  }

  async speakViaBrowser(agentId, text, profile) {
    const u = new SpeechSynthesisUtterance(text);
    u.pitch = profile.pitch ?? 1;
    u.rate = profile.rate ?? 1;
    u.volume = 1;
    const assigned = this.map?.get(agentId);
    if (assigned) {
      u.voice = assigned;
      if (assigned.lang) u.lang = assigned.lang;
    } else if (profile.lang) u.lang = profile.lang;
    let raf = 0;
    let energy = 0.12;
    const tick = () => {
      energy += (0.1 + Math.random() * 0.16 - energy) * 0.24;
      this.onLevel?.(energy);
      raf = requestAnimationFrame(tick);
    };
    u.onboundary = () => {
      energy = 0.3 + Math.random() * 0.5;
    };
    raf = requestAnimationFrame(tick);
    await new Promise((res) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        this.onLevel?.(0.06);
        res();
      };
      u.onend = finish;
      u.onerror = finish;
      setTimeout(finish, 20000 + text.length * 55); // watchdog: some engines drop onend
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    });
  }

  async speakViaBridge(agentId, text) {
    // `voice` is the seat id (stable key for a TTS server); `hint` is the browser
    // voice name, for bridges that prefer to match on it.
    const seat = this.seatFor(agentId);
    const url =
      `/api/tts?text=${encodeURIComponent(text)}` +
      `&voice=${encodeURIComponent(agentId)}` +
      `&hint=${encodeURIComponent(seat?.voice?.voiceHint || '')}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return this.speakViaBrowser(agentId, text, this.seatFor(agentId)?.voice ?? {});
      const blob = await res.blob();
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const buf = await this.ctx.decodeAudioData(await blob.arrayBuffer());
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      this.analyser = this.analyser || this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      src.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      const data = new Uint8Array(this.analyser.frequencyBinCount);
      let raf = 0;
      const measure = () => {
        this.analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        this.onLevel?.(Math.min(1, Math.sqrt(sum / data.length) * 3.2 + 0.06));
        raf = requestAnimationFrame(measure);
      };
      raf = requestAnimationFrame(measure);
      await new Promise((res) => {
        src.onended = () => {
          cancelAnimationFrame(raf);
          res();
        };
        src.start();
      });
    } catch {
      await this.speakViaBrowser(agentId, text, this.seatFor(agentId)?.voice ?? {});
    }
  }

  stop() {
    this.queue = [];
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    this.audio?.pause?.();
    this.onSpeaking?.(null);
    this.busy = false;
  }

  // ── the ears ─────────────────────────────────────────────────────────────
  get sttSupported() {
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  listen({ onInterim, onFinal, onError } = {}) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return { ok: false, reason: 'no Web Speech STT in this browser — recording through whisper.cpp instead', fallback: true };
    const rec = new SR();
    rec.lang = 'en-US';
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let stopped = false;
    rec.onresult = (e) => {
      let interim = '';
      let final = '';
      for (const r of e.results) {
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (interim) onInterim?.(interim);
      if (final) onFinal?.(final.trim());
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed') onError?.('microphone permission denied');
      else if (!stopped) onError?.(e.error);
    };
    rec.onend = () => { if (!stopped) onInterim?.(''); };
    try {
      rec.start();
    } catch (err) {
      return { ok: false, reason: String(err?.message || err) };
    }
    return {
      ok: true,
      stop: () => {
        stopped = true;
        try { rec.stop(); } catch { /* already stopped */ }
      },
    };
  }

  /** Fallback path: record, hand the clip to whisper.cpp, get text back. */
  async recordAndTranscribe({ onState } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('no microphone access in this context');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mr = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '' });
    const chunks = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.start();
    onState?.('recording');
    await new Promise((r) => setTimeout(r, 3500));
    const stopped = new Promise((r) => (mr.onstop = r));
    mr.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
    const base64 = btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
    onState?.('transcribing');
    const out = await fetch('/api/mic', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio: base64, mimetype: mr.mimeType || 'audio/webm' }),
    }).then((r) => r.json());
    onState?.('idle');
    if (!out.ok) throw new Error(out.reason || out.error || 'transcription unavailable');
    return out.text;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

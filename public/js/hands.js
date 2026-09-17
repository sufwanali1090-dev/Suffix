/**
 * hands.js — steering the orb with bare hands (MediaPipe, in the browser).
 *
 * Gestures, deliberately few and unambiguous:
 *   hover  → the orb leans toward your index fingertip; the nearest seat lights
 *   pinch  → grab: focus the seat you are pointing at
 *   swipe  → open hand moving fast sideways: flip to the next / previous symbol
 *   fist   → release focus
 *
 * Everything loads lazily from a CDN and everything degrades: if the model, the
 * camera, or the sandbox policy is unavailable, the button explains why and the
 * desk stays fully usable with mouse and keys. The camera never leaves the
 * page — landmarks are computed locally and only the gesture is sent anywhere.
 */
const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const CONNECTIONS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

export async function enableHands({ videoEl, canvasEl, onSteer, onPinch, onSwipe, onFist } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('this context blocks camera access');
  let mod;
  try {
    mod = await import(/* @vite-ignore */ `${CDN}/vision_bundle.mjs`);
  } catch {
    throw new Error('MediaPipe could not load from the CDN (offline?)');
  }
  const { HandLandmarker, FilesetResolver } = mod;
  const vision = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
  const landmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 1,
  });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: 'user' } });
  videoEl.srcObject = stream;
  await videoEl.play().catch(() => {});
  videoEl.muted = true;

  const ctx = canvasEl?.getContext('2d') ?? null;
  let raf = 0;
  let stopped = false;
  let wasPinching = false;
  let xTrail = [];
  let lastSwipeAt = 0;
  let fistFrames = 0;

  const frame = async () => {
    if (stopped) return;
    if (videoEl.readyState >= 2) {
      let res = null;
      try {
        res = landmarker.detectForVideo(videoEl, performance.now());
      } catch { /* transient decode errors are fine */ }
      const lm = res?.landmarks?.[0];
      if (lm && ctx) paint(lm);
      if (lm) {
        const tip = lm[8];
        const thumb = lm[4];
        const mcp = lm[5];
        const pinch = Math.hypot(tip.x - thumb.x, tip.y - thumb.y);
        const open = lm.filter((p, i) => [4, 8, 12, 16, 20].includes(i)).reduce((s, p) => s + Math.hypot(p.x - mcp.x, p.y - mcp.y), 0) / 5;

        // mirrored so moving your hand right moves the orb right
        onSteer?.(-(tip.x - 0.5) * 2, (tip.y - 0.5) * 2);

        const isPinching = pinch < 0.055;
        if (isPinching && !wasPinching) onPinch?.(true, { x: tip.x, y: tip.y });
        if (!isPinching && wasPinching) onPinch?.(false);
        wasPinching = isPinching;

        xTrail.push({ x: tip.x, t: performance.now() });
        xTrail = xTrail.filter((p) => performance.now() - p.t < 260);
        if (xTrail.length > 4) {
          const dx = xTrail[xTrail.length - 1].x - xTrail[0].x;
          const dt = (xTrail[xTrail.length - 1].t - xTrail[0].t) / 1000;
          const v = dx / Math.max(0.05, dt);
          if (Math.abs(v) > 1.15 && open > 0.16 && performance.now() - lastSwipeAt > 900) {
            lastSwipeAt = performance.now();
            onSwipe?.(v > 0 ? -1 : 1); // mirrored
            xTrail = [];
          }
        }

        const fist = open < 0.075;
        fistFrames = fist ? fistFrames + 1 : 0;
        if (fistFrames === 14) onFist?.();
      } else if (ctx) {
        ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      }
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  function paint(lm) {
    const w = (canvasEl.width = videoEl.videoWidth || 320);
    const h = (canvasEl.height = videoEl.videoHeight || 240);
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.strokeStyle = 'rgba(47,224,138,.75)';
    ctx.lineWidth = 1.6;
    for (const [a, b] of CONNECTIONS) {
      ctx.beginPath();
      ctx.moveTo(lm[a].x * w, lm[a].y * h);
      ctx.lineTo(lm[b].x * w, lm[b].y * h);
      ctx.stroke();
    }
    ctx.fillStyle = '#ffcb52';
    for (const p of lm) {
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  frame();
  return {
    disable() {
      stopped = true;
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((t) => t.stop());
      try { videoEl.srcObject = null; } catch { /* already gone */ }
      landmarker.close();
      ctx?.clearRect(0, 0, canvasEl?.width ?? 0, canvasEl?.height ?? 0);
    },
  };
}

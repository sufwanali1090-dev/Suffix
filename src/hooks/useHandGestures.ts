/**
 * MediaPipe hand tracking → desk gestures.
 *
 * Model: MediaPipe **Hand Landmarker** (21 landmarks, VIDEO mode)
 *   https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker
 *
 * Requirements are wired in the order they actually bite:
 *   1. Camera permission — Electron denies it by default; `electron/main.ts`
 *      installs a permission handler that grants `media`/`camera`.
 *   2. WASM asset root — fetched from the jsDelivr CDN pinned to the installed
 *      `@mediapipe/tasks-vision` version so the runtime matches the model.
 *   3. The `.task` model bundle, also pinned.
 *
 * Gesture grammar (deliberately small and unambiguous):
 *   open_palm    → pause the desk / hold streaming
 *   closed_fist  → resume
 *   swipe_left   → cycle telemetry focus backwards
 *   swipe_right  → cycle telemetry focus forwards
 *   pinch        → request a spoken briefing
 *   thumbs_up    → build and adjudicate a proposal
 *   thumbs_down  → flatten everything
 *   victory      → show QUANTUM generation state
 *
 * Classification is geometric (finger extension ratios + wrist kinematics)
 * rather than a second model, so the hook has no extra model download and every
 * decision is inspectable. A confidence score and a per-gesture cooldown keep it
 * from firing spuriously.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GestureName } from '@/types/contract';

type HandLandmarker = any; // @mediapipe/tasks-vision is loaded lazily

export interface HandGesturesOptions {
  enabled: boolean;
  videoRef: React.RefObject<HTMLVideoElement>;
  canvasRef?: React.RefObject<HTMLCanvasElement>;
  /** Minimum classifier confidence before a gesture is emitted. */
  confidenceThreshold?: number;
  /** Cooldown per gesture, milliseconds. */
  cooldownMs?: number;
  onGesture?: (gesture: GestureName, score: number) => void;
  onFrame?: (info: { hands: number; landmarks: number[][] | null }) => void;
  modelUrl?: string;
  wasmRoot?: string;
}

export interface HandGesturesState {
  ready: boolean;
  loading: boolean;
  error: string | null;
  handsVisible: number;
  gesture: GestureName;
  score: number;
  fps: number;
  start: () => Promise<void>;
  stop: () => void;
}

const DEFAULT_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// Pinned to the installed tasks-vision build; a version skew between the WASM
// loader and the model bundle is the most common cause of silent no-detections.
const TASKS_VISION_VERSION = '0.10.14';
const DEFAULT_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;

/** Landmark indices we care about. */
const TIP = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
const PIP = { thumb: 2, index: 6, middle: 10, ring: 14, pinky: 18 };
const MCP = { index: 5, middle: 9, ring: 13, pinky: 17 };

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] ?? 0) - (b[2] ?? 0));

/**
 * A finger counts as extended when its tip is further from the wrist than its
 * PIP joint, measured along the finger axis. Ratio-based tests are far more
 * robust to hand size and camera distance than absolute distances.
 */
function fingerExtended(lm: number[][], tip: number, pip: number, mcp: number): boolean {
  const wrist = lm[0];
  const tipD = dist(lm[tip], wrist);
  const pipD = dist(lm[pip], wrist);
  const mcpD = dist(lm[mcp], wrist);
  const straight = tipD > pipD * 1.12;
  const away = dist(lm[tip], lm[mcp]) > dist(lm[pip], lm[mcp]) * 1.05;
  return straight && away && mcpD > 0;
}

function thumbExtended(lm: number[][]): boolean {
  const wrist = lm[0];
  return dist(lm[TIP.thumb], wrist) > dist(lm[PIP.thumb], lm[MCP.index]) * 1.35;
}

interface HandFeatures {
  extended: boolean[];
  cursor: { x: number; y: number };
  pinchDist: number;
  palmWidth: number;
  pointingUp: number;
}

function extractFeatures(lm: number[][]): HandFeatures {
  const extended = [
    thumbExtended(lm),
    fingerExtended(lm, TIP.index, PIP.index, MCP.index),
    fingerExtended(lm, TIP.middle, PIP.middle, MCP.middle),
    fingerExtended(lm, TIP.ring, PIP.ring, MCP.ring),
    fingerExtended(lm, TIP.pinky, PIP.pinky, MCP.pinky),
  ];
  const palmWidth = Math.max(dist(lm[0], lm[MCP.index]), 1e-6);
  // Normalise the pinch by palm width so it works at any distance from camera.
  const pinchDist = dist(lm[TIP.thumb], lm[TIP.index]) / palmWidth;
  const pointingUp = lm[0][1] - lm[9][1]; // negative when the hand points up
  return {
    extended,
    cursor: { x: lm[9][0], y: lm[9][1] },
    pinchDist,
    palmWidth,
    pointingUp,
  };
}

export function useHandGestures(options: HandGesturesOptions): HandGesturesState {
  const {
    enabled,
    videoRef,
    canvasRef,
    confidenceThreshold = 0.72,
    cooldownMs = 1100,
    onGesture,
    onFrame,
    modelUrl = DEFAULT_MODEL,
    wasmRoot = DEFAULT_WASM,
  } = options;

  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const rafRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastVideoTimeRef = useRef(-1);
  const wristHistoryRef = useRef<Array<{ x: number; t: number }>>([]);
  const lastFireRef = useRef<Record<string, number>>({});
  const stableRef = useRef<{ gesture: GestureName; count: number }>({ gesture: 'none', count: 0 });
  const fpsRef = useRef<number[]>([]);

  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handsVisible, setHandsVisible] = useState(0);
  const [gesture, setGesture] = useState<GestureName>('none');
  const [score, setScore] = useState(0);
  const [fps, setFps] = useState(0);

  const onGestureRef = useRef(onGesture);
  const onFrameRef = useRef(onFrame);
  useEffect(() => {
    onGestureRef.current = onGesture;
    onFrameRef.current = onFrame;
  }, [onGesture, onFrame]);

  const cooldownOk = useCallback(
    (name: GestureName): boolean => {
      const now = performance.now();
      const last = lastFireRef.current[name] ?? 0;
      if (now - last < cooldownMs) return false;
      lastFireRef.current[name] = now;
      return true;
    },
    [cooldownMs],
  );

  const drawOverlay = useCallback(
    (landmarks: number[][] | null) => {
      const canvas = canvasRef?.current;
      const video = videoRef.current;
      if (!canvas || !video) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const w = (canvas.width = video.videoWidth || 640);
      const h = (canvas.height = video.videoHeight || 480);
      ctx.clearRect(0, 0, w, h);
      if (!landmarks) return;

      // Skeleton: palm ring + five finger chains.
      const chains = [
        [0, 1, 2, 3, 4],
        [0, 5, 6, 7, 8],
        [0, 9, 10, 11, 12],
        [0, 13, 14, 15, 16],
        [0, 17, 18, 19, 20],
        [5, 9, 13, 17, 5],
      ];
      ctx.lineWidth = Math.max(2, w / 320);
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.85)';
      ctx.shadowColor = 'rgba(34, 211, 238, 0.9)';
      ctx.shadowBlur = 12;
      for (const chain of chains) {
        ctx.beginPath();
        chain.forEach((idx, i) => {
          const [x, y] = landmarks[idx];
          if (i === 0) ctx.moveTo(x * w, y * h);
          else ctx.lineTo(x * w, y * h);
        });
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(165, 243, 252, 0.95)';
      for (const [x, y] of landmarks) {
        ctx.beginPath();
        ctx.arc(x * w, y * h, Math.max(2, w / 260), 0, Math.PI * 2);
        ctx.fill();
      }
    },
    [canvasRef, videoRef],
  );

  /**
   * Map landmarks → gesture. Returns the best candidate and its confidence.
   * Swipes are detected from wrist/middle-MCP x kinematics over a short window.
   */
  const classify = useCallback(
    (lm: number[][]): { gesture: GestureName; score: number } => {
      const f = extractFeatures(lm);
      const [thumb, index, middle, ring, pinky] = f.extended;
      const extendedCount = f.extended.filter(Boolean).length;

      // ---- kinematic swipe detection on the palm centre -------------------
      const now = performance.now();
      const centre = lm[9];
      const history = wristHistoryRef.current;
      history.push({ x: centre[0], t: now });
      while (history.length && now - history[0].t > 420) history.shift();
      if (history.length >= 4) {
        const first = history[0];
        const last = history[history.length - 1];
        const dx = last.x - first.x;
        const dt = last.t - first.t;
        const horizontal = Math.abs(dx) / Math.max(dt, 1);
        if (Math.abs(dx) > 0.20 && horizontal > 0.0006) {
          // A swipe is only meaningful with an open-ish hand, otherwise a
          // fist drag reads as a swipe.
          if (extendedCount >= 3) {
            history.length = 0;
            return { gesture: dx > 0 ? 'swipe_right' : 'swipe_left', score: 0.86 };
          }
        }
      }

      // ---- static poses ----------------------------------------------------
      if (extendedCount === 0 && !thumb) {
        return { gesture: 'closed_fist', score: 0.9 };
      }
      if (f.extended.every(Boolean)) {
        return { gesture: 'open_palm', score: 0.93 };
      }
      if (index && middle && !ring && !pinky && !thumb) {
        return { gesture: 'victory', score: 0.88 };
      }
      if (thumb && !index && !middle && !ring && !pinky) {
        // Thumb out and pointing up vs down decides the direction.
        return { gesture: f.pointingUp < 0 ? 'thumbs_up' : 'thumbs_down', score: 0.85 };
      }
      // Pinch: thumb tip close to index tip, measured in palm widths.
      if (f.pinchDist < 0.42 && !middle && !ring && !pinky) {
        return { gesture: 'pinch', score: Math.min(0.95, 1 - f.pinchDist) };
      }
      if (index && !middle && !ring && !pinky) {
        return { gesture: 'none', score: 0.2 }; // pointing: reserved, no action
      }
      return { gesture: 'none', score: 0 };
    },
    [],
  );

  const loop = useCallback(() => {
    const video = videoRef.current;
    const landmarker = landmarkerRef.current;
    if (!video || !landmarker) return;

    if (video.readyState >= 2 && video.currentTime !== lastVideoTimeRef.current) {
      lastVideoTimeRef.current = video.currentTime;
      let result: any = null;
      try {
        result = landmarker.detectForVideo(video, performance.now());
      } catch (err) {
        // A transient decode failure must not kill the render loop.
        result = null;
      }

      const landmarks = result?.landmarks?.[0] as number[][] | undefined;
      setHandsVisible(result?.landmarks?.length ?? 0);
      drawOverlay(landmarks ?? null);
      onFrameRef.current?.({
        hands: result?.landmarks?.length ?? 0,
        landmarks: landmarks ?? null,
      });

      if (landmarks) {
        const candidate = classify(landmarks);
        setScore(candidate.score);
        if (candidate.gesture === 'none') {
          stableRef.current = { gesture: 'none', count: 0 };
          setGesture('none');
        } else {
          // Require two consecutive agreeing frames: kills single-frame jitter.
          if (stableRef.current.gesture === candidate.gesture) {
            stableRef.current.count += 1;
          } else {
            stableRef.current = { gesture: candidate.gesture, count: 1 };
          }
          setGesture(candidate.gesture);
          if (
            stableRef.current.count >= 2 &&
            candidate.score >= confidenceThreshold &&
            cooldownOk(candidate.gesture)
          ) {
            onGestureRef.current?.(candidate.gesture, candidate.score);
          }
        }
      } else {
        stableRef.current = { gesture: 'none', count: 0 };
        setGesture('none');
      }
    }

    const now = performance.now();
    fpsRef.current.push(now);
    fpsRef.current = fpsRef.current.filter((t) => now - t < 1000);
    setFps(Math.round(fpsRef.current.length));

    rafRef.current = requestAnimationFrame(loop);
  }, [videoRef, drawOverlay, classify, confidenceThreshold, cooldownOk]);

  const start = useCallback(async () => {
    if (ready || loading) return;
    setLoading(true);
    setError(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('getUserMedia unavailable (camera access requires a secure context)');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: 'user' },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error('video element not mounted');
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      await new Promise<void>((resolve) => {
        if (video.videoWidth > 0) return resolve();
        video.onloadedmetadata = () => resolve();
      });

      const vision = await import('@mediapipe/tasks-vision');
      const fileset = await vision.FilesetResolver.forVisionTasks(wasmRoot);
      const landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelUrl, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.55,
      });
      landmarkerRef.current = landmarker;
      setReady(true);
      rafRef.current = requestAnimationFrame(loop);
    } catch (err) {
      const message = (err as Error).message || 'gesture engine failed to start';
      setError(message);
      // Release a half-acquired camera so the LED does not stay lit on failure.
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    } finally {
      setLoading(false);
    }
  }, [ready, loading, videoRef, wasmRoot, modelUrl, loop]);

  const stop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    try {
      landmarkerRef.current?.close?.();
    } catch {
      /* already closed */
    }
    landmarkerRef.current = null;
    const video = videoRef.current;
    if (video) video.srcObject = null;
    wristHistoryRef.current = [];
    stableRef.current = { gesture: 'none', count: 0 };
    setReady(false);
    setHandsVisible(0);
    setGesture('none');
    setScore(0);
    setFps(0);
  }, [videoRef]);

  // Start/stop follows the `enabled` flag so the camera light is honest.
  useEffect(() => {
    if (enabled && !ready && !loading && !error) void start();
    if (!enabled && ready) stop();
    // `error` intentionally excluded: a failed start must not silently retry
    // in a loop — the UI surfaces the error and offers an explicit retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ready, loading]);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  return useMemo(
    () => ({ ready, loading, error, handsVisible, gesture, score, fps, start, stop }),
    [ready, loading, error, handsVisible, gesture, score, fps, start, stop],
  );
}

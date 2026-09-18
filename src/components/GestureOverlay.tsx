/**
 * MediaPipe gesture overlay.
 *
 * A picture-in-picture camera feed with the hand skeleton drawn on a canvas by
 * `useHandGestures`, plus the current gesture, confidence and the last actions
 * the desk took in response. Deliberately small and out of the way: it is an
 * input device, not the show.
 */

import { useEffect, useRef } from 'react';
import { clsx } from 'clsx';
import type { GestureFlash, GestureName } from '@/types/contract';

const GESTURE_LABEL: Record<GestureName, { label: string; action: string }> = {
  open_palm: { label: 'OPEN PALM', action: 'pause desk' },
  closed_fist: { label: 'FIST', action: 'resume desk' },
  swipe_left: { label: 'SWIPE ←', action: 'previous agent' },
  swipe_right: { label: 'SWIPE →', action: 'next agent' },
  pinch: { label: 'PINCH', action: 'spoken briefing' },
  thumbs_up: { label: 'THUMB UP', action: 'propose trade' },
  thumbs_down: { label: 'THUMB DOWN', action: 'flatten all' },
  victory: { label: 'VICTORY', action: 'quantum state' },
  none: { label: 'NO HAND', action: '—' },
};

export function GestureOverlay({
  videoRef,
  canvasRef,
  gesture,
  score,
  handsVisible,
  fps,
  ready,
  loading,
  error,
  enabled,
  onToggle,
  onRetry,
  flashes,
}: {
  videoRef: React.RefObject<HTMLVideoElement>;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  gesture: GestureName;
  score: number;
  handsVisible: number;
  fps: number;
  ready: boolean;
  loading: boolean;
  error: string | null;
  enabled: boolean;
  onToggle: () => void;
  onRetry: () => void;
  flashes: GestureFlash[];
}) {
  const active = GESTURE_LABEL[gesture] ?? GESTURE_LABEL.none;
  const live = ready && enabled && !error;
  const lastFlash = useRef<GestureFlash | null>(null);
  lastFlash.current = flashes[0] ?? null;

  return (
    <div className="panel overflow-hidden">
      <div className="panel-header">
        <span className="panel-title">Hand Track — MediaPipe</span>
        <div className="flex items-center gap-1.5">
          {live && <span className="chip border-bull/35 bg-bull/10 text-bull">{fps} fps</span>}
          <button
            className={clsx('btn no-drag px-2 py-0.5 text-[9px]', enabled && 'btn-warn')}
            onClick={onToggle}
          >
            {enabled ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      <div className="relative aspect-video w-full bg-black/60">
        <video
          ref={videoRef}
          playsInline
          muted
          className={clsx(
            'h-full w-full scale-x-[-1] object-cover transition-opacity duration-300',
            live ? 'opacity-70' : 'opacity-0',
          )}
        />
        <canvas
          ref={canvasRef}
          className={clsx(
            'pointer-events-none absolute inset-0 h-full w-full scale-x-[-1]',
            live ? 'opacity-100' : 'opacity-0',
          )}
        />

        {!live && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center">
            {loading ? (
              <>
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-signal-400/30 border-t-signal-400" />
                <span className="font-mono text-[10px] text-slate-500">loading landmarker…</span>
              </>
            ) : error ? (
              <>
                <span className="font-mono text-[10px] text-caution">camera unavailable</span>
                <span className="max-w-[240px] text-[9px] leading-snug text-slate-600">{error}</span>
                <button className="btn no-drag mt-1 px-2 py-1 text-[9px]" onClick={onRetry}>
                  RETRY
                </button>
              </>
            ) : (
              <>
                <span className="font-mono text-[10px] text-slate-500">hand tracking disabled</span>
                <span className="max-w-[250px] text-[9px] leading-snug text-slate-600">
                  Enable the camera to drive the desk by gesture — swipe to cycle agents,
                  open palm to pause.
                </span>
                <button className="btn no-drag mt-1 px-2.5 py-1 text-[9px]" onClick={onToggle}>
                  ENABLE
                </button>
              </>
            )}
          </div>
        )}

        {live && (
          <div className="absolute left-2 top-2 rounded border border-signal-400/25 bg-black/70 px-2 py-1 backdrop-blur">
            <div className="font-mono text-[10px] tracking-[0.16em] text-signal-200">{active.label}</div>
            <div className="font-mono text-[8px] text-slate-500">
              {handsVisible} hand{handsVisible === 1 ? '' : 's'} · {active.action} ·{' '}
              {(score * 100).toFixed(0)}%
            </div>
          </div>
        )}
      </div>

      {flashes.length > 0 && (
        <div className="max-h-[76px] space-y-px overflow-y-auto border-t border-white/5 px-2 py-1.5">
          {flashes.slice(0, 4).map((f, i) => (
            <div key={`${f.ts}-${i}`} className="flex items-center justify-between font-mono text-[9px]">
              <span className="text-slate-500">
                {GESTURE_LABEL[f.gesture]?.label ?? f.gesture}
              </span>
              <span className="text-signal-200/80">{f.action}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

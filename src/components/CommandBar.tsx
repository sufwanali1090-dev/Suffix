/**
 * Command bar — typed natural-language control of the desk.
 *
 * The grammar lives server-side (`SuffoOrchestrator.handle_command`), so the
 * same text routing applies whether the operator typed it, said it, or a
 * gesture triggered it. The bar just ships the string and renders the result.
 */

import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';

const HINTS = [
  'brief me',
  'what do you think of SOL-USD',
  'should i trade',
  'how much am i risking',
  'macro read',
  'chart the levels',
  'quantum status',
  'take a long BTC-USD',
  'flatten everything',
  'kill switch',
];

export function CommandBar({
  onSubmit,
  onVoice,
  busy,
  listening,
  voiceAvailable,
}: {
  onSubmit: (text: string) => void;
  onVoice: () => void;
  busy: string | null;
  listening: boolean;
  voiceAvailable: boolean;
}) {
  const [value, setValue] = useState('');
  const [hintIndex, setHintIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Rotate placeholder hints so the command grammar is discoverable.
  useEffect(() => {
    const t = setInterval(() => setHintIndex((i) => (i + 1) % HINTS.length), 4200);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <form
      className="panel flex items-center gap-2 px-2.5 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim() || busy) return;
        onSubmit(value.trim());
        setValue('');
      }}
    >
      <span className="pl-1 font-mono text-[11px] text-signal-400/70">›</span>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={`Speak or type… e.g. "${HINTS[hintIndex]}"`}
        spellCheck={false}
        autoComplete="off"
        className="no-drag min-w-0 flex-1 bg-transparent font-mono text-[12px] text-slate-100
                   placeholder:text-slate-600 focus:outline-none"
      />

      {busy && (
        <span className="hidden shrink-0 items-center gap-1.5 font-mono text-[10px] text-signal-200 md:flex">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal-400" />
          {busy}
        </span>
      )}

      <button
        type="button"
        onClick={onVoice}
        disabled={!voiceAvailable}
        title={voiceAvailable ? 'Push to talk (Ctrl/Cmd+Shift+Space)' : 'whisper.cpp sidecar not running'}
        className={clsx(
          'btn no-drag shrink-0 px-2.5',
          listening && 'btn-warn animate-pulse',
          !voiceAvailable && 'opacity-30',
        )}
      >
        {listening ? '● REC' : '🎙'}
      </button>

      <button type="submit" className="btn no-drag shrink-0 px-3" disabled={!value.trim() || Boolean(busy)}>
        SEND
      </button>
    </form>
  );
}

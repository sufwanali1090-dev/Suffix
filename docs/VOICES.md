# Voices and ears

Nine agents that all read like the same narrator are nine tabs in one chat window.
Distinctness here comes from three things: a voice, a pitch/rate, and *when* a seat is
allowed to talk. The last one matters most — the master answers by default; you switch on
per-seat voices for the demo, not for every query.

## What runs by default (zero install, zero keys)

`public/js/voices.js` uses the browser's `speechSynthesis`, and gives each seat the profile
declared in `server/agents/roster.js`:

| seat | hint (matched against installed voices) | pitch | rate | feel |
| --- | --- | --- | --- | --- |
| F.R.I.D.A.Y. (master) | Daniel | 0.92 | 1.02 | measured, unhurried, British |
| ATLAS · macro | Google UK English Male | 0.78 | 0.94 | low and slow — the tide |
| CAPITOL · smart money | Fred | 0.68 | 0.90 | quiet, deliberate, slightly sly |
| SCOUT · recon | Alex | 1.18 | 1.16 | fast, bright, interrupting |
| ATHENA · analyst | Karen | 0.95 | 0.98 | dry, exact, Australian |
| CHARTIST · technician | Rocko | 0.62 | 1.06 | gruff, terse, all verbs |
| ORACLE · quant | Whisper | 1.45 | 1.10 | breathy, precise, unbothered |
| SENTINEL · risk | Albert | 0.55 | 0.86 | the slowest voice on the desk. It has never needed to be fast |
| PILOT · execution | Rishi | 0.88 | 1.08 | crisp, transactional |
| LEDGER · the book | Grandpa | 0.60 | 0.84 | archival, unimpressed |

If a name isn't installed, `Voices.init()` rotates through whatever voices exist so seats
stay distinct anyway — the mapping is stable across reloads, so ATLAS keeps its voice.

Three speaking modes, cycled with the 🔊 button or `m`:

* **master** — F.R.I.D.A.Y. alone reads the synthesized answer (default: fastest to work with);
* **all seats** — the master speaks, then each specialist that answered reads its own line in
  its own voice. This is the mode that makes the desk sound like a room;
* **muted** — captions only. The HUD never depends on audio to be useful.

While a line is spoken, `onLevel()` feeds the orb: with `speechSynthesis` we drive the pulse
from word-boundary events; with a real audio bridge we drive it from an `AnalyserNode`, so the
orb moves on the actual waveform (`orb.js`).

## Local TTS — the upgrade that stays free ($0)

Any HTTP server that answers `{text, voice, format} → audio` works. Point the desk at it:

```bash
# .env
TTS_BRIDGE_URL=http://127.0.0.1:8880/speak
TTS_DEFAULT_FORMAT=wav
```

The server proxies it at `GET /api/tts?text=…&voice=…` (see `server/index.js` →
`ttsProxy`) so the HUD stays same-origin — no CORS, no keys in the browser.

A ~25-line Kokoro shim, if you would rather not install someone's GUI:

```python
# pip install "kokoro>=0.6" soundfile flask
# python3 kokoro-bridge.py        →  POST http://127.0.0.1:8880/speak
from flask import Flask, request, Response
from kokoro import KPipeline
import io, soundfile as sf

# speaker ids come from the Kokoro model card — swap to taste; the point is
# one distinct, stable voice per seat, not these particular ten.
SEATS = {
  "friday":   ("b", "bm_george"),   # master — warm, deliberate
  "atlas":    ("b", "bf_emma"),     # macro — low, even
  "capitol":  ("a", "am_echo"),      # smart money — drawling
  "scout":    ("a", "af_sky"),       # recon — quick, bright
  "athena":   ("e", "ef_dora"),      # analyst — dry, exact
  "chartist": ("a", "am_michael"),   # technician — gruff
  "oracle":   ("a", "af_sarah"),      # quant — flat, precise
  "sentinel": ("a", "am_adam"),      # risk — the slowest on the desk
  "pilot":    ("i", "af_nicole"),    # execution — crisp
  "ledger":   ("a", "am_omnia"),     # the book — archival
}
app = Flask(__name__)
pipes = {}

def pipe_for(lang):
    if lang not in pipes:
        pipes[lang] = KPipeline(lang_code=lang)
    return pipes[lang]

@app.post("/speak")
def speak():
    j = request.json or {}
    lang, speaker = SEATS.get(j.get("voice", "friday"), ("a", "af_heart"))
    buf = io.BytesIO()
    with sf.SoundFile(buf, "w", samplerate=24000, channels=1, format="WAV") as f:
        for _, _, audio in pipe_for(lang)(j.get("text", ""), voice=speaker, speed=0.95):
            f.write(audio)
    return Response(buf.getvalue(), mimetype="audio/wav")

app.run(port=8880)
```

`server/agent-service.js` and the HUD both pass the seat **id** as `voice`, which is why the
map above is keyed by id rather than by the browser voice names.

Anything that returns `audio/*` works, including an ElevenLabs shim behind the same route —
that's the paid polish option, and it is deliberately *not* required: ~2 s per clip on Kokoro
is fast enough for a desk that thinks in seconds.

## The ears

**Default:** the browser's `SpeechRecognition` (Chrome/Edge/Safari). Push to talk on the orb
button or `space`; interim transcripts paint on the orb's subtitle line while you speak, and
the final transcript is the command.

**Local, private, no per-minute fees:** whisper.cpp. Set the binary and the desk gets
`POST /api/mic`:

```bash
brew install whisper-cpp            # or build from github.com/ggerganov/whisper.cpp
# .env
WHISPER_BIN=/opt/homebrew/bin/whisper-cli
WHISPER_MODEL=ggml-small.bin        # lives next to the binary, or use an absolute path
WHISPER_ARGS=--language en --model ./WHISPER_MODEL --no-prints --output-txt
```

If the browser has no speech engine (Firefox, some Linux builds), `Voices.recordAndTranscribe()`
records ~3.5 s of `audio/webm`, base64s it to `/api/mic`, and the server runs whisper on it. Same
UX, different engine. `small` is the right model for this: commands are short and full of tickers;
`large-v3` mostly buys you slower turn-taking.

Practical notes:

* say the ticker the way you'd type it — "N V D A" beats "Nvidia" for accuracy on small models;
* `--language en` avoids the model guessing Polish from a two-word utterance;
* the transcript is not trusted on its own: `extractSymbol()`/`extractParams()` in
  `master.js` re-parse it, and anything ambiguous routes to the safest seat (analysis, never
  execution). "buy" with no symbol is a blocked draft, not a market order.

## Troubleshooting

| symptom | cause | fix |
| --- | --- | --- |
| no audio at all | browsers gate `speechSynthesis` behind a user gesture | click the desk once, then press `space` and speak |
| one voice for everyone | only one system voice installed | install more, or wire the TTS bridge above |
| voices drift after reload | OS reordered its voice list | mapping is by `voiceHint`, then index — pin it in `roster.js` |
| orb doesn't pulse | speech-driven amplitude needs real audio | expected with `speechSynthesis` boundary mode; use the bridge for waveform |
| mic never fires | page not served over https/localhost | `localhost` (or the sandbox preview host) is fine; a LAN IP is not |
| whisper returns nothing | model path resolved against the wrong cwd | use an absolute `WHISPER_MODEL` |

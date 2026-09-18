"""Speech-to-text via whisper.cpp (https://github.com/ggerganov/whisper.cpp).

Two transports, tried in order:

1. **HTTP** — the ``whisper-server`` example (``--server --port 8082``) exposes a
   multipart ``/inference`` endpoint.  Cheaper: the model stays resident.
2. **CLI**  — ``whisper-cli -m <model> -f <wav> -otxt`` for one-shot jobs when
   the server is not running.

Both are optional.  When neither is reachable, ``transcribe`` raises a
``SpeechUnavailable`` error which the WebSocket layer converts into a typed
error frame — the HUD then simply disables the push-to-talk affordance.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

from server.config import ROOT_DIR, settings

log = logging.getLogger("suffix.stt")


class SpeechUnavailable(RuntimeError):
    """Raised when no STT backend can service a request."""


class SpeechToText:
    def __init__(self) -> None:
        self.backend = settings.suffix_stt_backend
        self.url = settings.whisper_cpp_url
        self.bin = (ROOT_DIR / settings.whisper_cpp_bin) if not os.path.isabs(settings.whisper_cpp_bin) else Path(settings.whisper_cpp_bin)
        self.model = (ROOT_DIR / settings.whisper_cpp_model) if not os.path.isabs(settings.whisper_cpp_model) else Path(settings.whisper_cpp_model)

    # ------------------------------------------------------------------ health
    def health(self) -> Dict[str, Any]:
        http_ok = False
        try:
            import httpx

            base = self.url.rsplit("/inference", 1)[0]
            resp = httpx.get(base, timeout=3.0)
            http_ok = resp.status_code < 500
        except Exception:  # noqa: BLE001
            http_ok = False
        return {
            "backend": self.backend,
            "http_server": http_ok,
            "http_url": self.url,
            "cli_binary": str(self.bin),
            "cli_present": self.bin.exists() and os.access(self.bin, os.X_OK),
            "model": str(self.model),
            "model_present": self.model.exists(),
            "ready": self.backend != "disabled" and (http_ok or (self.bin.exists() and self.model.exists())),
        }

    # ------------------------------------------------------------ transcription
    async def transcribe(self, audio: bytes, *, language: str = "en",
                         content_type: str = "audio/wav") -> Dict[str, Any]:
        """Transcribe raw audio bytes, returning text + confidence metadata."""
        if self.backend == "disabled":
            raise SpeechUnavailable("STT backend disabled (SUFFIX_STT_BACKEND=disabled)")
        if not audio:
            raise SpeechUnavailable("empty audio payload")

        ext = ".webm" if "webm" in content_type else ".ogg" if "ogg" in content_type else ".wav"
        tmp_dir = Path(tempfile.mkdtemp(prefix="suffix-stt-"))
        src = tmp_dir / f"input{ext}"
        src.write_bytes(audio)
        try:
            wav = await self._ensure_wav(src)
            text = None
            http_err: Optional[str] = None
            if self.health().get("http_server"):
                try:
                    text = await self._http_infer(wav, language)
                except Exception as exc:  # noqa: BLE001
                    http_err = str(exc)
                    log.debug("whisper.cpp HTTP inference failed: %s", exc)
            if text is None:
                text = await self._cli_infer(wav, language)
            cleaned = " ".join(str(text).strip().split())
            return {"text": cleaned, "backend": f"whisper.cpp/{self.backend}",
                    "language": language, "empty": not cleaned,
                    "note": http_err}
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    async def _ensure_wav(self, src: Path) -> Path:
        """whisper.cpp wants 16 kHz mono PCM; convert with ffmpeg when present."""
        if src.suffix == ".wav":
            return src
        wav = src.with_suffix(".wav")
        if shutil.which("ffmpeg") is None:
            # No ffmpeg: hand the raw container over and let whisper.cpp try.
            return src
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(src), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(wav),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        _, err = await asyncio.wait_for(proc.communicate(), timeout=45.0)
        if proc.returncode != 0:
            log.debug("ffmpeg failed (%s); attempting raw decode", err.decode(errors="replace")[:200])
            return src
        return wav

    async def _http_infer(self, wav: Path, language: str) -> str:
        import httpx

        with wav.open("rb") as fh:
            files = {"file": (wav.name, fh, "audio/wav")}
            data = {"temperature": "0.0", "response_format": "json"}
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(self.url, files=files, data=data)
        resp.raise_for_status()
        try:
            payload = resp.json()
            return str(payload.get("text", ""))
        except ValueError:
            return resp.text

    async def _cli_infer(self, wav: Path, language: str) -> str:
        if not (self.bin.exists() and self.model.exists()):
            raise SpeechUnavailable(
                "whisper.cpp not built: expected binary at "
                f"{self.bin} and model at {self.model}. "
                "Run `bash scripts/bootstrap.sh --whisper` to fetch both.")
        out_prefix = wav.with_suffix("")
        cmd = [str(self.bin), "-m", str(self.model), "-f", str(wav),
               "-l", language, "-otxt", "-of", str(out_prefix), "--no-prints"]
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        _, err = await asyncio.wait_for(proc.communicate(), timeout=180.0)
        if proc.returncode != 0:
            raise SpeechUnavailable(f"whisper-cli failed: {err.decode(errors='replace')[:300]}")
        txt = Path(str(out_prefix) + ".txt")
        if not txt.exists():
            raise SpeechUnavailable("whisper-cli produced no transcript")
        return txt.read_text(encoding="utf-8", errors="replace")


_stt: Optional[SpeechToText] = None


def get_stt() -> SpeechToText:
    global _stt
    if _stt is None:
        _stt = SpeechToText()
    return _stt

"""Text-to-speech for the SUFFIX master voice.

Engines, tried in order:

1. **Kokoro-82M** — https://huggingface.co/hexgrad/Kokoro-82M, served locally by
   ``kokoro-fastapi`` on :8880 with an OpenAI-compatible
   ``POST /v1/audio/speech``.  Free, fast, offline.
2. **ElevenLabs** — https://elevenlabs.io, used when
   ``SUFFIX_TTS_BACKEND=elevenlabs`` and a key is configured.

A tiny LRU cache keyed on text+voice keeps repeated briefings from re-synthesizing.
If every engine fails, ``synthesize`` returns ``None`` and the HUD falls back to
the browser SpeechSynthesis API — SUFFIX never goes mute silently.
"""

from __future__ import annotations

import hashlib
import logging
import time
from collections import OrderedDict
from typing import Any, Dict, Optional, Tuple

from server.config import settings

log = logging.getLogger("suffix.tts")

CACHE_MAX = 32
MAX_CHARS = 1200          # keep utterances inside one synthesis call


class TextToSpeech:
    def __init__(self) -> None:
        self.backend = settings.suffix_tts_backend
        self._cache: "OrderedDict[str, Tuple[bytes, str]]" = OrderedDict()
        self.failures = 0
        self.successes = 0
        self.last_error: Optional[str] = None

    # ------------------------------------------------------------------ health
    def health(self) -> Dict[str, Any]:
        kokoro_ok = False
        try:
            import httpx

            base = settings.kokoro_url.rsplit("/v1/", 1)[0]
            resp = httpx.get(f"{base}/health", timeout=2.5)
            kokoro_ok = resp.status_code < 500
            if not kokoro_ok:
                resp = httpx.get(f"{base}/v1/models", timeout=2.5)
                kokoro_ok = resp.status_code < 500
        except Exception:  # noqa: BLE001
            kokoro_ok = False
        return {
            "backend": self.backend,
            "kokoro_url": settings.kokoro_url,
            "kokoro_reachable": kokoro_ok,
            "kokoro_voice": settings.kokoro_voice,
            "elevenlabs_configured": bool(settings.elevenlabs_api_key),
            "elevenlabs_voice_id": settings.elevenlabs_voice_id,
            "successes": self.successes,
            "failures": self.failures,
            "last_error": self.last_error,
            "cache_entries": len(self._cache),
            "ready": (kokoro_ok if self.backend == "kokoro"
                      else bool(settings.elevenlabs_api_key) if self.backend == "elevenlabs"
                      else False),
        }

    # ------------------------------------------------------------------- cache
    def _key(self, text: str, voice: str) -> str:
        return hashlib.sha1(f"{self.backend}|{voice}|{text}".encode()).hexdigest()

    def _get(self, key: str) -> Optional[Tuple[bytes, str]]:
        hit = self._cache.get(key)
        if hit is None:
            return None
        self._cache.move_to_end(key)
        return hit

    def _put(self, key: str, value: Tuple[bytes, str]) -> None:
        self._cache[key] = value
        self._cache.move_to_end(key)
        while len(self._cache) > CACHE_MAX:
            self._cache.popitem(last=False)

    # ------------------------------------------------------------- synthesis
    async def synthesize(self, text: str, *, voice: Optional[str] = None,
                         priority: str = "briefing") -> Optional[Tuple[bytes, str]]:
        """Return ``(audio_bytes, mime)`` or ``None`` when no engine is usable."""
        text = (text or "").strip()[:MAX_CHARS]
        if not text or self.backend == "disabled":
            return None
        voice = voice or settings.kokoro_voice

        key = self._key(text, voice)
        cached = self._get(key)
        if cached:
            return cached

        engine_order = ([("kokoro", self._kokoro), ("elevenlabs", self._elevenlabs)]
                        if self.backend == "kokoro"
                        else [("elevenlabs", self._elevenlabs), ("kokoro", self._kokoro)])
        for name, fn in engine_order:
            try:
                result = await fn(text, voice)
                if result:
                    self._put(key, result)
                    self.successes += 1
                    self.last_error = None
                    log.debug("TTS synthesized %d chars via %s (%.1f KB)",
                              len(text), name, len(result[0]) / 1024)
                    return result
            except Exception as exc:  # noqa: BLE001 - fall through to the next engine
                self.last_error = f"{name}: {exc}"
                log.debug("TTS %s failed: %s", name, exc)
        self.failures += 1
        return None

    async def _kokoro(self, text: str, voice: str) -> Optional[Tuple[bytes, str]]:
        import httpx

        payload = {"model": "kokoro", "input": text, "voice": voice,
                   "response_format": "mp3", "speed": settings.kokoro_speed}
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(settings.kokoro_url, json=payload)
        if resp.status_code != 200:
            raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:160]}")
        if not resp.content:
            raise RuntimeError("empty audio body")
        return resp.content, "audio/mpeg"

    async def _elevenlabs(self, text: str, voice: str) -> Optional[Tuple[bytes, str]]:
        if not settings.elevenlabs_api_key:
            raise RuntimeError("ELEVENLABS_API_KEY not configured")
        import httpx

        voice_id = settings.elevenlabs_voice_id or voice
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
        headers = {"xi-api-key": settings.elevenlabs_api_key, "accept": "audio/mpeg"}
        payload = {
            "text": text,
            "model_id": settings.elevenlabs_model,
            "voice_settings": {"stability": 0.45, "similarity_boost": 0.75, "style": 0.15},
        }
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:160]}")
        return resp.content, "audio/mpeg"


_tts: Optional[TextToSpeech] = None


def get_tts() -> TextToSpeech:
    global _tts
    if _tts is None:
        _tts = TextToSpeech()
    return _tts

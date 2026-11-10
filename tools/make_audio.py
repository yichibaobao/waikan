#!/usr/bin/env python3
"""Narrate an article.

    python3 tools/make_audio.py <slug> --model kokoro-v1.0.int8.onnx --voices voices-v1.0.bin [--only narration|clips]
    python3 tools/build.py        # then rebuild so the page picks the audio up

narration: one MP3 for the whole text plus the start/end time of every sentence
    a/<slug>/audio.mp3, content/<slug>/audio.json   {voice, speed, dur, hash, t: [[start, end], ...]}
clips:     one MP3 "sprite" holding every vocabulary word and every example sentence, with their times
    a/<slug>/clips.mp3, content/<slug>/clips.json   {voice, speed, dur, hash, t: {"w1": [s, e], "e1_0": [s, e], ...}}

Needs (not part of the repo, see README.md):  pip install kokoro-onnx soundfile numpy   and ffmpeg with libmp3lame.
The model files come from https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0
(kokoro-v1.0.int8.onnx, ~90 MB, and voices-v1.0.bin, ~28 MB).

Text that the speech engine reads badly (Japanese names, years, ...) can be respelled per article with
meta.pronounce, e.g. {"koban": "koh-bahn", "2019": "twenty nineteen"}. The page still shows the original text.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tts_text import spoken_text, text_hash, clip_items, clips_hash, split_speaker  # noqa: E402
# dialogue voices (meta.speakers = {"阿詩": "f", "阿明": "m"}): the narrator's voice for other lines
DIALOGUE_VOICES = {"ko": {"f": "ko-KR-SunHiNeural", "m": "ko-KR-InJoonNeural"},
                   "yue": {"f": "zh-HK-HiuGaaiNeural", "m": "zh-HK-WanLungNeural"},
                   "ja": {"f": "ja-JP-NanamiNeural", "m": "ja-JP-KeitaNeural"}}
from refs import resolve_refs  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SR = 24000  # Kokoro's native sample rate

CLIP_LEAD = 1.0       # silence at the start of the clip sprite
CLIP_GAP = 0.5        # silence after every clip in the sprite
PAUSE_SENT = 0.32     # between sentences inside a paragraph
PAUSE_PARA = 0.75     # between body paragraphs
PAUSE_HEAD = 0.9      # after the title and after the deck
LEAD = 0.25           # silence before the first word


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--engine", choices=["kokoro", "edge"], default=None,
                    help="kokoro: offline model (English). edge: Microsoft's online voices (needs pip install edge-tts and internet); default for Korean lessons")
    ap.add_argument("--model", help="kokoro only")
    ap.add_argument("--voices", help="kokoro only")
    ap.add_argument("--voice", default="af_heart", help="American: af_heart af_bella af_nicole af_sarah am_michael am_adam am_eric ...; British: bf_emma bf_isabella bm_george bm_lewis ...")
    ap.add_argument("--lang", default=None, help="en-us or en-gb; default: from the voice (a* = American, b* = British)")
    ap.add_argument("--speed", type=float, default=0.95)
    ap.add_argument("--bitrate", default="56k", help="narration bitrate")
    ap.add_argument("--clip-bitrate", default="40k", help="word/example sprite bitrate")
    ap.add_argument("--only", choices=["narration", "clips"], help="make just one of the two files")
    a = ap.parse_args()
    raw = json.load(open(os.path.join(ROOT, "content", a.slug, "article.json"), encoding="utf-8"))
    err = resolve_refs(a.slug, raw, os.path.join(ROOT, "content"))
    if err:
        sys.exit(err)
    lang = raw["meta"].get("lang", "en")
    korean = lang in ("ko", "yue")     # beginners: read a little slower
    a.engine = a.engine or ("edge" if lang in ("ko", "ja", "yue") else "kokoro")
    if a.engine == "edge":
        if a.voice == "af_heart":
            a.voice = {"ko": "ko-KR-SunHiNeural", "ja": "ja-JP-NanamiNeural", "yue": "zh-HK-HiuGaaiNeural"}.get(lang, "en-US-AriaNeural")
        if korean and a.speed == 0.95:
            a.speed = 0.85          # slower for beginners
        k = EdgeVoice()
    else:
        if not (a.model and a.voices):
            sys.exit("kokoro needs --model and --voices")
        if not a.lang:
            a.lang = "en-gb" if a.voice.startswith("b") else "en-us"
        from kokoro_onnx import Kokoro
        k = Kokoro(a.model, a.voices)
    pronounce = raw["meta"].get("pronounce", {})
    if a.only != "clips":
        make_narration(a, raw, pronounce, k)
    if a.only != "narration":
        make_clips(a, raw, pronounce, k)


class EdgeVoice:
    """Microsoft Edge's online neural voices behind the same create() as Kokoro: (float32 samples at SR, SR)."""
    def create(self, text, voice, speed, lang=None):
        import asyncio
        import edge_tts
        rate = f"{round((speed - 1) * 100):+d}%"
        with tempfile.TemporaryDirectory() as tmp:
            mp3 = os.path.join(tmp, "s.mp3")
            for attempt in range(3):
                try:
                    asyncio.run(edge_tts.Communicate(text, voice, rate=rate).save(mp3))
                    break
                except Exception:
                    if attempt == 2:
                        raise
            raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", mp3, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                                 check=True, capture_output=True).stdout
        samples = np.frombuffer(raw, dtype=np.float32)
        return trim(samples), SR


def trim(samples, floor=0.01):
    """Drop the silence the online voice puts around each clip, so the sprite timings stay tight."""
    loud = np.nonzero(np.abs(samples) > floor)[0]
    if not len(loud):
        return samples
    a = max(0, loud[0] - int(0.03 * SR))
    b = min(len(samples), loud[-1] + int(0.08 * SR))
    return samples[a:b]


def encode_mp3(audio, mp3, bitrate, title):
    os.makedirs(os.path.dirname(mp3), exist_ok=True)
    peak = float(np.abs(audio).max())
    audio = audio * (0.89 / peak) if peak > 0 else audio     # peak-normalise to about -1 dB
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "n.wav")
        sf.write(wav, audio, SR)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-ac", "1", "-ar", str(SR), "-codec:a", "libmp3lame",
                        "-b:a", bitrate, "-metadata", f"title={title}", mp3], check=True)
    return len(audio) / SR


def make_clips(a, raw, pronounce, k):
    items = clip_items(raw["data"]["vocab"], pronounce)
    chunks = [np.zeros(int(CLIP_LEAD * SR), dtype=np.float32)]
    t = CLIP_LEAD
    times = {}
    for n, (key, text) in enumerate(items):
        samples, sr = k.create(text, voice=a.voice, speed=a.speed, lang=a.lang)
        assert sr == SR, sr
        samples = samples.astype(np.float32)
        dur = len(samples) / SR
        times[key] = [round(t, 2), round(t + dur, 2)]
        chunks.append(samples)
        chunks.append(np.zeros(int(CLIP_GAP * SR), dtype=np.float32))
        t += dur + CLIP_GAP
        if n % 10 == 0:
            print(f"  clip {n + 1}/{len(items)}  {key:8s} {text[:60]}", flush=True)
    mp3 = os.path.join(ROOT, "a", a.slug, "clips.mp3")
    total = encode_mp3(np.concatenate(chunks), mp3, a.clip_bitrate, raw["meta"]["title"] + " (words and examples)")
    meta = dict(voice=a.voice, speed=a.speed, dur=round(total, 2), hash=clips_hash(items), t=times)
    json.dump(meta, open(os.path.join(ROOT, "content", a.slug, "clips.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(f"wrote {os.path.relpath(mp3, ROOT)} ({os.path.getsize(mp3) // 1024} KB, {total:.1f}s, {len(items)} clips) and content/{a.slug}/clips.json")


def make_narration(a, raw, pronounce, k):
    sents = raw["data"]["sents"]
    speakers = raw["meta"].get("speakers") or {}
    lang = raw["meta"].get("lang", "en")
    if speakers:
        if a.engine != "edge" or lang not in DIALOGUE_VOICES:
            sys.exit("meta.speakers needs the edge engine and a language with dialogue voices")
        bad = [n for n, g in speakers.items() if g not in ("f", "m")]
        if bad:
            sys.exit(f"meta.speakers: give each speaker 'f' or 'm' ({bad})")
    chunks = [np.zeros(int(LEAD * SR), dtype=np.float32)]
    t = LEAD
    times = []
    for n, s in enumerate(sents):
        text = spoken_text(s, pronounce, speakers)
        who = split_speaker(s["en"], speakers)[0]
        voice = DIALOGUE_VOICES[lang][speakers[who]] if who else a.voice
        samples, sr = k.create(text, voice=voice, speed=a.speed, lang=a.lang)
        assert sr == SR, sr
        samples = samples.astype(np.float32)
        dur = len(samples) / SR
        times.append([round(t, 2), round(t + dur, 2)])
        print(f"  {n:2d}  {t:6.2f}-{t + dur:6.2f}  {voice[-14:]:14s} {text[:60]}", flush=True)
        chunks.append(samples)
        t += dur
        nxt = sents[n + 1] if n + 1 < len(sents) else None
        if nxt is None:
            pause = 0.6
        elif s["kind"] in ("title", "sub") and nxt["kind"] != s["kind"]:
            pause = PAUSE_HEAD
        elif s["kind"] == "body" and nxt["kind"] == "body" and nxt["p"] != s["p"]:
            pause = PAUSE_PARA
        else:
            pause = PAUSE_SENT
        chunks.append(np.zeros(int(pause * SR), dtype=np.float32))
        t += pause
    mp3 = os.path.join(ROOT, "a", a.slug, "audio.mp3")
    total = encode_mp3(np.concatenate(chunks), mp3, a.bitrate, raw["meta"]["title"])
    meta = dict(voice=a.voice, speed=a.speed, dur=round(total, 2), hash=text_hash(sents, pronounce, speakers or None), t=times)
    json.dump(meta, open(os.path.join(ROOT, "content", a.slug, "audio.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(f"wrote {os.path.relpath(mp3, ROOT)} ({os.path.getsize(mp3) // 1024} KB, {total:.1f}s) and content/{a.slug}/audio.json")


if __name__ == "__main__":
    sys.exit(main())

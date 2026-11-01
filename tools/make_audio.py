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
from tts_text import spoken_text, text_hash, clip_items, clips_hash  # noqa: E402

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
    ap.add_argument("--model", required=True)
    ap.add_argument("--voices", required=True)
    ap.add_argument("--voice", default="af_heart", help="American: af_heart af_bella af_nicole af_sarah am_michael am_adam am_eric ...; British: bf_emma bf_isabella bm_george bm_lewis ...")
    ap.add_argument("--lang", default=None, help="en-us or en-gb; default: from the voice (a* = American, b* = British)")
    ap.add_argument("--speed", type=float, default=0.95)
    ap.add_argument("--bitrate", default="56k", help="narration bitrate")
    ap.add_argument("--clip-bitrate", default="40k", help="word/example sprite bitrate")
    ap.add_argument("--only", choices=["narration", "clips"], help="make just one of the two files")
    a = ap.parse_args()
    if not a.lang:
        a.lang = "en-gb" if a.voice.startswith("b") else "en-us"

    from kokoro_onnx import Kokoro

    raw = json.load(open(os.path.join(ROOT, "content", a.slug, "article.json"), encoding="utf-8"))
    pronounce = raw["meta"].get("pronounce", {})
    k = Kokoro(a.model, a.voices)
    if a.only != "clips":
        make_narration(a, raw, pronounce, k)
    if a.only != "narration":
        make_clips(a, raw, pronounce, k)


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
    chunks = [np.zeros(int(LEAD * SR), dtype=np.float32)]
    t = LEAD
    times = []
    for n, s in enumerate(sents):
        text = spoken_text(s, pronounce)
        samples, sr = k.create(text, voice=a.voice, speed=a.speed, lang=a.lang)
        assert sr == SR, sr
        samples = samples.astype(np.float32)
        dur = len(samples) / SR
        times.append([round(t, 2), round(t + dur, 2)])
        print(f"  {n:2d}  {t:6.2f}-{t + dur:6.2f}  {text[:70]}", flush=True)
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
    meta = dict(voice=a.voice, speed=a.speed, dur=round(total, 2), hash=text_hash(sents, pronounce), t=times)
    json.dump(meta, open(os.path.join(ROOT, "content", a.slug, "audio.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(f"wrote {os.path.relpath(mp3, ROOT)} ({os.path.getsize(mp3) // 1024} KB, {total:.1f}s) and content/{a.slug}/audio.json")


if __name__ == "__main__":
    sys.exit(main())

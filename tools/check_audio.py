"""Check the recorded audio against the text with speech recognition (faster-whisper), to catch misread words.

    ~/.cache/waikan-tts/venv/bin/python tools/check_audio.py [slug ...] [--out report.json]

For every article with audio, the narration (audio.mp3) and the word / example sprite (clips.mp3) are transcribed with word
timestamps; the recognised words are split back into the sentences and clips by their timings and compared with the text.
Prints the lines whose recognised text differs a lot from the text (score below the threshold). Recognition is not perfect,
especially for single short words and for Cantonese, so a flagged line is something to listen to, not proof of an error.
Needs: pip install faster-whisper (TTS venv); the "medium" model is kept in ~/.cache/waikan-tts/whisper.
"""
import difflib
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from refs import resolve_refs  # noqa: E402
from tts_text import spoken_text, clip_items  # noqa: E402

FFMPEG = os.path.expanduser("~/.cache/waikan-tts/bin/ffmpeg")
MODEL_DIR = os.path.expanduser("~/.cache/waikan-tts/whisper")
LANGS = {"en": "en", "ko": "ko", "ja": "ja", "yue": "zh"}      # medium has no separate Cantonese; zh + a Cantonese prompt works
PROMPTS = {"yue": "以下係廣東話：你好，我係阿詩。唔該，今日好凍呀。", "ja": "以下は日本語の文章です。", "ko": "다음은 한국어입니다."}


def norm(s, lang):
    s = s.lower()
    if lang == "en":
        s = re.sub(r"[’']", "", s)
        return " ".join(re.findall(r"[a-z0-9]+", s))
    return "".join(re.findall(r"[a-z0-9가-힣぀-ヿ々一-鿿]", s))


def score(ref, got, lang):
    a, b = norm(ref, lang), norm(got, lang)
    if not a:
        return 1.0
    if lang == "en":
        a, b = a.split(), b.split()
    return difflib.SequenceMatcher(None, a, b).ratio()


def load_audio(path):
    import numpy as np
    raw = subprocess.run([FFMPEG, "-loglevel", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def transcribe_windows(model, samples, windows, lang):
    """One pass over the whole file with word timestamps; each recognised word goes to the window holding its midpoint."""
    segs, _ = model.transcribe(samples, language=LANGS[lang], beam_size=1, vad_filter=False, word_timestamps=True,
                               condition_on_previous_text=False, initial_prompt=PROMPTS.get(lang))
    words = [w for s in segs for w in (s.words or [])]
    out, redo = [], []
    for win in windows:
        key, ref, t0, t1 = win
        got = "".join(w.word for w in words if t0 - 0.1 <= (w.start + w.end) / 2 <= t1 + 0.1).strip()
        sc = round(score(ref, got, lang), 2)
        out.append((key, ref, got, sc))
        if sc < 0.75:
            redo.append(win)
    # anything that looks wrong is heard again on its own (slower, but short words are often lost in one long pass)
    if redo:
        again = {r[0]: r for r in transcribe_windows_slow(model, samples, redo, lang)}
        out = [again[r[0]] if r[0] in again and again[r[0]][3] > r[3] else r for r in out]
    return out


def transcribe_windows_slow(model, samples, windows, lang):
    """windows: [(key, ref_text, start, end)]; returns [(key, ref, got, score)] — each window transcribed on its own slice."""
    out = []
    for key, ref, t0, t1 in windows:
        a, b = max(0, int((t0 - 0.05) * 16000)), int((t1 + 0.15) * 16000)
        seg = samples[a:b]
        if len(seg) < 1600:
            seg = __import__("numpy").pad(seg, (0, 1600 - len(seg)))
        segs, _ = model.transcribe(seg, language=LANGS[lang], beam_size=5, vad_filter=False, condition_on_previous_text=False,
                                   initial_prompt=PROMPTS.get(lang), without_timestamps=True)
        got = "".join(s.text for s in segs).strip()
        out.append((key, ref, got, round(score(ref, got, lang), 2)))
    return out


def check(slug, model):
    raw = json.load(open(os.path.join(ROOT, "content", slug, "article.json"), encoding="utf-8"))
    resolve_refs(slug, raw, os.path.join(ROOT, "content"))
    lang = raw["meta"].get("lang", "en")
    sp = raw["meta"].get("speakers")
    pron = raw["meta"].get("pronounce", {})
    res = []
    ap, cp = os.path.join(ROOT, "content", slug, "audio.json"), os.path.join(ROOT, "content", slug, "clips.json")
    if os.path.isfile(ap):
        au = json.load(open(ap, encoding="utf-8"))
        samples = load_audio(os.path.join(ROOT, "a", slug, "audio.mp3"))
        wins = []
        for i, (s, (t0, t1)) in enumerate(zip(raw["data"]["sents"], au["t"])):
            ref = spoken_text(s, {}, sp)            # compare with the written text, not the respelling for the voice
            wins.append((f"s{i}", ref, t0, t1))
        res += [("sentence",) + r for r in transcribe_windows(model, samples, wins, lang)]
    if os.path.isfile(cp):
        cl = json.load(open(cp, encoding="utf-8"))
        samples = load_audio(os.path.join(ROOT, "a", slug, "clips.mp3"))
        items = dict(clip_items(raw["data"]["vocab"], {}))
        wins = [(k, items[k], t[0], t[1]) for k, t in cl["t"].items() if k in items]
        res += [("word" if r[0].startswith("w") else "example",) + r for r in transcribe_windows(model, samples, wins, lang)]
    return lang, res


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else None
    if out in args:
        args.remove(out)
    from faster_whisper import WhisperModel
    model = WhisperModel("medium", device="cpu", compute_type="int8", download_root=MODEL_DIR)
    slugs = args or sorted(d for d in os.listdir(os.path.join(ROOT, "content")) if os.path.isfile(os.path.join(ROOT, "content", d, "audio.json")))
    report = {}
    for slug in slugs:
        lang, res = check(slug, model)
        report[slug] = {"lang": lang, "items": [dict(kind=k, key=key, ref=ref, got=got, score=sc) for k, key, ref, got, sc in res]}
        low = [r for r in res if r[4] < (0.6 if r[0] == "word" else 0.75)]
        print(f"{slug} ({lang}): {len(res)} checked, {len(low)} to listen to", flush=True)
        for k, key, ref, got, sc in low:
            print(f"   {sc:.2f} {k:8s} {key:7s} text: {ref[:70]} | heard: {got[:70]}", flush=True)
        if out:
            json.dump(report, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()

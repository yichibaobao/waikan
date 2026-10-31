"""Text the narration engine speaks for each sentence. Shared by make_audio.py and build.py (no heavy imports)."""
import hashlib
import json
import re


def spoken_text(sent, pronounce):
    t = sent["en"].replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    for word, say in pronounce.items():
        t = re.sub(r"(?<![A-Za-z0-9])" + re.escape(word) + r"(?![A-Za-z0-9])", say, t)
    return t


def text_hash(sents, pronounce):
    return hashlib.sha1(json.dumps([spoken_text(s, pronounce) for s in sents], ensure_ascii=False).encode()).hexdigest()[:16]


def clip_items(vocab, pronounce):
    """(key, spoken text) for every word and example sentence: w<id>, e<id>_<k>. The order is the order in the sprite."""
    items = []
    for v in vocab:
        items.append((f"w{v['id']}", spoken_text({"en": v.get("say") or v["core"]}, pronounce)))
        for k, ex in enumerate(v["ex"]):
            items.append((f"e{v['id']}_{k}", spoken_text({"en": ex["en"].replace("[[", "").replace("]]", "")}, pronounce)))
    return items


def clips_hash(items):
    return hashlib.sha1(json.dumps(items, ensure_ascii=False).encode()).hexdigest()[:16]

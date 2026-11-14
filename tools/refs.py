"""Vocab entries that point at a word of an earlier article: {"id": 5, "ref": "konbini:12", "m": [...]}.

Used by unit-test articles. The entry takes the gloss, note, forms and examples of the word it points at, so both
build.py and make_audio.py see a complete entry; the review schedule stays the one of the original word.
"""
import json
import os

COPIED = ("expr", "zh", "note", "core", "forms", "syn", "ex", "say", "ipa")


def resolve_refs(slug, raw, content_dir):
    """Fill in every {"ref": "<slug>:<id>"} vocab entry of raw in place. Returns an error message or None."""
    cache = {}
    for v in raw["data"]["vocab"]:
        ref = v.get("ref")
        if not ref:
            continue
        src_slug, _, src_id = ref.partition(":")
        if src_slug == slug or not src_id.isdigit():
            return f"[{slug}] vocab {v['id']}: bad ref {ref!r}"
        if src_slug not in cache:
            path = os.path.join(content_dir, src_slug, "article.json")
            if not os.path.isfile(path):
                return f"[{slug}] vocab {v['id']}: ref {ref!r} names an unknown article"
            cache[src_slug] = json.load(open(path, encoding="utf-8"))
        src = cache[src_slug]
        orig = next((w for w in src["data"]["vocab"] if w["id"] == int(src_id)), None)
        if not orig or orig.get("ref"):
            return f"[{slug}] vocab {v['id']}: ref {ref!r} must name an original word"
        for k in COPIED:
            if k in orig:
                v[k] = orig[k]
        v["from"] = src["meta"]["short"]
    return None

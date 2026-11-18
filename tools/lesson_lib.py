"""Small helper for writing short beginner lessons (Korean / Cantonese) as a Python script.

    import sys; sys.path.insert(0, "tools"); from lesson_lib import Lesson
    L = Lesson()
    L.sent("title", "...", "rom", "中文", ["讲解"])            # "sub" and "body" too; each body line becomes its own paragraph
    L.word(expr, rom, zh, m, note, core, forms, [(ex, rom, zh), ...], ans=None, hint="", at=None, **extra)
    L.save(meta, breakdown_sentence_index, ["要点", ...])     # writes content/<slug>/article.json

word(): the cloze goes in the first sentence where `ans` (default: m) appears exactly once and m appears, unless at= gives
the sentence index. Run the script from the repo root, then python3 tools/build.py.
"""
import json
import os


class Lesson:
    def __init__(self):
        self.S, self.V, self.C = [], [], []

    def sent(self, kind, en, rom, zh, notes):
        s = {"kind": kind, "en": en, "rom": rom, "zh": zh, "notes": notes}
        if kind == "body":
            s["p"] = sum(1 for x in self.S if x["kind"] == "body") + 1
        self.S.append(s)

    def word(self, expr, rom, zh, m, note, core, forms, ex, ans=None, hint="", at=None, **extra):
        ans = ans or m
        i = at if at is not None else next(k for k, s in enumerate(self.S) if s["en"].count(ans) == 1 and m in s["en"])
        vid = len(self.V) + 1
        v = {"id": vid, "expr": expr, "rom": rom, "zh": zh, "m": [m], "note": note, "core": core, "forms": forms, "syn": [],
             "ex": [{"en": e, "rom": r, "zh": z} for e, r, z in ex]}
        v.update(extra)
        self.V.append(v)
        self.C.append({"id": vid, "i": i, "ans": ans, "hint": hint or zh})

    def save(self, meta, breakdown_i, points):
        meta["title"] = self.S[0]["en"]
        data = {"meta": meta, "data": {"sents": self.S, "vocab": self.V, "cloze": self.C,
                                       "breakdown": {"en": self.S[breakdown_i]["en"], "points": points}}}
        os.makedirs(f"content/{meta['slug']}", exist_ok=True)
        open(f"content/{meta['slug']}/article.json", "w", encoding="utf-8").write(json.dumps(data, ensure_ascii=False, indent=1) + "\n")
        print(meta["slug"], len(self.S), "sentences,", len(self.V), "words")

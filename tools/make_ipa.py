"""Add British IPA (音标) to the English words of articles: writes "ipa": "/ˈmaɪnd/" into each vocab entry of content/<slug>/article.json.

Run with the TTS virtualenv (it has phonemizer + the espeak-ng library):
    ~/.cache/waikan-tts/venv/bin/python tools/make_ipa.py            # every English article, only entries without ipa
    ~/.cache/waikan-tts/venv/bin/python tools/make_ipa.py emu-war    # just these slugs
    ... --force                                                      # recompute entries that already have ipa
An entry's ipa can also be written by hand; hand-written values are kept unless --force is given.
Grammar entries, unit-test references and non-English articles are skipped.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(ROOT, "content")

VOWELS = set("aeiouæɑɒɔəɜɛɪʊʌɐᵻ")
# consonant clusters English allows at the start of a syllable (after r-normalisation); the stress mark goes before them
ONSETS = {"pl", "pr", "bl", "br", "tr", "dr", "kl", "kr", "ɡl", "ɡr", "fl", "fr", "θr", "ʃr", "sp", "st", "sk", "sm", "sn", "sl", "sw",
          "tw", "kw", "dw", "ɡw", "pj", "bj", "tj", "dj", "kj", "mj", "nj", "fj", "vj", "hj", "lj", "spr", "str", "skr", "spl", "skw", "sj"}
SINGLE = ("tʃ", "dʒ")      # one sound written with two letters


def tidy(ipa):
    """espeak's IPA -> dictionary style: r for ɹ, ʌ for ɐ, ɪ for ᵻ, stress marks moved to the start of the syllable."""
    ipa = ipa.replace("ɹ", "r").replace("ɐ", "ə").replace("ᵻ", "ɪ").replace("ɾ", "t").replace("ʔ", "")
    # the symbols of Chinese learners' dictionaries (Oxford / Cambridge style): e for ɛ, æ for the TRAP vowel, ɪə for iə
    ipa = ipa.replace("ɛ", "e").replace("iə", "ɪə")
    ipa = re.sub(r"a(?![ɪʊː])", "æ", ipa)
    out = []
    for word in ipa.split():
        chars = list(word)
        i = 0
        while i < len(chars):
            if chars[i] in "ˈˌ":
                mark = chars.pop(i)
                # walk left over the consonants that belong to this syllable's onset
                j = i
                cons = ""
                while j > 0 and chars[j - 1] not in VOWELS and chars[j - 1] not in "ːˈˌ":
                    cand = chars[j - 1] + cons
                    two = "".join(chars[j - 2:j]) if j >= 2 else ""
                    if two in SINGLE and len(cons) == 0:
                        cons, j = two, j - 2
                        continue
                    if len(cand) == 1 or cand in ONSETS:
                        cons, j = cand, j - 1
                    else:
                        break
                chars.insert(j, mark)
                i += 1
            i += 1
        w = "".join(chars)
        if len(re.findall(r"[aeiouæɑɒɔəɜɛɪʊʌ]+", w)) <= 1:      # one syllable: dictionaries print no stress mark
            w = w.replace("ˈ", "").replace("ˌ", "")
        out.append(w)
    if len(out) == 1 and out[0].count("ˈ") == 0:
        pass
    return " ".join(out)


def spoken(core):
    """The part of a word's core that is actually pronounced: drop sb / sth / A / B placeholders and brackets."""
    t = re.sub(r"[（(][^）)]*[）)]", " ", core)
    t = re.sub(r"\b(?:sb|sth)(?:'s)?\b", " ", t)
    t = re.sub(r"(?<![A-Za-z'])[AB](?![A-Za-z'])", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    import espeakng_loader
    from phonemizer.backend.espeak.wrapper import EspeakWrapper
    EspeakWrapper.set_library(espeakng_loader.get_library_path())
    EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
    from phonemizer import phonemize

    slugs = args or sorted(d for d in os.listdir(CONTENT) if os.path.isfile(os.path.join(CONTENT, d, "article.json")))
    for slug in slugs:
        path = os.path.join(CONTENT, slug, "article.json")
        raw = json.load(open(path, encoding="utf-8"))
        if raw["meta"].get("lang", "en") != "en":
            continue
        todo = [v for v in raw["data"]["vocab"] if not v.get("ref") and v.get("kind") != "grammar" and (force or not v.get("ipa"))]
        texts = [spoken(v["core"]) for v in todo]
        todo = [v for v, t in zip(todo, texts) if t]
        texts = [t for t in texts if t]
        if not todo:
            continue
        res = phonemize(texts, language="en-gb-x-rp", backend="espeak", strip=True, preserve_punctuation=False, with_stress=True)
        for v, ipa in zip(todo, res):
            v["ipa"] = "/" + tidy(ipa) + "/"
        open(path, "w", encoding="utf-8").write(json.dumps(raw, ensure_ascii=False, indent=1) + "\n")
        print(f"{slug}: {len(todo)} words")


if __name__ == "__main__":
    main()

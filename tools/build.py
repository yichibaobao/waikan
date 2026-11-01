#!/usr/bin/env python3
"""Build the whole site from content/<slug>/article.json.

    python3 tools/build.py            # from the repo root

Writes   a/<slug>/index.html   one study page per article (reader.template.html)
         a/<slug>/words.json   the article's words with everything a quiz needs (read by the review page)
         a/<slug>/listen.json  the article's sentences with narration times, for the listening exam (only when audio exists)
         review/index.html     the spaced-repetition review page (review.template.html)
         index.html            the collection home page (home.template.html)

tools/shared/*.css|js are inlined into the templates (placeholders like /*__COMMON_JS__*/), so every page stays one self-contained file.

Everything is deterministic: the generated pages can always be rebuilt from content/ and tools/.
See README.md for the article.json format.
"""
import html as htmllib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tts_text import text_hash, clip_items, clips_hash  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools")
CONTENT = os.path.join(ROOT, "content")
SHARED = os.path.join(TOOLS, "shared")
SHARED_PARTS = (("/*__BASE_CSS__*/", "base.css"), ("/*__COMMON_JS__*/", "common.js"), ("/*__SRS_JS__*/", "srs.js"),
                ("/*__CLIPS_JS__*/", "clips.js"), ("/*__KIT_JS__*/", "quizkit.js"),
                ("/*__WHO_CSS__*/", "who.css"), ("/*__WHO_JS__*/", "who.js"))
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def die(msg):
    sys.exit(f"build error: {msg}")


def check(cond, msg):
    if not cond:
        die(msg)


def word_re(term):
    return re.compile(r"(?<![A-Za-z])" + re.escape(term) + r"(?![A-Za-z])", re.I)


def norm_key(s):
    return re.sub(r"[^a-z]", "", s.lower())


def prepare(slug, raw):
    """Fill in derived fields, validate, and return (meta, data)."""
    meta, data = raw["meta"], raw["data"]
    where = f"[{slug}]"

    # ---- meta
    check(meta.get("slug") == slug, f"{where} meta.slug must equal the folder name")
    check(SLUG_RE.match(slug), f"{where} slug must be lowercase letters, digits and hyphens")
    check(DATE_RE.match(meta.get("date", "")), f"{where} meta.date must be YYYY-MM-DD")
    for k in ("title", "deck", "short"):
        check(meta.get(k), f"{where} meta.{k} is required")
    meta.setdefault("tags", [])
    meta.setdefault("source", {"type": "original"})
    check(meta["source"].get("type") in ("original", "link"), f"{where} source.type must be original or link")
    if meta["source"]["type"] == "link":
        check(meta["source"].get("url", "").startswith("http"), f"{where} source.url must be an http(s) link")
    meta.setdefault("lsKey", f"wk-{slug}-state")

    # ---- sentences
    sents = data["sents"]
    check(sents and sents[0]["kind"] == "title", f"{where} first sentence must be kind 'title'")
    body_n = 0
    for i, s in enumerate(sents):
        check(s["kind"] in ("title", "sub", "body"), f"{where} sentence {i}: bad kind")
        check(s.get("en") and s.get("zh"), f"{where} sentence {i}: en and zh are required")
        s["i"] = i
        s.setdefault("notes", [])
        if s["kind"] == "body":
            check(isinstance(s.get("p"), int) and s["p"] >= 1, f"{where} sentence {i}: body needs paragraph number p")
            body_n += 1
            s["n"] = body_n
            s["label"] = f"第 {body_n} 句"
        else:
            s["p"], s["n"] = 0, 0
            s["label"] = "标题" if s["kind"] == "title" else "副标题"
    data["title"] = sents[0]["en"]
    check(data["title"] == meta["title"], f"{where} meta.title must equal the title sentence")

    # ---- vocabulary
    all_en = " ".join(s["en"] for s in sents)
    ids = set()
    for v in data["vocab"]:
        vid = v["id"]
        check(vid not in ids, f"{where} duplicate vocab id {vid}")
        ids.add(vid)
        for k in ("expr", "zh", "m", "core", "forms"):
            check(v.get(k), f"{where} vocab {vid}: {k} is required")
        v.setdefault("syn", [])
        v.setdefault("note", "")
        check(v["core"] in v["forms"], f"{where} vocab {vid}: core must be one of forms")
        for t in v["m"]:
            check(word_re(t).search(all_en), f"{where} vocab {vid}: highlight term {t!r} not found in the article")
        hit = next((s for s in sents if any(word_re(t).search(s["en"]) for t in v["m"])), None)
        check(hit, f"{where} vocab {vid}: no sentence contains its terms")
        v.setdefault("ctx", hit["en"])
        check(any(word_re(t).search(v["ctx"]) for t in v["m"]), f"{where} vocab {vid}: ctx lacks its own term")
        check(2 <= len(v.get("ex", [])) <= 3, f"{where} vocab {vid} ({v['expr']}): give 2-3 examples")
        form_keys = [norm_key(f) for f in v["forms"]]
        for ex in v["ex"]:
            check(ex.get("en") and ex.get("zh"), f"{where} vocab {vid}: example needs en and zh")
            m = re.search(r"\[\[(.+?)\]\]", ex["en"])
            check(m, f"{where} vocab {vid}: mark the target in each example with [[ ]]")
            check(any(fk in norm_key(m.group(1)) for fk in form_keys),
                  f"{where} vocab {vid}: example target {m.group(1)!r} matches none of forms")
    # terms must not be shared between words (the highlighter maps a term to one word)
    seen = {}
    for v in data["vocab"]:
        for t in v["m"]:
            check(t.lower() not in seen, f"{where} term {t!r} used by two vocab entries")
            seen[t.lower()] = v["id"]

    # ---- cloze items: either resolved already, or {id, i, ans, hint}
    cloze, cids = [], set()
    for c in data["cloze"]:
        check(c["id"] in ids and c["id"] not in cids, f"{where} cloze id {c['id']} unknown or repeated")
        cids.add(c["id"])
        if "before" not in c:
            s = sents[c["i"]]
            ms = list(word_re(c["ans"]).finditer(s["en"]))
            check(len(ms) == 1, f"{where} cloze {c['id']}: {c['ans']!r} must appear exactly once in sentence {c['i']}")
            c = dict(id=c["id"], i=c["i"], before=s["en"][: ms[0].start()], ans=ms[0].group(0),
                     after=s["en"][ms[0].end():], hint=c["hint"])
        cloze.append(c)
    check(cids == ids, f"{where} every vocab entry needs exactly one cloze item")
    data["cloze"] = cloze

    # ---- breakdown and questions
    bd = data["breakdown"]
    bd["i"] = next((s["i"] for s in sents if s["en"] == bd["en"]), None)
    check(bd["i"] is not None, f"{where} breakdown.en must be one of the article sentences")
    check(len(bd["points"]) >= 1 and len(data["questions"]) >= 1, f"{where} breakdown points / questions missing")

    # ---- derived numbers for the home page
    meta["words"] = sum(len(s["en"].split()) for s in sents)
    meta["vocab"] = len(data["vocab"])
    return meta, data


def syntax_check(page, label):
    """Fail the build if the page's script does not parse (needs node; skipped when node is missing)."""
    node = shutil.which("node")
    if not node:
        return
    m = re.search(r"<script>(.*)</script>", page, re.S)
    with tempfile.TemporaryDirectory() as tmp:
        f = os.path.join(tmp, "page.js")
        open(f, "w", encoding="utf-8").write(m.group(1))
        r = subprocess.run([node, "--check", f], capture_output=True, text=True)
        check(r.returncode == 0, f"[{label}] script does not parse:\n{r.stderr}")


def attach_audio(slug, meta, data, raw):
    """If content/<slug>/audio.json exists (made by make_audio.py), add the narration to the page data."""
    path = os.path.join(CONTENT, slug, "audio.json")
    meta["audio"] = False
    if not os.path.isfile(path):
        return
    au = json.load(open(path, encoding="utf-8"))
    mp3 = os.path.join(ROOT, "a", slug, "audio.mp3")
    check(os.path.isfile(mp3), f"[{slug}] audio.json exists but a/{slug}/audio.mp3 is missing")
    check(len(au["t"]) == len(data["sents"]), f"[{slug}] audio has {len(au['t'])} timings for {len(data['sents'])} sentences; rerun make_audio.py")
    check(au["hash"] == text_hash(data["sents"], raw["meta"].get("pronounce", {})),
          f"[{slug}] the article text changed after its audio was made; rerun tools/make_audio.py {slug}")
    for a, b in au["t"]:
        check(0 <= a < b <= au["dur"] + 0.5, f"[{slug}] bad audio timing {a}-{b}")
    data["audio"] = dict(src="audio.mp3?v=" + file_tag(mp3), dur=au["dur"], t=au["t"], voice=au.get("voice", ""))
    meta["audio"] = True


def attach_clips(slug, data, raw):
    """If content/<slug>/clips.json exists, add the word/example sprite (played by the speaker icons)."""
    path = os.path.join(CONTENT, slug, "clips.json")
    if not os.path.isfile(path):
        return
    cl = json.load(open(path, encoding="utf-8"))
    check(os.path.isfile(os.path.join(ROOT, "a", slug, "clips.mp3")), f"[{slug}] clips.json exists but a/{slug}/clips.mp3 is missing")
    items = clip_items(data["vocab"], raw["meta"].get("pronounce", {}))
    check(set(cl["t"]) == {k for k, _ in items}, f"[{slug}] words/examples changed after the clips were made; rerun tools/make_audio.py {slug} --only clips")
    check(cl["hash"] == clips_hash(items), f"[{slug}] clip texts changed after the clips were made; rerun tools/make_audio.py {slug} --only clips")
    for k, (a, b) in cl["t"].items():
        check(0 <= a < b <= cl["dur"] + 0.5, f"[{slug}] bad clip timing for {k}")
    data["clips"] = dict(src="clips.mp3?v=" + file_tag(os.path.join(ROOT, "a", slug, "clips.mp3")), t=cl["t"])


def file_tag(path):
    """Short content hash for a ?v= query on audio URLs: a re-made mp3 must not be served from a browser or CDN cache."""
    return hashlib.md5(open(path, "rb").read()).hexdigest()[:8]


def inline_shared(tpl, label):
    """Put the shared css/js files into a template; they must be inlined before any article data is."""
    for ph, name in SHARED_PARTS:
        if ph in tpl:
            part = open(os.path.join(SHARED, name), encoding="utf-8").read()
            check("__" not in part.replace("__proto__", ""), f"tools/shared/{name} must not contain '__' (placeholder clash)")
            tpl = tpl.replace(ph, part)
    return tpl


def words_json(slug, meta, data):
    """Everything the review page needs to quiz this article's words, without loading the article page."""
    cl = {c["id"]: c for c in data["cloze"]}
    words = []
    for v in data["vocab"]:
        c = cl[v["id"]]
        words.append(dict(
            id=v["id"], expr=v["expr"], zh=v["zh"], core=v["core"], forms=v["forms"], syn=v["syn"], note=v["note"],
            m=v["m"], ctx=v["ctx"], ex=v["ex"],
            cloze=dict(before=c["before"], ans=c["ans"], after=c["after"], hint=c["hint"], szh=data["sents"][c["i"]]["zh"])))
    return dict(slug=slug, title=meta["title"], clips=data.get("clips"), words=words)


LISTEN_MIN, LISTEN_MAX = 5, 32      # words per article sentence that make a fair dictation


def listen_sents(data):
    """The article sentences the listening exam may use: the deck and the body, not too short and not too long."""
    out = []
    for s in data["sents"]:
        n = len(s["en"].split())
        if s["kind"] != "title" and LISTEN_MIN <= n <= LISTEN_MAX:
            out.append(s)
    return out


def listen_json(slug, meta, data):
    a = data["audio"]
    return dict(slug=slug, title=meta["title"], audio=dict(src=a["src"]),
                sents=[dict(i=s["i"], en=s["en"], zh=s["zh"], t=a["t"][s["i"]]) for s in listen_sents(data)])


def foot_html(meta):
    parts = []
    note = meta.get("note")
    if note:
        parts.append(htmllib.escape(note))
    src = meta["source"]
    if src["type"] == "link":
        name = htmllib.escape(src.get("name") or src["url"])
        parts.append(f'原文出处：<a href="{htmllib.escape(src["url"], quote=True)}" rel="noopener noreferrer">{name}</a>。')
    return " ".join(parts) or "仅供语言学习。"


def main():
    reader_tpl = inline_shared(open(os.path.join(TOOLS, "reader.template.html"), encoding="utf-8").read(), "reader")
    home_tpl = inline_shared(open(os.path.join(TOOLS, "home.template.html"), encoding="utf-8").read(), "home")
    review_tpl = inline_shared(open(os.path.join(TOOLS, "review.template.html"), encoding="utf-8").read(), "review")
    for ph in ("__DATA__", "__LS_STATE__", "__TITLE__", "__BRAND__", "__HOME__", "__FOOT__", "__SLUG__", "__REVIEW__"):
        check(reader_tpl.count(ph) >= 1, f"reader template lost placeholder {ph}")
    check(home_tpl.count("__SITE__") == 1, "home template lost placeholder __SITE__")
    check(review_tpl.count("__INDEX__") == 1, "review template lost placeholder __INDEX__")

    metas, index = [], []
    slugs = sorted(d for d in os.listdir(CONTENT) if os.path.isfile(os.path.join(CONTENT, d, "article.json")))
    check(slugs, "no articles found in content/")
    for slug in slugs:
        raw = json.load(open(os.path.join(CONTENT, slug, "article.json"), encoding="utf-8"))
        meta, data = prepare(slug, raw)
        attach_audio(slug, meta, data, raw)
        attach_clips(slug, data, raw)
        payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
        page = (reader_tpl
                .replace("__TITLE__", htmllib.escape(f"{meta['short']} · 外刊精读"))
                .replace("__BRAND__", htmllib.escape(meta["short"]))
                .replace("__HOME__", "../../")
                .replace("__FOOT__", foot_html(meta))
                .replace("__LS_STATE__", meta["lsKey"])
                .replace("__SLUG__", slug)
                .replace("__REVIEW__", "../../review/")
                .replace("__DATA__", payload))
        out = os.path.join(ROOT, "a", slug)
        os.makedirs(out, exist_ok=True)
        open(os.path.join(out, "index.html"), "w", encoding="utf-8").write(page)
        syntax_check(page, slug)
        wj = words_json(slug, meta, data)
        open(os.path.join(out, "words.json"), "w", encoding="utf-8").write(json.dumps(wj, ensure_ascii=False, separators=(",", ":")))
        ls = [[s["i"], len(s["en"].split())] for s in listen_sents(data)] if data.get("audio") else []   # [sentence index, words]
        lj = os.path.join(out, "listen.json")
        if ls:
            open(lj, "w", encoding="utf-8").write(json.dumps(listen_json(slug, meta, data), ensure_ascii=False, separators=(",", ":")))
        elif os.path.isfile(lj):
            os.remove(lj)
        index.append(dict(slug=slug, title=meta["title"], short=meta["short"], date=meta["date"], clips=bool(data.get("clips")), ls=ls,
                          w=[[v["id"], v["expr"], v["zh"]] for v in data["vocab"]]))
        metas.append(meta)
        print(f"  a/{slug}/index.html  {len(page.encode('utf-8')) // 1024} KB  ({meta['vocab']} words, {len(data['sents'])} sentences)")

    metas.sort(key=lambda m: (m["date"], m["slug"]), reverse=True)
    index.sort(key=lambda a: (a["date"], a["slug"]), reverse=True)
    os.makedirs(os.path.join(ROOT, "review"), exist_ok=True)
    rv = review_tpl.replace("__INDEX__", json.dumps(dict(articles=index), ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/"))
    syntax_check(rv, "review")
    open(os.path.join(ROOT, "review", "index.html"), "w", encoding="utf-8").write(rv)
    print(f"  review/index.html  ({sum(len(a['w']) for a in index)} words)")
    site = dict(articles=[dict(slug=m["slug"], date=m["date"], title=m["title"], deck=m["deck"], tags=m["tags"],
                               source=m["source"], words=m["words"], vocab=m["vocab"], lsKey=m["lsKey"], audio=m["audio"]) for m in metas])
    payload = json.dumps(site, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    home = home_tpl.replace("__SITE__", payload)
    syntax_check(home, "home")
    open(os.path.join(ROOT, "index.html"), "w", encoding="utf-8").write(home)
    print(f"  index.html  ({len(metas)} article{'s' if len(metas) != 1 else ''})")


if __name__ == "__main__":
    main()

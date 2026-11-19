#!/usr/bin/env python3
"""Build the whole site from content/<slug>/article.json.

    python3 tools/build.py            # from the repo root

Writes   a/<slug>/index.html   one study page per article (reader.template.html)
         a/<slug>/words.json   the article's words with everything a quiz needs (read by the review page)
         a/<slug>/listen.json  the article's sentences with narration times, for the listening exam (only when audio exists)
         review/index.html     the spaced-repetition review page (review.template.html); review-ko/ for the Korean section
         index.html            the collection home page (home.template.html); ko/index.html for the Korean section

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
from tts_text import text_hash, clip_items, clips_hash, split_speaker, strip_rom_speaker  # noqa: E402
from refs import resolve_refs  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools")
CONTENT = os.path.join(ROOT, "content")
SHARED = os.path.join(TOOLS, "shared")
SHARED_PARTS = (("/*__BASE_CSS__*/", "base.css"), ("/*__COMMON_JS__*/", "common.js"), ("/*__SRS_JS__*/", "srs.js"),
                ("/*__CLIPS_JS__*/", "clips.js"), ("/*__KIT_JS__*/", "quizkit.js"),
                ("/*__WHO_CSS__*/", "who.css"), ("/*__WHO_JS__*/", "who.js"))
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# the sections of the site: English articles at the root, the others under their own folder (meta.lang = "ko" / "ja" / "yue")
SECTIONS = {
    "en": dict(home="", icon="📰", review="review", label="英文外刊", brand="外刊精读", h1="外刊精读合集", eyebrow="DAILY CLOSE READING",
               tagline="每天一篇：逐句精读、攒词、自测。", rtitle="词汇复习 · 外刊精读",
               foot2="标明“原创练习文章”的文章是为学习而写的仿外刊练习，不是真实外刊的转载。"),
    "ko": dict(home="ko", icon="🌷", review="review-ko", label="韩语入门", brand="韩语入门", h1="韩语入门", eyebrow="KOREAN FOR BEGINNERS",
               tagline="每天一小段：读、听、攒词、自测。", rtitle="词汇复习 · 韩语入门",
               foot2="韩语短文是为零基础学习者写的原创练习。"),
    "ja": dict(home="ja", icon="🌸", review="review-ja", label="日语中级", brand="日语中级", h1="日语中级", eyebrow="JAPANESE · INTERMEDIATE",
               tagline="跟着网课，每课一页：单词、语法、短文、自测。", rtitle="词汇复习 · 日语中级",
               foot2="单词和语法点按课程整理；讲解、例句和短文为原创练习。"),
    "yue": dict(home="yue", icon="🥟", review="review-yue", label="粤语入门", brand="粤语入门", h1="粤语入门", eyebrow="CANTONESE FOR BEGINNERS",
                tagline="每天一小段：读、听、攒词、自测。", rtitle="词汇复习 · 粤语入门",
                foot2="粤语短文是为零基础学习者写的原创练习；读音用粤拼（香港语言学学会粤语拼音方案）标注。"),
}
JA_CHARS = "\u3040-\u30ff\u3005\u4e00-\u9fff"


def die(msg):
    sys.exit(f"build error: {msg}")


def check(cond, msg):
    if not cond:
        die(msg)


def word_re(term):
    """A term in a text: no letter just before; no Latin letter after (Korean particles and endings may follow)."""
    return re.compile(r"(?<![A-Za-z\uac00-\ud7a3])" + re.escape(term) + r"(?![A-Za-z])", re.I)


def norm_key(s):
    return re.sub(r"[^a-z\uac00-\ud7a3" + JA_CHARS + "]", "", s.lower())


def sent_len(text, lang):
    """Words of a sentence; characters for Japanese and Cantonese, which have no spaces."""
    return len(re.sub(r"[^" + JA_CHARS + r"A-Za-z0-9]", "", text)) if lang in ("ja", "yue") else len(text.split())


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
    meta.setdefault("lang", "en")
    check(meta["lang"] in SECTIONS, f"{where} meta.lang must be one of {sorted(SECTIONS)}")
    data["lang"] = meta["lang"]
    if meta.get("ruby"):
        # Japanese: readings shown above hard kanji, {"漢字": "かんじ"} (longest match first, see rubyNodes in common.js)
        check(meta["lang"] == "ja" and isinstance(meta["ruby"], dict) and all(k and v for k, v in meta["ruby"].items()),
              f"{where} meta.ruby is for Japanese: a map of kanji to kana")
        data["ruby"] = meta["ruby"]
    ko = meta["lang"] in ("ko", "ja", "yue")   # these need a reading line (rom): romanization / kana / Jyutping

    # ---- sentences
    sents = data["sents"]
    check(sents and sents[0]["kind"] == "title", f"{where} first sentence must be kind 'title'")
    body_n = 0
    for i, s in enumerate(sents):
        check(s["kind"] in ("title", "sub", "body"), f"{where} sentence {i}: bad kind")
        check(s.get("en") and s.get("zh"), f"{where} sentence {i}: en and zh are required")
        check(not ko or s.get("rom"), f"{where} sentence {i}: Korean, Japanese and Cantonese sentences need rom (romanization / kana / Jyutping)")
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
        seen = v.get("seen")
        if seen:
            # a word met outside the article text: its own sentence stands in for the article sentence
            check(seen.get("en") and seen.get("zh") and seen.get("hint"), f"{where} vocab {vid}: seen needs en, zh and hint")
            sm = re.search(r"\[\[(.+?)\]\]", seen["en"])
            check(sm, f"{where} vocab {vid}: mark the word in seen.en with [[ ]]")
            v["m"] = [sm.group(1)]
            v["ctx"] = seen["en"].replace("[[", "").replace("]]", "")
        for k in ("expr", "zh", "m", "core", "forms") + (("rom",) if ko else ()):
            check(v.get(k), f"{where} vocab {vid}: {k} is required")
        v.setdefault("syn", [])
        v.setdefault("note", "")
        check(v["core"] in v["forms"], f"{where} vocab {vid}: core must be one of forms")
        if v.get("ipa") is not None:
            check(re.fullmatch(r"/[^/]+/", v["ipa"] or ""), f"{where} vocab {vid}: ipa is written between slashes, e.g. /ˈmaɪnd/ (tools/make_ipa.py makes it)")
        if meta["lang"] == "yue":
            check(re.fullmatch(r"[a-z]+[1-6]( [a-z]+[1-6])*", v["rom"]), f"{where} vocab {vid}: rom must be Jyutping with tone numbers, e.g. 'nei5 hou2'")
        if not seen:
            for t in v["m"]:
                check(word_re(t).search(all_en), f"{where} vocab {vid}: highlight term {t!r} not found in the article")
            hit = next((s for s in sents if any(word_re(t).search(s["en"]) for t in v["m"])), None)
            check(hit, f"{where} vocab {vid}: no sentence contains its terms")
            v.setdefault("ctx", hit["en"])
        check(any(word_re(t).search(v["ctx"]) for t in v["m"]), f"{where} vocab {vid}: ctx lacks its own term")
        check(2 <= len(v.get("ex", [])) <= 5, f"{where} vocab {vid} ({v['expr']}): give 2-5 examples")
        if meta["lang"] == "en" and v.get("kind") != "grammar" and not v.get("mine"):
            check(v.get("def") and not re.search(r"[\u4e00-\u9fff]", v["def"]), f"{where} vocab {vid} ({v['expr']}): def (an English-English definition) is required")
        for c in v.get("cf", []):
            check(isinstance(c, dict) and c.get("w") and c.get("rel") in ("syn", "ant", "cf") and c.get("diff"),
                  f"{where} vocab {vid}: each cf needs w, rel (syn / ant / cf) and diff")
            for x in c.get("ex", []):
                check(x.get("en") and x.get("zh"), f"{where} vocab {vid}: cf examples need en and zh")
        for q in v.get("pick", []):
            check(q.get("q") and len(q.get("opts", [])) >= 2 and 0 <= q.get("a", -1) < len(q["opts"]) and q.get("why"),
                  f"{where} vocab {vid}: each pick needs q, 2+ opts, a valid answer index a and why")
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

    # ---- cloze items: either resolved already, or {id, i, ans, hint}; words with "seen" are blanked out of that sentence
    cloze, cids = [], set()
    for v in data["vocab"]:
        if v.get("seen"):
            sm = re.search(r"\[\[(.+?)\]\]", v["seen"]["en"])
            cloze.append(dict(id=v["id"], before=v["seen"]["en"][: sm.start()], ans=sm.group(1), after=v["seen"]["en"][sm.end():],
                              hint=v["seen"]["hint"], szh=v["seen"]["zh"]))
            cids.add(v["id"])
    for c in data["cloze"]:
        check(c["id"] in ids and c["id"] not in cids, f"{where} cloze id {c['id']} unknown or repeated")
        cids.add(c["id"])
        if "before" not in c:
            s = sents[c["i"]]
            ms = list(word_re(c["ans"]).finditer(s["en"]))
            check(len(ms) == 1, f"{where} cloze {c['id']}: {c['ans']!r} must appear exactly once in sentence {c['i']}")
            c = dict(id=c["id"], i=c["i"], before=s["en"][: ms[0].start()], ans=ms[0].group(0),
                     after=s["en"][ms[0].end():], hint=c["hint"])
        c.setdefault("szh", sents[c["i"]]["zh"])
        cloze.append(c)
    check(cids == ids, f"{where} every vocab entry needs exactly one cloze item")
    data["cloze"] = cloze

    # ---- long-sentence breakdown
    bd = data["breakdown"]
    bd["i"] = next((s["i"] for s in sents if s["en"] == bd["en"]), None)
    check(bd["i"] is not None, f"{where} breakdown.en must be one of the article sentences")
    check(len(bd["points"]) >= 1, f"{where} breakdown points missing")
    data.pop("questions", None)      # the old post-reading questions are no longer shown

    # ---- derived numbers for the home page
    meta["words"] = sum(sent_len(s["en"], meta["lang"]) for s in sents)
    meta["vocab"] = len(data["vocab"])
    meta["fresh"] = sum(1 for v in data["vocab"] if not v.get("ref"))   # words first taught here (refs are reviewed under their own article)
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
    check(au["hash"] == text_hash(data["sents"], raw["meta"].get("pronounce", {}), raw["meta"].get("speakers")),
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
        if v.get("ref"):
            continue
        c = cl[v["id"]]
        words.append(dict(
            id=v["id"], expr=v["expr"], zh=v["zh"], core=v["core"], forms=v["forms"], syn=v["syn"], note=v["note"],
            m=v["m"], ctx=v["ctx"], ex=v["ex"], **{k: v[k] for k in ("rom", "ipa", "kind", "conn", "pick", "def", "cf") if k in v},
            cloze=dict(before=c["before"], ans=c["ans"], after=c["after"], hint=c["hint"], szh=c["szh"])))
    return dict(slug=slug, title=meta["title"], clips=data.get("clips"), words=words)


LISTEN_MIN, LISTEN_MAX = 5, 32      # words per article sentence that make a fair dictation
LISTEN_MIN_KO = 2                   # Korean lessons are short and a Korean "word" carries its particle
LISTEN_MIN_JA, LISTEN_MAX_JA = 8, 60   # Japanese: characters
LISTEN_MIN_YUE, LISTEN_MAX_YUE = 4, 40   # Cantonese: characters


def listen_sents(data):
    """The article sentences the listening exam may use: the deck and the body, not too short and not too long."""
    out = []
    lang = data.get("lang")
    lo, hi = {"ko": (LISTEN_MIN_KO, LISTEN_MAX), "ja": (LISTEN_MIN_JA, LISTEN_MAX_JA), "yue": (LISTEN_MIN_YUE, LISTEN_MAX_YUE)}.get(lang, (LISTEN_MIN, LISTEN_MAX))
    for s in data["sents"]:
        n = sent_len(s["en"], lang)
        if s["kind"] != "title" and lo <= n <= hi:
            out.append(s)
    return out


def listen_json(slug, meta, data):
    a = data["audio"]
    sp = meta.get("speakers")

    def one(s):
        # dictation asks for what is said, not who says it: drop "阿詩：" (and its reading) from dialogue lines
        who, en = split_speaker(s["en"], sp)
        x = dict(i=s["i"], en=en, zh=re.sub(r"^[^：:]{1,8}[：:]", "", s["zh"]) if who else s["zh"], t=a["t"][s["i"]])
        if data.get("lang") == "yue":
            x["rom"] = strip_rom_speaker(s["rom"]) if who else s["rom"]
        return x
    return dict(slug=slug, title=meta["title"], audio=dict(src=a["src"]), sents=[one(s) for s in listen_sents(data)])


LIST_CSS = """
:root{--bg:#FFF8F1;--fg:#3B2F2A;--muted:#8C7B71;--line:#F2E3D6;--accent:#3F86D6;--soft:#E4F0FC;--surface:#fff;--surface-2:#FBEFE4}
html[data-lang="ko"]{--accent:#E8618F;--soft:#FDE6EF} html[data-lang="ja"]{--accent:#3F9E6C;--soft:#DFF3E7} html[data-lang="yue"]{--accent:#D9693A;--soft:#FCE9DE}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:400 15px/1.6 ui-rounded,'SF Pro Rounded',system-ui,-apple-system,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif}
.in{max-width:820px;margin:0 auto;padding:24px max(16px,env(safe-area-inset-left,0px)) 56px}
.top{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;justify-content:space-between;margin-bottom:6px}
.back{color:var(--muted);text-decoration:none;font-weight:700;font-size:14px}
.btn{appearance:none;border:0;border-radius:999px;padding:8px 16px;background:var(--accent);color:#fff;font-weight:700;font-size:14px;line-height:1.2;font-family:inherit;cursor:pointer}
h1{margin:6px 0 2px;font-weight:800;font-size:26px;line-height:1.3} .sub{margin:0 0 18px;color:var(--muted);font-size:13.5px}
.w{padding:14px 16px;margin-bottom:10px;background:var(--surface);border-radius:18px;box-shadow:0 8px 24px -16px rgba(122,84,58,.35);break-inside:avoid;page-break-inside:avoid}
.h{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
.n{min-width:1.6em;color:var(--muted);font:700 13px/1 ui-monospace,Menlo,monospace}
.e{font-weight:800;font-size:19px;line-height:1.35} .p{color:var(--accent);font-weight:500;font-size:15px;letter-spacing:.02em} .z{font-weight:600}
.d{margin:2px 0 0 2.2em;font-style:italic;font-size:14px} .c{margin:2px 0 0 2.2em;color:var(--muted);font-size:13px} .c b{color:var(--fg)}
.tag{padding:0 8px;border-radius:999px;background:var(--soft);color:var(--accent);font-weight:700;font-size:11px;line-height:1.7}
ol{margin:8px 0 0;padding-left:1.6em} li{margin:4px 0} li b{color:var(--accent)} .r,.t{display:block;color:var(--muted);font-size:13.5px} .r{letter-spacing:.01em}
.prev{appearance:none;border:2px solid var(--line);border-radius:999px;padding:6px 14px;background:var(--surface);color:var(--muted);font-weight:700;font-size:13px;font-family:inherit;cursor:pointer}
#mm{position:absolute;left:-9999px;top:0;width:1px;height:279mm}
/* print layout (printing, or the 预览 buttons): A4, columns, small type; the script picks the largest size that fits one or two pages */
@page{size:A4;margin:9mm}
body.printing{background:#fff}
.printing .in{width:192mm;max-width:none;padding:0;margin:0 auto;font-size:var(--fs,9px);line-height:1.32}
.printing .top{display:none}
.printing h1{font-size:1.5em;margin:0} .printing .sub{font-size:.9em;margin:0 0 .6em}
.printing .sheet{column-count:var(--cols,2);column-gap:5mm;column-rule:0.3pt solid #ccc}
.printing .w{background:none;box-shadow:none;border-radius:0;padding:0 0 .35em;margin:0 0 .35em;border-bottom:0.3pt solid #ddd}
.printing .e{font-size:1.15em} .printing .p,.printing .z{font-size:1em} .printing .n{font-size:.9em;min-width:1.4em}
.printing .tag{font-size:.8em}
.printing .d,.printing .c{font-size:.92em;margin:.1em 0 0 1.3em}
.printing.no-cf .c,.printing.no-def .d{display:none}
.printing #sheet2{break-before:page;page-break-before:always}
@media screen{.printing #sheet2{margin-top:9mm;padding-top:9mm;border-top:1px dashed #999}}
.tip{margin:0 0 14px;color:var(--muted);font-size:13px}
.printing .tip{display:none}
.printing ol{margin:.15em 0 0;padding-left:1.3em} .printing li{margin:0}
.printing .r,.printing .t{display:inline;font-size:.92em} .printing .r::before,.printing .t::before{content:" · "}
@media print{.noprint,.top{display:none}}
"""


LIST_JS = """<script>
/* print layouts. 正反两页 (default): the list split over two A4 pages, page 1 filled first, with the largest type that fits;
   一页纸: everything on one A4 page. Both use columns; if a list still does not fit at the smallest size, the 辨析 line and then
   the English definition are left out. The chosen layout is remembered and is also used by the browser's own print command. */
(function(){
  var root = document.documentElement, body = document.body, inn = document.querySelector('.in'), s1 = document.querySelector('.sheet');
  var rows = [].slice.call(s1.children), s2 = null;
  var KEY = 'wk-list-mode', mode = 'two';
  try { mode = localStorage.getItem(KEY) === 'one' ? 'one' : 'two'; } catch (e) {}
  /* 6% spare: browsers lay out a printed page a little differently from the screen (fonts, rounding, header lines), so a page
     measured as exactly full on screen can push its last word onto the next sheet */
  var SPARE = 0.94;
  function H(){ return document.getElementById('mm').getBoundingClientRect().height * SPARE; }
  function page1(){ return s1.getBoundingClientRect().bottom - inn.getBoundingClientRect().top <= H(); }
  function page2(){ var cs = getComputedStyle(s2); return s2.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.borderTopWidth); }
  var LEVELS = ['', 'no-cf', 'no-cf no-def'];
  function setLevel(l){ body.classList.remove('no-cf', 'no-def'); if (l) l.split(' ').forEach(function(c){ body.classList.add(c); }); }
  function size(cols, fs){ root.style.setProperty('--cols', cols); root.style.setProperty('--fs', fs + 'px'); }
  function put(k){ rows.forEach(function(r, i){ (i < k || !s2 ? s1 : s2).appendChild(r); }); }
  function unsplit(){ if (s2){ s2.remove(); s2 = null; } put(rows.length); }
  function fitOne(){
    var tries = [[2, 13, 6.5], [3, 8, 6]];
    for (var L = 0; L < LEVELS.length; L++){
      setLevel(LEVELS[L]);
      for (var k = 0; k < tries.length; k++)
        for (var fs = tries[k][1]; fs >= tries[k][2]; fs -= 0.25){ size(tries[k][0], fs); if (page1()) return; }
    }
  }
  function fitTwo(){
    s2 = document.createElement('div'); s2.className = 'sheet'; s2.id = 'sheet2'; s1.parentNode.insertBefore(s2, s1.nextSibling);
    var tries = [[2, 14, 7], [3, 9, 6]], n = rows.length;
    for (var L = 0; L < LEVELS.length; L++){
      setLevel(LEVELS[L]);
      for (var t = 0; t < tries.length; t++)
        for (var fs = tries[t][1]; fs >= tries[t][2]; fs -= 0.25){
          size(tries[t][0], fs);
          var lo = 0, hi = n;                       /* the most words that fit on page 1 */
          while (lo < hi){ var mid = Math.ceil((lo + hi) / 2); put(mid); if (page1()) lo = mid; else hi = mid - 1; }
          put(lo);
          if (page1() && page2() <= H()) return;
        }
    }
  }
  function fit(){ body.classList.add('printing'); unsplit(); setLevel(''); if (mode === 'two') fitTwo(); else fitOne(); }
  var preview = false;
  function clear(){ body.classList.remove('printing'); setLevel(''); unsplit(); }
  function done(){ if (!preview) clear(); }
  window.addEventListener('beforeprint', function(){ if (!preview) fit(); });
  window.addEventListener('afterprint', done);
  function open(m){
    mode = m; try { localStorage.setItem(KEY, m); } catch (e) {}
    preview = true; fit();
    var old = document.getElementById('pbar'); if (old) old.remove();
    var bar = document.createElement('div'); bar.className = 'noprint'; bar.id = 'pbar';
    bar.style.cssText = 'position:fixed;top:10px;right:10px;z-index:9';
    bar.innerHTML = '<button class="prev" type="button">退出预览</button> <button class="btn" type="button">打印 / 存成 PDF</button>';
    bar.children[0].onclick = function(){ preview = false; clear(); bar.remove(); };
    bar.children[1].onclick = function(){ window.print(); };
    body.appendChild(bar);
    window.scrollTo(0, 0);
  }
  document.getElementById('prev2').addEventListener('click', function(){ open('two'); });
  document.getElementById('prev').addEventListener('click', function(){ open('one'); });
  document.getElementById('printBtn').addEventListener('click', function(){ window.print(); });
})();
</script>"""


def list_html(slug, meta, data, sec):
    """A plain, printable word list of one article: the word, its phonetics (IPA / romanization / reading), meaning and two examples."""
    e = htmllib.escape
    lang = meta["lang"]

    def mark(s):
        return re.sub(r"\[\[(.+?)\]\]", lambda m: "<b>" + m.group(1) + "</b>", e(s, quote=False))
    rows = []
    for n, v in enumerate(data["vocab"], 1):
        pron = v.get("ipa") if lang == "en" else v.get("rom")
        tags = ('<span class="tag">语法</span>' if v.get("kind") == "grammar" else "") + (f'<span class="tag">出自 {e(v["from"])}</span>' if v.get("from") else "")
        exs = "".join(f'<li>{mark(x["en"])}' + (f'<span class="r">{e(x["rom"])}</span>' if x.get("rom") else "") + f'<span class="t">{e(x["zh"])}</span></li>'
                      for x in v["ex"][:2])
        extra = (f'<div class="d">{e(v["def"])}</div>' if v.get("def") else "")
        if v.get("cf"):
            extra += '<div class="c">辨析：' + "；".join(f'{ {"syn": "≈", "ant": "↔", "cf": "≠"}[c["rel"]]} <b>{e(c["w"])}</b> {e(c.get("zh", ""))}' for c in v["cf"]) + '</div>'
        rows.append(f'<div class="w"><div class="h"><span class="n">{n}</span><span class="e">{e(v["expr"])}</span>'
                    + (f'<span class="p">{e(pron)}</span>' if pron else "") + f'<span class="z">{e(v["zh"])}</span>{tags}</div>{extra}<ol>{exs}</ol></div>')
    label = {"en": "音标为英式（DJ）音标，由程序生成，以录音为准。", "ko": "读音为韩国官方罗马字。", "ja": "读音为假名。", "yue": "读音为粤拼，数字是声调。"}[lang]
    return (f'<!doctype html><html lang="zh-CN" data-lang="{lang}"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width, initial-scale=1"><title>{e(meta["short"])} · 单词表 · {e(sec["brand"])}</title>'
            f'<style>{LIST_CSS}</style></head><body><div class="in">'
            f'<div class="top noprint"><a class="back" href="./">‹ 回到文章</a><span><button class="prev" type="button" id="prev2">预览正反两页</button> '
            f'<button class="prev" type="button" id="prev">预览一页纸</button> '
            f'<a class="prev" href="check.html" style="text-decoration:none">✅ 背单词打卡表</a> '
            f'<a class="prev" href="ex.html" style="text-decoration:none">✍️ 例句默写纸</a> '
            + (f'<a class="prev" href="trans.html" style="text-decoration:none">🖨 回译练习纸</a> ' if lang in ("en", "ja") else "") +
            f'<button class="btn" type="button" id="printBtn">打印 / 存成 PDF</button></span></div>'
            f'<p class="tip noprint">打印正反两页：先点“预览正反两页”，再点“打印”，在打印设置里选“双面打印”（长边翻转）。</p>'
            f'<h1>{e(meta["short"])} · 单词表</h1><p class="sub">{e(meta["date"])} · {len(data["vocab"])} 个词 · 每个词两个例句。{label}</p>'
            + '<div class="sheet">' + "".join(rows) + '</div></div><div id="mm"></div>' + LIST_JS + '</body></html>')


CHECK_CSS = """
:root{--bg:#FFF8F1;--fg:#3B2F2A;--muted:#8C7B71;--line:#E9D8CA;--accent:#3F86D6;--soft:#E4F0FC;--surface:#fff}
html[data-lang="ko"]{--accent:#E8618F;--soft:#FDE6EF} html[data-lang="ja"]{--accent:#3F9E6C;--soft:#DFF3E7} html[data-lang="yue"]{--accent:#D9693A;--soft:#FCE9DE}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:400 15px/1.5 ui-rounded,'SF Pro Rounded',system-ui,-apple-system,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif}
.in{max-width:980px;margin:0 auto;padding:24px 16px 56px}
.top{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;justify-content:space-between;margin-bottom:6px}
.back{color:var(--muted);text-decoration:none;font-weight:700;font-size:14px}
.btn,.prev{appearance:none;border-radius:999px;padding:8px 16px;font-weight:700;font-size:14px;line-height:1.2;font-family:inherit;cursor:pointer}
.btn{border:0;background:var(--accent);color:#fff} .prev{border:2px solid var(--line);background:var(--surface);color:var(--muted);padding:6px 14px;font-size:13px}
h1{margin:6px 0 2px;font-weight:800;font-size:24px;line-height:1.3} .sub{margin:0 0 12px;color:var(--muted);font-size:13.5px}
.ctl{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;margin:0 0 12px;padding:12px 14px;background:var(--surface);border-radius:16px}
.ctl label{display:flex;gap:6px;align-items:center;font-size:14px;font-weight:600}
.ctl input[type=date]{font:inherit;padding:4px 8px;border:2px solid var(--line);border-radius:10px;background:#fff;color:var(--fg)}
.plan{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.plan span{padding:4px 10px;border-radius:999px;background:var(--surface);font-size:13px;border:1px solid var(--line)}
.plan span.today{background:var(--accent);color:#fff;border-color:var(--accent);font-weight:700}
.wrap{overflow-x:auto;background:var(--surface);border-radius:16px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{border:1px solid var(--line);padding:5px 6px;text-align:left;vertical-align:middle}
thead th{background:var(--soft);font-size:12.5px;line-height:1.3;text-align:center;white-space:nowrap}
thead th.today{background:var(--accent);color:#fff}
td.n{color:var(--muted);font:700 12px ui-monospace,Menlo,monospace;text-align:center;width:2.4em}
td.e{font-weight:800} td.p{color:var(--accent);font-size:12.5px;white-space:nowrap} td.z{font-size:13px}
td.k{width:3.6em;text-align:center;cursor:pointer;user-select:none;font-size:18px;line-height:1}
td.k::before{content:"☐";color:#B9A99D} td.k.on::before{content:"☑";color:var(--accent)}
td.k.today{background:#FFF3C9}
.hidezh td.z{color:transparent} .hidezh td.z:hover{color:var(--fg)}
.foot{margin:12px 0 0;color:var(--muted);font-size:12.5px}
@page{size:A4;margin:9mm}
@media print{
  body{background:#fff;font-size:10px} .in{max-width:none;padding:0} .noprint{display:none!important}
  h1{font-size:15px;margin:0} .sub{font-size:9px;margin:0 0 4px}
  .plan{margin:0 0 5px;gap:3px} .plan span{padding:1px 6px;font-size:9px;background:#fff!important;color:#000!important;border-color:#999!important}
  .wrap{overflow:visible;border-radius:0}
  table{font-size:10px} th,td{border-color:#999;padding:2px 4px}
  thead{display:table-header-group} tr{break-inside:avoid;page-break-inside:avoid}
  thead th,thead th.today{background:#eee!important;color:#000!important;font-size:9px}
  td.k{font-size:15px} td.k::before{color:#444} td.k.on::before{color:#000} td.k.today{background:none} td.n{font-size:9px} td.p{font-size:9px} td.z{font-size:9.5px}
  .hidezh td.z{color:transparent}
  .foot{font-size:8.5px}
}
"""

CHECK_JS = """<script>
/* 艾宾浩斯打卡表: review rounds on day 0 (learn), 1, 2, 4, 7, 15 and 30 after the start date. Ticks and the start date are kept in
   this browser (localStorage); printing gives the table with empty (or ticked) boxes and the real dates in the header. */
(function(){
  var OFF = [0, 1, 2, 4, 7, 15, 30], NAME = ['学习', '第1次', '第2次', '第3次', '第4次', '第5次', '第6次'];
  var WK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var key = 'wk-check-' + document.body.getAttribute('data-slug'), st = {start:'', c:{}, hide:false};
  try { var raw = JSON.parse(localStorage.getItem(key) || 'null'); if (raw && typeof raw === 'object') st = {start:raw.start || '', c:raw.c || {}, hide:!!raw.hide}; } catch (e) {}
  function save(){ try { localStorage.setItem(key, JSON.stringify(st)); } catch (e) {} }
  function ymd(d){ return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function parse(s){ var m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  var today = new Date(); today.setHours(0, 0, 0, 0);
  if (!parse(st.start)){ st.start = ymd(today); save(); }
  var inp = document.getElementById('start'), hz = document.getElementById('hidezh');
  inp.value = st.start; hz.checked = st.hide;
  function draw(){
    var s0 = parse(st.start) || today, plan = document.getElementById('plan'), ths = document.querySelectorAll('thead th.d'), tIdx = -1;
    plan.innerHTML = '';
    OFF.forEach(function(o, i){
      var d = new Date(s0); d.setDate(d.getDate() + o);
      var label = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + WK[d.getDay()];
      var isToday = d.getTime() === today.getTime(); if (isToday) tIdx = i;
      var sp = document.createElement('span'); sp.textContent = NAME[i] + (o ? '（' + o + '天后）' : '') + '　' + label; if (isToday) sp.className = 'today';
      plan.appendChild(sp);
      ths[i].innerHTML = NAME[i] + '<br>' + label; ths[i].classList.toggle('today', isToday);
    });
    document.querySelectorAll('td.k').forEach(function(td){
      td.classList.toggle('on', !!st.c[td.getAttribute('data-k')]);
      td.classList.toggle('today', +td.getAttribute('data-i') === tIdx);
    });
    document.body.classList.toggle('hidezh', st.hide);
  }
  inp.addEventListener('change', function(){ if (parse(inp.value)){ st.start = inp.value; save(); draw(); } });
  hz.addEventListener('change', function(){ st.hide = hz.checked; save(); draw(); });
  document.querySelector('tbody').addEventListener('click', function(e){
    var td = e.target.closest('td.k'); if (!td) return;
    var k = td.getAttribute('data-k'); if (st.c[k]) delete st.c[k]; else st.c[k] = 1;
    save(); draw();
  });
  document.getElementById('clear').addEventListener('click', function(){ if (!confirm('把这张表的勾全部清掉？')) return; st.c = {}; save(); draw(); });
  document.getElementById('printBtn').addEventListener('click', function(){ window.print(); });
  draw();
})();
</script>"""


def check_html(slug, meta, data, sec):
    """A tick-box sheet for learning one article's words by the Ebbinghaus schedule (review 1, 2, 4, 7, 15 and 30 days after
    the first day), with the dates filled in from a start date the learner picks; printable on A4."""
    e = htmllib.escape
    lang = meta["lang"]
    rows = []
    for n, v in enumerate(data["vocab"], 1):
        pron = v.get("ipa") if lang == "en" else v.get("rom")
        cells = "".join(f'<td class="k" data-i="{i}" data-k="{v["id"]}_{i}" role="checkbox"></td>' for i in range(7))
        rows.append(f'<tr><td class="n">{n}</td><td class="e">{e(v["expr"])}</td><td class="p">{e(pron or "")}</td><td class="z">{e(v["zh"])}</td>{cells}</tr>')
    ths = "".join('<th class="d"></th>' for _ in range(7))
    return (f'<!doctype html><html lang="zh-CN" data-lang="{lang}"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width, initial-scale=1"><title>{e(meta["short"])} · 背单词打卡表 · {e(sec["brand"])}</title>'
            f'<style>{CHECK_CSS}</style></head><body data-slug="{e(slug)}"><div class="in">'
            f'<div class="top noprint"><a class="back" href="./">‹ 回到文章</a><span><a class="prev" href="list.html" style="text-decoration:none">单词表</a> '
            f'<button class="btn" type="button" id="printBtn">打印 / 存成 PDF</button></span></div>'
            f'<h1>{e(meta["short"])} · 背单词打卡表</h1><p class="sub">{e(meta["date"])} · {len(data["vocab"])} 个词 · '
            f'按艾宾浩斯遗忘曲线：学习当天，之后第 1、2、4、7、15、30 天各复习一次，复习完在格子里打勾。</p>'
            f'<div class="ctl noprint"><label>开始背的日期 <input type="date" id="start"></label>'
            f'<label><input type="checkbox" id="hidezh"> 遮住中文（自测用，鼠标移上去显示）</label>'
            f'<button class="prev" type="button" id="clear">清空打勾</button></div>'
            f'<div class="plan" id="plan"></div>'
            f'<div class="wrap"><table><thead><tr><th>#</th><th>单词</th><th>{"音标" if lang == "en" else "读音"}</th><th>意思</th>{ths}</tr></thead>'
            f'<tbody>{"".join(rows)}</tbody></table></div>'
            f'<p class="foot">在网页上点格子就能打勾（勾记在这台设备的浏览器里）；也可以打印出来用笔打勾。黄色那一列是今天要复习的。</p>'
            f'</div>{CHECK_JS}</body></html>')


TRANS_CSS = """
:root{--bg:#FFF8F1;--fg:#3B2F2A;--muted:#8C7B71;--line:#E9D8CA;--accent:#3F86D6;--soft:#E4F0FC;--surface:#fff}
html[data-lang="ja"]{--accent:#3F9E6C;--soft:#DFF3E7}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:400 15px/1.6 ui-rounded,'SF Pro Rounded',system-ui,-apple-system,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif}
.in{max-width:820px;margin:0 auto;padding:24px 16px 56px}
.top{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;justify-content:space-between;margin-bottom:6px}
.back{color:var(--muted);text-decoration:none;font-weight:700;font-size:14px}
.btn,.prev{appearance:none;border-radius:999px;padding:8px 16px;font-weight:700;font-size:14px;line-height:1.2;font-family:inherit;cursor:pointer;text-decoration:none;display:inline-block}
.btn{border:0;background:var(--accent);color:#fff} .prev{border:2px solid var(--line);background:var(--surface);color:var(--muted);padding:6px 14px;font-size:13px}
h1{margin:6px 0 2px;font-weight:800;font-size:24px;line-height:1.3} h2{margin:0 0 6px;font-size:18px}
.sub{margin:0 0 12px;color:var(--muted);font-size:13.5px}
.ctl{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;margin:0 0 14px;padding:12px 14px;background:var(--surface);border-radius:16px}
.ctl label{display:flex;gap:6px;align-items:center;font-size:14px;font-weight:600}
.sheet{background:var(--surface);border-radius:16px;padding:16px 18px}
.blk{margin:0 0 6px;color:var(--accent);font-weight:800;font-size:13px;letter-spacing:.04em}
.q{break-inside:avoid;page-break-inside:avoid;margin:0 0 12px}
.zh{margin:0;font-size:15.5px;line-height:1.6} .zh b{display:inline-block;min-width:1.8em;color:var(--muted);font:700 13px ui-monospace,Menlo,monospace}
.hint{display:none;margin:2px 0 0 1.9em;color:var(--muted);font-size:12.5px}
.hints .hint{display:block}
.ln{height:30px;margin-left:1.9em;border-bottom:1px solid #C9B8AA}
.gap{height:8px}
.ans{margin-top:22px}
.noans .ans{display:none}
.a{margin:0 0 6px;font:400 15px/1.55 Georgia,'Times New Roman',serif} .a b{display:inline-block;min-width:1.8em;color:var(--muted);font:700 12px ui-monospace,Menlo,monospace}
.a .r{display:block;margin-left:2.2em;color:var(--muted);font:400 12.5px/1.5 ui-rounded,system-ui,sans-serif}
.foot{margin:12px 0 0;color:var(--muted);font-size:12.5px}
@page{size:A4;margin:12mm}
@media print{
  body{background:#fff} .in{max-width:none;padding:0} .noprint{display:none!important}
  h1{font-size:16px;margin:0} .sub{font-size:9.5px;margin:0 0 6px}
  .sheet{padding:0;border-radius:0}
  .zh{font-size:11.5px} .zh b{font-size:10px} .hint{font-size:9.5px}
  .q{margin:0 0 7px} .ln{height:8.5mm;border-bottom-color:#999}
  .ans{margin-top:0;break-before:page;page-break-before:always}
  h2{font-size:14px} .a{font-size:11px;margin:0 0 3px} .a b{font-size:9px} .a .r{font-size:9.5px}
  .foot{display:none}
}
"""

TRANS_JS = """<script>
(function(){
  var b = document.body, key = 'wk-trans-print';
  var st = {hints:false, ans:true};
  try { var r = JSON.parse(localStorage.getItem(key) || 'null'); if (r) st = {hints:!!r.hints, ans:r.ans !== false}; } catch (e) {}
  var h = document.getElementById('hints'), a = document.getElementById('withans');
  function draw(){ b.classList.toggle('hints', st.hints); b.classList.toggle('noans', !st.ans); h.checked = st.hints; a.checked = st.ans; }
  function save(){ try { localStorage.setItem(key, JSON.stringify(st)); } catch (e) {} }
  h.addEventListener('change', function(){ st.hints = h.checked; save(); draw(); });
  a.addEventListener('change', function(){ st.ans = a.checked; save(); draw(); });
  document.getElementById('printBtn').addEventListener('click', function(){ window.print(); });
  draw();
})();
</script>"""


def trans_html(slug, meta, data, sec):
    """A printable back-translation sheet (English and Japanese articles): each Chinese sentence with lines to write the original
    language on, grouped by paragraph; the original text follows on a new page as the answer key."""
    e = htmllib.escape
    lang = meta["lang"]
    XL = {"en": "英文", "ja": "日语"}[lang]
    per_line = 48 if lang == "en" else 24          # how much handwriting fits on one line, roughly
    sents = data["sents"]
    groups = [("标题", [s for s in sents if s.get("kind") == "title"]), ("导语", [s for s in sents if s.get("kind") == "sub"])]
    for p in sorted({s["p"] for s in sents if s.get("p")}):
        groups.append((f"第 {p} 段", [s for s in sents if s.get("p") == p]))
    vocab = [v for v in data["vocab"] if v.get("kind") != "grammar"]
    qs, ans, n = [], [], 0
    for label, ss in groups:
        if not ss:
            continue
        qs.append(f'<p class="blk">{label}</p>')
        for s in ss:
            n += 1
            words = [v for v in vocab if any(word_re(t).search(s["en"]) for t in v["m"])]
            hint = ("提示：" + "；".join(f'{e(v["expr"])}（{e(v["zh"])}）' for v in words)) if words else ""
            lines = max(1, -(-len(s["en"]) // per_line))
            qs.append(f'<div class="q"><p class="zh"><b>{n}</b>{e(s["zh"])}</p>' + (f'<p class="hint">{hint}</p>' if hint else "")
                      + '<div class="ln"></div>' * lines + '</div>')
            ans.append(f'<p class="a"><b>{n}</b>{e(s["en"])}' + (f'<span class="r">{e(s["rom"])}</span>' if lang == "ja" and s.get("rom") else "") + '</p>')
        qs.append('<div class="gap"></div>')
    return (f'<!doctype html><html lang="zh-CN" data-lang="{lang}"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width, initial-scale=1"><title>{e(meta["short"])} · 回译练习纸 · {e(sec["brand"])}</title>'
            f'<style>{TRANS_CSS}</style></head><body><div class="in">'
            f'<div class="top noprint"><a class="back" href="./#trans">‹ 回到文章</a><span><a class="prev" href="list.html">单词表</a> '
            f'<button class="btn" type="button" id="printBtn">打印 / 存成 PDF</button></span></div>'
            f'<h1>{e(meta["short"])} · 回译练习纸</h1><p class="sub">{e(meta["date"])} · {n} 句 · 看中文，在横线上写出{XL}原文；写完再看最后的参考答案。'
            f'　姓名 ________　日期 ________</p>'
            f'<div class="ctl noprint"><label><input type="checkbox" id="withans"> 附参考答案（另起一页）</label>'
            f'<label><input type="checkbox" id="hints"> 每句下面提示本句生词</label></div>'
            f'<div class="sheet">{"".join(qs)}<div class="ans"><h2>参考答案（{XL}原文）</h2>{"".join(ans)}</div></div>'
            f'<p class="foot">打印时可以双面打印；答案会从新的一页开始，不想先看到答案可以把那一页撕下来放一边。</p>'
            f'</div>{TRANS_JS}</body></html>')


EX_CSS = TRANS_CSS.replace('html[data-lang="ja"]{--accent:#3F9E6C;--soft:#DFF3E7}',
    'html[data-lang="ko"]{--accent:#E8618F;--soft:#FDE6EF} html[data-lang="ja"]{--accent:#3F9E6C;--soft:#DFF3E7} html[data-lang="yue"]{--accent:#D9693A;--soft:#FCE9DE}') + """
.w{break-inside:avoid;page-break-inside:avoid;margin:0 0 10px}
.wh{margin:0 0 2px;font-weight:800;font-size:15px} .wh i{font-style:normal;color:var(--muted);font:700 12px ui-monospace,Menlo,monospace;margin-right:6px}
.wh span{font-weight:600;color:var(--muted);font-size:13px;margin-left:8px}
.wh span.x{margin-left:0;color:var(--fg);font-weight:800;font-size:15px}
.nohead .wh .x{display:none}
.zh2{margin:2px 0 0 1.9em;font-size:14.5px;line-height:1.55}
.cl{margin:2px 0 0 1.9em;font:400 15px/1.9 Georgia,'Times New Roman',serif}
.cl u{display:inline-block;min-width:5em;border-bottom:1px solid #777;text-decoration:none;color:transparent}
.m-cloze .ln,.m-sent .cl{display:none}
.one .e1{display:none}
.a .x{color:var(--muted);font-size:.9em}
@media print{.wh{font-size:11.5px} .wh span,.wh i{font-size:9.5px} .wh span.x{font-size:11.5px} .zh2{font-size:10.5px} .cl{font-size:11px;line-height:2.1} .w{margin:0 0 6px}}
"""

EX_JS = """<script>
(function(){
  var b = document.body, key = 'wk-ex-print', st = {mode:'sent', one:false, head:true, ans:true};
  try { var r = JSON.parse(localStorage.getItem(key) || 'null'); if (r) st = {mode:r.mode === 'cloze' ? 'cloze' : 'sent', one:!!r.one, head:r.head !== false, ans:r.ans !== false}; } catch (e) {}
  var M = document.querySelectorAll('input[name=mode]'), one = document.getElementById('one'), head = document.getElementById('head'), ans = document.getElementById('withans');
  function draw(){
    b.classList.toggle('m-sent', st.mode === 'sent'); b.classList.toggle('m-cloze', st.mode === 'cloze');
    b.classList.toggle('one', st.one); b.classList.toggle('nohead', !st.head); b.classList.toggle('noans', !st.ans);
    M.forEach(function(x){ x.checked = x.value === st.mode; }); one.checked = st.one; head.checked = st.head; ans.checked = st.ans;
  }
  function save(){ try { localStorage.setItem(key, JSON.stringify(st)); } catch (e) {} }
  M.forEach(function(x){ x.addEventListener('change', function(){ st.mode = x.value; save(); draw(); }); });
  one.addEventListener('change', function(){ st.one = one.checked; save(); draw(); });
  head.addEventListener('change', function(){ st.head = head.checked; save(); draw(); });
  ans.addEventListener('change', function(){ st.ans = ans.checked; save(); draw(); });
  document.getElementById('printBtn').addEventListener('click', function(){ window.print(); });
  draw();
})();
</script>"""


def ex_html(slug, meta, data, sec):
    """A printable dictation sheet of the words' example sentences: 整句默写 (the Chinese, lines to write the sentence) or 挖空填词
    (the sentence with the word blanked out), the first one or two examples of each word, answers on a new page."""
    e = htmllib.escape
    lang = meta["lang"]
    XL = {"en": "英文", "ko": "韩语", "ja": "日语", "yue": "粤语"}[lang]
    per_line = {"en": 48, "ko": 30}.get(lang, 24)
    ws, ans, n = [], [], 0
    for wn, v in enumerate(data["vocab"], 1):
        items = []
        for k, x in enumerate(v["ex"][:2]):
            n += 1
            lab = f"{wn}-{k + 1}"
            plain = x["en"].replace("[[", "").replace("]]", "")
            cl = re.sub(r"\[\[(.+?)\]\]", lambda m: "<u>" + e(m.group(1)) + "</u>", e(x["en"], quote=False))
            lines = max(1, -(-len(plain) // per_line))
            items.append(f'<div class="e{k}"><p class="zh2"><b>{lab}</b> {e(x["zh"])}</p><p class="cl">{cl}</p>' + '<div class="ln"></div>' * lines + '</div>')
            ans.append(f'<p class="a e{k}"><b>{lab}</b>' + re.sub(r"\[\[(.+?)\]\]", lambda m: "<strong>" + e(m.group(1)) + "</strong>", e(x["en"], quote=False))
                       + (f'<span class="r">{e(x["rom"])}</span>' if x.get("rom") else "") + '</p>')
        ws.append(f'<div class="w"><p class="wh"><i>{wn}</i><span class="x">{e(v["expr"])}</span><span>{e(v["zh"])}</span></p>{"".join(items)}</div>')
    return (f'<!doctype html><html lang="zh-CN" data-lang="{lang}"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width, initial-scale=1"><title>{e(meta["short"])} · 例句默写纸 · {e(sec["brand"])}</title>'
            f'<style>{EX_CSS}</style></head><body class="m-sent"><div class="in">'
            f'<div class="top noprint"><a class="back" href="./#words">‹ 回到文章</a><span><a class="prev" href="list.html">单词表</a> '
            f'<button class="btn" type="button" id="printBtn">打印 / 存成 PDF</button></span></div>'
            f'<h1>{e(meta["short"])} · 例句默写纸</h1><p class="sub">{e(meta["date"])} · {len(data["vocab"])} 个词的例句 · 看中文写出{XL}例句（或填出空着的词），写完再看最后的答案。'
            f'　姓名 ________　日期 ________</p>'
            f'<div class="ctl noprint"><label><input type="radio" name="mode" value="sent"> 整句默写（看中文写整句）</label>'
            f'<label><input type="radio" name="mode" value="cloze"> 挖空填词（句子里空出生词）</label>'
            f'<label><input type="checkbox" id="one"> 每个词只要 1 句</label>'
            f'<label><input type="checkbox" id="head"> 显示生词本身</label>'
            f'<label><input type="checkbox" id="withans"> 附答案（另起一页）</label></div>'
            f'<div class="sheet">{"".join(ws)}<div class="ans"><h2>答案（例句原文，生词加粗）</h2>{"".join(ans)}</div></div>'
            f'<p class="foot">“显示生词本身”不勾时只显示中文意思，难度更高。选项会记住，下次打开还是这样。</p>'
            f'</div>{EX_JS}</body></html>')


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
    for ph in ("__DATA__", "__LS_STATE__", "__TITLE__", "__BRAND__", "__HOME__", "__FOOT__", "__SLUG__", "__REVIEW__", "__LANG__"):
        check(reader_tpl.count(ph) >= 1, f"reader template lost placeholder {ph}")
    for ph in ("__SITE__", "__LANG__", "__H1__", "__EYEBROW__", "__TAGLINE__", "__FOOT2__"):
        check(home_tpl.count(ph) >= 1, f"home template lost placeholder {ph}")
    for ph in ("__INDEX__", "__LANG__", "__TITLE__", "__HOME__"):
        check(review_tpl.count(ph) >= 1, f"review template lost placeholder {ph}")

    metas, index = [], []
    slugs = sorted(d for d in os.listdir(CONTENT) if os.path.isfile(os.path.join(CONTENT, d, "article.json")))
    check(slugs, "no articles found in content/")
    for slug in slugs:
        raw = json.load(open(os.path.join(CONTENT, slug, "article.json"), encoding="utf-8"))
        err = resolve_refs(slug, raw, CONTENT)
        check(not err, err)
        meta, data = prepare(slug, raw)
        attach_audio(slug, meta, data, raw)
        attach_clips(slug, data, raw)
        payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
        sec = SECTIONS[meta["lang"]]
        page = (reader_tpl
                .replace("__TITLE__", htmllib.escape(f"{meta['short']} · {sec['brand']}"))
                .replace("__BRAND__", htmllib.escape(meta["short"]))
                .replace("__HOME__", "../../" + (sec["home"] + "/" if sec["home"] else ""))
                .replace("__LANG__", meta["lang"])
                .replace("__FOOT__", foot_html(meta))
                .replace("__LS_STATE__", meta["lsKey"])
                .replace("__SLUG__", slug)
                .replace("__REVIEW__", "../../" + sec["review"] + "/")
                .replace("__DATA__", payload))
        out = os.path.join(ROOT, "a", slug)
        os.makedirs(out, exist_ok=True)
        open(os.path.join(out, "index.html"), "w", encoding="utf-8").write(page)
        open(os.path.join(out, "list.html"), "w", encoding="utf-8").write(list_html(slug, meta, data, sec))
        open(os.path.join(out, "check.html"), "w", encoding="utf-8").write(check_html(slug, meta, data, sec))
        open(os.path.join(out, "ex.html"), "w", encoding="utf-8").write(ex_html(slug, meta, data, sec))
        tp = os.path.join(out, "trans.html")
        if meta["lang"] in ("en", "ja"):
            open(tp, "w", encoding="utf-8").write(trans_html(slug, meta, data, sec))
        elif os.path.isfile(tp):
            os.remove(tp)
        syntax_check(page, slug)
        wj = words_json(slug, meta, data)
        open(os.path.join(out, "words.json"), "w", encoding="utf-8").write(json.dumps(wj, ensure_ascii=False, separators=(",", ":")))
        ls = [[s["i"], len(s["en"].split())] for s in listen_sents(data)] if data.get("audio") else []   # [sentence index, words]
        lj = os.path.join(out, "listen.json")
        if ls:
            open(lj, "w", encoding="utf-8").write(json.dumps(listen_json(slug, meta, data), ensure_ascii=False, separators=(",", ":")))
        elif os.path.isfile(lj):
            os.remove(lj)
        index.append(dict(slug=slug, lang=meta["lang"], title=meta["title"], short=meta["short"], date=meta["date"], clips=bool(data.get("clips")), ls=ls,
                          w=[[v["id"], v["expr"], v["zh"]] for v in data["vocab"] if not v.get("ref")],
                          r=[v["ref"] for v in data["vocab"] if v.get("ref")]))
        metas.append(meta)
        print(f"  a/{slug}/index.html  {len(page.encode('utf-8')) // 1024} KB  ({meta['vocab']} words, {len(data['sents'])} sentences)")

    metas.sort(key=lambda m: (m["date"], m["slug"]), reverse=True)
    index.sort(key=lambda a: (a["date"], a["slug"]), reverse=True)
    langs = [lg for lg in SECTIONS if lg == "en" or any(m["lang"] == lg for m in metas)]
    for lg in langs:
        sec = SECTIONS[lg]
        up = "../" if sec["home"] else ""
        # review page
        idx = [a for a in index if a["lang"] == lg]
        rv = (review_tpl.replace("__LANG__", lg).replace("__TITLE__", htmllib.escape(sec["rtitle"])).replace("__HOME__", "../" + (sec["home"] + "/" if sec["home"] else ""))
              .replace("__INDEX__", json.dumps(dict(articles=idx), ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")))
        syntax_check(rv, sec["review"])
        os.makedirs(os.path.join(ROOT, sec["review"]), exist_ok=True)
        open(os.path.join(ROOT, sec["review"], "index.html"), "w", encoding="utf-8").write(rv)
        print(f"  {sec['review']}/index.html  ({sum(len(a['w']) for a in idx)} words)")
        # home page
        ms = [m for m in metas if m["lang"] == lg]
        nav = [dict(label=SECTIONS[o]["label"], icon=SECTIONS[o]["icon"], on=o == lg,
                    href="./" if o == lg else up + (SECTIONS[o]["home"] + "/" if SECTIONS[o]["home"] else "")) for o in langs]
        site = dict(root=up, review=up + sec["review"] + "/", langs=nav if len(langs) > 1 else [],
                    articles=[dict(slug=m["slug"], date=m["date"], title=m["title"], deck=m["deck"], tags=m["tags"],
                                   source=m["source"], words=m["words"], vocab=m["vocab"], fresh=m["fresh"], lsKey=m["lsKey"], audio=m["audio"]) for m in ms])
        payload = json.dumps(site, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
        home = (home_tpl.replace("__LANG__", lg).replace("__H1__", sec["h1"]).replace("__EYEBROW__", sec["eyebrow"])
                .replace("__TAGLINE__", sec["tagline"]).replace("__FOOT2__", sec["foot2"]).replace("__SITE__", payload))
        syntax_check(home, "home " + lg)
        out = os.path.join(ROOT, sec["home"], "index.html") if sec["home"] else os.path.join(ROOT, "index.html")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        open(out, "w", encoding="utf-8").write(home)
        print(f"  {os.path.relpath(out, ROOT)}  ({len(ms)} article{'s' if len(ms) != 1 else ''})")


if __name__ == "__main__":
    main()

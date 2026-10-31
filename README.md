# 外刊精读合集 (waikan)

每天一篇外刊：逐句精读、生词表、填空与中译英自测。站点是纯静态页面，部署在 GitHub Pages
(`https://yichibaobao.github.io/waikan/`)，不依赖任何境外字体或脚本，国内可直接打开。

A static site: a home page listing daily articles, and one self-contained study page per article.

```
index.html                       home page (generated)
a/<slug>/index.html              one study page per article (generated)
content/<slug>/article.json      the source of each article  <-- the only thing you edit
tools/build.py                   builds everything from content/
tools/reader.template.html       template of a study page
tools/home.template.html         template of the home page
```

Never edit `index.html` or `a/**` by hand; they are overwritten by the build.

## Add an article (the daily routine)

1. Write `content/<slug>/article.json` (format below). `<slug>` is lowercase letters, digits and hyphens, e.g. `2026-11-01-konbini`.
2. Run `python3 tools/build.py` from the repo root. The build validates the data (highlight terms exist in the text,
   every cloze answer appears exactly once in its sentence, every example marks its target, every example contains an
   accepted form of its word, ...) and refuses to write anything if a check fails. It also syntax-checks the page script when `node` is installed.
3. Open `a/<slug>/index.html` and `index.html` once (a local `python3 -m http.server` works) and look at the page.
4. Commit `content/`, `a/`, `index.html` and push to `main`. GitHub Pages redeploys in a minute or two.

Changing a template (`tools/*.template.html`) and re-running the build updates every article at once.

## article.json

```jsonc
{
  "meta": {
    "slug": "finders-keepers",            // = folder name
    "date": "2026-10-31",                 // YYYY-MM-DD, shown on the home page and calendar
    "title": "Finders, keepers? Not in Tokyo",   // must equal the first sentence (kind "title")
    "deck": "In one of the world's busiest cities, ...",  // one-line summary shown on cards
    "short": "Finders, Keepers",          // short name for the page header and <title>
    "tags": ["城市观察", "社会信任"],       // topic chips on the home page
    "source": {"type": "original"},       // or {"type": "link", "name": "...", "url": "https://..."}
    "note": "页脚说明文字",                 // footer note on the study page
    "lsKey": "fk-state-v1"                // OPTIONAL. Browser-storage key for progress. Default: "wk-<slug>-state".
                                          // Never change it for an existing article, it would erase readers' progress.
  },
  "data": {
    "sents": [                            // every sentence, in order. First is the title, then the deck, then the body.
      {"kind": "title", "en": "...", "zh": "...", "notes": ["讲解要点", "..."]},
      {"kind": "sub",   "en": "...", "zh": "...", "notes": []},
      {"kind": "body",  "p": 1, "en": "...", "zh": "...", "notes": ["..."]}   // p = paragraph number, starting at 1
    ],
    "vocab": [
      {
        "id": 1,                           // unique within the article
        "expr": "slump onto",              // headword as displayed
        "zh": "瘫坐在……上",
        "m": ["slumps onto"],              // exact strings to highlight in the text; each term belongs to one word only
        "note": "optional usage note",
        "core": "slump onto",              // canonical answer for the Chinese->English quiz
        "forms": ["slump onto", "slumps onto", "slumped onto"],   // accepted inflections (must include core)
        "syn": [],                         // valid synonyms accepted only in the word-recall quiz
        "ex": [                            // 2-3 examples; mark the target with [[ ]]
          {"en": "He [[slumped onto]] the sofa.", "zh": "他瘫坐在沙发上。"}
        ]
        // "ctx" (the article sentence) is filled in automatically
      }
    ],
    "cloze": [                             // exactly one fill-in item per vocab entry
      {"id": 1, "i": 4, "ans": "slumps", "hint": "瘫坐在……上（注意动词词形）"}   // i = sentence index in "sents"
    ],
    "breakdown": {"en": "<one article sentence>", "points": ["拆解要点 1", "..."]},   // the "思考" tab: a long sentence taken apart
    "questions": ["讨论题 1", "讨论题 2", "讨论题 3"]
  }
}
```

Conventions used for the first article (`content/finders-keepers/article.json` is the reference):
20-40 expressions per article, each with a Chinese gloss, 2-3 bilingual examples, accepted forms, one cloze item;
a per-sentence translation and 2-4 teaching notes for each sentence; one long sentence broken down; three discussion questions.

## Notes

- Reading progress (word status, own sentences, quiz score) lives in the reader's own browser (`localStorage`) and is
  read back by the home page for the per-article progress bars. There is no server.
- The site is public. Only publish text you have the right to publish. For articles taken from a publisher, prefer
  `"source": {"type": "link", ...}` with your own notes, translations and vocabulary rather than the full original text.

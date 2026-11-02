# 外刊精读合集 (waikan)

每天一篇外刊：逐句精读、听力、生词表、六种题型的自测，按艾宾浩斯遗忘曲线安排的词汇复习、跨文章总考，只听不看的听力默写考试，以及按名字分开保存、可导出备份的学习进度。站点是纯静态页面，部署在 GitHub Pages
(`https://yichibaobao.github.io/waikan/`)，不依赖任何境外字体或脚本，国内可直接打开。

A static site: a home page listing daily articles, and one self-contained study page per article.

```
index.html                       home page (generated)
a/<slug>/index.html              one study page per article (generated)
a/<slug>/words.json              the article's words with everything a quiz needs (generated, read by the review page)
a/<slug>/listen.json             the article's sentences with their narration timings (generated, only for articles with audio; read by the listening exam)
review/index.html                spaced-repetition review + cross-article exam + listening exam + vocabulary table (generated)
content/<slug>/article.json      the source of each article  <-- the only thing you edit
content/<slug>/audio.json, clips.json   timings of the narration / the word+example clips (made by make_audio.py)
tools/build.py                   builds everything from content/
tools/make_audio.py              makes the narration and the clips (needs the TTS toolchain, see Audio)
tools/reader.template.html       template of a study page
tools/home.template.html         template of the home page
tools/review.template.html       template of the review page
tools/shared/                    code used by several pages, inlined by the build: base.css, common.js, srs.js (the review schedule),
                                 clips.js (speaker buttons / clip player), quizkit.js (the six question types),
                                 who.js + who.css (learners, progress backup / restore)
tools/tests/srs.test.js          unit tests of the review schedule: node tools/tests/srs.test.js
tools/tests/who.test.js          unit tests of learners, progress codes and merging: node tools/tests/who.test.js
```

Never edit `index.html` or `a/**` by hand; they are overwritten by the build.

## Add an article (the daily routine)

1. Write `content/<slug>/article.json` (format below). `<slug>` is lowercase letters, digits and hyphens, e.g. `2026-11-01-konbini`.
2. Run `python3 tools/build.py` from the repo root. The build validates the data (highlight terms exist in the text,
   every cloze answer appears exactly once in its sentence, every example marks its target, every example contains an
   accepted form of its word, ...) and refuses to write anything if a check fails. It also syntax-checks the page script when `node` is installed.
3. Open `a/<slug>/index.html` and `index.html` once (a local `python3 -m http.server` works) and look at the page.
4. Commit `content/`, `a/`, `index.html` and push to `main`. GitHub Pages redeploys in a minute or two.

Changing a template or a file in `tools/shared/` and re-running the build updates every page at once. Nothing else is needed to feed the review page:
every new article's words join the review plan automatically (the build writes `a/<slug>/words.json` and the word index inside `review/index.html`).

## Quiz types, review and exam

Six question types (`tools/shared/quizkit.js`), used by the 自测 tab of every article and by the review page:

| type | what it asks |
|---|---|
| 选择题 `mcq` | four options; either the English expression -> its meaning, or the meaning -> the expression (keys 1-4) |
| 文章填空 `cloze` | the word blanked out of the article sentence |
| 例句填空 `exs` | the word blanked out of one of its own example sentences |
| 中文写英文词 `zh` | type the English expression for a Chinese gloss (forms and listed synonyms are accepted) |
| 听写 `dict` | listen to the word or an example sentence and type it; the differing words are underlined (needs the article's clips) |
| 中文写英文句 `sent` | translate an example sentence, graded by the learner |

Review (`/review/`, linked from the home page): every answer anywhere on the site feeds one schedule per word, kept in the browser (`localStorage`, key `wk-srs-v1`, one copy per learner).
The ladder is 5 min, 30 min, 12 h, 1 d, 2 d, 4 d, 7 d, 15 d, 30 d, then every 60 days. Right and due: one step up. Wrong: back to 5 minutes.
Right but not yet due: nothing changes (so drilling a word again right away does not push it up). In the mixed review mode the question type
follows the step: recognise (选择题) -> fill in -> spell -> listen -> write a sentence. Words answered wrong are asked once more at the end of the session (not counted).
The 总考 tab samples words across all articles (or one article) with mixed question types and keeps the last results.

The 听力 tab is a dictation exam: pick the scope (all articles with audio, or one), what to hear (words, example sentences, the article's own sentences
cut out of the narration, or a mix; article sentences can be filtered short / medium / long), 10 / 20 / 30 questions, and when to be told the answer
(all at the end, the default, or after each question). Each question plays once by itself and can be replayed or slowed down (0.7x). The result screen
shows the score per source, and every mistake with the replayable audio, the differing words underlined, and a "只是小失误，算我对" button that
corrects the answer, the schedule and the saved score. Words and example sentences feed the review schedule like any other answer; article sentences
do not (they are not words). The results are stored in `wk-srs-v1` as `ex[]` records with `k:"listen"` (总考 records have `k:"exam"`), 20 kept.
`a/<slug>/listen.json` is built from `audio.json` (the sentence timings) and `article.json`; the page loads it lazily, like `words.json`.
`tools/tests/srs.test.js` pins the rules; change them there and in `tools/shared/srs.js` together.

## Learners and progress backup

There is no server, so there are no passwords. Every page starts with `Who.boot()` (`tools/shared/who.js`): if nobody has been chosen on this browser yet,
a picker covers the page (the home page is the normal entry; a deep link to an article or the review page shows the same picker). A learner is just a name.
Choosing or creating one makes it current (and remembered); the round avatar at the top right of every page opens the menu: switch learner, export,
import, delete. The name only keeps progress apart (anyone on the device can switch to any name), it does not protect it.

- Storage: every progress key of a learner is stored as `<key>@<id>` (`pkey()` in `common.js`, so `lsGet / lsSet / lsDel` need no changes). The learner list
  is `wk-who-v1` = `{v:1, cur, list:[{id,name,c,u}], claimed}`. Progress saved before learners existed (plain `wk-*` / `fk-*` keys) is copied to the first
  learner created, once (`claimed`); the old keys are left in place as a backup.
- New progress keys must start with `wk-` or `fk-`: only those are exported, imported and deleted with a learner. Any key that is not `wk-srs-v1` or a
  UI-preference key (`fk-ui-v1`, `wk-review-ui-v1`, listed in `who.js`) is read as one article's state by `stateClean`.
- Backup: "导出进度" makes a progress code (`WK1.` + base64 of `{app:"waikan", name, data:{key: value}}`) that can be copied, or the same JSON as a file.
  "导入进度" merges (never overwrites): per word the answer given last wins, day tallies keep the larger count, exam results are united, notes and sentences
  are kept. Importing the same code twice changes nothing. On a new device the picker's "已有进度码？导入进度" creates the learner named in the code.
- A browser that cannot store anything (some private modes) gets no picker and no saved progress.
- Real cross-device sync would need a server (and one reachable from mainland China); the storage layer is the only place to change for that.

## Audio (listening tab and speaker icons)

Each article can have two audio files, both made offline with the Kokoro text-to-speech model (American voice `af_heart` by default; `--voice` takes any Kokoro voice, e.g. `bf_emma` for British, and `--lang` follows it):

- `a/<slug>/audio.mp3` : the whole article read aloud, with the start/end time of every sentence (`content/<slug>/audio.json`).
  It powers the 听力 tab (play, seek, speed, sentence highlight, loop one sentence, hide/show the text).
- `a/<slug>/clips.mp3` : one "sprite" with every vocabulary word and every example sentence (`content/<slug>/clips.json`).
  It powers the speaker icons next to words and examples. The article sentence shown under each word plays from `audio.mp3`.

One-time setup of the toolchain (nothing from this is committed, the model is ~120 MB):

```
python3 -m venv venv && ./venv/bin/pip install kokoro-onnx soundfile
curl -L -o kokoro-v1.0.int8.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx
curl -L -o voices-v1.0.bin       https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
# ffmpeg with libmp3lame must be on PATH
```

Per article (about 3 min for the narration and 6-8 min for the clips on 2 CPU cores):

```
./venv/bin/python tools/make_audio.py <slug> --model kokoro-v1.0.int8.onnx --voices voices-v1.0.bin   # both files
python3 tools/build.py
```

- Audio is optional: an article without `audio.json` / `clips.json` simply has no 听力 tab / no icons.
- `build.py` refuses to build if the text, the words or the examples changed after the audio was made; rerun `make_audio.py` (use `--only clips` or `--only narration` to redo one file).
- Words the engine mispronounces (Japanese names, years) are respelled per article in `meta.pronounce`, e.g. `{"koban": "koh-bahn", "2019": "twenty nineteen"}`;
  check with `k.tokenizer.phonemize(text, "en-us")` in Python (`en-gb` for a British voice). A vocab entry may carry `"say": "..."` to override what is read for the word icon (default: `core`).
- Changing the voice means re-running `make_audio.py` for every article (about 10 minutes each on 2 cores). The build adds `?v=<hash of the mp3>` to the audio URLs, so a re-made file is never served from a browser or CDN cache.
- Size: roughly 3 MB of audio per article, so plan for about 1 GB after a year of daily articles (GitHub Pages sites are limited to 1 GB).
- `audio.mp3` and `clips.mp3` are seeked inside the browser, which needs HTTP byte-range support. GitHub Pages has it; `python3 -m http.server` does not
  (use a range-capable server when testing locally).

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
    "pronounce": {"koban": "koh-bahn"},   // OPTIONAL. Respellings for the narration only (see Audio)
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
        "id": 1,                           // unique within the article; learners' progress is keyed by it, so never renumber a published word (new words take the next free number, the list can be in any order)
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
      },
      {
        // a word met outside the article text (e.g. in an example sentence): give "seen" instead of "m" and of a cloze item.
        // seen.en replaces the article sentence everywhere (word card, 文章填空); the [[ ]] part is the blank.
        "id": 39, "expr": "from scratch", "zh": "从零开始", "extra": true,   // extra = shown with the 新增 tag
        "seen": {"en": "Making it [[from scratch]] is another story.", "zh": "从头自己做就是另一回事了。", "hint": "从零开始"},
        "core": "from scratch", "forms": ["from scratch"], "syn": [], "ex": [ /* 2-3 examples as above */ ]
      }
    ],
    "cloze": [                             // exactly one fill-in item per vocab entry without "seen"
      {"id": 1, "i": 4, "ans": "slumps", "hint": "瘫坐在……上（注意动词词形）"}   // i = sentence index in "sents"
    ],
    "breakdown": {"en": "<one article sentence>", "points": ["拆解要点 1", "..."]}   // the "长句" tab: a long sentence taken apart
  }
}
```

Conventions used for the first article (`content/finders-keepers/article.json` is the reference):
20-40 expressions per article, each with a Chinese gloss, 2-3 bilingual examples, accepted forms, one cloze item;
a per-sentence translation and 2-4 teaching notes for each sentence; one long sentence broken down.

## Notes

- Reading progress (word status, own sentences, quiz score) lives in the reader's own browser (`localStorage`, per learner, see above) and is
  read back by the home page for the per-article progress bars. The review schedule is stored the same way (`wk-srs-v1`). There is no server,
  so progress does not sync between devices; "导出进度" / "导入进度" move it by hand.
- The review page fetches `a/<slug>/words.json` with `fetch`, so it must be opened through the website (or a local `python3 -m http.server`), not by double-clicking the file.
- The site is public. Only publish text you have the right to publish. For articles taken from a publisher, prefer
  `"source": {"type": "link", ...}` with your own notes, translations and vocabulary rather than the full original text.

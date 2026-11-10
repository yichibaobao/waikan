"""Text the narration engine speaks for each sentence. Shared by make_audio.py and build.py (no heavy imports)."""
import hashlib
import json
import re


SPEAKER_RE = re.compile(r"^([^\s：:]{1,8})[：:]\s*")


def split_speaker(text, speakers):
    """"阿詩：唔該" -> ("阿詩", "唔該") when 阿詩 is a speaker listed in meta.speakers; otherwise (None, text)."""
    m = SPEAKER_RE.match(text)
    if speakers and m and m.group(1) in speakers:
        return m.group(1), text[m.end():]
    return None, text


def strip_rom_speaker(rom):
    """The reading line of a dialogue line without its speaker: "aa3 si1: m4 goi1" -> "m4 goi1"."""
    return re.sub(r"^[^:：]{1,40}[:：]\s*", "", rom)


def spoken_text(sent, pronounce, speakers=None):
    """What the narration says: a dialogue line is read without its speaker's name (the voice tells the speakers apart)."""
    t = split_speaker(sent["en"], speakers)[1]
    t = t.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    for word, say in pronounce.items():
        t = re.sub(r"(?<![A-Za-z0-9])" + re.escape(word) + r"(?![A-Za-z0-9])", say, t)
    return t


def text_hash(sents, pronounce, speakers=None):
    texts = [spoken_text(s, pronounce, speakers) for s in sents]
    if speakers:            # a change of who speaks with which voice also needs new audio
        texts.append(sorted(speakers.items()))
    return hashlib.sha1(json.dumps(texts, ensure_ascii=False).encode()).hexdigest()[:16]


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

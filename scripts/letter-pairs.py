#!/usr/bin/env python3
# Builds internal/textscore/letterpairs.bin, the letter-pair table the mash
# check scores words with (internal/textscore/mash.go):
#
#   python3 scripts/letter-pairs.py
#
# For each language it takes the 20,000 most common words of FrequencyWords
# (github.com/hermitdave/FrequencyWords, from OpenSubtitles 2018), folds
# them to plain a-z as people type without accents, and counts each pair of
# adjacent letters once per word, with ^ and $ for the word's start and end.
# English comes from the dictionary teardrop already embeds. Only the counts'
# log-probabilities are kept, never the words.
#
# The file is one table per language: 27 rows (^, a-z) of 27 bytes (a-z, $),
# each byte the pair's -log(probability of the second letter after the
# first) times 16, at most 255.
import gzip, math, os, re, unicodedata, urllib.request

LANGS = "es fr de pt it nl id tr pl sv ro cs fi hu sk hr da no lv lt et ms sq eu ca gl sl is bs eo".split()
WORDS = 20000
HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "internal", "textscore")
SOURCE = "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018"

def fold(w):
    for a, b in {"ß": "ss", "ł": "l", "ı": "i", "ø": "o", "æ": "ae", "œ": "oe", "đ": "d", "þ": "th", "ð": "d"}.items():
        w = w.replace(a, b)
    w = "".join(c for c in unicodedata.normalize("NFKD", w) if not unicodedata.combining(c))
    return w if re.fullmatch(r"[a-z]+", w) else None

def common(lang):
    for name in (f"{lang}_50k.txt", f"{lang}_full.txt"):
        try:
            with urllib.request.urlopen(f"{SOURCE}/{lang}/{name}") as res:
                lines = res.read().decode("utf8").splitlines()
            break
        except urllib.error.HTTPError:
            continue
    out = []
    for line in lines:
        w = fold(line.split()[0].lower()) if line.strip() else None
        if w:
            out.append(w)
        if len(out) == WORDS:
            break
    return out

def table(words):
    count = {}
    for w in set(words):
        s = "^" + w + "$"
        for a, b in zip(s, s[1:]):
            count[a, b] = count.get((a, b), 0) + 1
    out = bytearray()
    for a in "^abcdefghijklmnopqrstuvwxyz":
        after = "abcdefghijklmnopqrstuvwxyz$"
        total = sum(count.get((a, b), 0) for b in after) + 0.5 * len(after)
        for b in after:
            out.append(min(255, round(-math.log((count.get((a, b), 0) + 0.5) / total) * 16)))
    return out

with gzip.open(os.path.join(HERE, "words.txt.gz"), "rt") as f:
    english = [w.strip() for w in f if re.fullmatch(r"[a-z]+", w.strip())]
data = table(english)
for lang in LANGS:
    data += table(common(lang))
with open(os.path.join(HERE, "letterpairs.bin"), "wb") as f:
    f.write(data)
print(f"wrote {len(data)} bytes for English and {len(LANGS)} other languages")

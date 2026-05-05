#!/usr/bin/env python3
"""
Build static JSON data files for the front-end-only WordWise extension.

Outputs:
  extension/lib/data/frequency.json   — vocab levels + word lists
  extension/lib/data/dict-core.json   — top ~10k high-freq words (compact)

Run from project root:
    python3 extension/scripts/build_data.py
"""
import json
import sys
import os
from pathlib import Path

# Resolve project root from this script
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent
BACKEND_DIR = PROJECT_ROOT / "backend"
OUT_DIR = SCRIPT_DIR.parent / "lib" / "data"

OUT_DIR.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(BACKEND_DIR))

# ─── 1) Frequency / vocabulary levels ──────────────────────────
from services.frequency import (  # type: ignore
    _KINDERGARTEN, _ELEMENTARY, _MIDDLE_SCHOOL,
    _HIGH_SCHOOL, _COLLEGE, _IELTS,
    LEVEL_ORDER, LEVEL_LABELS,
)

level_words: dict[str, list[str]] = {}
running: set[str] = set()
for level_name, word_set in (
    ("kindergarten",  _KINDERGARTEN),
    ("elementary",    _ELEMENTARY),
    ("middle_school", _MIDDLE_SCHOOL),
    ("high_school",   _HIGH_SCHOOL),
    ("college",       _COLLEGE),
    ("ielts",         _IELTS),
):
    new = sorted(word_set)
    level_words[level_name] = new
    running |= word_set

# Build cumulative lists (each level INCLUDES all lower levels)
cumulative: dict[str, list[str]] = {}
seen_so_far: set[str] = set()
for level_name in LEVEL_ORDER:
    if level_name == "professional":
        # professional means "annotate everything" — empty exclusion set
        cumulative[level_name] = []
        continue
    seen_so_far |= set(level_words.get(level_name, []))
    cumulative[level_name] = sorted(seen_so_far)

freq_data = {
    "level_order": LEVEL_ORDER,
    "level_labels": LEVEL_LABELS,
    # words_below[level] = words you ALREADY know at this level
    # (i.e., words to NOT annotate)
    "words_below": cumulative,
    "level_word_counts": {k: len(v) for k, v in cumulative.items()},
}

freq_path = OUT_DIR / "frequency.json"
freq_path.write_text(json.dumps(freq_data, ensure_ascii=False, separators=(",", ":")))
print(f"✓ wrote {freq_path}  ({freq_path.stat().st_size // 1024} KB)")

# ─── 2) Dictionary core: top high-frequency words from ECDICT ────
ECDICT_DB = BACKEND_DIR / "data" / "ecdict.db"
if not ECDICT_DB.exists():
    print(f"⚠️  ECDICT database not found at {ECDICT_DB} — skipping dict-core.")
    print("   Run `cd backend && python3 scripts/build_ecdict_index.py` first.")
    sys.exit(0)

import sqlite3

conn = sqlite3.connect(str(ECDICT_DB))
cur = conn.cursor()

# Inspect schema first
cur.execute("PRAGMA table_info(stardict)")
cols = [r[1] for r in cur.fetchall()]
print(f"  ECDICT columns: {cols}")

# ECDICT tag values include: zk(中考)/gk(高考)/cet4/cet6/ky(考研)/toefl/ielts/gre
# Frequency: lower BNC/COCA rank = more common
# Strategy: take top ~12000 by combined frequency, with tags
# Schema: entries(word, brief, pos, phonetic, meanings_json, definition_en)
# We don't have a frequency column — instead, take the union of:
#   1. all words from the frequency.json levels (~3800 words)
#   2. top 8000 words by length sorted alphabetically (rough heuristic)
# That gives ~10k high-quality entries.

# First: words from levels (these are guaranteed common)
core_words: set[str] = set()
for words in cumulative.values():
    core_words.update(words)

# Then: get more high-frequency words from ECDICT tag column (zk, gk, cet4, cet6, ky)
# but the schema doesn't have tag... so we take all entries that match
# words in core_words, plus add a curated "top 10000" filtered by length+letters
cur.execute("""
    SELECT word FROM entries
    WHERE word IS NOT NULL
      AND length(word) BETWEEN 2 AND 20
      AND word GLOB '[a-z]*'
""")
all_words = [r[0] for r in cur.fetchall()]
print(f"  total entries in ECDICT: {len(all_words)}")

# We don't have frequency, so include EVERY level word + a sample.
# Better strategy: include every word from frequency.json (definitely common)
# and then expand with words that are short (< 10 chars) and look common.
# In practice, including ALL ~3800 frequency-level words is enough for the
# core dict, and we let LLM handle the long tail.
target_words = sorted(core_words & set(all_words))
print(f"  level words present in ECDICT: {len(target_words)}")

import re
# Fetch entries for these words
placeholders = ",".join("?" * len(target_words))
batch_size = 500
rows = []
for i in range(0, len(target_words), batch_size):
    batch = target_words[i:i+batch_size]
    qs = ",".join("?" * len(batch))
    cur.execute(f"SELECT word, phonetic, pos, brief, meanings_json, definition_en FROM entries WHERE word IN ({qs})", batch)
    rows.extend(cur.fetchall())

print(f"  fetched {len(rows)} entries from ECDICT")

dict_core: dict[str, dict] = {}
for word, phonetic, pos, brief, meanings_json, definition_en in rows:
    w = (word or "").strip().lower()
    if not w:
        continue
    entry: dict = {}
    # Brief is the short Chinese gloss used inline
    if brief:
        b = str(brief).strip()
        if b:
            entry["b"] = b
    # Meanings (parsed multi-meanings as list)
    if meanings_json:
        try:
            mlist = json.loads(meanings_json)
            if isinstance(mlist, list):
                cleaned = []
                for item in mlist[:4]:
                    if isinstance(item, dict):
                        # Items might be {"pos": "n", "meaning": "..."}
                        meaning = item.get("meaning") or item.get("zh") or ""
                        if meaning:
                            cleaned.append(str(meaning).strip())
                    elif isinstance(item, str):
                        cleaned.append(item.strip())
                if cleaned:
                    entry["m"] = cleaned
        except (json.JSONDecodeError, TypeError):
            pass
    if phonetic:
        entry["p"] = str(phonetic).strip()
    if pos:
        entry["s"] = str(pos).strip()
    if definition_en:
        en_lines = [s.strip() for s in str(definition_en).split("\n") if s.strip()][:2]
        if en_lines:
            entry["e"] = en_lines
    if entry:
        dict_core[w] = entry

# Write compact JSON (no whitespace, short keys)
dict_path = OUT_DIR / "dict-core.json"
dict_path.write_text(json.dumps(dict_core, ensure_ascii=False, separators=(",", ":")))
size_mb = dict_path.stat().st_size / 1024 / 1024
print(f"✓ wrote {dict_path}  ({size_mb:.1f} MB, {len(dict_core)} words)")

print("\nDone. Next: ship these files alongside the extension and load them on startup.")

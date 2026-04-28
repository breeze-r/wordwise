import csv
import json
import os
import re
import sqlite3
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CSV_PATH = PROJECT_ROOT / "data" / "ecdict.csv"
DEFAULT_DB_PATH = PROJECT_ROOT / "data" / "ecdict.db"


POS_PATTERN = re.compile(r"^(?:[a-z]+\.)\s*", re.IGNORECASE)
BRACKET_TAG_PATTERN = re.compile(r"^\[[^\]]+\]\s*")
PAREN_PATTERN = re.compile(r"[（(]([^）)]+)[）)]")
LABEL_METADATA_PATTERN = re.compile(
    r"(?:人名|地名|别名|又称|简称|缩写|姓氏|男子名|女子名)",
    re.IGNORECASE,
)
INFLECTION_METADATA_PATTERN = re.compile(
    r"(?:过去式|过去分词|现在分词|第三人称单数|复数|比较级|最高级|形式|变形|异体|所有格)",
    re.IGNORECASE,
)
LATIN_REF_PATTERN = re.compile(
    r"[A-Za-z][A-Za-z' -]*\s*的(?:过去式|过去分词|现在分词|第三人称单数|复数|比较级|最高级)",
    re.IGNORECASE,
)


def resolve_path(raw_path: str) -> Path:
    path = Path(raw_path)
    if path.is_absolute():
        return path
    return PROJECT_ROOT / path


def normalize_meaning(text: str) -> str:
    value = POS_PATTERN.sub("", text.strip())
    value = BRACKET_TAG_PATTERN.sub("", value)
    value = value.strip(" ;,/")
    return value


def split_meanings(raw_text: str) -> list[str]:
    if not raw_text:
        return []

    parts = re.split(r"[\n;,，；]+", raw_text)
    meanings = []
    for part in parts:
        base = PAREN_PATTERN.sub("", part)
        value = normalize_meaning(base)
        if value and value not in meanings:
            meanings.append(value)
        for note in PAREN_PATTERN.findall(part):
            note_value = normalize_meaning(note)
            if note_value and note_value not in meanings:
                meanings.append(note_value)
        if len(meanings) >= 5:
            break
    return meanings


def is_metadata_meaning(text: str) -> bool:
    value = text.strip()
    if not value:
        return True
    if LATIN_REF_PATTERN.search(value):
        return True
    return bool(LABEL_METADATA_PATTERN.search(value) or INFLECTION_METADATA_PATTERN.search(value))


def choose_pos(row: dict[str, str]) -> str | None:
    raw_pos = (row.get("pos") or "").strip()
    if raw_pos:
        return raw_pos

    for source in (row.get("translation") or "", row.get("definition") or ""):
        match = re.match(r"([a-z]+\.)", source.strip(), re.IGNORECASE)
        if match:
            return match.group(1)
    return None


def choose_brief(meanings: list[str], word: str, raw_text: str) -> str:
    if LABEL_METADATA_PATTERN.search(raw_text or ""):
        return ""
    for item in meanings:
        if not is_metadata_meaning(item) and re.search(r"[\u4e00-\u9fff]", item):
            return item[:20]
    return ""


def main() -> None:
    csv_path = resolve_path(
        os.environ.get("WORDWISE_LOCAL_DICTIONARY_CSV_PATH", str(DEFAULT_CSV_PATH))
    )
    db_path = resolve_path(
        os.environ.get("WORDWISE_LOCAL_DICTIONARY_DB_PATH", str(DEFAULT_DB_PATH))
    )
    db_path.parent.mkdir(parents=True, exist_ok=True)

    if not csv_path.exists():
        raise SystemExit(f"CSV source not found: {csv_path}")

    with sqlite3.connect(db_path) as conn:
        conn.executescript(
            """
            DROP TABLE IF EXISTS entries;
            CREATE TABLE entries (
                word TEXT PRIMARY KEY,
                brief TEXT NOT NULL,
                pos TEXT,
                phonetic TEXT,
                meanings_json TEXT,
                definition_en TEXT
            );
            """
        )

        with csv_path.open("r", encoding="utf-8-sig", newline="") as fp:
            reader = csv.DictReader(fp)
            rows = []
            count = 0
            for row in reader:
                word = (row.get("word") or "").strip().lower()
                if not word:
                    continue

                translation = (row.get("translation") or "").strip()
                definition = (row.get("definition") or "").strip()
                meanings = split_meanings(translation) or split_meanings(definition)
                phonetic = (row.get("phonetic") or "").strip() or None
                pos = choose_pos(row)
                brief = choose_brief(meanings, word, translation or definition)

                rows.append(
                    (
                        word,
                        brief,
                        pos,
                        phonetic,
                        json.dumps(meanings, ensure_ascii=False),
                        definition,
                    )
                )
                count += 1

            conn.executemany(
                "INSERT OR REPLACE INTO entries "
                "(word, brief, pos, phonetic, meanings_json, definition_en) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                rows,
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_word ON entries(word)")
            conn.commit()

    print({"csv": str(csv_path), "db": str(db_path), "entries": count})


if __name__ == "__main__":
    main()

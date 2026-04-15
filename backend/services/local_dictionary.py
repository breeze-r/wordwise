import json
import logging
import re
import sqlite3
from functools import lru_cache
from pathlib import Path
from typing import Any

from settings import get_settings


logger = logging.getLogger(__name__)
POS_PREFIX_PATTERN = re.compile(r"^(?:[a-z]+\.(?:/[a-z]+\.)*)\s*", re.IGNORECASE)
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
INFLECTION_LEMMA_PATTERN = re.compile(
    r"(?:^|[^A-Za-z])([A-Za-z][A-Za-z' -]*)\s*的(?:过去式|过去分词|现在分词|第三人称单数|复数|比较级|最高级)",
    re.IGNORECASE,
)


def _resolve_path(raw_path: str) -> Path:
    path = Path(raw_path)
    if path.is_absolute():
        return path
    return Path(__file__).resolve().parent.parent / path


def _clean_segment(text: str, *, strip_parenthetical: bool) -> str:
    value = str(text or "").replace("\\n", "\n").strip()
    value = POS_PREFIX_PATTERN.sub("", value)
    value = BRACKET_TAG_PATTERN.sub("", value)
    if strip_parenthetical:
        value = PAREN_PATTERN.sub("", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip(" ,;，；/|")


def _split_segments(text: Any, *, include_parenthetical_notes: bool) -> list[str]:
    raw = str(text or "").replace("\\n", "\n").strip()
    if not raw:
        return []

    pieces = re.split(r"[\n;,，；]+", raw)
    values: list[str] = []

    for piece in pieces:
        notes = PAREN_PATTERN.findall(piece) if include_parenthetical_notes else []
        cleaned = _clean_segment(piece, strip_parenthetical=include_parenthetical_notes)
        if cleaned:
            values.append(cleaned)
        if include_parenthetical_notes:
            for note in notes:
                cleaned_note = _clean_segment(note, strip_parenthetical=False)
                if cleaned_note:
                    values.append(cleaned_note)

    return values


def is_metadata_meaning(text: str | None) -> bool:
    value = str(text or "").strip()
    if not value:
        return True
    if LATIN_REF_PATTERN.search(value):
        return True
    return bool(LABEL_METADATA_PATTERN.search(value) or INFLECTION_METADATA_PATTERN.search(value))


def normalize_detail_meanings(meanings: Any, limit: int = 4) -> list[str]:
    if isinstance(meanings, str):
        raw_items = [meanings]
    elif isinstance(meanings, list):
        raw_items = meanings
    else:
        return []

    normalized: list[str] = []
    for item in raw_items:
        for candidate in _split_segments(item, include_parenthetical_notes=True):
            if candidate and candidate not in normalized:
                normalized.append(candidate)
            if len(normalized) >= limit:
                return normalized
    return normalized


def extract_inline_brief(*sources: Any) -> str | None:
    for source in sources:
        if source is None:
            continue

        raw_items = source if isinstance(source, list) else [source]
        for item in raw_items:
            raw_text = str(item or "")
            skip_for_inline = bool(LABEL_METADATA_PATTERN.search(raw_text))
            if skip_for_inline:
                return None
            for candidate in _split_segments(item, include_parenthetical_notes=False):
                if not candidate or is_metadata_meaning(candidate):
                    continue
                if not re.search(r"[\u4e00-\u9fff]", candidate):
                    continue
                return candidate[:20]
    return None


def extract_inflection_lemma(*sources: Any) -> str | None:
    for source in sources:
        if source is None:
            continue
        raw_items = source if isinstance(source, list) else [source]
        for item in raw_items:
            text = str(item or "").replace("\\n", "\n")
            match = INFLECTION_LEMMA_PATTERN.search(text)
            if match:
                return match.group(1).strip().lower()
    return None


_POS_LINE_RE = re.compile(r"^([a-z]+\.(?:/[a-z]+\.)*|\[[^\]]+\])\s*(.*)", re.IGNORECASE)


def _normalize_pos_tag(pos: str) -> str:
    """Normalize POS for matching: 'vt.' -> 'v', 'adj.' -> 'adj', etc."""
    tag = pos.strip().lower().rstrip(".")
    if tag.startswith("v"):
        return "v"
    if tag in ("a", "adj"):
        return "adj"
    if tag in ("ad", "adv"):
        return "adv"
    return tag


def _parse_pos_sections(meanings_json: str | None) -> list[tuple[str, list[str]]]:
    """Parse meanings_json into POS-grouped sections.
    Returns: [(pos_tag, [chinese_meanings]), ...]
    Empty pos_tag = implicit noun.
    """
    if not meanings_json:
        return []
    try:
        items = json.loads(meanings_json)
    except json.JSONDecodeError:
        return []
    if not isinstance(items, list) or not items:
        return []

    raw = "\n".join(str(i) for i in items).replace("\\n", "\n")
    sections: list[tuple[str, list[str]]] = []
    current_pos = ""
    current_meanings: list[str] = []

    for line in raw.split("\n"):
        line = line.strip()
        if not line:
            continue
        m = _POS_LINE_RE.match(line)
        if m:
            if current_meanings:
                sections.append((current_pos, current_meanings))
            current_pos = m.group(1).strip()
            rest = m.group(2).strip()
            current_meanings = [s.strip() for s in rest.split(",") if s.strip()] if rest else []
        else:
            current_meanings.extend([s.strip() for s in line.split(",") if s.strip()])

    if current_meanings:
        sections.append((current_pos, current_meanings))

    return sections


def match_senses_to_chinese(word_senses: dict[str, str]) -> dict[str, str]:
    """Match LLM English sense hints against local dictionary (ecdict.db) to find
    contextually correct Chinese meanings.

    word_senses: {"address": "n. a place to live", "bark": "v. to make a sharp sound"}
    Returns:     {"address": "住址", "bark": "吠"}
    """
    words = [w.strip().lower() for w in word_senses if w.strip()]
    if not words:
        return {}

    db_path = _dictionary_db_path()
    if not db_path.exists():
        return {}

    try:
        with sqlite3.connect(db_path) as conn:
            rows_by_word = _query_db_rows(conn, words)
    except sqlite3.Error:
        return {}

    results: dict[str, str] = {}

    for raw_word, sense_hint in word_senses.items():
        word = raw_word.strip().lower()
        row = rows_by_word.get(word)
        if not row:
            continue

        brief = row[1]
        meanings_json = row[4]

        # Parse POS from sense hint, e.g. "n. a place to live" -> pos="n", sense rest
        pos_match = re.match(r"^([a-z]+\.)\s*", sense_hint.strip(), re.I)
        hint_pos = _normalize_pos_tag(pos_match.group(1)) if pos_match else ""

        sections = _parse_pos_sections(meanings_json)

        # Try POS-matched section first
        matched = False
        if hint_pos and sections:
            for section_pos, section_meanings in sections:
                section_norm = _normalize_pos_tag(section_pos) if section_pos else "n"
                if section_norm == hint_pos or (not section_pos and hint_pos == "n"):
                    for m in section_meanings:
                        cleaned = _clean_segment(m, strip_parenthetical=True)
                        if (
                            cleaned
                            and re.search(r"[\u4e00-\u9fff]", cleaned)
                            and not is_metadata_meaning(cleaned)
                        ):
                            results[word] = cleaned[:20]
                            matched = True
                            break
                    if matched:
                        break

        # Fallback: generic brief
        if not matched:
            fallback = extract_inline_brief(brief)
            if fallback:
                results[word] = fallback

    return results


def _collect_all_chinese_meanings(meanings_json: str | None, brief: str | None) -> list[str]:
    """从 meanings_json 和 brief 中提取所有独立的中文释义片段。"""
    all_meanings: list[str] = []

    # 从 meanings_json 按 POS 段落解析
    sections = _parse_pos_sections(meanings_json)
    for _, section_meanings in sections:
        for m in section_meanings:
            cleaned = _clean_segment(m, strip_parenthetical=True)
            if cleaned and re.search(r"[\u4e00-\u9fff]", cleaned) and cleaned not in all_meanings:
                all_meanings.append(cleaned)

    # 从 brief 补充
    if brief:
        for piece in re.split(r"[,;，；\n]+", str(brief).replace("\\n", "\n")):
            cleaned = _clean_segment(piece, strip_parenthetical=True)
            if cleaned and re.search(r"[\u4e00-\u9fff]", cleaned) and cleaned not in all_meanings:
                all_meanings.append(cleaned)

    return all_meanings


def validate_chinese_with_dictionary(
    word_translations: dict[str, str],
    paragraph_zh: str | None = None,
) -> dict[str, str]:
    """用 LLM 给出的中文翻译去本地词典里找最匹配的释义。

    逻辑：
    1. 如果 LLM 中文直接匹配词典某条释义（子串包含）→ 用词典释义
    2. 如果 LLM 中文不在词典里，但段落中文包含某条词典释义 → 用那条词典释义
    3. 都匹配不到 → 直接用 LLM 返回的中文

    word_translations: {"address": "地址", "fears": "担忧"}
    paragraph_zh:      "缩短发行期限的举措可能缓解投资者对...的担忧..."
    Returns:           {"address": "住址", "fears": "担忧"}
    """
    words = [w.strip().lower() for w in word_translations if w.strip()]
    if not words:
        return {}

    db_path = _dictionary_db_path()
    if not db_path.exists():
        return word_translations  # 无词典，直接用 LLM 中文

    try:
        with sqlite3.connect(db_path) as conn:
            rows_by_word = _query_db_rows(conn, words)
    except sqlite3.Error:
        return word_translations

    para_zh = paragraph_zh or ""
    results: dict[str, str] = {}

    for raw_word, llm_zh in word_translations.items():
        word = raw_word.strip().lower()
        llm_zh = str(llm_zh).strip()
        row = rows_by_word.get(word)

        if not row:
            # 词典里没有这个词，直接用 LLM 中文
            if llm_zh:
                results[word] = llm_zh[:20]
            continue

        brief = row[1]
        meanings_json = row[4]
        all_meanings = _collect_all_chinese_meanings(meanings_json, brief)

        if not all_meanings:
            if llm_zh:
                results[word] = llm_zh[:20]
            continue

        # --- 匹配策略：给每条词典释义打分，选最佳 ---
        scored: list[tuple[str, int]] = []
        for m in all_meanings:
            if is_metadata_meaning(m):
                continue
            if llm_zh == m:
                scored.append((m, 100))  # 精确匹配
            elif m in llm_zh:
                scored.append((m, 80))   # 词典释义是 LLM 的子串（词典更简洁）
            elif llm_zh in m and len(m) <= len(llm_zh) + 3:
                scored.append((m, 60))   # LLM 是词典的子串且长度相近
            elif llm_zh in m:
                scored.append((m, 20))   # LLM 是词典的子串但词典明显更长

        if scored:
            scored.sort(key=lambda x: -x[1])
            best = scored[0][0][:20]
        else:
            # 词典没匹配到，直接用 LLM 的中文（LLM 最懂语境）
            best = llm_zh[:20]

        if best:
            results[word] = best

    return results


def _clean_definition_en(raw: Any) -> list[str]:
    """Parse English definitions from ecdict format into a clean list."""
    text = str(raw or "").replace("\\n", "\n").strip()
    if not text:
        return []

    items: list[str] = []
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        # Remove leading pos prefix like "n. " / "v. " / "adj. "
        cleaned = re.sub(r"^[a-z]+\.\s*", "", line, count=1).strip()
        if cleaned and cleaned not in items:
            items.append(cleaned)
        if len(items) >= 4:
            break
    return items


def _merge_meanings(primary: list[str], extra: list[str], limit: int = 4) -> list[str]:
    merged: list[str] = []
    for item in [*primary, *extra]:
        text = str(item or "").strip()
        if text and text not in merged:
            merged.append(text)
        if len(merged) >= limit:
            break
    return merged


def _query_db_rows(conn: sqlite3.Connection, words: list[str]) -> dict[str, tuple[Any, ...]]:
    normalized_words = []
    for word in words:
        clean = str(word).strip().lower()
        if clean and clean not in normalized_words:
            normalized_words.append(clean)

    if not normalized_words:
        return {}

    placeholders = ",".join("?" for _ in normalized_words)
    # Try to include definition_en if the column exists
    try:
        query = (
            "SELECT word, brief, pos, phonetic, meanings_json, definition_en "
            f"FROM entries WHERE word IN ({placeholders})"
        )
        rows = conn.execute(query, normalized_words).fetchall()
    except sqlite3.OperationalError:
        query = (
            "SELECT word, brief, pos, phonetic, meanings_json "
            f"FROM entries WHERE word IN ({placeholders})"
        )
        rows = conn.execute(query, normalized_words).fetchall()
        # Pad rows with None for missing definition_en
        rows = [(*row, None) for row in rows]
    return {str(row[0]).strip().lower(): row for row in rows}


def _normalize_entry(word: str, payload: dict[str, Any]) -> dict[str, Any]:
    meanings = normalize_detail_meanings(payload.get("meanings"))
    brief = extract_inline_brief(payload.get("brief"), payload.get("meanings"), meanings) or ""
    return {
        "lemma": word,
        "brief": brief,
        "pos": str(payload.get("pos") or "").strip() or None,
        "phonetic": str(payload.get("phonetic") or "").strip() or None,
        "meanings": meanings,
    }


@lru_cache
def load_json_wordbook() -> dict[str, dict[str, Any]]:
    settings = get_settings()
    path = _resolve_path(settings.local_wordbook_path)
    if not path.exists():
        logger.warning("Local wordbook not found: %s", path)
        return {}

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Failed to load local wordbook %s: %s", path, exc)
        return {}

    if not isinstance(payload, dict):
        return {}

    normalized: dict[str, dict[str, Any]] = {}
    for raw_word, raw_entry in payload.items():
        word = str(raw_word).strip().lower()
        if word and isinstance(raw_entry, dict):
            normalized[word] = _normalize_entry(word, raw_entry)
    return normalized


def _dictionary_db_path() -> Path:
    settings = get_settings()
    return _resolve_path(settings.local_dictionary_db_path)


def has_dictionary_db() -> bool:
    return _dictionary_db_path().exists()


def lookup_dictionary_entries(words: list[str]) -> dict[str, dict[str, Any]]:
    normalized_words = []
    for word in words:
        clean = str(word).strip().lower()
        if clean:
            normalized_words.append(clean)

    if not normalized_words:
        return {}

    wordbook = load_json_wordbook()
    found = {
        word: entry
        for word, entry in wordbook.items()
        if word in normalized_words
    }

    remaining = [word for word in normalized_words if word not in found]
    db_path = _dictionary_db_path()
    if not remaining or not db_path.exists():
        return found

    try:
        with sqlite3.connect(db_path) as conn:
            rows_by_word = _query_db_rows(conn, remaining)
            root_words: list[str] = []
            for row in rows_by_word.values():
                brief = row[1]
                meanings_json = row[4]
                try:
                    meanings = json.loads(meanings_json) if meanings_json else []
                except json.JSONDecodeError:
                    meanings = []
                root_word = extract_inflection_lemma(brief, meanings)
                if (
                    root_word
                    and root_word not in wordbook
                    and root_word not in rows_by_word
                    and root_word not in root_words
                ):
                    root_words.append(root_word)

            root_rows_by_word = _query_db_rows(conn, root_words)
    except sqlite3.Error as exc:
        logger.warning("Failed to query local dictionary db %s: %s", db_path, exc)
        return found

    # Row format: (word, brief, pos, phonetic, meanings_json, definition_en)
    for row in rows_by_word.values():
        word = row[0]
        brief = row[1]
        pos = row[2]
        phonetic = row[3]
        meanings_json = row[4]
        definition_en = row[5] if len(row) > 5 else None

        try:
            meanings = json.loads(meanings_json) if meanings_json else []
        except json.JSONDecodeError:
            meanings = []
        normalized_meanings = normalize_detail_meanings(meanings)
        root_word = extract_inflection_lemma(brief, meanings)
        root_entry = wordbook.get(root_word)
        if root_entry is None and root_word in root_rows_by_word:
            root_row = root_rows_by_word[root_word]
            root_brief = root_row[1]
            root_pos = root_row[2]
            root_phonetic = root_row[3]
            root_meanings_json = root_row[4]
            root_definition_en = root_row[5] if len(root_row) > 5 else None
            try:
                root_meanings = json.loads(root_meanings_json) if root_meanings_json else []
            except json.JSONDecodeError:
                root_meanings = []
            root_entry = {
                "lemma": root_word,
                "brief": extract_inline_brief(root_brief, root_meanings) or "",
                "pos": root_pos or None,
                "phonetic": root_phonetic or None,
                "meanings": normalize_detail_meanings(root_meanings),
                "definition_en": _clean_definition_en(root_definition_en),
            }

        merged_meanings = normalized_meanings
        display_brief = extract_inline_brief(brief, meanings, normalized_meanings) or ""
        if root_entry:
            root_brief_text = str(root_entry.get("brief") or "").strip()
            root_meanings = normalize_detail_meanings(root_entry.get("meanings"))
            if root_brief_text:
                display_brief = root_brief_text
            if root_meanings:
                merged_meanings = _merge_meanings(root_meanings, normalized_meanings, limit=4)

        # Use root entry's definition_en if available, else current word's
        en_def = definition_en
        if root_entry and root_entry.get("definition_en"):
            en_def = root_entry["definition_en"]

        found[word] = {
            "lemma": word,
            "brief": display_brief,
            "pos": pos or None,
            "phonetic": phonetic or None,
            "meanings": merged_meanings,
            "definition_en": _clean_definition_en(en_def),
        }

    return found


def lookup_dictionary_entry(word: str) -> dict[str, Any] | None:
    return lookup_dictionary_entries([word]).get(str(word).strip().lower())

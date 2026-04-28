"""
阅读扫描接口：一次请求完成 过滤 + 翻译
"""

import json
import logging
from datetime import datetime
from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import User, UserVocabulary, WordStatus
from schemas import WordLookupRequest, WordLookupResponse
from services.auth import get_current_user
from services.frequency import get_known_words
from services.local_dictionary import extract_inline_brief, normalize_detail_meanings
from services.translator import (
    batch_translate,
    lookup_word_detail,
    summarize_article,
    summarize_article_stream,
)

router = APIRouter(prefix="/api/reading", tags=["reading"])
DEFAULT_EXPOSURE_LIMIT = 10
logger = logging.getLogger(__name__)


class WordContext(BaseModel):
    word: str
    sentence: str
    paragraph: str | None = None


class ScanRequest(BaseModel):
    words: list[WordContext]
    page_url: str | None = None
    page_session_id: str | None = None


class AnnotationItem(BaseModel):
    word: str
    chinese: str
    sentence_zh: str | None = None


class ScanResponse(BaseModel):
    annotations: list[AnnotationItem]
    llm_ok: bool = True
    llm_error: str | None = None


def _prefer_vocab(existing: UserVocabulary | None, candidate: UserVocabulary) -> UserVocabulary:
    if existing is None:
        return candidate

    existing_score = (
        1 if existing.definition_cn else 0,
        existing.last_seen_at or datetime.min,
        existing.id,
    )
    candidate_score = (
        1 if candidate.definition_cn else 0,
        candidate.last_seen_at or datetime.min,
        candidate.id,
    )
    return candidate if candidate_score > existing_score else existing


def _brief_from_definition(definition_cn: str | None) -> str | None:
    return extract_inline_brief(definition_cn)


def _parse_meanings(raw_value: str | None) -> list[str]:
    if not raw_value:
        return []
    try:
        payload = json.loads(raw_value)
    except json.JSONDecodeError:
        return []
    if not isinstance(payload, list):
        return []
    return normalize_detail_meanings(payload, limit=4)


def _parse_json_list(raw_value: str | None, limit: int = 4) -> list[str]:
    if not raw_value:
        return []
    try:
        payload = json.loads(raw_value)
    except json.JSONDecodeError:
        return []
    if not isinstance(payload, list):
        return []
    values: list[str] = []
    for item in payload:
        text = str(item or "").strip()
        if text and text not in values:
            values.append(text)
        if len(values) >= limit:
            break
    return values


def _set_meanings(vocab: UserVocabulary, meanings: list[str]) -> None:
    normalized = normalize_detail_meanings(meanings, limit=4)
    vocab.meanings_json = json.dumps(normalized, ensure_ascii=False) if normalized else None


def _set_definition_en(vocab: UserVocabulary, definitions: list[str]) -> None:
    values = _parse_json_list(json.dumps(definitions, ensure_ascii=False), limit=4)
    vocab.definition_en_json = json.dumps(values, ensure_ascii=False) if values else None


def _reset_exposure_cycle(vocab: UserVocabulary) -> None:
    vocab.exposure_limit = vocab.exposure_limit or DEFAULT_EXPOSURE_LIMIT
    vocab.exposure_remaining = vocab.exposure_limit
    vocab.last_exposure_session_id = None


def _translator_overrides_from_request(request: Request) -> dict[str, str]:
    headers = request.headers
    overrides: dict[str, str] = {}

    mode = (headers.get("X-WordWise-Translator-Mode") or "").strip()
    if mode in {"local_wordbook", "hybrid", "remote"}:
        overrides["mode"] = mode

    api_key = (headers.get("X-WordWise-Translator-Key") or "").strip()
    if api_key:
        overrides["api_key"] = api_key

    api_url = (headers.get("X-WordWise-Translator-Api-Url") or "").strip()
    if api_url:
        overrides["api_url"] = api_url

    model = (headers.get("X-WordWise-Translator-Model") or "").strip()
    if model:
        overrides["model"] = model

    return overrides


def _apply_annotation_exposure(vocab: UserVocabulary, page_session_id: str | None) -> None:
    if page_session_id and vocab.last_exposure_session_id == page_session_id:
        return

    if vocab.exposure_remaining is None or vocab.exposure_remaining < 0:
        vocab.exposure_limit = vocab.exposure_limit or DEFAULT_EXPOSURE_LIMIT
        vocab.exposure_remaining = vocab.exposure_limit

    vocab.exposure_remaining = max(0, (vocab.exposure_remaining or 0) - 1)
    vocab.annotation_count = (vocab.annotation_count or 0) + 1
    if page_session_id:
        vocab.last_exposure_session_id = page_session_id


async def _ensure_vocab_detail(
    vocab: UserVocabulary,
    word: str,
    sentence: str | None,
    translator_overrides: dict[str, str] | None = None,
) -> dict:
    """Fetch full word detail (from LLM / local dict), update vocab row, return detail dict."""
    has_cached_detail = bool(
        vocab.definition_cn
        and vocab.meanings_json
        and vocab.definition_en_json
        and (not sentence or vocab.sentence_zh)
    )
    if has_cached_detail:
        return {
            "lemma": vocab.lemma,
            "brief": _brief_from_definition(vocab.definition_cn) or "",
            "pos": vocab.pos,
            "phonetic": vocab.phonetic,
            "phonetic_uk": vocab.phonetic_uk,
            "phonetic_us": vocab.phonetic_us,
            "meanings": _parse_meanings(vocab.meanings_json),
            "definition_en": _parse_json_list(vocab.definition_en_json),
            "sentence_zh": vocab.sentence_zh,
        }

    sentence_for_lookup = None if vocab.sentence_zh else sentence
    detail = await lookup_word_detail(word, sentence_for_lookup, overrides=translator_overrides)
    if not isinstance(detail, dict) or not detail:
        return {}

    brief = detail.get("brief")
    if brief:
        vocab.definition_cn = vocab.definition_cn or brief
    if detail.get("pos"):
        vocab.pos = detail["pos"]
    if detail.get("phonetic"):
        vocab.phonetic = detail["phonetic"]
    if detail.get("phonetic_uk"):
        vocab.phonetic_uk = detail["phonetic_uk"]
    if detail.get("phonetic_us"):
        vocab.phonetic_us = detail["phonetic_us"]
    if detail.get("meanings"):
        _set_meanings(vocab, detail["meanings"])
    if detail.get("definition_en"):
        _set_definition_en(vocab, detail["definition_en"])
    if detail.get("sentence_zh"):
        vocab.sentence_zh = detail["sentence_zh"]

    return detail


@router.post("/scan", response_model=ScanResponse, summary="扫描页面词汇，返回需要标注的词+中文翻译")
async def scan_page(
    body: ScanRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    translator_overrides = _translator_overrides_from_request(request)
    logger.info(
        "[reading] scan mode=%s page=%s words=%d",
        translator_overrides.get("mode", "default"),
        body.page_url or "",
        len(body.words),
    )
    # 1. 根据用户词汇等级过滤已知词
    known_words = get_known_words(user.vocab_level or "high_school")
    candidates: dict[str, WordContext] = {}
    for wc in body.words:
        w = wc.word.lower().strip()
        if w in known_words:
            continue
        if len(w) <= 2:
            continue
        candidates.setdefault(w, wc)

    if not candidates:
        return ScanResponse(annotations=[], llm_ok=True)

    # 2. 查用户词库，过滤已掌握的词
    lemmas = list(candidates.keys())
    result = await db.execute(
        select(UserVocabulary).where(
            UserVocabulary.user_id == user.id,
            UserVocabulary.lemma.in_(lemmas),
        )
    )
    vocab_map: dict[str, UserVocabulary] = {}
    for vocab in result.scalars().all():
        vocab_map[vocab.lemma] = _prefer_vocab(vocab_map.get(vocab.lemma), vocab)

    to_translate = []
    fallback_cache: dict[str, str] = {}
    now = datetime.utcnow()

    for lemma, wc in candidates.items():
        v = vocab_map.get(lemma)

        if v and v.status == WordStatus.mastered:
            continue  # 已掌握，跳过
        if v and (v.exposure_remaining or 0) <= 0:
            continue

        if v:
            v.encounter_count += 1
            v.last_seen_at = now
            if body.page_url:
                v.source_url = body.page_url
            if wc.sentence:
                v.context_sentence = wc.sentence[:200]

        # 数据库缓存仅作兜底，不阻止 LLM 语境翻译
        cached_brief = _brief_from_definition(v.definition_cn) if v else None
        if cached_brief:
            fallback_cache[lemma] = cached_brief

        # 所有词都发给 LLM 做语境翻译
        to_translate.append({"word": wc.word, "sentence": wc.sentence, "paragraph": wc.paragraph})

    # 3. 调 LLM 结合句意翻译（本地词典 / 数据库缓存仅兜底）
    llm_results: dict[str, str] = {}
    llm_ok = True
    llm_error = None
    if to_translate:
        batch_result = await batch_translate(to_translate, overrides=translator_overrides)
        llm_results = batch_result.get("_translations", {})
        llm_ok = batch_result.get("_llm_ok", True)
        llm_error = batch_result.get("_error")

    # 4. 合并结果：LLM 优先 → DB 缓存兜底
    annotations = []
    for lemma, wc in candidates.items():
        v = vocab_map.get(lemma)
        if v and v.status == WordStatus.mastered:
            continue
        if v and (v.exposure_remaining or 0) <= 0:
            continue

        chinese = llm_results.get(lemma) or fallback_cache.get(lemma)
        if not chinese:
            continue  # LLM + 兜底都没有，跳过

        annotations.append(AnnotationItem(
            word=wc.word, chinese=chinese,
        ))

        # 5. 把语境翻译写回数据库
        if not v:
            v = UserVocabulary(
                user_id=user.id,
                lemma=lemma,
                status=WordStatus.new_word,
                definition_cn=chinese,
                source_url=body.page_url,
                context_sentence=wc.sentence[:200] if wc.sentence else None,
                last_seen_at=now,
                exposure_limit=DEFAULT_EXPOSURE_LIMIT,
                exposure_remaining=DEFAULT_EXPOSURE_LIMIT,
            )
            db.add(v)
            vocab_map[lemma] = v
        else:
            # 用最新的语境翻译更新缓存
            v.definition_cn = chinese

        _apply_annotation_exposure(v, body.page_session_id)

    await db.commit()
    return ScanResponse(annotations=annotations, llm_ok=llm_ok, llm_error=llm_error)


@router.post("/lookup", response_model=WordLookupResponse, summary="查询单词详情，可选触发重新曝光")
async def lookup_word(
    body: WordLookupRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    translator_overrides = _translator_overrides_from_request(request)
    logger.info(
        "[reading] lookup mode=%s word=%s trigger_cycle=%s",
        translator_overrides.get("mode", "default"),
        body.word,
        body.trigger_cycle,
    )
    lemma = body.word.lower().strip()
    if not lemma:
        return WordLookupResponse(
            lemma="",
            brief="",
            exposure_remaining=0,
            manual_lookup_count=0,
        )

    now = datetime.utcnow()
    result = await db.execute(
        select(UserVocabulary).where(
            UserVocabulary.user_id == user.id,
            UserVocabulary.lemma == lemma,
        )
    )
    vocab = result.scalar_one_or_none()

    if vocab is None:
        vocab = UserVocabulary(
            user_id=user.id,
            lemma=lemma,
            status=WordStatus.learning if body.trigger_cycle else WordStatus.new_word,
            source_url=body.page_url,
            context_sentence=body.sentence[:200] if body.sentence else None,
            last_seen_at=now,
            exposure_limit=DEFAULT_EXPOSURE_LIMIT,
            exposure_remaining=DEFAULT_EXPOSURE_LIMIT,
        )
        db.add(vocab)
    else:
        vocab.last_seen_at = now
        vocab.encounter_count += 1
        if body.page_url:
            vocab.source_url = body.page_url
        if body.sentence:
            vocab.context_sentence = body.sentence[:200]

    # Always fetch fresh detail for full pronunciation + English definition
    detail = await _ensure_vocab_detail(
        vocab,
        lemma,
        body.sentence,
        translator_overrides=translator_overrides,
    )
    brief = _brief_from_definition(vocab.definition_cn) or detail.get("brief") or ""

    if body.trigger_cycle:
        _reset_exposure_cycle(vocab)
        vocab.last_clicked_translation = True
        vocab.manual_lookup_count = (vocab.manual_lookup_count or 0) + 1
        vocab.last_manual_lookup_at = now
        if vocab.status == WordStatus.mastered:
            vocab.status = WordStatus.learning
        elif vocab.status in (WordStatus.unseen, WordStatus.suspected_known):
            vocab.status = WordStatus.new_word

    await db.commit()

    return WordLookupResponse(
        lemma=lemma,
        brief=brief,
        pos=detail.get("pos") or vocab.pos,
        phonetic=detail.get("phonetic") or vocab.phonetic,
        phonetic_uk=detail.get("phonetic_uk") or vocab.phonetic_uk,
        phonetic_us=detail.get("phonetic_us") or vocab.phonetic_us,
        meanings=_parse_meanings(vocab.meanings_json),
        definition_en=detail.get("definition_en") or _parse_json_list(vocab.definition_en_json),
        sentence_zh=detail.get("sentence_zh") or vocab.sentence_zh,
        exposure_remaining=vocab.exposure_remaining or 0,
        manual_lookup_count=vocab.manual_lookup_count or 0,
    )


# ── Article Summary ──────────────────────────────


class SummarizeRequest(BaseModel):
    text: str
    page_url: str | None = None


@router.post("/summarize", summary="AI 文章摘要（中英双语结构化大纲）")
async def summarize(
    body: SummarizeRequest,
    request: Request,
    user: User = Depends(get_current_user),
):
    translator_overrides = _translator_overrides_from_request(request)
    logger.info(
        "[reading] summarize mode=%s page=%s text_len=%d",
        translator_overrides.get("mode", "default"),
        body.page_url or "",
        len(body.text),
    )

    if len(body.text.strip()) < 100:
        return {"error": "文章内容过短，无法生成摘要"}

    result = await summarize_article(body.text, overrides=translator_overrides)
    if result is None:
        return {"error": "AI 摘要生成失败，请检查 LLM 配置（API Key / 地址 / 模型名）"}
    if isinstance(result, dict) and "_error" in result:
        return {"error": f"LLM 调用失败：{result['_error']}"}

    return result


@router.post("/summarize/stream", summary="AI 文章摘要（SSE 流式输出）")
async def summarize_stream(
    body: SummarizeRequest,
    request: Request,
    user: User = Depends(get_current_user),
):
    """流式生成文章摘要。

    返回 text/event-stream，每个事件为一行 `data: {json}`，json 格式：
    - {"type":"meta","data":{title_en,title_zh,overview_en,overview_zh}}
    - {"type":"section","data":{heading_en,heading_zh,points_en,points_zh}}
    - {"type":"done","data":{}}
    - {"type":"error","data":{"message":"..."}}
    """
    translator_overrides = _translator_overrides_from_request(request)
    logger.info(
        "[reading] summarize/stream mode=%s page=%s text_len=%d",
        translator_overrides.get("mode", "default"),
        body.page_url or "",
        len(body.text),
    )

    text = body.text

    async def event_source():
        if len(text.strip()) < 100:
            yield f"data: {json.dumps({'type':'error','data':{'message':'文章内容过短，无法生成摘要'}}, ensure_ascii=False)}\n\n"
            return
        try:
            async for evt in summarize_article_stream(text, overrides=translator_overrides):
                yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"
        except Exception as exc:
            logger.exception("[reading] summarize/stream failure: %s", exc)
            err = {"type": "error", "data": {"message": f"流式摘要异常：{exc}"}}
            yield f"data: {json.dumps(err, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",  # disable proxy buffering (nginx etc.)
            "Connection": "keep-alive",
        },
    )

from datetime import datetime
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import User, UserVocabulary, WordStatus
from schemas import (
    WordEncounter, WordBatchEncounter, VocabItem, VocabList,
    WordStatusUpdate, WordCheckRequest, WordCheckResponse, WordCheckItem,
)
from services.auth import get_current_user

router = APIRouter(prefix="/api/vocabulary", tags=["vocabulary"])
DEFAULT_EXPOSURE_LIMIT = 10


@router.post("/encounter", summary="生词入库 - 单个")
async def encounter_word(
    body: WordEncounter,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    lemma = body.lemma.lower().strip()

    result = await db.execute(
        select(UserVocabulary).where(
            UserVocabulary.user_id == user.id,
            UserVocabulary.lemma == lemma,
        )
    )
    vocab = result.scalar_one_or_none()

    if vocab:
        vocab.encounter_count += 1
        vocab.last_seen_at = datetime.utcnow()
        if body.context_sentence:
            vocab.context_sentence = body.context_sentence
        if body.source_url:
            vocab.source_url = body.source_url
        if body.clicked_translation:
            vocab.last_clicked_translation = True
            vocab.manual_lookup_count = (vocab.manual_lookup_count or 0) + 1
            vocab.last_manual_lookup_at = datetime.utcnow()
            vocab.exposure_limit = vocab.exposure_limit or DEFAULT_EXPOSURE_LIMIT
            vocab.exposure_remaining = vocab.exposure_limit
            vocab.last_exposure_session_id = None
            if vocab.status == WordStatus.unseen:
                vocab.status = WordStatus.new_word
            elif vocab.status == WordStatus.mastered:
                vocab.status = WordStatus.learning
    else:
        vocab = UserVocabulary(
            user_id=user.id,
            lemma=lemma,
            status=WordStatus.new_word,
            context_sentence=body.context_sentence,
            source_url=body.source_url,
            definition_cn=body.definition_cn,
            phonetic=body.phonetic,
            pos=body.pos,
            last_clicked_translation=body.clicked_translation,
            manual_lookup_count=1 if body.clicked_translation else 0,
            last_manual_lookup_at=datetime.utcnow() if body.clicked_translation else None,
            exposure_limit=DEFAULT_EXPOSURE_LIMIT,
            exposure_remaining=DEFAULT_EXPOSURE_LIMIT,
        )
        db.add(vocab)

    await db.commit()
    return {"status": "ok", "lemma": lemma}


@router.post("/encounter/batch", summary="生词入库 - 批量（页面结束时）")
async def encounter_batch(
    body: WordBatchEncounter,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    count = 0
    # Batch load existing vocab to avoid N+1 queries
    lemmas = [w.lemma.lower().strip() for w in body.words]
    result = await db.execute(
        select(UserVocabulary).where(
            UserVocabulary.user_id == user.id,
            UserVocabulary.lemma.in_(lemmas),
        )
    )
    vocab_map = {v.lemma: v for v in result.scalars().all()}

    for word in body.words:
        lemma = word.lemma.lower().strip()
        vocab = vocab_map.get(lemma)

        if vocab:
            vocab.encounter_count += 1
            vocab.last_seen_at = datetime.utcnow()
            if word.context_sentence:
                vocab.context_sentence = word.context_sentence
            if word.source_url:
                vocab.source_url = word.source_url
            if word.clicked_translation:
                vocab.last_clicked_translation = True
                vocab.manual_lookup_count = (vocab.manual_lookup_count or 0) + 1
                vocab.last_manual_lookup_at = datetime.utcnow()
                vocab.exposure_limit = vocab.exposure_limit or DEFAULT_EXPOSURE_LIMIT
                vocab.exposure_remaining = vocab.exposure_limit
                vocab.last_exposure_session_id = None
                if vocab.status == WordStatus.mastered:
                    vocab.status = WordStatus.learning
        else:
            vocab = UserVocabulary(
                user_id=user.id,
                lemma=lemma,
                status=WordStatus.new_word,
                context_sentence=word.context_sentence,
                source_url=word.source_url,
                definition_cn=word.definition_cn,
                phonetic=word.phonetic,
                pos=word.pos,
                last_clicked_translation=word.clicked_translation,
                manual_lookup_count=1 if word.clicked_translation else 0,
                last_manual_lookup_at=datetime.utcnow() if word.clicked_translation else None,
                exposure_limit=DEFAULT_EXPOSURE_LIMIT,
                exposure_remaining=DEFAULT_EXPOSURE_LIMIT,
            )
            db.add(vocab)
            count += 1

    await db.commit()
    return {"status": "ok", "new_words": count}


@router.post("/check", response_model=WordCheckResponse, summary="插件用 - 批量检查词汇状态")
async def check_words(
    body: WordCheckRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    normalized_words = [word.lower().strip() for word in body.words]
    result = await db.execute(
        select(UserVocabulary).where(
            UserVocabulary.user_id == user.id,
            UserVocabulary.lemma.in_(normalized_words),
        )
    )
    vocab_map = {v.lemma: v for v in result.scalars().all()}

    words_out = {}
    for raw_word, normalized_word in zip(body.words, normalized_words):
        v = vocab_map.get(normalized_word)
        if v is None:
            words_out[raw_word] = WordCheckItem(status="unknown")
        elif v.status in (WordStatus.mastered,):
            words_out[raw_word] = WordCheckItem(status="known")
        elif v.status in (WordStatus.learning, WordStatus.forgotten):
            words_out[raw_word] = WordCheckItem(
                status="learning",
                definition_cn=v.definition_cn,
                phonetic=v.phonetic,
                pos=v.pos,
                exposure_remaining=v.exposure_remaining,
            )
        else:  # new_word, unseen, suspected_known
            words_out[raw_word] = WordCheckItem(
                status="unknown",
                definition_cn=v.definition_cn,
                phonetic=v.phonetic,
                pos=v.pos,
                exposure_remaining=v.exposure_remaining,
            )

    return WordCheckResponse(words=words_out)


@router.get("/list", response_model=VocabList, summary="获取词库列表")
async def list_vocabulary(
    status: WordStatus | None = None,
    page: int = Query(1, ge=1),
    size: int = Query(30, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = select(UserVocabulary).where(UserVocabulary.user_id == user.id)
    count_query = select(func.count()).select_from(UserVocabulary).where(UserVocabulary.user_id == user.id)

    if status:
        query = query.where(UserVocabulary.status == status)
        count_query = count_query.where(UserVocabulary.status == status)

    total_result = await db.execute(count_query)
    total = total_result.scalar()

    query = query.order_by(UserVocabulary.last_seen_at.desc())
    query = query.offset((page - 1) * size).limit(size)
    result = await db.execute(query)

    return VocabList(items=result.scalars().all(), total=total)


@router.put("/status", summary="手动更新词汇状态")
async def update_word_status(
    body: WordStatusUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    lemma = body.lemma.lower().strip()
    result = await db.execute(
        select(UserVocabulary).where(
            UserVocabulary.user_id == user.id,
            UserVocabulary.lemma == lemma,
        )
    )
    vocab = result.scalar_one_or_none()
    if not vocab:
        return {"status": "error", "detail": "词汇不存在"}

    vocab.status = body.new_status
    if body.new_status == WordStatus.mastered:
        vocab.exposure_remaining = 0
    elif vocab.exposure_remaining is None:
        vocab.exposure_limit = vocab.exposure_limit or DEFAULT_EXPOSURE_LIMIT
        vocab.exposure_remaining = vocab.exposure_limit
    await db.commit()
    return {"status": "ok", "lemma": lemma, "new_status": body.new_status}


@router.get("/stats", summary="词汇统计")
async def vocabulary_stats(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Single GROUP BY query instead of 7 separate COUNT queries
    result = await db.execute(
        select(UserVocabulary.status, func.count())
        .where(UserVocabulary.user_id == user.id)
        .group_by(UserVocabulary.status)
    )
    counts = {s.value: 0 for s in WordStatus}
    for status, cnt in result.all():
        counts[status.value if hasattr(status, 'value') else status] = cnt

    return {
        "estimated_vocabulary": user.estimated_vocabulary,
        "total_words": sum(counts.values()),
        "by_status": counts,
    }

from datetime import datetime
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import User, UserVocabulary, ReviewLog, WordStatus
from schemas import ReviewCard, ReviewSession, ReviewAnswer, ReviewBatchAnswer
from services.auth import get_current_user
from services.spaced_repetition import calculate_next_review, get_familiarity_score

router = APIRouter(prefix="/api/review", tags=["review"])


@router.get("/due", response_model=ReviewSession, summary="获取今日待复习卡片")
async def get_due_cards(
    limit: int = Query(50, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    now = datetime.utcnow()

    # 获取到期需要复习的词
    result = await db.execute(
        select(UserVocabulary).where(
            UserVocabulary.user_id == user.id,
            UserVocabulary.status.in_([
                WordStatus.new_word,
                WordStatus.learning,
                WordStatus.forgotten,
            ]),
            (UserVocabulary.next_review_at <= now) | (UserVocabulary.next_review_at.is_(None)),
        ).order_by(
            # 优先: 新词 > 遗忘 > 学习中
            UserVocabulary.status.desc(),
            UserVocabulary.next_review_at.asc(),
        ).limit(limit)
    )
    vocabs = result.scalars().all()

    cards = [
        ReviewCard(
            lemma=v.lemma,
            phonetic=v.phonetic,
            definition_cn=v.definition_cn,
            pos=v.pos,
            context_sentence=v.context_sentence,
            source_url=v.source_url,
            error_count=v.error_count,
            review_stage=v.review_stage,
        )
        for v in vocabs
    ]

    return ReviewSession(cards=cards, total_due=len(cards))


@router.post("/answer", summary="提交单个复习结果")
async def submit_answer(
    body: ReviewAnswer,
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

    # 计算下一次复习
    new_stage, next_review, new_status, new_consec, new_errors = calculate_next_review(
        current_stage=vocab.review_stage,
        result=body.result,
        consecutive_correct=vocab.consecutive_correct,
        error_count=vocab.error_count,
    )

    vocab.review_stage = new_stage
    vocab.next_review_at = next_review
    vocab.status = new_status
    vocab.consecutive_correct = new_consec
    vocab.error_count = new_errors
    vocab.familiarity_score = get_familiarity_score(new_stage, new_consec, new_errors)

    # 记录复习日志
    log = ReviewLog(
        user_id=user.id,
        lemma=lemma,
        result=body.result,
    )
    db.add(log)
    await db.commit()

    return {
        "status": "ok",
        "lemma": lemma,
        "new_status": new_status.value,
        "next_review_at": next_review.isoformat(),
        "familiarity_score": vocab.familiarity_score,
    }


@router.post("/answer/batch", summary="批量提交复习结果")
async def submit_batch_answers(
    body: ReviewBatchAnswer,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    results = []
    for ans in body.answers:
        lemma = ans.lemma.lower().strip()
        result = await db.execute(
            select(UserVocabulary).where(
                UserVocabulary.user_id == user.id,
                UserVocabulary.lemma == lemma,
            )
        )
        vocab = result.scalar_one_or_none()
        if not vocab:
            continue

        new_stage, next_review, new_status, new_consec, new_errors = calculate_next_review(
            current_stage=vocab.review_stage,
            result=ans.result,
            consecutive_correct=vocab.consecutive_correct,
            error_count=vocab.error_count,
        )

        vocab.review_stage = new_stage
        vocab.next_review_at = next_review
        vocab.status = new_status
        vocab.consecutive_correct = new_consec
        vocab.error_count = new_errors
        vocab.familiarity_score = get_familiarity_score(new_stage, new_consec, new_errors)

        db.add(ReviewLog(user_id=user.id, lemma=lemma, result=ans.result))
        results.append({"lemma": lemma, "new_status": new_status.value})

    await db.commit()
    return {"status": "ok", "results": results}


@router.get("/history", summary="复习历史")
async def review_history(
    page: int = Query(1, ge=1),
    size: int = Query(30, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(ReviewLog).where(ReviewLog.user_id == user.id)
        .order_by(ReviewLog.reviewed_at.desc())
        .offset((page - 1) * size).limit(size)
    )
    logs = result.scalars().all()
    return {
        "items": [
            {
                "lemma": l.lemma,
                "result": l.result.value,
                "review_type": l.review_type,
                "reviewed_at": l.reviewed_at.isoformat(),
            }
            for l in logs
        ]
    }

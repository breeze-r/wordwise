from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import User
from schemas import UserResponse, VocabLevelUpdate
from services.auth import get_current_user
from services.frequency import LEVEL_ORDER, get_level_info

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/me", response_model=UserResponse, summary="获取本地学习档案")
async def get_me(user: User = Depends(get_current_user)):
    return user


@router.get("/vocab-levels", summary="获取所有词汇等级信息")
async def vocab_levels():
    return get_level_info()


@router.put("/vocab-level", response_model=UserResponse, summary="设置词汇等级")
async def set_vocab_level(
    body: VocabLevelUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.level not in LEVEL_ORDER:
        raise HTTPException(status_code=400, detail=f"无效等级: {body.level}")

    user.vocab_level = body.level
    matched = next((item for item in get_level_info() if item["key"] == body.level), None)
    if matched:
        user.estimated_vocabulary = matched["word_count"]

    await db.commit()
    await db.refresh(user)
    return user

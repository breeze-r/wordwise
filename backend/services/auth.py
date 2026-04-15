from fastapi import Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import User, UserVocabulary

LOCAL_USER_EMAIL = "local@wordwise.invalid"
LOCAL_USER_PASSWORD_PLACEHOLDER = "LOCAL_ONLY"


async def _get_or_create_local_user(
    db: AsyncSession,
) -> User:
    result = await db.execute(
        select(User).where(User.email == LOCAL_USER_EMAIL)
    )
    user = result.scalar_one_or_none()
    if user is not None:
        return user

    # 兼容旧库：若历史上只有一个用户，直接复用，避免把学习记录切走。
    existing_users = (
        await db.execute(
            select(User)
            .outerjoin(UserVocabulary, UserVocabulary.user_id == User.id)
            .group_by(User.id)
            .order_by(
                func.count(UserVocabulary.id).desc(),
                User.created_at.asc(),
                User.id.asc(),
            )
        )
    ).scalars().all()
    if existing_users:
        return existing_users[0]

    user = User(
        email=LOCAL_USER_EMAIL,
        hashed_password=LOCAL_USER_PASSWORD_PLACEHOLDER,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def get_current_user(
    db: AsyncSession = Depends(get_db),
) -> User:
    return await _get_or_create_local_user(db)

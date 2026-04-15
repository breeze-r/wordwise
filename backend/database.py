from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

from settings import get_settings


settings = get_settings()
DATABASE_URL = settings.database_url

engine = create_async_engine(DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


USER_VOCABULARY_COLUMN_MIGRATIONS = {
    "meanings_json": "ALTER TABLE user_vocabulary ADD COLUMN meanings_json TEXT",
    "exposure_limit": "ALTER TABLE user_vocabulary ADD COLUMN exposure_limit INTEGER DEFAULT 10",
    "exposure_remaining": "ALTER TABLE user_vocabulary ADD COLUMN exposure_remaining INTEGER DEFAULT 10",
    "annotation_count": "ALTER TABLE user_vocabulary ADD COLUMN annotation_count INTEGER DEFAULT 0",
    "manual_lookup_count": "ALTER TABLE user_vocabulary ADD COLUMN manual_lookup_count INTEGER DEFAULT 0",
    "last_exposure_session_id": "ALTER TABLE user_vocabulary ADD COLUMN last_exposure_session_id VARCHAR(100)",
    "last_manual_lookup_at": "ALTER TABLE user_vocabulary ADD COLUMN last_manual_lookup_at DATETIME",
}


async def get_db():
    async with async_session() as session:
        yield session


async def init_db():
    import models  # noqa: F401

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

        # Users 表迁移
        users_info = await conn.execute(text("PRAGMA table_info(users)"))
        users_columns = {row[1] for row in users_info.fetchall()}
        if "vocab_level" not in users_columns:
            await conn.execute(
                text("ALTER TABLE users ADD COLUMN vocab_level VARCHAR(30) DEFAULT 'high_school'")
            )

        # UserVocabulary 表迁移
        table_info = await conn.execute(text("PRAGMA table_info(user_vocabulary)"))
        existing_columns = {row[1] for row in table_info.fetchall()}
        for column_name, ddl in USER_VOCABULARY_COLUMN_MIGRATIONS.items():
            if column_name not in existing_columns:
                await conn.execute(text(ddl))
        await conn.execute(
            text("UPDATE user_vocabulary SET lemma = lower(trim(lemma)) WHERE lemma IS NOT NULL")
        )
        await conn.execute(
            text(
                "UPDATE user_vocabulary "
                "SET exposure_limit = COALESCE(exposure_limit, 10), "
                "exposure_remaining = COALESCE(exposure_remaining, exposure_limit, 10), "
                "annotation_count = COALESCE(annotation_count, 0), "
                "manual_lookup_count = COALESCE(manual_lookup_count, 0)"
            )
        )

    from models import UserVocabulary

    async with async_session() as session:
        duplicate_keys = (
            await session.execute(
                select(UserVocabulary.user_id, UserVocabulary.lemma)
                .group_by(UserVocabulary.user_id, UserVocabulary.lemma)
                .having(func.count(UserVocabulary.id) > 1)
            )
        ).all()

        for user_id, lemma in duplicate_keys:
            rows = (
                await session.execute(
                    select(UserVocabulary)
                    .where(
                        UserVocabulary.user_id == user_id,
                        UserVocabulary.lemma == lemma,
                    )
                    .order_by(UserVocabulary.last_seen_at.desc(), UserVocabulary.id.desc())
                )
            ).scalars().all()

            primary = rows[0]
            for extra in rows[1:]:
                primary.familiarity_score = max(
                    primary.familiarity_score or 0.0,
                    extra.familiarity_score or 0.0,
                )
                primary.review_stage = max(primary.review_stage or 0, extra.review_stage or 0)
                primary.consecutive_correct = max(
                    primary.consecutive_correct or 0,
                    extra.consecutive_correct or 0,
                )
                primary.error_count = max(primary.error_count or 0, extra.error_count or 0)
                primary.encounter_count = (
                    (primary.encounter_count or 0) + (extra.encounter_count or 0)
                )
                primary.context_sentence = primary.context_sentence or extra.context_sentence
                primary.source_url = primary.source_url or extra.source_url
                primary.definition_cn = primary.definition_cn or extra.definition_cn
                primary.phonetic = primary.phonetic or extra.phonetic
                primary.pos = primary.pos or extra.pos
                primary.meanings_json = primary.meanings_json or extra.meanings_json
                primary.last_clicked_translation = bool(
                    primary.last_clicked_translation or extra.last_clicked_translation
                )
                primary.exposure_limit = max(primary.exposure_limit or 10, extra.exposure_limit or 10)
                primary.exposure_remaining = max(
                    primary.exposure_remaining or 0,
                    extra.exposure_remaining or 0,
                )
                primary.annotation_count = (
                    (primary.annotation_count or 0) + (extra.annotation_count or 0)
                )
                primary.manual_lookup_count = (
                    (primary.manual_lookup_count or 0) + (extra.manual_lookup_count or 0)
                )
                primary.last_exposure_session_id = (
                    primary.last_exposure_session_id or extra.last_exposure_session_id
                )

                if extra.first_seen_at and (
                    primary.first_seen_at is None or extra.first_seen_at < primary.first_seen_at
                ):
                    primary.first_seen_at = extra.first_seen_at
                if extra.last_seen_at and (
                    primary.last_seen_at is None or extra.last_seen_at > primary.last_seen_at
                ):
                    primary.last_seen_at = extra.last_seen_at
                if extra.next_review_at and (
                    primary.next_review_at is None or extra.next_review_at < primary.next_review_at
                ):
                    primary.next_review_at = extra.next_review_at
                if extra.last_manual_lookup_at and (
                    primary.last_manual_lookup_at is None
                    or extra.last_manual_lookup_at > primary.last_manual_lookup_at
                ):
                    primary.last_manual_lookup_at = extra.last_manual_lookup_at

                await session.delete(extra)

        await session.commit()

    async with engine.begin() as conn:
        await conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS "
                "ux_user_vocabulary_user_lemma "
                "ON user_vocabulary (user_id, lemma)"
            )
        )

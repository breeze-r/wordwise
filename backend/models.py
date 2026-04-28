import enum
from datetime import datetime
from sqlalchemy import (
    Column, Integer, String, Float, DateTime, ForeignKey, Enum, Text, Boolean,
    Index,
)
from sqlalchemy.orm import relationship
from database import Base


class WordStatus(str, enum.Enum):
    unseen = "unseen"
    suspected_known = "suspected_known"
    new_word = "new_word"
    learning = "learning"
    mastered = "mastered"
    forgotten = "forgotten"


class ReviewResult(str, enum.Enum):
    again = "again"       # 不会
    fuzzy = "fuzzy"       # 模糊
    good = "good"         # 会
    easy = "easy"         # 完全掌握


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), unique=True, nullable=False, index=True)
    hashed_password = Column(String(255), nullable=False)
    estimated_vocabulary = Column(Integer, default=0)
    test_completed = Column(Boolean, default=False)
    vocab_level = Column(String(30), default="high_school")
    created_at = Column(DateTime, default=datetime.utcnow)

    vocabulary = relationship("UserVocabulary", back_populates="user")
    review_logs = relationship("ReviewLog", back_populates="user")


class UserVocabulary(Base):
    __tablename__ = "user_vocabulary"
    __table_args__ = (
        Index("ux_user_vocabulary_user_lemma", "user_id", "lemma", unique=True),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    lemma = Column(String(100), nullable=False, index=True)
    status = Column(Enum(WordStatus), default=WordStatus.new_word)
    familiarity_score = Column(Float, default=0.0)  # 0.0 ~ 1.0

    # 间隔重复
    review_stage = Column(Integer, default=0)  # 当前复习阶段
    next_review_at = Column(DateTime, nullable=True)
    consecutive_correct = Column(Integer, default=0)
    error_count = Column(Integer, default=0)

    # 阅读上下文
    context_sentence = Column(Text, nullable=True)
    source_url = Column(String(2048), nullable=True)
    definition_cn = Column(Text, nullable=True)
    phonetic = Column(String(100), nullable=True)
    phonetic_uk = Column(String(100), nullable=True)
    phonetic_us = Column(String(100), nullable=True)
    pos = Column(String(20), nullable=True)  # 词性
    meanings_json = Column(Text, nullable=True)
    definition_en_json = Column(Text, nullable=True)
    sentence_zh = Column(Text, nullable=True)

    # 时间
    first_seen_at = Column(DateTime, default=datetime.utcnow)
    last_seen_at = Column(DateTime, default=datetime.utcnow)
    encounter_count = Column(Integer, default=1)
    last_clicked_translation = Column(Boolean, default=False)
    exposure_limit = Column(Integer, default=10)
    exposure_remaining = Column(Integer, default=10)
    annotation_count = Column(Integer, default=0)
    manual_lookup_count = Column(Integer, default=0)
    last_exposure_session_id = Column(String(100), nullable=True)
    last_manual_lookup_at = Column(DateTime, nullable=True)

    user = relationship("User", back_populates="vocabulary")


class ReviewLog(Base):
    __tablename__ = "review_logs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    lemma = Column(String(100), nullable=False)
    result = Column(Enum(ReviewResult), nullable=False)
    review_type = Column(String(20), default="recognize")  # recognize / recall / context
    reviewed_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="review_logs")

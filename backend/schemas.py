from datetime import datetime
from pydantic import BaseModel
from models import WordStatus, ReviewResult


class UserResponse(BaseModel):
    id: int
    estimated_vocabulary: int
    test_completed: bool
    vocab_level: str = "high_school"

    model_config = {"from_attributes": True}


class VocabLevelUpdate(BaseModel):
    level: str


# === Vocabulary Test ===
class TestQuestion(BaseModel):
    word: str
    phonetic: str
    options: list[str]


class TestGenerateResponse(BaseModel):
    session_token: str
    questions: list[TestQuestion]
    total: int


class TestSubmit(BaseModel):
    session_token: str
    selected_indexes: list[int]


class TestResult(BaseModel):
    estimated_vocabulary: int
    level_description: str


# === Vocabulary ===
class WordEncounter(BaseModel):
    lemma: str
    context_sentence: str | None = None
    source_url: str | None = None
    definition_cn: str | None = None
    phonetic: str | None = None
    pos: str | None = None
    clicked_translation: bool = False


class WordBatchEncounter(BaseModel):
    words: list[WordEncounter]


class VocabItem(BaseModel):
    id: int
    lemma: str
    status: WordStatus
    familiarity_score: float
    definition_cn: str | None
    phonetic: str | None
    pos: str | None
    context_sentence: str | None
    source_url: str | None
    next_review_at: datetime | None
    encounter_count: int
    exposure_remaining: int
    exposure_limit: int
    annotation_count: int
    manual_lookup_count: int
    error_count: int
    first_seen_at: datetime
    last_seen_at: datetime

    model_config = {"from_attributes": True}


class VocabList(BaseModel):
    items: list[VocabItem]
    total: int


class WordStatusUpdate(BaseModel):
    lemma: str
    new_status: WordStatus


# === Review ===
class ReviewCard(BaseModel):
    lemma: str
    phonetic: str | None
    definition_cn: str | None
    pos: str | None
    context_sentence: str | None
    source_url: str | None
    error_count: int
    review_stage: int


class ReviewSession(BaseModel):
    cards: list[ReviewCard]
    total_due: int


class ReviewAnswer(BaseModel):
    lemma: str
    result: ReviewResult


class ReviewBatchAnswer(BaseModel):
    answers: list[ReviewAnswer]


# === Reading page check ===
class WordCheckRequest(BaseModel):
    words: list[str]  # lemma list from page


class WordCheckItem(BaseModel):
    status: str              # "unknown" | "learning" | "known"
    definition_cn: str | None = None
    phonetic: str | None = None
    pos: str | None = None
    exposure_remaining: int | None = None


class WordCheckResponse(BaseModel):
    words: dict[str, WordCheckItem]


class WordLookupRequest(BaseModel):
    word: str
    sentence: str | None = None
    page_url: str | None = None
    trigger_cycle: bool = False


class WordLookupResponse(BaseModel):
    lemma: str
    brief: str
    pos: str | None = None
    phonetic: str | None = None
    phonetic_uk: str | None = None
    phonetic_us: str | None = None
    meanings: list[str] = []
    definition_en: list[str] = []
    sentence_zh: str | None = None
    exposure_remaining: int
    manual_lookup_count: int

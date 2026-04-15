"""词汇量测试 - 自适应测试"""

from datetime import datetime, timedelta
import random
from fastapi import APIRouter, Depends, HTTPException, status
from jose import JWTError, jwt
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import User
from schemas import TestGenerateResponse, TestQuestion, TestSubmit, TestResult
from services.auth import get_current_user
from settings import get_settings

router = APIRouter(prefix="/api/test", tags=["vocabulary-test"])
settings = get_settings()
TEST_SESSION_SCOPE = "vocabulary-test"

# 按词频分层的测试词库 (简化版，实际应从词典数据库加载)
# 格式: (word, phonetic, meaning, [distractors])
TEST_WORD_BANK = {
    1000: [
        ("important", "/ɪmˈpɔːrtənt/", "重要的", ["困难的", "有趣的", "危险的"]),
        ("different", "/ˈdɪfərənt/", "不同的", ["相似的", "困难的", "普通的"]),
        ("because", "/bɪˈkɒz/", "因为", ["虽然", "但是", "所以"]),
        ("between", "/bɪˈtwiːn/", "在...之间", ["在...上面", "在...旁边", "在...后面"]),
    ],
    2000: [
        ("achieve", "/əˈtʃiːv/", "达成，实现", ["避免", "接受", "承认"]),
        ("ancient", "/ˈeɪnʃənt/", "古代的", ["现代的", "中世纪的", "未来的"]),
        ("available", "/əˈveɪləbl/", "可用的", ["不可能的", "必需的", "可见的"]),
        ("behavior", "/bɪˈheɪvjər/", "行为", ["信仰", "利益", "负担"]),
    ],
    3000: [
        ("adequate", "/ˈædɪkwət/", "足够的", ["优秀的", "困难的", "奢侈的"]),
        ("contempt", "/kənˈtempt/", "蔑视", ["同情", "嫉妒", "怀疑"]),
        ("diminish", "/dɪˈmɪnɪʃ/", "减少", ["增加", "维持", "改变"]),
        ("elaborate", "/ɪˈlæbərət/", "详尽的", ["简单的", "普通的", "快速的"]),
    ],
    5000: [
        ("ambiguous", "/æmˈbɪɡjuəs/", "模棱两可的", ["清晰的", "简洁的", "完整的"]),
        ("coherent", "/koʊˈhɪrənt/", "连贯的", ["混乱的", "简短的", "冗长的"]),
        ("empirical", "/ɪmˈpɪrɪkl/", "经验主义的", ["理论的", "实际的", "主观的"]),
        ("precedent", "/ˈpresɪdənt/", "先例", ["结果", "原因", "过程"]),
    ],
    8000: [
        ("conundrum", "/kəˈnʌndrəm/", "难题", ["答案", "机会", "传统"]),
        ("ephemeral", "/ɪˈfemərəl/", "短暂的", ["永恒的", "重要的", "普遍的"]),
        ("juxtapose", "/ˌdʒʌkstəˈpoʊz/", "并列，并置", ["分离", "组合", "替代"]),
        ("ubiquitous", "/juːˈbɪkwɪtəs/", "无处不在的", ["罕见的", "局部的", "短暂的"]),
    ],
    10000: [
        ("conflagration", "/ˌkɒnfləˈɡreɪʃn/", "大火", ["小溪", "微风", "暴风雪"]),
        ("perspicacious", "/ˌpɜːrspɪˈkeɪʃəs/", "敏锐的", ["迟钝的", "傲慢的", "谨慎的"]),
        ("recalcitrant", "/rɪˈkælsɪtrənt/", "不服从的", ["顺从的", "冷漠的", "热情的"]),
        ("verisimilitude", "/ˌverɪsɪˈmɪlɪtjuːd/", "逼真", ["虚假", "简单", "复杂"]),
    ],
    12000: [
        ("sesquipedalian", "/ˌseskwɪpɪˈdeɪliən/", "冗长的（词语）", ["简洁的", "优美的", "古老的"]),
        ("defenestrate", "/diːˈfenɪstreɪt/", "把…从窗户扔出", ["装饰", "拆除", "修理"]),
        ("tergiversate", "/ˈtɜːrdʒɪvərseɪt/", "变节，推诿", ["坚持", "支持", "赞同"]),
        ("callipygian", "/ˌkælɪˈpɪdʒiən/", "臀部美的", ["面容美的", "身材高的", "声音美的"]),
    ],
}

LEVELS = sorted(TEST_WORD_BANK.keys())


def generate_test(num_questions: int = 40) -> list[dict]:
    """生成自适应测试题目，每个词频段取若干题"""
    questions = []
    per_level = max(num_questions // len(LEVELS), 2)

    for level in LEVELS:
        words = TEST_WORD_BANK[level]
        sample = random.sample(words, min(per_level, len(words)))
        for word, phonetic, meaning, distractors in sample:
            options = distractors + [meaning]
            random.shuffle(options)
            questions.append({
                "word": word,
                "phonetic": phonetic,
                "options": options,
                "correct_index": options.index(meaning),
                "level": level,
            })

    random.shuffle(questions)
    return questions[:num_questions]


def estimate_vocabulary(questions: list[dict], answers: list[bool]) -> int:
    """根据答题结果估算词汇量"""
    level_correct = {}
    level_total = {}

    for q, correct in zip(questions, answers):
        lvl = q["level"]
        level_total[lvl] = level_total.get(lvl, 0) + 1
        if correct:
            level_correct[lvl] = level_correct.get(lvl, 0) + 1

    # 找到正确率降到 50% 以下的词频段
    estimated = 0
    for level in LEVELS:
        total = level_total.get(level, 0)
        correct = level_correct.get(level, 0)
        if total == 0:
            continue
        rate = correct / total
        if rate >= 0.5:
            estimated = level
        else:
            break

    return estimated


def create_test_session_token(questions: list[dict]) -> str:
    expire = datetime.utcnow() + timedelta(minutes=settings.test_session_expire_minutes)
    payload = {
        "scope": TEST_SESSION_SCOPE,
        "exp": expire,
        "questions": [
            {"level": q["level"], "correct_index": q["correct_index"]}
            for q in questions
        ],
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def decode_test_session_token(session_token: str) -> list[dict]:
    try:
        payload = jwt.decode(
            session_token,
            settings.jwt_secret_key,
            algorithms=[settings.jwt_algorithm],
        )
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="测试会话已失效，请重新生成题目",
        ) from exc

    if payload.get("scope") != TEST_SESSION_SCOPE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="无效的测试会话",
        )

    questions = payload.get("questions")
    if not isinstance(questions, list) or not questions:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="测试会话内容不完整",
        )

    return questions


@router.get("/generate", response_model=TestGenerateResponse, summary="生成测试题")
async def generate_test_questions():
    questions = generate_test(40)
    session_token = create_test_session_token(questions)
    return TestGenerateResponse(
        session_token=session_token,
        questions=[
            TestQuestion(
                word=q["word"],
                phonetic=q["phonetic"],
                options=q["options"],
            )
            for q in questions
        ],
        total=len(questions),
    )


@router.post("/submit", response_model=TestResult, summary="提交测试结果")
async def submit_test(
    body: TestSubmit,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    question_meta = decode_test_session_token(body.session_token)
    if len(question_meta) != len(body.selected_indexes):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="答题数量与测试题数量不一致",
        )

    questions = []
    answers = []
    for meta, selected_index in zip(question_meta, body.selected_indexes):
        level = meta.get("level")
        correct_index = meta.get("correct_index")
        if not isinstance(level, int) or not isinstance(correct_index, int):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="测试会话内容不合法",
            )
        if not isinstance(selected_index, int) or selected_index < 0 or selected_index > 3:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="提交的选项序号不合法",
            )

        questions.append({"level": level})
        answers.append(selected_index == correct_index)

    vocab_size = estimate_vocabulary(questions, answers)

    # 更新用户词汇量
    user.estimated_vocabulary = vocab_size
    user.test_completed = True

    # 将估算词汇量以下的常见词批量标记为 mastered
    # (实际应基于词频表，这里简化处理)
    await db.commit()

    level_desc = "初学者" if vocab_size <= 2000 else \
                 "初中水平" if vocab_size <= 3000 else \
                 "高中水平" if vocab_size <= 5000 else \
                 "大学四级" if vocab_size <= 6000 else \
                 "大学六级" if vocab_size <= 8000 else \
                 "高级" if vocab_size <= 10000 else "专家"

    return TestResult(estimated_vocabulary=vocab_size, level_description=level_desc)

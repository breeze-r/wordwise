"""
简化版间隔重复算法

阶段间隔（天）: [0, 1, 3, 7, 15, 30, 60, 120]

答题结果影响:
- again: 回退到 stage 0, 当天再次出现
- fuzzy: 维持当前 stage, 短间隔重复
- good:  进入下一 stage
- easy:  跳升 2 个 stage, 进入超长间隔
"""

from datetime import datetime, timedelta
from models import WordStatus, ReviewResult

# 间隔天数表
INTERVALS = [0, 1, 3, 7, 15, 30, 60, 120]
MAX_STAGE = len(INTERVALS) - 1


def calculate_next_review(
    current_stage: int,
    result: ReviewResult,
    consecutive_correct: int,
    error_count: int,
) -> tuple[int, datetime, WordStatus, int, int]:
    """
    Returns: (new_stage, next_review_at, new_status, new_consecutive, new_errors)
    """
    now = datetime.utcnow()

    if result == ReviewResult.again:
        new_stage = 0
        new_consecutive = 0
        new_errors = error_count + 1
        next_review = now + timedelta(minutes=10)  # 10分钟后再次出现
        new_status = WordStatus.learning

    elif result == ReviewResult.fuzzy:
        new_stage = max(0, current_stage - 1)
        new_consecutive = 0
        new_errors = error_count
        interval_days = INTERVALS[new_stage]
        next_review = now + timedelta(days=max(interval_days, 1))
        new_status = WordStatus.learning

    elif result == ReviewResult.good:
        new_stage = min(current_stage + 1, MAX_STAGE)
        new_consecutive = consecutive_correct + 1
        new_errors = error_count
        interval_days = INTERVALS[new_stage]
        next_review = now + timedelta(days=interval_days)
        new_status = WordStatus.learning if new_stage < 4 else WordStatus.mastered

    else:  # easy
        new_stage = min(current_stage + 2, MAX_STAGE)
        new_consecutive = consecutive_correct + 1
        new_errors = error_count
        interval_days = INTERVALS[new_stage]
        next_review = now + timedelta(days=interval_days)
        # 如果连续正确 >= 3 次且 stage >= 5, 判定为长期掌握
        if new_consecutive >= 3 and new_stage >= 5:
            new_status = WordStatus.mastered
        else:
            new_status = WordStatus.learning if new_stage < 4 else WordStatus.mastered

    return new_stage, next_review, new_status, new_consecutive, new_errors


def get_familiarity_score(
    stage: int, consecutive_correct: int, error_count: int
) -> float:
    """计算熟悉度分数 0.0 ~ 1.0"""
    base = stage / MAX_STAGE  # 0 ~ 1
    correct_bonus = min(consecutive_correct * 0.05, 0.2)
    error_penalty = min(error_count * 0.03, 0.3)
    return max(0.0, min(1.0, base + correct_bonus - error_penalty))

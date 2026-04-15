"""
LLM 翻译服务：根据句子语境翻译英文单词（支持自定义 LLM 接口）
"""

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any

import httpx

from collections import defaultdict

from services.local_dictionary import (
    extract_inline_brief,
    lookup_dictionary_entry,
    lookup_dictionary_entries,
    match_senses_to_chinese,
    normalize_detail_meanings,
    validate_chinese_with_dictionary,
)
from settings import get_settings


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TranslatorConfig:
    mode: str
    api_key: str | None
    api_url: str
    model: str


def _resolve_translator_config(overrides: dict[str, str] | None = None) -> TranslatorConfig:
    settings = get_settings()
    mode = settings.translator_mode
    api_key = settings.translator_api_key
    api_url = settings.translator_api_url
    model = settings.translator_model

    if overrides:
        override_mode = str(overrides.get("mode") or "").strip()
        if override_mode in {"local_wordbook", "hybrid", "remote"}:
            mode = override_mode

        override_key = str(overrides.get("api_key") or "").strip()
        if override_key:
            api_key = override_key

        override_url = str(overrides.get("api_url") or "").strip()
        if override_url:
            api_url = override_url

        override_model = str(overrides.get("model") or "").strip()
        if override_model:
            model = override_model

    return TranslatorConfig(
        mode=mode,
        api_key=api_key,
        api_url=api_url,
        model=model,
    )


def _extract_json_payload(text: str) -> Any:
    cleaned = text.strip()
    if "```" in cleaned:
        cleaned = cleaned.split("```")[1]
        if cleaned.startswith("json"):
            cleaned = cleaned[4:]
        cleaned = cleaned.strip()

    # 第一次尝试：直接解析
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # 第二次尝试：修复 LLM 常见的 JSON 引号问题
    # 段落翻译中的中文引号""会破坏 JSON 结构，替换为「」
    import re
    fixed = cleaned
    # 将 JSON value 中的内嵌双引号替换
    # 策略：找到 paragraphs 的值并单独修复
    try:
        # 尝试分段提取 words 部分（最关键的数据）
        words_match = re.search(r'"words"\s*:\s*\{([^}]*)\}', fixed)
        para_match = re.search(r'"paragraphs"\s*:\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}', fixed)
        if words_match:
            words_json = "{" + words_match.group(1) + "}"
            words = json.loads(words_json)
            paragraphs = {}
            if para_match:
                # 段落值可能有引号问题，逐个提取
                para_raw = para_match.group(1)
                for m in re.finditer(r'"(\d+)"\s*:\s*"', para_raw):
                    key = m.group(1)
                    start = m.end()
                    # 找到这个值的结束引号（在下一个 key 或 } 之前）
                    rest = para_raw[start:]
                    # 找最后一个 " 在下一个 ,"数字" 之前
                    next_key = re.search(r'"\s*,\s*"\d+"', rest)
                    if next_key:
                        val = rest[:next_key.start()]
                    else:
                        val = rest.rstrip('" ')
                    paragraphs[key] = val.strip().strip('"')
            result = {"words": words}
            if paragraphs:
                result["paragraphs"] = paragraphs
            logger.info("[translator] JSON repaired via regex extraction")
            return result
    except Exception:
        pass

    # 第三次尝试：暴力修复 — 把中文引号替换后重试
    fixed = re.sub(r'(?<=[\u4e00-\u9fff])"(?=[\u4e00-\u9fff])', '「', fixed)
    fixed = re.sub(r'"(?=[\u4e00-\u9fff，。！？、；：])', '「', fixed)
    fixed = re.sub(r'(?<=[\u4e00-\u9fff，。！？、；：])"', '」', fixed)
    try:
        return json.loads(fixed)
    except json.JSONDecodeError:
        pass

    raise json.JSONDecodeError("All JSON repair attempts failed", cleaned, 0)


async def _chat_completion(
    prompt: str,
    overrides: dict[str, str] | None = None,
    *,
    max_retries: int = 2,
    parse_json: bool = True,
) -> Any:
    config = _resolve_translator_config(overrides)
    if config.mode == "local_wordbook":
        return None
    if not config.api_key or not config.api_url or not config.model:
        logger.warning(
            "[translator] LLM not configured (mode=%s, url=%s, model=%s, key=%s). "
            "Set via .env or popup settings.",
            config.mode,
            config.api_url or "(empty)",
            config.model or "(empty)",
            "set" if config.api_key else "(empty)",
        )
        return None

    logger.info(
        "[translator] LLM request: url=%s model=%s prompt_len=%d",
        config.api_url, config.model, len(prompt),
    )

    resp = None
    last_exc: Exception | None = None
    last_error_detail: str | None = None
    for attempt in range(1 + max_retries):
        try:
            # 绕开系统代理直连 LLM API，避免代理节点不稳定导致超时
            transport = httpx.AsyncHTTPTransport(proxy=None)
            async with httpx.AsyncClient(timeout=30.0, transport=transport) as client:
                resp = await client.post(
                    config.api_url,
                    headers={
                        "Authorization": f"Bearer {config.api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": config.model,
                        "messages": [{"role": "user", "content": prompt}],
                        "max_tokens": 2048,
                        "temperature": 0.1,
                    },
                )
            resp.raise_for_status()
            data = resp.json()
            text = data["choices"][0]["message"]["content"].strip()
            result = _extract_json_payload(text) if parse_json else text
            if attempt > 0:
                logger.info("[translator] LLM succeeded on retry #%d", attempt)
            return result
        except httpx.HTTPStatusError as exc:
            last_exc = exc
            # 提取 API 返回的具体错误信息
            error_body = ""
            if exc.response is not None:
                try:
                    error_body = exc.response.text[:500]
                    error_json = exc.response.json()
                    last_error_detail = error_json.get("error", {}).get("message", "") or error_body
                except Exception:
                    last_error_detail = error_body
            logger.warning(
                "[translator] LLM HTTP %d (attempt %d/%d): %s",
                exc.response.status_code if exc.response is not None else 0,
                attempt + 1, 1 + max_retries, error_body,
            )
            # 4xx 客户端错误（401/403/422等）不重试，直接返回
            if exc.response is not None and 400 <= exc.response.status_code < 500:
                break
            resp = None
            if attempt < max_retries:
                await asyncio.sleep(1.0 * (attempt + 1))
        except Exception as exc:
            last_exc = exc
            last_error_detail = str(exc)
            logger.warning(
                "[translator] LLM error (attempt %d/%d): [%s] %s",
                attempt + 1, 1 + max_retries, type(exc).__name__, exc,
            )
            resp = None
            # 对 5xx / 超时等瞬时错误做退避重试
            if attempt < max_retries:
                await asyncio.sleep(1.0 * (attempt + 1))

    logger.error("[translator] LLM failed after %d attempts: %s", 1 + max_retries, last_exc)
    # 返回错误详情字典而非 None，让上层可以展示具体原因
    if last_error_detail:
        return {"_error": last_error_detail}
    return None


async def summarize_article(
    text: str,
    overrides: dict[str, str] | None = None,
) -> dict | None:
    """使用 LLM 生成结构化文章摘要（中英双语）。"""
    # 截断过长文本，保留核心内容
    truncated = text[:6000]
    if len(text) > 6000:
        truncated += "\n[... article truncated ...]"

    prompt = f"""You are a bilingual reading assistant. Analyze the following article and return a structured summary in JSON format.

Requirements:
- "title_en": a concise English title (max 15 words)
- "title_zh": the same title in Chinese (max 20 chars)
- "overview_en": 1-2 sentence English overview
- "overview_zh": 1-2 sentence Chinese overview
- "sections": array of 3-6 key sections, each with:
  - "heading_en": short English section heading (3-8 words)
  - "heading_zh": Chinese translation of heading
  - "points_en": array of 1-3 bullet points in English (each under 20 words)
  - "points_zh": array of 1-3 bullet points in Chinese (corresponding to points_en)

Keep it concise and insightful. Return ONLY valid JSON, no markdown.

Article:
{truncated}"""

    result = await _chat_completion(prompt, overrides=overrides, parse_json=True)

    # LLM 调用失败，透传错误详情
    if result is None:
        return None
    if isinstance(result, dict) and "_error" in result:
        return result  # 包含 _error 字段，由上层处理

    if not isinstance(result, dict):
        logger.warning("[translator] summarize_article returned non-dict: %s", type(result))
        return None

    # 基础验证
    if "title_en" not in result or "sections" not in result:
        logger.warning("[translator] summarize_article missing required fields")
        return None

    return result


async def _batch_chinese_fallback(
    word_contexts: list[dict], overrides: dict[str, str] | None = None
) -> dict[str, str]:
    """Small LLM call for Chinese translations of words not found in dictionary."""
    if not word_contexts:
        return {}

    lines = []
    for i, wc in enumerate(word_contexts, 1):
        word = str(wc.get("word", "")).strip()
        sentence = str(wc.get("sentence", ""))[:150]
        lines.append(f'{i}. "{word}" — "{sentence}"')

    prompt = f"""你是英语学习助手。下面有一些英文单词和它们所在的句子。
请根据句子语境，给出每个单词在当前句中最贴切的中文翻译。

规则：翻译简短精炼（2-6个字），只返回纯 JSON 对象，key 是小写英文，value 是中文。

单词列表：
{chr(10).join(lines)}"""

    result = await _chat_completion(prompt, overrides=overrides)
    if not isinstance(result, dict):
        return {}
    return {str(k).lower(): str(v).strip() for k, v in result.items() if v}


async def batch_translate(
    word_contexts: list[dict], overrides: dict[str, str] | None = None
) -> dict:
    """
    批量翻译单词（段落优先）。

    核心逻辑：先让 LLM 翻译整段 + 给出每个词的语境中文，
    再用 LLM 的中文去本地词典匹配最合适的释义。

    word_contexts: [{"word": "paradigm", "sentence": "...", "paragraph": "..."}, ...]
    returns: {"_translations": {"paradigm": "范式", ...}, "_llm_ok": True/False}
    """
    if not word_contexts:
        return {"_translations": {}, "_llm_ok": True}

    config = _resolve_translator_config(overrides)

    # ── 本地词典：始终预查，作为兜底 ──
    all_words = [str(wc.get("word", "")).strip().lower() for wc in word_contexts]
    local_entries = lookup_dictionary_entries(all_words)
    local_results: dict[str, str] = {}
    if config.mode != "remote":
        for word, entry in local_entries.items():
            if entry.get("brief"):
                local_results[word] = str(entry["brief"]).strip()

    logger.info(
        "[translator] batch mode=%s total=%d local_fallback=%d",
        config.mode, len(word_contexts), len(local_results),
    )

    if config.mode == "local_wordbook":
        return {"_translations": local_results, "_llm_ok": True}

    # ── 按段落分组 ──
    paragraph_groups: defaultdict[str, list[dict]] = defaultdict(list)
    for wc in word_contexts:
        para = str(wc.get("paragraph") or wc.get("sentence") or "").strip()[:500]
        paragraph_groups[para or ""].append(wc)

    # ── 构建段落优先的 prompt：先翻译整段，再给每个词的语境中文 ──
    prompt_parts = [
        "你是英语学习翻译助手。请先翻译每个段落为通顺的中文，"
        "然后根据段落语境给出每个标记单词在当前上下文中最贴切的中文翻译。",
        "",
    ]

    group_idx = 0
    para_keys: list[str] = []
    for paragraph, wcs in paragraph_groups.items():
        group_idx += 1
        para_keys.append(str(group_idx))
        word_list = ", ".join(str(wc.get("word", "")).strip() for wc in wcs)
        prompt_parts.append(f"--- Paragraph {group_idx} ---")
        prompt_parts.append(f'"{paragraph}"')
        prompt_parts.append(f"Words: {word_list}")
        prompt_parts.append("")

    prompt_parts.append(
        '请只返回 JSON 对象，格式如下：\n'
        '{\n'
        '  "paragraphs": {"1": "第一段的中文翻译", "2": "第二段的中文翻译"},\n'
        '  "words": {"address": "地址", "novel": "新奇的", "bark": "树皮"}\n'
        '}\n\n'
        '规则：\n'
        '- paragraphs: 每段完整通顺的中文翻译，key 是段落编号\n'
        '- words: 每个标记单词在当前语境下最贴切的中文翻译，2-6个字\n'
        '- 同一个词在不同句子里含义不同，必须按当前段落语境翻译\n'
        '- 不要遗漏任何单词\n'
        '- 不要输出 markdown 或解释'
    )

    prompt = "\n".join(prompt_parts)

    result = await _chat_completion(prompt, overrides=overrides)
    if not isinstance(result, dict):
        if config.mode == "remote":
            logger.warning("[translator] LLM paragraph translation failed in remote mode.")
            return {"_translations": {}, "_llm_ok": False}
        logger.info(
            "[translator] LLM unavailable; falling back to %d local entries.",
            len(local_results),
        )
        return {"_translations": local_results, "_llm_ok": False}

    # ── 提取 LLM 结果 ──
    paragraphs_zh = result.get("paragraphs") or {}
    llm_words = result.get("words") or {}
    llm_word_zh = {str(k).lower(): str(v).strip() for k, v in llm_words.items() if v}

    # 拼接全部段落中文，用于词典匹配
    all_para_zh = " ".join(str(v) for v in paragraphs_zh.values() if v)

    logger.info(
        "[translator] LLM returned: paragraphs=%d words=%d",
        len(paragraphs_zh), len(llm_word_zh),
    )

    # ── 用 LLM 的中文 + 段落中文 去词典匹配最佳释义 ──
    validated = validate_chinese_with_dictionary(llm_word_zh, paragraph_zh=all_para_zh)

    logger.info(
        "[translator] dictionary validated: %d / %d words",
        len(validated), len(llm_word_zh),
    )

    # ── 将段落编号映射回段落原文 → 中文翻译 ──
    para_zh_map: dict[str, str] = {}
    for idx_str, zh_text in paragraphs_zh.items():
        idx = int(idx_str) - 1 if str(idx_str).isdigit() else -1
        if 0 <= idx < len(para_keys):
            para_en = list(paragraph_groups.keys())[idx]
            para_zh_map[para_en[:80]] = str(zh_text).strip()

    # 合并：词典验证后的结果 > 本地词典兜底
    final = {**local_results, **validated}
    logger.info(
        "[translator] batch done: total=%d validated=%d local=%d paras=%d",
        len(final), len(validated), len(local_results), len(para_zh_map),
    )
    return {"_translations": final, "_llm_ok": True, "_paragraphs_zh": para_zh_map}


async def _translate_sentence(
    sentence: str, overrides: dict[str, str] | None = None
) -> str | None:
    """轻量级 LLM 调用：只翻译一个句子为中文。"""
    context = sentence.strip()[:300]
    if not context:
        return None
    prompt = f'将以下英文翻译为通顺的中文，只返回翻译结果，不要任何解释：\n\n"{context}"'
    result = await _chat_completion(prompt, overrides=overrides, parse_json=False)
    if isinstance(result, str):
        cleaned = result.strip().strip('"').strip()
        return cleaned if cleaned else None
    return None


async def lookup_word_detail(
    word: str, sentence: str | None = None, overrides: dict[str, str] | None = None
) -> dict[str, Any]:
    """查询单词详情。本地词典提供词义（即时），LLM 只补充句子中文翻译。"""
    clean_word = word.strip().lower()
    if not clean_word:
        return {}

    config = _resolve_translator_config(overrides)
    local_entry = lookup_dictionary_entry(clean_word)

    # 本地词典数据（即时可用）
    detail: dict[str, Any] = {}
    if local_entry:
        normalized_meanings = normalize_detail_meanings(local_entry.get("meanings"))
        detail = {
            "lemma": clean_word,
            "brief": str(local_entry.get("brief") or "").strip(),
            "pos": str(local_entry.get("pos") or "").strip() or None,
            "phonetic": str(local_entry.get("phonetic") or "").strip() or None,
            "phonetic_uk": None,
            "phonetic_us": None,
            "meanings": normalized_meanings,
            "definition_en": local_entry.get("definition_en") or [],
            "sentence_zh": None,
        }
    else:
        detail = {
            "lemma": clean_word, "brief": "", "pos": None, "phonetic": None,
            "phonetic_uk": None, "phonetic_us": None,
            "meanings": [], "definition_en": [], "sentence_zh": None,
        }

    # 如果 LLM 可用且有句子上下文，补充句子中文翻译
    if config.mode != "local_wordbook" and sentence:
        sentence_zh = await _translate_sentence(sentence, overrides=overrides)
        if sentence_zh:
            detail["sentence_zh"] = sentence_zh

    logger.info(
        "[translator] lookup word=%s source=local_dict sentence_zh=%s",
        clean_word, "yes" if detail.get("sentence_zh") else "no",
    )
    return detail

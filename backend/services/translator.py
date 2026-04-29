"""
LLM 翻译服务：根据句子语境翻译英文单词（支持自定义 LLM 接口）
"""

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, AsyncIterator

import httpx

from collections import defaultdict

from services.local_dictionary import (
    extract_inline_brief,
    is_metadata_meaning,
    lookup_dictionary_entry,
    lookup_dictionary_entries,
    normalize_detail_meanings,
)
from settings import get_settings


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TranslatorConfig:
    mode: str
    api_key: str | None
    api_url: str
    model: str


def _normalize_chat_api_url(raw_url: str) -> str:
    value = str(raw_url or "").strip().rstrip("/")
    if not value:
        return ""
    if value.endswith("/chat/completions"):
        return value
    if value.endswith("/v1"):
        return f"{value}/chat/completions"
    return value


def _build_extra_payload(model: str) -> dict:
    """Provider-specific payload extras to fix common gotchas.

    - DeepSeek V4 (and reasoner) default to thinking-mode ON, which emits
      <think>...</think> content and breaks structured/JSON output. Disable
      it explicitly for the use cases in this app (translation + summary).
    """
    m = (model or "").lower()
    extras: dict = {}
    if "deepseek-v4" in m or "deepseek-reasoner" in m or m.endswith("-thinking"):
        extras["thinking"] = {"type": "disabled"}
    return extras


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
        api_url=_normalize_chat_api_url(api_url),
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
    max_retries: int = 1,
    parse_json: bool = True,
    max_tokens: int = 1200,
    timeout_seconds: float = 20.0,
) -> Any:
    config = _resolve_translator_config(overrides)
    if config.mode == "local_wordbook":
        return None
    if not config.api_key or not config.api_url or not config.model:
        missing = []
        if not config.api_key:
            missing.append("API Key")
        if not config.api_url:
            missing.append("API URL")
        if not config.model:
            missing.append("模型名称")
        detail = f"LLM 配置不完整，缺少：{', '.join(missing)}。请在插件弹窗中设置。"
        logger.warning("[translator] %s", detail)
        return {"_error": detail}

    logger.info(
        "[translator] LLM request: url=%s model=%s prompt_len=%d",
        config.api_url, config.model, len(prompt),
    )

    resp = None
    last_exc: Exception | None = None
    last_error_detail: str | None = None
    for attempt in range(1 + max_retries):
        try:
            timeout = httpx.Timeout(timeout_seconds, connect=10.0)
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    config.api_url,
                    headers={
                        "Authorization": f"Bearer {config.api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": config.model,
                        "messages": [{"role": "user", "content": prompt}],
                        "max_tokens": max_tokens,
                        "temperature": 0.1,
                        **_build_extra_payload(config.model),
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
        except (httpx.ConnectTimeout, httpx.ReadTimeout, httpx.ReadError, httpx.ConnectError) as exc:
            # Network-class errors — give a helpful message hinting at proxy/network
            last_exc = exc
            kind = type(exc).__name__
            if isinstance(exc, httpx.ConnectTimeout):
                last_error_detail = "🌐 连接超时（网络/代理不通）。建议换节点或用国内直连的 LLM（DeepSeek/Kimi/智谱）"
            elif isinstance(exc, httpx.ReadTimeout):
                last_error_detail = "🌐 响应超时（连上了没回数据）。代理节点抖动，可重试"
            elif isinstance(exc, httpx.ReadError):
                last_error_detail = "🌐 连接中断（中间被掐）。代理节点不稳"
            else:
                last_error_detail = f"🌐 网络错误：{exc}"
            logger.warning(
                "[translator] LLM network error (attempt %d/%d): [%s] %s",
                attempt + 1, 1 + max_retries, kind, exc,
            )
            resp = None
            if attempt < max_retries:
                await asyncio.sleep(1.0 * (attempt + 1))
        except Exception as exc:
            last_exc = exc
            last_error_detail = f"{type(exc).__name__}: {exc}"
            logger.warning(
                "[translator] LLM error (attempt %d/%d): [%s] %s",
                attempt + 1, 1 + max_retries, type(exc).__name__, exc,
            )
            resp = None
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
    # Keep in sync with summarize_article_stream — trim to 3500 for lower TTFT.
    truncated = text[:3500]
    if len(text) > 3500:
        truncated += "\n[... truncated ...]"

    prompt = f"""You are a bilingual reading assistant. Analyze the following article and return a structured summary in JSON format.

Requirements:
- "title_en": a concise English title (max 15 words)
- "title_zh": the same title in Chinese (max 20 chars)
- "overview_en": 1-2 sentence English overview
- "overview_zh": 1-2 sentence Chinese overview
- "sections": array of 4-6 key sections, each with:
  - "heading_en": short English section heading (3-8 words)
  - "heading_zh": Chinese translation of heading
  - "points_en": array of 1-3 bullet points in English (each under 20 words)
  - "points_zh": array of 1-3 bullet points in Chinese (corresponding to points_en)

Keep it concise and insightful. Return ONLY valid JSON, no markdown.

Article:
{truncated}"""

    result = await _chat_completion(
        prompt,
        overrides=overrides,
        parse_json=True,
        max_retries=0,
        max_tokens=1200,
        timeout_seconds=60.0,
    )

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


# ── Streaming summary (NDJSON over SSE) ──────────────────────────────

_SUMMARY_NDJSON_PROMPT = r"""You are a bilingual reading assistant. Stream a structured summary as NDJSON: one complete JSON object per line, no array, no markdown, no commentary.

Match the depth of your summary to the content. {depth_hint}

Order:
1. {{"type":"meta","title_en":"<={title_words} words","title_zh":"<={title_zh_chars} chars","overview_en":"{overview_sents}","overview_zh":"{overview_sents}"}}
2. Then {section_range} section objects:
{{"type":"section","heading_en":"3-7 words","heading_zh":"...","points_en":["...","..."],"points_zh":["...","..."]}}

Rules:
- Each line MUST be one complete, parseable JSON object.
- No literal or escaped newlines inside strings — use spaces.
- {points_per_section} substantive points per section (each <={point_words} words).
- Cover the article comprehensively — do NOT oversimplify rich content.
- For papers/financial reports, surface concrete numbers, methods, findings, conclusions.

Math notation (CRITICAL for academic / quantitative content):
- ALWAYS write equations and mathematical expressions in LaTeX, NOT plain text.
- Use $...$ for inline math and $$...$$ for display math.
- Examples: write $E = mc^2$ NOT "E = mc^2"; write $\sigma^2$ NOT "sigma squared";
  write $\sum_{{i=1}}^n x_i$ NOT "sum from i=1 to n of x_i".
- Greek letters, subscripts, superscripts, integrals, fractions, matrices —
  all of these MUST be in LaTeX form so they render natively.
- Inside JSON strings, backslashes must be escaped: write "\\sigma" not "\sigma",
  "$\\frac{{a}}{{b}}$" not "$\frac{{a}}{{b}}$".
- For non-math content (regular sentences), do NOT use LaTeX — only wrap actual
  math expressions.

Output ONLY the NDJSON lines.

Article:
{article}"""


def _summary_depth_profile(text_len: int) -> dict:
    """Choose summary depth based on content length.

    Returns the parameters used to render the prompt and to set max_tokens.
    The thresholds are tuned for: short web articles, typical news/blogs,
    long-form essays, and full academic papers / financial reports.
    """
    if text_len < 1500:
        # Short blog post or news brief — keep it tight
        return {
            "depth_hint": "Content is short, so be concise but complete.",
            "title_words": 12, "title_zh_chars": 16,
            "overview_sents": "1-2 sentences",
            "section_range": "3-4",
            "points_per_section": "1-2",
            "point_words": 18,
            "input_cap": 1800,
            "max_tokens": 800,
        }
    if text_len < 5000:
        return {
            "depth_hint": "Content is medium length — give a balanced overview.",
            "title_words": 14, "title_zh_chars": 18,
            "overview_sents": "2-3 sentences",
            "section_range": "4-6",
            "points_per_section": "2-3",
            "point_words": 25,
            "input_cap": 5500,
            "max_tokens": 1600,
        }
    if text_len < 12000:
        return {
            "depth_hint": "Content is long — go deep enough to capture the substance.",
            "title_words": 15, "title_zh_chars": 22,
            "overview_sents": "2-4 sentences",
            "section_range": "6-8",
            "points_per_section": "2-3",
            "point_words": 30,
            "input_cap": 12000,
            "max_tokens": 2400,
        }
    # Full papers / financial reports / long technical docs
    return {
        "depth_hint": "Content is dense and rich — produce a thorough briefing with concrete details.",
        "title_words": 16, "title_zh_chars": 24,
        "overview_sents": "3-5 sentences",
        "section_range": "8-10",
        "points_per_section": "3-4",
        "point_words": 38,
        "input_cap": 18000,
        "max_tokens": 3500,
    }


async def summarize_article_stream(
    text: str,
    overrides: dict[str, str] | None = None,
) -> AsyncIterator[dict]:
    """流式生成文章摘要：边解析 LLM 输出边逐行 yield 事件。

    yields events of shape {"type": "meta"|"section"|"done"|"error", "data": {...}}
    """
    # Pick depth profile based on full content length, then truncate to its cap.
    profile = _summary_depth_profile(len(text))
    cap = profile["input_cap"]
    truncated = text[:cap]
    if len(text) > cap:
        truncated += "\n[... truncated ...]"

    prompt = _SUMMARY_NDJSON_PROMPT.format(
        article=truncated,
        depth_hint=profile["depth_hint"],
        title_words=profile["title_words"],
        title_zh_chars=profile["title_zh_chars"],
        overview_sents=profile["overview_sents"],
        section_range=profile["section_range"],
        points_per_section=profile["points_per_section"],
        point_words=profile["point_words"],
    )
    logger.info(
        "[translator] summary depth: text_len=%d cap=%d sections=%s max_tokens=%d",
        len(text), cap, profile["section_range"], profile["max_tokens"],
    )

    config = _resolve_translator_config(overrides)
    if not config.api_key or not config.api_url or not config.model:
        missing = []
        if not config.api_key:
            missing.append("API Key")
        if not config.api_url:
            missing.append("API URL")
        if not config.model:
            missing.append("模型名称")
        yield {"type": "error", "data": {"message": f"LLM 配置不完整，缺少：{', '.join(missing)}。请在插件弹窗中设置。"}}
        return

    logger.info(
        "[translator] LLM stream request: url=%s model=%s prompt_len=%d",
        config.api_url, config.model, len(prompt),
    )

    payload = {
        "model": config.model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": profile["max_tokens"],
        "temperature": 0.2,
        "stream": True,
        **_build_extra_payload(config.model),
    }
    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }

    import time
    # Scale timeout with max_tokens — deep summaries can take 60-90s end to end.
    # Read timeout is per-chunk (between bytes) — generous since SSE may pause briefly.
    read_timeout = 60.0 if profile["max_tokens"] >= 2400 else 45.0
    timeout = httpx.Timeout(read_timeout, connect=10.0)
    NETWORK_ERRORS = (
        httpx.ConnectTimeout, httpx.ReadTimeout, httpx.ReadError,
        httpx.ConnectError, httpx.RemoteProtocolError,
    )
    MAX_ATTEMPTS = 3  # only retried while NOTHING has been yielded yet

    output_buffer = ""
    emitted_any = False
    t_start = time.monotonic()

    for attempt in range(MAX_ATTEMPTS):
        emitted_in_attempt = False
        attempt_start = time.monotonic()
        t_first_byte = None
        t_first_event = None
        output_buffer = ""

        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream("POST", config.api_url, headers=headers, json=payload) as resp:
                    if resp.status_code >= 400:
                        body = (await resp.aread()).decode("utf-8", errors="replace")[:500]
                        logger.warning("[translator] LLM stream HTTP %d: %s", resp.status_code, body)
                        detail = body
                        try:
                            err_json = json.loads(body)
                            detail = err_json.get("error", {}).get("message", body) or body
                        except Exception:
                            pass
                        # 4xx / 5xx — don't retry, surface immediately
                        yield {"type": "error", "data": {"message": f"LLM HTTP {resp.status_code}: {detail}"}}
                        return

                    async for raw_line in resp.aiter_lines():
                        if t_first_byte is None:
                            t_first_byte = time.monotonic() - attempt_start
                            logger.info("[translator] LLM stream first byte: %.2fs (attempt %d)", t_first_byte, attempt + 1)
                        if not raw_line:
                            continue
                        if not raw_line.startswith("data:"):
                            continue
                        data_str = raw_line[5:].strip()
                        if not data_str or data_str == "[DONE]":
                            if data_str == "[DONE]":
                                break
                            continue
                        try:
                            chunk = json.loads(data_str)
                        except json.JSONDecodeError:
                            continue
                        try:
                            delta = chunk["choices"][0].get("delta", {}).get("content") or ""
                        except (KeyError, IndexError, TypeError):
                            delta = ""
                        if not delta:
                            continue
                        output_buffer += delta
                        while "\n" in output_buffer:
                            nl = output_buffer.index("\n")
                            line = output_buffer[:nl].strip()
                            output_buffer = output_buffer[nl + 1:]
                            evt = _parse_summary_line(line)
                            if evt is not None:
                                if t_first_event is None:
                                    t_first_event = time.monotonic() - attempt_start
                                    logger.info(
                                        "[translator] LLM stream first event: %.2fs (type=%s, attempt %d)",
                                        t_first_event, evt.get("type"), attempt + 1,
                                    )
                                emitted_any = True
                                emitted_in_attempt = True
                                yield evt
            # Stream finished cleanly — exit retry loop
            break

        except NETWORK_ERRORS as exc:
            kind = type(exc).__name__
            elapsed = time.monotonic() - attempt_start
            if emitted_in_attempt:
                # Already yielded events — can't safely retry without dup events.
                logger.warning(
                    "[translator] LLM stream interrupted mid-stream after %.2fs (attempt %d): [%s] %s",
                    elapsed, attempt + 1, kind, exc,
                )
                yield {"type": "error", "data": {"message": f"🌐 流式连接被中断（已生成部分内容）：{exc}。代理节点不稳，可重试或换 API 提供商。"}}
                return

            if attempt < MAX_ATTEMPTS - 1:
                backoff = 0.6 * (attempt + 1)
                logger.warning(
                    "[translator] LLM stream connect failed (attempt %d/%d, %.2fs) — retry in %.1fs: [%s] %s",
                    attempt + 1, MAX_ATTEMPTS, elapsed, backoff, kind, exc,
                )
                await asyncio.sleep(backoff)
                continue

            # All retries exhausted
            logger.warning(
                "[translator] LLM stream gave up after %d attempts: [%s] %s",
                MAX_ATTEMPTS, kind, exc,
            )
            if isinstance(exc, httpx.ConnectTimeout):
                msg = f"🌐 连不上 LLM 服务器（已重试 {MAX_ATTEMPTS} 次仍超时）。代理节点路由不稳，建议换节点或换国内 LLM（DeepSeek/Kimi/智谱）。"
            elif isinstance(exc, httpx.ReadTimeout):
                msg = f"🌐 LLM 响应超时（已重试 {MAX_ATTEMPTS} 次）。模型负载高或代理抖动，稍后再试或换更快的模型。"
            elif isinstance(exc, (httpx.ReadError, httpx.RemoteProtocolError)):
                msg = f"🌐 连接被中间设备掐断（已重试 {MAX_ATTEMPTS} 次）。代理节点不可靠，强烈建议换国内直连 LLM。"
            else:
                msg = f"🌐 网络错误（已重试 {MAX_ATTEMPTS} 次）：{exc}"
            yield {"type": "error", "data": {"message": msg}}
            return

        except Exception as exc:
            logger.exception("[translator] LLM stream unexpected error: %s", exc)
            yield {"type": "error", "data": {"message": f"⚠️ LLM 流式请求失败：{type(exc).__name__}: {exc}"}}
            return

    # Flush trailing buffer
    tail = output_buffer.strip()
    if tail:
        evt = _parse_summary_line(tail)
        if evt is not None:
            emitted_any = True
            yield evt

    if not emitted_any:
        yield {"type": "error", "data": {"message": "LLM 未返回可解析的摘要内容"}}
        return

    total = time.monotonic() - t_start
    logger.info(
        "[translator] LLM stream done: total=%.2fs first_byte=%.2fs first_event=%.2fs",
        total, t_first_byte or -1, t_first_event or -1,
    )
    yield {"type": "done", "data": {}}


def _parse_summary_line(line: str) -> dict | None:
    """Parse one NDJSON line from the LLM and convert it into a stream event.

    Tolerates ```json fences and stray prefixes the model occasionally emits.
    Returns None if the line is not a usable summary object.
    """
    s = line.strip()
    if not s:
        return None
    # Strip code fences
    if s.startswith("```"):
        return None
    # Some models prefix lines with bullets — strip
    if s[0] in "-*•":
        s = s.lstrip("-*• ").strip()
    if not s.startswith("{"):
        return None
    try:
        obj = json.loads(s)
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None
    obj_type = obj.pop("type", None)
    if obj_type == "meta":
        return {"type": "meta", "data": obj}
    if obj_type == "section":
        return {"type": "section", "data": obj}
    return None


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
    if not isinstance(result, dict) or "_error" in result:
        return {}
    return {str(k).lower(): str(v).strip() for k, v in result.items() if v}


def _pick_dictionary_meaning(entry: dict[str, Any], translated_context: str) -> str:
    candidates = normalize_detail_meanings(
        [entry.get("brief"), *(entry.get("meanings") or [])],
        limit=8,
    )
    filtered = [
        item for item in candidates
        if item and not is_metadata_meaning(item)
    ]

    context = translated_context or ""
    scored: list[tuple[int, int, str]] = []
    for item in filtered:
        if item == context:
            scored.append((100, -len(item), item))
        elif item and item in context:
            scored.append((80, -len(item), item))
        elif context and context in item and len(item) <= len(context) + 3:
            scored.append((50, -len(item), item))

    if scored:
        scored.sort(reverse=True)
        return scored[0][2][:20]

    return (extract_inline_brief(entry.get("brief"), entry.get("meanings")) or "")[:20]


async def batch_translate(
    word_contexts: list[dict], overrides: dict[str, str] | None = None
) -> dict:
    """
    批量翻译单词（段落优先）。

    hybrid 模式：LLM 先翻译段落，本地词典再根据中文段落匹配词义。
    remote 模式：LLM 同时返回段落和词义。

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

    # ── 构建段落优先的 prompt ──
    prompt_parts = [
        "你是英语学习翻译助手。请把下面每个英文段落翻译成通顺、准确的中文。",
        "",
    ]

    para_keys: list[str] = []
    for paragraph, wcs in paragraph_groups.items():
        para_keys.append(paragraph)
        group_idx = len(para_keys)
        word_list = ", ".join(str(wc.get("word", "")).strip() for wc in wcs)
        prompt_parts.append(f"--- Paragraph {group_idx} ---")
        prompt_parts.append(f'"{paragraph}"')
        if config.mode == "remote":
            prompt_parts.append(f"Words needing short Chinese meanings: {word_list}")
        else:
            prompt_parts.append(f"Focus words for later dictionary matching: {word_list}")
        prompt_parts.append("")

    if config.mode == "remote":
        prompt_parts.append(
            '请只返回 JSON 对象，格式如下：\n'
            '{\n'
            '  "paragraphs": {"1": "第一段的中文翻译", "2": "第二段的中文翻译"},\n'
            '  "words": {"address": "地址", "novel": "新奇的", "bark": "树皮"}\n'
            '}\n\n'
            '规则：\n'
            '- paragraphs: 每段完整通顺的中文翻译，key 是段落编号\n'
            '- words: 每个标记单词在当前语境下最贴切的中文翻译，2-6个字\n'
            '- 不要输出 markdown 或解释'
        )
    else:
        prompt_parts.append(
            '请只返回 JSON 对象，格式如下：\n'
            '{"paragraphs": {"1": "第一段的中文翻译", "2": "第二段的中文翻译"}}\n\n'
            '规则：\n'
            '- paragraphs: 每段完整通顺的中文翻译，key 是段落编号\n'
            '- 不要单独输出 words\n'
            '- 不要输出 markdown 或解释'
        )

    prompt = "\n".join(prompt_parts)

    result = await _chat_completion(prompt, overrides=overrides)
    # Treat error dicts (from failed LLM calls) and non-dict results as failures
    llm_failed = not isinstance(result, dict) or "_error" in result
    if llm_failed:
        err_detail = result.get("_error") if isinstance(result, dict) else None
        if config.mode == "remote":
            logger.warning(
                "[translator] LLM paragraph translation failed in remote mode: %s",
                err_detail or "unknown",
            )
            return {"_translations": {}, "_llm_ok": False, "_error": err_detail}
        logger.info(
            "[translator] LLM unavailable (%s); falling back to %d local entries.",
            err_detail or "unknown", len(local_results),
        )
        return {"_translations": local_results, "_llm_ok": False, "_error": err_detail}

    # ── 提取 LLM 结果 ──
    paragraphs_zh = result.get("paragraphs") or {}
    llm_words = result.get("words") or {}
    llm_word_zh = {str(k).lower(): str(v).strip() for k, v in llm_words.items() if v}

    logger.info(
        "[translator] LLM returned: paragraphs=%d words=%d",
        len(paragraphs_zh), len(llm_word_zh),
    )

    # ── 将段落编号映射回段落原文 → 中文翻译 ──
    para_zh_map: dict[str, str] = {}
    for idx_str, zh_text in paragraphs_zh.items():
        idx = int(idx_str) - 1 if str(idx_str).isdigit() else -1
        if 0 <= idx < len(para_keys):
            para_en = para_keys[idx]
            para_zh_map[para_en] = str(zh_text).strip()

    if config.mode == "remote":
        final = llm_word_zh
    else:
        final = {}
        missing_local: list[dict] = []
        for wc in word_contexts:
            word = str(wc.get("word", "")).strip().lower()
            paragraph = str(wc.get("paragraph") or wc.get("sentence") or "").strip()[:500]
            translated_context = para_zh_map.get(paragraph, "")
            entry = local_entries.get(word)
            if entry:
                meaning = _pick_dictionary_meaning(entry, translated_context)
                if meaning:
                    final[word] = meaning
            else:
                missing_local.append(wc)

        if missing_local:
            final.update(await _batch_chinese_fallback(missing_local, overrides=overrides))

        final = {**local_results, **final}

    logger.info(
        "[translator] batch done: total=%d local=%d paras=%d",
        len(final), len(local_results), len(para_zh_map),
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
    result = await _chat_completion(
        prompt,
        overrides=overrides,
        parse_json=False,
        max_retries=0,
        max_tokens=500,
        timeout_seconds=12.0,
    )
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

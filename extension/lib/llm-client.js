// Direct LLM client — replaces backend translator.py.
// Runs in the service worker, calls user's chosen LLM API directly.
//
// Mainland-direct providers (DeepSeek/Kimi/GLM/Qwen) are reached without
// any proxy bypass logic since the browser already has direct connectivity.

const DIRECT_LLM_HOSTS = new Set([
  "api.deepseek.com",
  "api.moonshot.cn",
  "open.bigmodel.cn",
  "dashscope.aliyuncs.com",
  "api.siliconflow.cn",
  "ark.cn-beijing.volces.com",
  "api.minimax.chat",
]);

/** Models where we should disable thinking-mode to avoid <think> token waste. */
function _buildExtraPayload(model) {
  const m = String(model || "").toLowerCase();
  const extras = {};
  if (m.includes("deepseek-v4") || m.includes("deepseek-reasoner") || m.endsWith("-thinking")) {
    extras.thinking = { type: "disabled" };
  }
  return extras;
}

function _missingFields(config) {
  const missing = [];
  if (!config?.apiKey) missing.push("API Key");
  if (!config?.apiUrl) missing.push("API URL");
  if (!config?.model) missing.push("模型名称");
  return missing;
}

/**
 * Non-streaming chat completion. Returns:
 *   { text } on success (raw model output)
 *   { json } if parse_json was true and response was valid JSON
 *   { error } on failure
 */
async function chatCompletion(config, prompt, opts = {}) {
  const {
    parseJson = false,
    maxRetries = 1,
    maxTokens = 1200,
    timeoutSeconds = 30,
    temperature = 0.1,
  } = opts;

  if (config?.mode === "local_wordbook") {
    return { error: "local_wordbook mode — no LLM call" };
  }

  const missing = _missingFields(config);
  if (missing.length) {
    return { error: `LLM 配置不完整，缺少：${missing.join(", ")}` };
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutSeconds * 1000);
    try {
      const res = await fetch(config.apiUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
          temperature,
          ..._buildExtraPayload(config.model),
        }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) {
        const body = (await res.text()).slice(0, 500);
        // 4xx — don't retry
        if (res.status >= 400 && res.status < 500) {
          let detail = body;
          try {
            const j = JSON.parse(body);
            detail = j?.error?.message || body;
          } catch { /* noop */ }
          return { error: `LLM HTTP ${res.status}: ${detail}` };
        }
        lastErr = `HTTP ${res.status}: ${body}`;
        continue;
      }
      const data = await res.json();
      const text = (data?.choices?.[0]?.message?.content || "").trim();
      if (parseJson) {
        const parsed = _tryParseJson(text);
        if (parsed != null) return { json: parsed, raw: text };
        return { error: "LLM 返回的不是合法 JSON", raw: text };
      }
      return { text };
    } catch (err) {
      clearTimeout(t);
      if (err.name === "AbortError") {
        lastErr = "请求超时";
      } else {
        lastErr = `${err.name}: ${err.message}`;
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
  }
  return { error: `🌐 网络错误（已重试 ${maxRetries + 1} 次）：${lastErr || "未知"}` };
}

/**
 * Streaming chat completion via SSE. Returns an async iterator yielding
 *   { delta }    — incremental text from the model
 *   { error }    — fatal error
 *   { done }     — clean end
 */
async function* chatCompletionStream(config, prompt, opts = {}) {
  const {
    maxTokens = 1500,
    timeoutSeconds = 60,
    temperature = 0.2,
  } = opts;

  const missing = _missingFields(config);
  if (missing.length) {
    yield { error: `LLM 配置不完整，缺少：${missing.join(", ")}` };
    return;
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutSeconds * 1000);

  try {
    const res = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature,
        stream: true,
        ..._buildExtraPayload(config.model),
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      let detail = body;
      try {
        const j = JSON.parse(body);
        detail = j?.error?.message || body;
      } catch { /* noop */ }
      yield { error: `LLM HTTP ${res.status}: ${detail}` };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames separated by blank line; each line starts with "data: "
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          yield { done: true };
          return;
        }
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk?.choices?.[0]?.delta?.content || "";
          if (delta) yield { delta };
        } catch { /* skip malformed line */ }
      }
    }
    yield { done: true };
  } catch (err) {
    if (err.name === "AbortError") {
      yield { error: "🌐 LLM 请求超时" };
    } else {
      yield { error: `⚠️ LLM 请求失败: ${err.name}: ${err.message}` };
    }
  } finally {
    clearTimeout(t);
  }
}

function _tryParseJson(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  }
  try {
    return JSON.parse(cleaned);
  } catch { return null; }
}

self.llmClient = { chatCompletion, chatCompletionStream };

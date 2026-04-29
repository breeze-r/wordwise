const DEFAULT_API_BASE = "http://localhost:8000";
const DEFAULT_TRANSLATOR_CONFIG = {
  mode: "hybrid",
  apiKey: "",
  apiUrl: "",
  model: "",
};

// === API Base URL (configurable) ===
async function getApiBase() {
  const { apiBase } = await chrome.storage.local.get("apiBase");
  return (apiBase && apiBase.trim()) || DEFAULT_API_BASE;
}

async function setApiBase(url) {
  const trimmed = (url || "").trim().replace(/\/+$/, "");
  await chrome.storage.local.set({ apiBase: trimmed || DEFAULT_API_BASE });
  return trimmed || DEFAULT_API_BASE;
}

// === Storage helpers ===
async function getEnabled() {
  const { enabled } = await chrome.storage.local.get("enabled");
  return enabled !== false; // default true
}

function normalizeTranslatorConfig(raw = {}) {
  const mode = typeof raw.mode === "string" ? raw.mode.trim() : "";
  const normalizedMode = ["local_wordbook", "hybrid", "remote"].includes(mode)
    ? mode
    : DEFAULT_TRANSLATOR_CONFIG.mode;

  return {
    mode: normalizedMode,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() : "",
    apiUrl:
      typeof raw.apiUrl === "string" && raw.apiUrl.trim()
        ? raw.apiUrl.trim()
        : DEFAULT_TRANSLATOR_CONFIG.apiUrl,
    model:
      typeof raw.model === "string" && raw.model.trim()
        ? raw.model.trim()
        : DEFAULT_TRANSLATOR_CONFIG.model,
  };
}

async function getTranslatorConfig() {
  const { translatorConfig } = await chrome.storage.local.get("translatorConfig");
  return normalizeTranslatorConfig(translatorConfig);
}

async function setTranslatorConfig(config) {
  const normalized = normalizeTranslatorConfig(config);
  await chrome.storage.local.set({ translatorConfig: normalized });
  return normalized;
}

// Migrate stale local_wordbook default to hybrid on extension update
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install" || details.reason === "update") {
    const { translatorConfig } = await chrome.storage.local.get("translatorConfig");
    if (!translatorConfig || translatorConfig.mode === "local_wordbook") {
      const upgraded = normalizeTranslatorConfig({
        ...(translatorConfig || {}),
        mode: "hybrid",
      });
      await chrome.storage.local.set({ translatorConfig: upgraded });
      /* upgraded to hybrid */
    }
  }
});

// === API helpers ===
async function apiRequest(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (path.startsWith("/api/reading/")) {
    const translatorConfig = await getTranslatorConfig();
    headers["X-WordWise-Translator-Mode"] = translatorConfig.mode;
    headers["X-WordWise-Translator-Api-Url"] = translatorConfig.apiUrl;
    headers["X-WordWise-Translator-Model"] = translatorConfig.model;
    if (translatorConfig.apiKey) {
      headers["X-WordWise-Translator-Key"] = translatorConfig.apiKey;
    }
  }

  const apiBase = await getApiBase();
  const controller = new AbortController();
  const timeoutMs = path === "/api/reading/summarize" ? 90000 : 45000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${apiBase}${path}`, { ...options, headers, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`请求超时：${Math.round(timeoutMs / 1000)} 秒内没有收到后端响应`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    const error = new Error(`API ${res.status}: ${text}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

// === Offscreen Document for PDF.js =================================
// PDF.js v4 only ships ESM, which classic content scripts can't import.
// Workaround: spawn a hidden offscreen document that loads PDF.js as a
// module, and forward extraction requests through it.
const OFFSCREEN_PATH = "offscreen.html";

async function ensureOffscreenDocument() {
  // Already created?
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["DOM_PARSER"],
    justification: "Run PDF.js to extract text from PDFs for translation/summary.",
  });
}

function arrayBufferToBase64(buffer) {
  // Chunked to avoid call-stack overflow on large buffers
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function extractPdfText(arrayBuffer) {
  await ensureOffscreenDocument();
  // Pass as base64 — far more compact than a JSON number array,
  // avoids ArrayBuffer transfer quirks in MV3 messaging.
  const bytesBase64 = arrayBufferToBase64(arrayBuffer);
  const result = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "extract_pdf_text",
    bytesBase64,
  });
  return result;
}

// === Message handler from content script / popup ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages destined for the offscreen doc are not for us
  if (msg && msg.target === "offscreen") return false;
  // The offscreen doc announces readiness — silently ignore
  if (msg && msg.type === "offscreen_ready") return false;

  handleMessage(msg, sender).then(sendResponse).catch((err) => {
    sendResponse({ error: err?.message || String(err) });
  });
  return true; // async response
});

// === Port-based streaming: SSE summary ===
// Content script opens chrome.runtime.connect({name:"ww-summarize"}) and posts
// {text, pageUrl}. We fetch the SSE endpoint and forward each parsed event back
// over the port: {type:"meta"|"section"|"done"|"error", data:{...}}.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ww-summarize") return;

  let aborter = null;
  let closed = false;

  const safePost = (msg) => {
    if (closed) return;
    try { port.postMessage(msg); } catch { /* port already gone */ }
  };

  port.onDisconnect.addListener(() => {
    closed = true;
    if (aborter) {
      try { aborter.abort(); } catch { /* noop */ }
    }
  });

  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== "start") return;
    if (aborter) return; // already running
    aborter = new AbortController();

    try {
      const apiBase = await getApiBase();
      const translatorConfig = await getTranslatorConfig();
      const headers = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "X-WordWise-Translator-Mode": translatorConfig.mode,
        "X-WordWise-Translator-Api-Url": translatorConfig.apiUrl,
        "X-WordWise-Translator-Model": translatorConfig.model,
      };
      if (translatorConfig.apiKey) {
        headers["X-WordWise-Translator-Key"] = translatorConfig.apiKey;
      }

      const res = await fetch(`${apiBase}/api/reading/summarize/stream`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: msg.text, page_url: msg.pageUrl }),
        signal: aborter.signal,
      });

      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        safePost({ type: "error", data: { message: `API ${res.status}: ${body}` } });
        try { port.disconnect(); } catch { /* noop */ }
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line ("\n\n").
        let sep;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          // Each frame may have multiple "data:" lines; concatenate them.
          const dataLines = [];
          for (const rawLine of frame.split("\n")) {
            if (rawLine.startsWith("data:")) {
              dataLines.push(rawLine.slice(5).trimStart());
            }
          }
          if (!dataLines.length) continue;
          const payload = dataLines.join("\n");
          try {
            safePost(JSON.parse(payload));
          } catch {
            // ignore malformed frame
          }
        }
      }
    } catch (err) {
      if (err?.name !== "AbortError") {
        safePost({ type: "error", data: { message: err?.message || String(err) } });
      }
    } finally {
      try { port.disconnect(); } catch { /* noop */ }
    }
  });
});

async function handleMessage(msg) {
  switch (msg.type) {
    case "get_user": {
      return await apiRequest("/api/auth/me");
    }

    // --- Toggle ---
    case "get_enabled": {
      return { enabled: await getEnabled() };
    }

    case "set_enabled": {
      await chrome.storage.local.set({ enabled: msg.enabled });
      return { ok: true };
    }

    case "get_api_base": {
      return { apiBase: await getApiBase() };
    }

    case "set_api_base": {
      const saved = await setApiBase(msg.apiBase);
      return { apiBase: saved };
    }

    case "get_translator_config": {
      return await getTranslatorConfig();
    }

    case "set_translator_config": {
      return await setTranslatorConfig(msg.config || {});
    }

    // --- Vocabulary ---
    case "check_words": {
      return await apiRequest("/api/vocabulary/check", {
        method: "POST",
        body: JSON.stringify({ words: msg.words }),
      });
    }

    case "encounter_word": {
      return await apiRequest("/api/vocabulary/encounter", {
        method: "POST",
        body: JSON.stringify(msg.word),
      });
    }

    case "encounter_batch": {
      return await apiRequest("/api/vocabulary/encounter/batch", {
        method: "POST",
        body: JSON.stringify({ words: msg.words }),
      });
    }

    case "update_word_status": {
      return await apiRequest("/api/vocabulary/status", {
        method: "PUT",
        body: JSON.stringify({ lemma: msg.lemma, new_status: msg.status }),
      });
    }

    case "get_stats": {
      return await apiRequest("/api/vocabulary/stats");
    }

    // --- Vocabulary test ---
    case "generate_test": {
      return await apiRequest("/api/test/generate");
    }

    case "submit_test": {
      return await apiRequest("/api/test/submit", {
        method: "POST",
        body: JSON.stringify({
          session_token: msg.sessionToken,
          selected_indexes: msg.selectedIndexes,
        }),
      });
    }

    // --- LLM status ---
    case "set_llm_status": {
      await chrome.storage.local.set({ llmOk: !!msg.ok });
      return { ok: true };
    }
    case "get_llm_status": {
      const { llmOk, llmError } = await chrome.storage.local.get(["llmOk", "llmError"]);
      // Return actual stored value; undefined means "never tested"
      return { ok: llmOk === true, known: typeof llmOk === "boolean", error: llmError || "" };
    }

    // --- Reading scan (combined filter + translate) ---
    case "scan_page": {
      const scanResult = await apiRequest("/api/reading/scan", {
        method: "POST",
        body: JSON.stringify({
          words: msg.words,
          page_url: msg.page_url,
          page_session_id: msg.pageSessionId,
        }),
      });
      // 持久化 LLM 状态
      if (scanResult && typeof scanResult.llm_ok === "boolean") {
        await chrome.storage.local.set({
          llmOk: scanResult.llm_ok,
          llmError: scanResult.llm_error || "",
        });
      }
      return scanResult;
    }

    case "lookup_word": {
      return await apiRequest("/api/reading/lookup", {
        method: "POST",
        body: JSON.stringify({
          word: msg.word,
          sentence: msg.sentence,
          page_url: msg.pageUrl,
          trigger_cycle: !!msg.triggerCycle,
        }),
      });
    }

    case "summarize_article": {
      return await apiRequest("/api/reading/summarize", {
        method: "POST",
        body: JSON.stringify({
          text: msg.text,
          page_url: msg.pageUrl,
        }),
      });
    }

    case "extract_pdf_text": {
      // Content script asks us to fetch+parse the PDF at msg.url.
      // We do the fetch here (not in content script) so cross-origin
      // PDFs and CSP-restricted pages don't block us.
      try {
        const r = await fetch(msg.url, { credentials: "include" });
        if (!r.ok) {
          return { ok: false, error: `下载 PDF 失败: HTTP ${r.status}` };
        }
        const buffer = await r.arrayBuffer();
        const result = await extractPdfText(buffer);
        return result;
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    }

    // --- Dict Packs ---
    case "get_dict_packs": {
      return await apiRequest("/api/dict-packs/");
    }

    case "get_enabled_packs": {
      const { enabledPacks } = await chrome.storage.local.get("enabledPacks");
      return enabledPacks || [];
    }

    case "set_enabled_packs": {
      const packs = Array.isArray(msg.packs) ? msg.packs : [];
      await chrome.storage.local.set({ enabledPacks: packs });
      return { ok: true, packs };
    }

    // --- Vocab Level ---
    case "get_vocab_levels": {
      return await apiRequest("/api/auth/vocab-levels");
    }

    case "set_vocab_level": {
      return await apiRequest("/api/auth/vocab-level", {
        method: "PUT",
        body: JSON.stringify({ level: msg.level }),
      });
    }

    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

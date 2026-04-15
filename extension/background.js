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
  const res = await fetch(`${apiBase}${path}`, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    const error = new Error(`API ${res.status}: ${text}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

// === Message handler from content script / popup ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch((err) => {
    sendResponse({ error: err.message });
  });
  return true; // async response
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
      const { llmOk } = await chrome.storage.local.get("llmOk");
      return { ok: llmOk !== false };
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
        await chrome.storage.local.set({ llmOk: scanResult.llm_ok });
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

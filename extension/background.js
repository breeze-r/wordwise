// WordWise service worker — pure frontend.
// All translation, dictionary lookup, vocab tracking, and summarization
// runs locally; LLM calls go directly from this worker to the user's
// chosen API endpoint.

importScripts(
  "lib/data/dict-client.js",
  "lib/data/freq-client.js",
  "lib/db/vocabulary.js",
  "lib/llm-client.js",
  "lib/reading-service.js",
);

const DEFAULT_TRANSLATOR_CONFIG = {
  mode: "hybrid",
  apiKey: "",
  apiUrl: "",
  model: "",
};

// === Storage helpers ============================================
async function getEnabled() {
  const { enabled } = await chrome.storage.local.get("enabled");
  return enabled !== false;
}

async function notifyContentTabs(message, hostname = null) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url) continue;
      if (hostname) {
        try {
          const url = new URL(tab.url);
          const tabHostname = url.hostname.toLowerCase().replace(/^www\./, "");
          if (tabHostname !== hostname) continue;
        } catch { continue; }
      }
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  } catch { /* ignore */ }
}

function normalizeTranslatorConfig(raw = {}) {
  const mode = typeof raw.mode === "string" ? raw.mode.trim() : "";
  return {
    mode: ["local_wordbook", "hybrid", "remote"].includes(mode) ? mode : DEFAULT_TRANSLATOR_CONFIG.mode,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() : "",
    apiUrl: typeof raw.apiUrl === "string" && raw.apiUrl.trim() ? raw.apiUrl.trim() : "",
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : "",
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

async function getVocabLevel() {
  return await self.vocabDb.getMeta("vocab_level", "high_school");
}

async function setVocabLevel(level) {
  return await self.vocabDb.setMeta("vocab_level", level);
}

// Migration: upgrade legacy local_wordbook → hybrid
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install" || details.reason === "update") {
    const { translatorConfig } = await chrome.storage.local.get("translatorConfig");
    if (!translatorConfig || translatorConfig.mode === "local_wordbook") {
      const upgraded = normalizeTranslatorConfig({ ...(translatorConfig || {}), mode: "hybrid" });
      await chrome.storage.local.set({ translatorConfig: upgraded });
    }
  }
});

// === Offscreen Document for PDF.js ==============================
const OFFSCREEN_PATH = "offscreen.html";

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["DOM_PARSER"],
    justification: "Run PDF.js to extract text from PDFs for translation/summary.",
  });
}

function arrayBufferToBase64(buffer) {
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
  const bytesBase64 = arrayBufferToBase64(arrayBuffer);
  return await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "extract_pdf_text",
    bytesBase64,
  });
}

// === Message handler ============================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.target === "offscreen") return false;
  if (msg && msg.type === "offscreen_ready") return false;

  handleMessage(msg, sender).then(sendResponse).catch((err) => {
    sendResponse({ error: err?.message || String(err) });
  });
  return true;
});

// === Port-based summary streaming ===============================
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ww-summarize") return;
  let closed = false;
  const safePost = (msg) => {
    if (closed) return;
    try { port.postMessage(msg); } catch { /* gone */ }
  };
  port.onDisconnect.addListener(() => { closed = true; });

  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== "start") return;
    const cfg = await getTranslatorConfig();
    if (cfg.mode === "local_wordbook") {
      safePost({ type: "error", data: { message: "本地模式不支持摘要功能，请在弹窗中切换为 LLM 模式。" } });
      try { port.disconnect(); } catch { /* */ }
      return;
    }
    try {
      for await (const evt of self.readingService.summarizeArticleStream(msg.text, cfg)) {
        safePost(evt);
        if (evt.type === "done" || evt.type === "error") break;
      }
    } catch (err) {
      safePost({ type: "error", data: { message: err?.message || String(err) } });
    } finally {
      try { port.disconnect(); } catch { /* */ }
    }
  });
});

// === Main message dispatch ======================================
async function handleMessage(msg, sender) {
  switch (msg.type) {
    // --- Toggle ---
    case "get_enabled":
      return { enabled: await getEnabled() };
    case "set_enabled":
      await chrome.storage.local.set({ enabled: msg.enabled });
      await notifyContentTabs({ type: "wordwise_enabled_changed", enabled: msg.enabled });
      return { ok: true };

    // --- Per-site overrides ---
    case "get_domain_override": {
      const { domainOverrides = {} } = await chrome.storage.local.get("domainOverrides");
      return { value: domainOverrides[msg.hostname] || "auto" };
    }
    case "set_domain_override": {
      if (!msg.hostname) return { error: "missing hostname" };
      const { domainOverrides = {} } = await chrome.storage.local.get("domainOverrides");
      const value = msg.value;
      if (value === "auto") {
        delete domainOverrides[msg.hostname];
      } else if (value === "on" || value === "off") {
        domainOverrides[msg.hostname] = value;
      } else {
        return { error: "invalid override value" };
      }
      await chrome.storage.local.set({ domainOverrides });
      await notifyContentTabs({ type: "wordwise_site_state_changed" }, msg.hostname);
      return { ok: true, value };
    }
    case "get_all_domain_overrides": {
      const { domainOverrides = {} } = await chrome.storage.local.get("domainOverrides");
      return domainOverrides;
    }
    case "set_page_state": {
      const tabId = sender?.tab?.id;
      if (typeof tabId !== "number") return { ok: false };
      const { pageStates = {} } = await chrome.storage.local.get("pageStates");
      pageStates[String(tabId)] = msg.pageState;
      const keys = Object.keys(pageStates);
      if (keys.length > 50) {
        for (const k of keys.slice(0, keys.length - 50)) delete pageStates[k];
      }
      await chrome.storage.local.set({ pageStates });
      return { ok: true };
    }
    case "get_page_state": {
      const { pageStates = {} } = await chrome.storage.local.get("pageStates");
      return pageStates[String(msg.tabId)] || null;
    }

    // --- Translator config ---
    case "get_translator_config":
      return await getTranslatorConfig();
    case "set_translator_config":
      return await setTranslatorConfig(msg.config || {});

    // --- LLM status ---
    case "set_llm_status":
      await chrome.storage.local.set({ llmOk: !!msg.ok });
      return { ok: true };
    case "get_llm_status": {
      const { llmOk, llmError } = await chrome.storage.local.get(["llmOk", "llmError"]);
      return { ok: llmOk === true, known: typeof llmOk === "boolean", error: llmError || "" };
    }

    // --- User profile (replaces backend /api/auth/me) ---
    case "get_user": {
      const stats = await self.vocabDb.getStats();
      const level = await getVocabLevel();
      return {
        id: 1,
        estimated_vocabulary: 0,
        test_completed: false,
        vocab_level: level,
        total_words: stats.total_words,
      };
    }

    // --- Vocab level ---
    case "get_vocab_levels":
      return await self.freqClient.getVocabLevels();
    case "set_vocab_level": {
      await setVocabLevel(msg.level);
      return { ok: true, level: msg.level };
    }

    // --- Vocabulary CRUD ---
    case "encounter_word": {
      const word = msg.word || {};
      const lemma = String(word.lemma || "").toLowerCase().trim();
      if (!lemma) return { error: "missing lemma" };
      const merged = await self.vocabDb.upsertVocab(lemma, {
        definition_cn: word.definition_cn || "",
        pos: word.pos || null,
        phonetic: word.phonetic || null,
        source_url: word.source_url || null,
        last_clicked_translation: !!word.clicked_translation,
        manual_lookup_count: word.clicked_translation
          ? (((await self.vocabDb.getVocab(lemma))?.manual_lookup_count) || 0) + 1
          : ((await self.vocabDb.getVocab(lemma))?.manual_lookup_count || 0),
        last_manual_lookup_at: word.clicked_translation ? Date.now() : undefined,
      });
      if (word.clicked_translation) {
        await self.vocabDb.resetExposureCycle(lemma);
      }
      return { status: "ok", lemma };
    }

    case "encounter_batch": {
      let count = 0;
      for (const w of msg.words || []) {
        await self.vocabDb.upsertVocab(w.lemma, {
          definition_cn: w.definition_cn || "",
          pos: w.pos || null,
          phonetic: w.phonetic || null,
          source_url: w.source_url || null,
        });
        count++;
      }
      return { status: "ok", new_words: count };
    }

    case "update_word_status": {
      const lemma = String(msg.lemma || "").toLowerCase().trim();
      if (!lemma) return { error: "missing lemma" };
      const v = await self.vocabDb.getVocab(lemma) || {};
      v.lemma = lemma;
      v.status = msg.status;
      if (msg.status === "mastered") {
        v.exposure_remaining = 0;
      }
      await self.vocabDb.putVocab(v);
      return { status: "ok", lemma, new_status: msg.status };
    }

    case "get_stats": {
      const s = await self.vocabDb.getStats();
      return { estimated_vocabulary: 0, ...s };
    }

    // --- Reading flow ---
    case "scan_page": {
      const cfg = await getTranslatorConfig();
      const level = await getVocabLevel();
      const result = await self.readingService.scanPage({
        wordContexts: msg.words || [],
        pageUrl: msg.page_url,
        pageSessionId: msg.pageSessionId,
        vocabLevel: level,
        llmConfig: cfg,
      });
      if (typeof result.llm_ok === "boolean") {
        await chrome.storage.local.set({ llmOk: result.llm_ok });
      }
      return result;
    }

    case "lookup_word": {
      const cfg = await getTranslatorConfig();
      const lemma = String(msg.word || "").toLowerCase().trim();
      if (!lemma) return { lemma: "", brief: "", exposure_remaining: 0, manual_lookup_count: 0 };

      const detail = await self.readingService.lookupWordDetail(lemma, msg.sentence, cfg);
      // Update vocab DB (reset cycle if explicitly clicked)
      const v = await self.vocabDb.getVocab(lemma) || { lemma };
      v.last_seen_at = Date.now();
      v.encounter_count = (v.encounter_count || 0) + 1;
      if (msg.pageUrl) v.source_url = msg.pageUrl;
      if (msg.sentence) v.context_sentence = String(msg.sentence).slice(0, 200);
      if (detail) {
        v.definition_cn = v.definition_cn || detail.brief;
        v.pos = detail.pos || v.pos;
        v.phonetic = detail.phonetic || v.phonetic;
        v.meanings_json = detail.meanings ? JSON.stringify(detail.meanings) : v.meanings_json;
        if (detail.sentence_zh) v.sentence_zh = detail.sentence_zh;
      }
      if (msg.triggerCycle) {
        v.last_clicked_translation = true;
        v.manual_lookup_count = (v.manual_lookup_count || 0) + 1;
        v.last_manual_lookup_at = Date.now();
        v.exposure_remaining = v.exposure_limit || self.vocabDb.DEFAULT_EXPOSURE_LIMIT;
        v.last_exposure_session_id = null;
        if (v.status === "mastered") v.status = "learning";
      }
      v.status = v.status || "new_word";
      v.exposure_limit = v.exposure_limit || self.vocabDb.DEFAULT_EXPOSURE_LIMIT;
      v.exposure_remaining = v.exposure_remaining ?? v.exposure_limit;
      await self.vocabDb.putVocab(v);

      return {
        lemma,
        brief: detail?.brief || "",
        pos: detail?.pos,
        phonetic: detail?.phonetic,
        phonetic_uk: null,
        phonetic_us: null,
        meanings: detail?.meanings || [],
        definition_en: detail?.definition_en || [],
        sentence_zh: detail?.sentence_zh || v.sentence_zh,
        exposure_remaining: v.exposure_remaining || 0,
        manual_lookup_count: v.manual_lookup_count || 0,
      };
    }

    case "summarize_article": {
      // Non-streaming summary fallback (kept for compat)
      const cfg = await getTranslatorConfig();
      if (cfg.mode === "local_wordbook") {
        return { error: "本地模式不支持摘要功能" };
      }
      const events = [];
      for await (const e of self.readingService.summarizeArticleStream(msg.text, cfg)) {
        events.push(e);
      }
      const meta = events.find((e) => e.type === "meta")?.data || {};
      const sections = events.filter((e) => e.type === "section").map((e) => e.data);
      const error = events.find((e) => e.type === "error")?.data?.message;
      if (error) return { error };
      return { ...meta, sections };
    }

    case "extract_pdf_text": {
      try {
        const r = await fetch(msg.url, { credentials: "include" });
        if (!r.ok) return { ok: false, error: `下载 PDF 失败: HTTP ${r.status}` };
        const buffer = await r.arrayBuffer();
        return await extractPdfText(buffer);
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    }

    // --- Dict packs (placeholder for future static packs) ---
    case "get_dict_packs":
      return [];
    case "get_enabled_packs": {
      const { enabledPacks } = await chrome.storage.local.get("enabledPacks");
      return enabledPacks || [];
    }
    case "set_enabled_packs": {
      const packs = Array.isArray(msg.packs) ? msg.packs : [];
      await chrome.storage.local.set({ enabledPacks: packs });
      return { ok: true, packs };
    }

    // --- Vocabulary export / import (migration path) ---
    case "export_vocabulary": {
      const all = await self.vocabDb.getAllVocab();
      const cfg = await getTranslatorConfig();
      const level = await getVocabLevel();
      return {
        version: 1,
        exported_at: new Date().toISOString(),
        vocab_level: level,
        translator_config: { ...cfg, apiKey: "" },  // strip key for safety
        words: all,
      };
    }

    case "import_vocabulary": {
      const data = msg.data;
      if (!data?.words || !Array.isArray(data.words)) {
        return { error: "格式错误：缺少 words 数组" };
      }
      let count = 0;
      for (const w of data.words) {
        if (!w.lemma) continue;
        await self.vocabDb.putVocab(w);
        count++;
      }
      if (data.vocab_level) await setVocabLevel(data.vocab_level);
      return { ok: true, count };
    }

    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

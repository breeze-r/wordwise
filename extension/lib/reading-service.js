// Reading service — replaces backend routers/reading.py.
// Combines: dictionary lookup, vocab tracking, LLM translation, summary streaming.
//
// Depends on: dictClient, freqClient, vocabDb, llmClient (loaded via importScripts).

const SUMMARY_NDJSON_PROMPT = `You are a bilingual reading assistant. Stream a structured summary as NDJSON: one complete JSON object per line, no array, no markdown, no commentary.

Match the depth of your summary to the content. {depthHint}

Order:
1. {"type":"meta","title_en":"<={titleWords} words","title_zh":"<={titleZhChars} chars","overview_en":"{overviewSents}","overview_zh":"{overviewSents}"}
2. Then {sectionRange} section objects:
{"type":"section","heading_en":"3-7 words","heading_zh":"...","points_en":["...","..."],"points_zh":["...","..."]}

Rules:
- Each line MUST be one complete, parseable JSON object.
- No literal or escaped newlines inside strings — use spaces.
- {pointsPerSection} substantive points per section (each <={pointWords} words).
- Cover the article comprehensively — do NOT oversimplify rich content.
- For papers/financial reports, surface concrete numbers, methods, findings, conclusions.

Math notation (CRITICAL for academic / quantitative content):
- ALWAYS write equations and mathematical expressions in LaTeX, NOT plain text.
- Use $...$ for inline math and $$...$$ for display math.
- Inside JSON strings, backslashes must be escaped: write "\\\\sigma" not "\\sigma".

Output ONLY the NDJSON lines.

Article:
{article}`;

function _summaryDepthProfile(textLen) {
  if (textLen < 1500) return {
    depthHint: "Content is short, so be concise but complete.",
    titleWords: 12, titleZhChars: 16, overviewSents: "1-2 sentences",
    sectionRange: "3-4", pointsPerSection: "1-2", pointWords: 18,
    inputCap: 1800, maxTokens: 800,
  };
  if (textLen < 5000) return {
    depthHint: "Content is medium length — give a balanced overview.",
    titleWords: 14, titleZhChars: 18, overviewSents: "2-3 sentences",
    sectionRange: "4-6", pointsPerSection: "2-3", pointWords: 25,
    inputCap: 5500, maxTokens: 1600,
  };
  if (textLen < 12000) return {
    depthHint: "Content is long — go deep enough to capture the substance.",
    titleWords: 15, titleZhChars: 22, overviewSents: "2-4 sentences",
    sectionRange: "6-8", pointsPerSection: "2-3", pointWords: 30,
    inputCap: 12000, maxTokens: 2400,
  };
  return {
    depthHint: "Content is dense and rich — produce a thorough briefing with concrete details.",
    titleWords: 16, titleZhChars: 24, overviewSents: "3-5 sentences",
    sectionRange: "8-10", pointsPerSection: "3-4", pointWords: 38,
    inputCap: 18000, maxTokens: 3500,
  };
}

function _formatPrompt(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// ─── Word lookup ────────────────────────────────────────────────

/**
 * Resolve full word detail. Local dictionary first; LLM fills sentence_zh.
 */
async function lookupWordDetail(word, sentence, llmConfig) {
  const lemma = String(word).toLowerCase().trim();
  if (!lemma) return null;

  const local = await self.dictClient.dictLookup(lemma);
  const detail = {
    lemma,
    brief: local?.brief || "",
    pos: local?.pos || null,
    phonetic: local?.phonetic || null,
    phonetic_uk: null,
    phonetic_us: null,
    meanings: local?.meanings || [],
    definition_en: local?.definitionEn || [],
    sentence_zh: null,
  };

  // If LLM available and we have sentence context, also get a sentence translation.
  if (llmConfig?.mode !== "local_wordbook" && sentence) {
    const ctx = String(sentence).trim().slice(0, 1200);
    const prompt =
      "Translate the following English text into fluent Chinese. " +
      "Translate the ENTIRE text — do not stop partway. " +
      "Return only the translation, no explanation, no quotes:\n\n" +
      ctx;
    const r = await self.llmClient.chatCompletion(llmConfig, prompt, {
      parseJson: false, maxRetries: 1, maxTokens: 1500, timeoutSeconds: 30,
    });
    if (r.text) {
      detail.sentence_zh = r.text.replace(/^["「]+|["」]+$/g, "").trim();
    }
  }
  return detail;
}

/**
 * Word LLM batch translation for context-aware annotation.
 * Returns { word: chinese_brief } for each word the LLM gives a meaning to.
 */
async function batchTranslateWords(wordContexts, llmConfig) {
  if (!wordContexts?.length) return { translations: {}, llmOk: true };

  // Build a single LLM call: paragraph -> Chinese, plus per-word translation
  const lines = [];
  for (let i = 0; i < wordContexts.length; i++) {
    const wc = wordContexts[i];
    const w = String(wc.word || "").trim();
    const sent = String(wc.sentence || "").slice(0, 150);
    lines.push(`${i + 1}. "${w}" — "${sent}"`);
  }
  const prompt =
    "你是英语学习助手。下面有一些英文单词和它们所在的句子。\n" +
    "请根据句子语境，给出每个单词在当前句中最贴切的中文翻译。\n\n" +
    "规则：翻译简短精炼（2-6个字），只返回纯 JSON 对象，key 是小写英文，value 是中文。\n\n" +
    "单词列表：\n" + lines.join("\n");

  const r = await self.llmClient.chatCompletion(llmConfig, prompt, {
    parseJson: true, maxRetries: 1, maxTokens: Math.min(3000, lines.length * 30 + 500),
    timeoutSeconds: 45,
  });
  if (r.error || !r.json) {
    return { translations: {}, llmOk: false, error: r.error };
  }
  const out = {};
  for (const [k, v] of Object.entries(r.json)) {
    if (v && typeof v === "string") out[String(k).toLowerCase()] = v.trim();
  }
  return { translations: out, llmOk: true };
}

// ─── Page scan ─────────────────────────────────────────────────

/**
 * Scan a list of word contexts: filter known words, look up locally,
 * call LLM for missing or context-disambiguated translations,
 * return annotation list + update vocab DB.
 */
async function scanPage({ wordContexts, pageUrl, pageSessionId, vocabLevel, llmConfig }) {
  const known = await self.freqClient.getKnownWords(vocabLevel || "high_school");

  // Step 1: dedup + filter known
  const candidates = new Map();  // lemma -> wordContext
  for (const wc of wordContexts || []) {
    const lemma = String(wc.word || "").toLowerCase().trim();
    if (!lemma || lemma.length <= 2) continue;
    if (known.has(lemma)) continue;
    if (!candidates.has(lemma)) candidates.set(lemma, wc);
  }

  if (candidates.size === 0) return { annotations: [], llm_ok: true };

  // Step 2: load vocab records for candidates, drop mastered + zero-exposure
  const vocabMap = await self.vocabDb.getVocabBatch([...candidates.keys()]);
  const toAnnotate = [];
  for (const [lemma, wc] of candidates) {
    const v = vocabMap[lemma];
    if (v?.status === "mastered") continue;
    if (v && (v.exposure_remaining ?? 0) <= 0) continue;
    toAnnotate.push({ lemma, wc, v });
  }

  // Step 3: local dictionary lookup for everyone (offline fallback)
  const localEntries = await self.dictClient.dictLookupBatch(toAnnotate.map((x) => x.lemma));

  // Step 4: LLM batch translate (for context disambiguation)
  let llmResults = {};
  let llmOk = true;
  if (llmConfig?.mode !== "local_wordbook" && toAnnotate.length) {
    const r = await batchTranslateWords(
      toAnnotate.map((x) => ({ word: x.lemma, sentence: x.wc.sentence })),
      llmConfig,
    );
    llmResults = r.translations;
    llmOk = r.llmOk;
  }

  // Step 5: assemble annotations + update DB
  const annotations = [];
  const now = Date.now();
  for (const item of toAnnotate) {
    const { lemma, wc, v } = item;
    const local = localEntries[lemma];
    const llmZh = llmResults[lemma];
    const chinese = llmZh || local?.brief;
    if (!chinese) continue;

    annotations.push({ word: wc.word, chinese });

    // Upsert into vocab DB with exposure tracking
    const merged = {
      lemma,
      definition_cn: chinese,
      pos: local?.pos || v?.pos || null,
      phonetic: local?.phonetic || v?.phonetic || null,
      meanings_json: local?.meanings ? JSON.stringify(local.meanings) : v?.meanings_json || null,
      source_url: pageUrl || v?.source_url || null,
      context_sentence: (wc.sentence || "").slice(0, 200),
      last_seen_at: now,
      encounter_count: (v?.encounter_count || 0) + 1,
      status: v?.status || "new_word",
    };
    await self.vocabDb.upsertVocab(lemma, merged);
    await self.vocabDb.applyAnnotationExposure(lemma, pageSessionId);
  }

  return { annotations, llm_ok: llmOk };
}

// ─── Summary streaming ─────────────────────────────────────────

async function* summarizeArticleStream(text, llmConfig) {
  const profile = _summaryDepthProfile((text || "").length);
  const truncated = String(text || "").slice(0, profile.inputCap)
    + ((text?.length || 0) > profile.inputCap ? "\n[... truncated ...]" : "");

  const prompt = _formatPrompt(SUMMARY_NDJSON_PROMPT, {
    article: truncated,
    depthHint: profile.depthHint,
    titleWords: profile.titleWords,
    titleZhChars: profile.titleZhChars,
    overviewSents: profile.overviewSents,
    sectionRange: profile.sectionRange,
    pointsPerSection: profile.pointsPerSection,
    pointWords: profile.pointWords,
  });

  let buffer = "";
  const stream = self.llmClient.chatCompletionStream(llmConfig, prompt, {
    maxTokens: profile.maxTokens,
    timeoutSeconds: 75,
    temperature: 0.2,
  });

  for await (const chunk of stream) {
    if (chunk.error) {
      yield { type: "error", data: { message: chunk.error } };
      return;
    }
    if (chunk.delta) {
      buffer += chunk.delta;
      // Try to emit each complete NDJSON line
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const evt = _parseSummaryLine(line);
        if (evt) yield evt;
      }
    }
    if (chunk.done) break;
  }

  // Flush trailing buffer
  const tail = buffer.trim();
  if (tail) {
    const evt = _parseSummaryLine(tail);
    if (evt) yield evt;
  }
  yield { type: "done", data: {} };
}

function _parseSummaryLine(line) {
  let s = (line || "").trim();
  if (!s) return null;
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  }
  if (!s) return null;
  try {
    const obj = JSON.parse(s);
    if (obj?.type === "meta") {
      return { type: "meta", data: { ...obj, type: undefined } };
    }
    if (obj?.type === "section") {
      return { type: "section", data: { ...obj, type: undefined } };
    }
  } catch { /* malformed line — skip */ }
  return null;
}

self.readingService = {
  lookupWordDetail,
  batchTranslateWords,
  scanPage,
  summarizeArticleStream,
};

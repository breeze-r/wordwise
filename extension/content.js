(() => {
  "use strict";

  const MAX_WORDS_PER_BATCH = 80;
  const SCAN_DEBOUNCE_MS = 500;
  const SELECTION_LOOKUP_DELAY_MS = 120;
  const pageSessionId =
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  // === State ===
  let annotationMap = {}; // lemma -> { brief, meanings, pos, phonetic, exposureRemaining, manualLookupCount }
  let isEnabled = true;
  let detailPanel = null;
  let selectionLookupTimer = null;
  let currentDetailWord = null;
  let isScanning = false;
  let scanQueued = false;
  let scannedWords = new Set();

  // === 基础过滤：前端先过滤掉明显不需要翻译的词 ===
  const SKIP = new Set([
    "the","be","to","of","and","a","in","that","have","i","it","for","not","on",
    "with","he","as","you","do","at","this","but","his","by","from","they","we",
    "say","her","she","or","an","will","my","one","all","would","there","their",
    "what","so","up","out","if","about","who","get","which","go","me","when",
    "can","like","no","just","him","know","take","into","your","some","could",
    "them","see","other","than","then","now","only","come","its","over","also",
    "back","after","use","how","our","well","way","even","because","any","these",
    "give","most","us","am","is","are","was","were","been","has","had","did",
    "does","may","might","shall","should","must","need","very","much","more",
    "here","where","why","too","own","same","still","such","each","both","few",
    "those","being","once","while","before","between","under","never","always",
    "often","let","make","think","look","want","find","tell","ask","work",
    "seem","feel","try","leave","call","keep","put","run","turn","start","show",
    "hear","play","move","live","happen","bring","write","sit","stand","lose",
    "pay","meet","set","learn","change","lead","watch","follow","stop","read",
    "spend","grow","open","walk","win","speak","buy","wait","send","build",
    "stay","fall","cut","reach","remain","hold","carry","break","ago","yet",
  ]);

  // 固定短语：当词处于短语中时，显示短语翻译而非单词翻译
  // [regex, 触发词, 短语中文]
  const PHRASE_MAP = [
    [/\bno\s+matter\b/i,            "matter",   "无论"],
    [/\bin\s+spite\s+of\b/i,        "spite",    "尽管"],
    [/\bfor\s+(the\s+)?sake\s+of\b/i,"sake",    "为了…的缘故"],
    [/\bget\s+rid\s+of\b/i,         "rid",      "摆脱"],
    [/\bin\s+lieu\s+of\b/i,         "lieu",     "代替"],
    [/\bin\s+vain\b/i,              "vain",     "徒劳"],
    [/\bby\s+virtue\s+of\b/i,      "virtue",   "凭借"],
    [/\bon\s+behalf\s+of\b/i,      "behalf",   "代表"],
    [/\bas\s+a\s+matter\s+of\s+fact\b/i, "matter", "事实上"],
    [/\bfor\s+that\s+matter\b/i,   "matter",   "就此而言"],
    [/\blet\s+alone\b/i,           "alone",    "更不用说"],
    [/\bby\s+means\s+of\b/i,       "means",    "通过"],
    [/\bby\s+no\s+means\b/i,       "means",    "绝不"],
    [/\bin\s+terms\s+of\b/i,       "terms",    "在…方面"],
    [/\bon\s+account\s+of\b/i,     "account",  "由于"],
    [/\btake\s+into\s+account\b/i, "account",  "考虑到"],
    [/\bin\s+the\s+wake\s+of\b/i,  "wake",     "在…之后"],
    [/\bwith\s+regard\s+to\b/i,    "regard",   "关于"],
    [/\bin\s+addition\s+to\b/i,    "addition", "除…之外"],
    [/\bas\s+opposed\s+to\b/i,     "opposed",  "与…相反"],
  ];

  /** 若词处于固定短语中，返回短语中文；否则返回 null */
  function getPhraseTranslation(word, context) {
    const w = word.toLowerCase();
    for (const [regex, trigger, zh] of PHRASE_MAP) {
      if (trigger === w && regex.test(context)) return zh;
    }
    return null;
  }

  function shouldProcess(word) {
    if (!word || word.length <= 2 || word.length > 30) return false;
    if (/^\d+$/.test(word)) return false;
    if (word.length >= 2 && word === word.toUpperCase()) return false;
    if (SKIP.has(word.toLowerCase())) return false;
    return /^[a-zA-Z'-]+$/.test(word);
  }

  function normalizeWord(word) {
    return (word || "").replace(/^['-]+|['-]+$/g, "").toLowerCase().trim();
  }

  function getAnnotationEntry(word) {
    const entry = annotationMap[word];
    if (!entry) return null;
    if (typeof entry === "string") return { brief: entry, meanings: [] };
    return entry;
  }

  function normalizeMeanings(values) {
    if (!Array.isArray(values)) return [];
    const normalized = [];
    for (const item of values) {
      const text = String(item || "").trim();
      if (text && !normalized.includes(text)) {
        normalized.push(text);
      }
      if (normalized.length >= 4) break;
    }
    return normalized;
  }

  function storeAnnotationEntry(payload) {
    if (!payload || !payload.lemma) return;
    const meanings = normalizeMeanings(payload.meanings);
    annotationMap[payload.lemma] = {
      brief: typeof payload.brief === "string" ? payload.brief.trim() : (payload.chinese || ""),
      pos: payload.pos || null,
      phonetic: payload.phonetic || null,
      phoneticUk: payload.phonetic_uk || null,
      phoneticUs: payload.phonetic_us || null,
      meanings,
      definitionEn: Array.isArray(payload.definition_en) ? payload.definition_en : [],
      sentenceZh: payload.sentence_zh || null,
      exposureRemaining: typeof payload.exposure_remaining === "number"
        ? payload.exposure_remaining
        : null,
      manualLookupCount: typeof payload.manual_lookup_count === "number"
        ? payload.manual_lookup_count
        : null,
    };
  }

  // === Send message to background ===
  function sendMsg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
        else resolve(res || {});
      });
    });
  }

  // === 文章主体检测：只处理正文区域，排除侧边栏/导航/页脚等 ===
  const NON_ARTICLE_SELECTORS = [
    "nav", "header", "footer", "aside",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']",
    "[role='complementary']", "[role='search']",
    ".sidebar", ".side-bar", ".widget", ".widgets",
    ".nav", ".navbar", ".navigation", ".menu",
    ".footer", ".header", ".masthead",
    ".ad", ".ads", ".advertisement", ".advert",
    ".comment", ".comments", "#comments", "#disqus_thread",
    ".related", ".recommended", ".suggestions",
    ".social", ".share", ".sharing",
    ".breadcrumb", ".breadcrumbs",
    ".toc", ".table-of-contents",
    ".cookie", ".popup", ".modal", ".overlay",
    "#ww-detail", "#ww-banner", "#ww-summary", "#ww-summary-fab",
  ].join(",");

  function findArticleRoot() {
    // 1. 优先：<article> 或 [role="main"]
    const article = document.querySelector("article, [role='main'], main");
    if (article && article.textContent.trim().length > 200) return article;

    // 2. 常见 class/id 模式
    const candidates = document.querySelectorAll(
      ".post-content, .article-content, .entry-content, .post-body, " +
      ".article-body, .story-body, .prose, .markdown-body, " +
      "#content, #main-content, .content, .main-content, " +
      ".page-content, .single-content, .blog-post"
    );
    for (const el of candidates) {
      if (el.textContent.trim().length > 200) return el;
    }

    // 3. 启发式：找最大文本密度的容器
    const allBlocks = document.querySelectorAll("div, section");
    let bestEl = null;
    let bestScore = 0;
    for (const el of allBlocks) {
      // 跳过太小或是非正文区域
      if (el.matches(NON_ARTICLE_SELECTORS)) continue;
      if (el.closest(NON_ARTICLE_SELECTORS)) continue;
      const paragraphs = el.querySelectorAll("p");
      if (paragraphs.length < 3) continue;
      // 计算段落文本总长度作为打分
      let textLen = 0;
      for (const p of paragraphs) textLen += p.textContent.trim().length;
      if (textLen > bestScore) {
        bestScore = textLen;
        bestEl = el;
      }
    }
    if (bestEl && bestScore > 300) return bestEl;

    // 4. 兜底：document.body（保持旧行为）
    return document.body;
  }

  let _articleRoot = null;
  function getArticleRoot() {
    if (!_articleRoot || !document.body.contains(_articleRoot)) {
      _articleRoot = findArticleRoot();
      /* debug: article root found */
    }
    return _articleRoot;
  }

  function isInsideArticle(el) {
    const root = getArticleRoot();
    if (root === document.body) return true; // 兜底时不过滤
    return root.contains(el);
  }

  // === 从段落中提取需要翻译的词+所在句子 ===
  function extractSentence(text, wordIndex) {
    // 向前找句子起点（. ! ? 或段落开头）
    let start = wordIndex;
    while (start > 0 && !/[.!?。！？\n]/.test(text[start - 1])) start--;
    // 向后找句子终点
    let end = wordIndex;
    while (end < text.length && !/[.!?。！？\n]/.test(text[end])) end++;
    if (end < text.length) end++; // 包含句末标点
    return text.slice(start, end).trim().slice(0, 200);
  }

  /**
   * 识别专有名词（人名、地名、品牌名等），跳过翻译。
   * 启发式：词在句中（非句首）出现大写形式 且 从未出现小写形式 → 判定为专有名词。
   * 能识别 "Trump" "Biden" "Microsoft"，但不会误伤 "Apple"（若文中也有 "apple"）。
   */
  function detectProperNouns(text) {
    const stats = new Map(); // lowercase -> { lower, midCap, sentStart }
    const regex = /[a-zA-Z][a-zA-Z'-]*/g;
    let match;
    let prevEnd = 0;

    while ((match = regex.exec(text)) !== null) {
      const word = match[0];
      const start = match.index;
      if (word.length <= 2) { prevEnd = start + word.length; continue; }
      if (word === word.toUpperCase()) { prevEnd = start + word.length; continue; } // 全大写（缩写）

      const lower = word.toLowerCase();
      const firstChar = word[0];
      const isCapitalized = firstChar >= "A" && firstChar <= "Z";
      const between = text.slice(prevEnd, start);
      // 句首判定：文本起始 / 前面有 .!? 或换行（允许后接引号/括号/空白）
      const isSentenceStart = prevEnd === 0 || /[.!?\n][\s"')\]]*$/.test(between);

      let entry = stats.get(lower);
      if (!entry) {
        entry = { lower: 0, midCap: 0, sentStart: 0 };
        stats.set(lower, entry);
      }
      if (!isCapitalized) entry.lower++;
      else if (isSentenceStart) entry.sentStart++;
      else entry.midCap++;

      prevEnd = start + word.length;
    }

    const properNouns = new Set();
    for (const [word, s] of stats) {
      if (s.midCap > 0 && s.lower === 0) properNouns.add(word);
    }
    return properNouns;
  }

  function extractWordsFromParagraphs() {
    const articleRoot = getArticleRoot();
    const blocks = articleRoot.querySelectorAll("p, li, td, h1, h2, h3, h4, h5, h6, blockquote, figcaption");
    const wordContexts = [];
    const seen = new Set();

    // 第一遍：收集全文文本，识别专有名词
    const eligibleBlocks = [];
    let fullText = "";
    for (const block of blocks) {
      if (block.closest(NON_ARTICLE_SELECTORS)) continue;
      const text = block.textContent || "";
      if (!text.trim() || text.length < 10) continue;
      eligibleBlocks.push({ block, text });
      fullText += text + "\n";
    }
    const properNouns = detectProperNouns(fullText);

    for (const { text } of eligibleBlocks) {
      // 整段文本用于 LLM 段落级语义消歧（截取前500字）
      const paragraph = text.trim().slice(0, 500);

      const regex = /[a-zA-Z'-]+/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const clean = normalizeWord(match[0]);
        if (!shouldProcess(clean)) continue;
        if (properNouns.has(clean)) continue; // 跳过专有名词
        if (seen.has(clean)) continue;
        // 固定短语检测：若命中短语，直接用短语翻译写入 annotationMap
        const phraseCtx = text.slice(Math.max(0, match.index - 30), match.index + match[0].length + 30);
        const phraseZh = getPhraseTranslation(clean, phraseCtx);
        if (phraseZh) {
          annotationMap[clean] = { brief: phraseZh, meanings: [], isPhrase: true };
          seen.add(clean);
          continue; // 不需要发给后端翻译
        }
        seen.add(clean);
        const sentence = extractSentence(text, match.index);
        wordContexts.push({ word: clean, sentence, paragraph });
      }
    }
    return wordContexts;
  }

  function getContextText(nodeOrElement) {
    const element =
      nodeOrElement?.nodeType === Node.ELEMENT_NODE
        ? nodeOrElement
        : nodeOrElement?.parentElement;
    const text =
      element?.closest("p, li, td, div, h1, h2, h3, h4, h5, h6, article, section, blockquote")
        ?.textContent || element?.textContent || "";
    return text.trim().slice(0, 240);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;")
      .replaceAll("'", "&#39;");
  }

  function escapeRegExpChars(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function highlightWord(text, word) {
    const source = String(text || "");
    if (!source || !word) return escapeHtml(source);

    const regex = new RegExp(`\\b(${escapeRegExpChars(word)})\\b`, "gi");
    let lastIndex = 0;
    let html = "";
    let match;

    while ((match = regex.exec(source)) !== null) {
      html += escapeHtml(source.slice(lastIndex, match.index));
      html += `<mark>${escapeHtml(match[0])}</mark>`;
      lastIndex = match.index + match[0].length;
    }
    html += escapeHtml(source.slice(lastIndex));
    return html;
  }

  // === DOM 标注：在原文词后插入中文 ===
  const SKIP_TAGS = new Set([
    "SCRIPT","STYLE","NOSCRIPT","SVG","MATH","CODE","PRE",
    "TEXTAREA","INPUT","SELECT","BUTTON","IFRAME","CANVAS",
    "VIDEO","AUDIO","IMG","BR","HR",
  ]);

  function isAlreadyAnnotatedWordNode(textNode) {
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return false;
    const text = textNode.textContent?.trim() || "";
    if (!/^[a-zA-Z'-]+$/.test(text)) return false;

    const next = textNode.nextSibling;
    if (!next || next.nodeType !== Node.ELEMENT_NODE) return false;
    if (!next.classList.contains("ww-cn")) return false;

    return next.dataset.wwWord === normalizeWord(text);
  }

  function dedupeAdjacentAnnotations(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    root.querySelectorAll(".ww-cn").forEach((el) => {
      let next = el.nextElementSibling;
      while (
        next &&
        next.classList.contains("ww-cn") &&
        next.dataset.wwWord === el.dataset.wwWord &&
        next.dataset.wwChinese === el.dataset.wwChinese
      ) {
        const duplicate = next;
        next = next.nextElementSibling;
        duplicate.remove();
      }
    });
  }

  function annotateDOM(root) {
    if (root.nodeType === Node.ELEMENT_NODE) {
      dedupeAdjacentAnnotations(root);
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        if (isAlreadyAnnotatedWordNode(node)) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest("[contenteditable]")) return NodeFilter.FILTER_REJECT;
        if (parent.classList.contains("ww-cn")) return NodeFilter.FILTER_REJECT;
        if (parent.id === "ww-detail" || parent.id === "ww-banner" || parent.id === "ww-summary" || parent.id === "ww-summary-fab") return NodeFilter.FILTER_REJECT;
        if (parent.closest(NON_ARTICLE_SELECTORS)) return NodeFilter.FILTER_REJECT;
        if (!isInsideArticle(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    for (const node of textNodes) {
      annotateTextNode(node);
    }
  }

  function annotateTextNode(textNode) {
    const text = textNode.textContent;
    if (!text || !text.trim()) return;
    if (isAlreadyAnnotatedWordNode(textNode)) return;

    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    const regex = /[a-zA-Z'-]+/g;
    let match;
    let didAnnotate = false;

    while ((match = regex.exec(text)) !== null) {
      const raw = match[0];
      const clean = normalizeWord(raw);
      // 固定短语检测：命中时用短语翻译覆盖
      const phraseCtx = text.slice(Math.max(0, match.index - 30), match.index + raw.length + 30);
      const phraseZh = getPhraseTranslation(clean, phraseCtx);
      if (phraseZh && !annotationMap[clean]) {
        annotationMap[clean] = { brief: phraseZh, meanings: [], isPhrase: true };
      }
      const entry = getAnnotationEntry(clean);
      const brief = phraseZh || entry?.brief;
      if (!brief) continue;

      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      fragment.appendChild(document.createTextNode(raw));

      const cn = document.createElement("span");
      cn.className = "ww-cn";
      cn.textContent = `(${brief})`;
      cn.dataset.wwWord = clean;
      cn.dataset.wwChinese = brief;
      fragment.appendChild(cn);

      lastIndex = match.index + raw.length;
      didAnnotate = true;
    }

    if (!didAnnotate) return;

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    textNode.parentNode.replaceChild(fragment, textNode);
  }

  // === Pronunciation ===
  let _audioEl = null;
  let _playId = 0; // monotonic id to detect stale callbacks

  function playPronunciation(word, accent) {
    if (!word) return;
    stopPronunciation();

    const id = ++_playId;
    const type = accent === "uk" ? 1 : 2;
    const url = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=${type}`;

    const audio = new Audio(url);
    audio.volume = 1.0;
    _audioEl = audio;

    _setPlayingState(accent, true);

    const cleanup = () => {
      if (_playId !== id) return; // stale
      _setPlayingState(accent, false);
      if (_audioEl === audio) _audioEl = null;
    };

    audio.addEventListener("ended", cleanup, { once: true });

    // On error: DON'T auto-fallback to speechSynthesis (that causes echo).
    // Just clean up silently.
    audio.addEventListener("error", cleanup, { once: true });

    audio.play().catch(cleanup);
  }

  function _setPlayingState(accent, playing) {
    const btn = document.querySelector(`#ww-detail .ww-dt-speak[data-accent="${accent}"]`);
    if (btn) btn.classList.toggle("playing", playing);
  }

  function stopPronunciation() {
    _playId++; // invalidate any in-flight callbacks
    if (_audioEl) {
      _audioEl.pause();
      _audioEl.removeAttribute("src");
      _audioEl.load(); // release network connection
      _audioEl = null;
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    document.querySelectorAll("#ww-detail .ww-dt-speak.playing").forEach((el) => el.classList.remove("playing"));
  }

  // === Detail panel ===
  function ensureDetailPanel() {
    if (!detailPanel) {
      detailPanel = document.createElement("div");
      detailPanel.id = "ww-detail";
      document.body.appendChild(detailPanel);
    }
    return detailPanel;
  }

  function positionDetailPanel(rect) {
    const panel = ensureDetailPanel();
    let left = rect.left + window.scrollX;
    const width = 340;
    if (left + width > window.scrollX + window.innerWidth - 8) {
      left = window.scrollX + window.innerWidth - width - 8;
    }
    panel.style.left = `${Math.max(window.scrollX + 8, left)}px`;
    panel.style.top = `${rect.bottom + window.scrollY + 8}px`;
  }

  function renderDetailPanel({
    word,
    brief,
    pos,
    phonetic,
    phoneticUk,
    phoneticUs,
    meanings,
    definitionEn,
    sentenceZh,
    context,
    exposureRemaining,
    manualLookupCount,
    loading = false,
  }) {
    const panel = ensureDetailPanel();
    currentDetailWord = word;

    const ew = escapeHtml(word);
    const meaningItems = normalizeMeanings(meanings);
    const headingMeaning = brief || meaningItems[0] || word;
    // Build the full alternative list: include current heading + all other meanings, dedup
    const allMeanings = [headingMeaning, ...meaningItems.filter((m) => m && m !== headingMeaning)];
    const uniqueMeanings = Array.from(new Set(allMeanings.filter(Boolean)));
    const detailMeaningsHtml = !loading && uniqueMeanings.length > 1
      ? `<div class="ww-dt-meanings">
          <div class="ww-dt-meanings-hint">点击切换当前释义</div>
          ${uniqueMeanings
            .map((item) => {
              const isCurrent = item === headingMeaning;
              const label = isCurrent ? "✓ " : "";
              return `<div class="ww-dt-meaning-item${isCurrent ? " is-current" : ""}" data-meaning="${escapeHtml(item)}" data-word="${ew}">${label}${escapeHtml(item)}</div>`;
            })
            .join("")}
        </div>`
      : "";

    // Phonetics — always show both UK & US speaker buttons (Youdao supports any word)
    const speakerSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
    const ukText = phoneticUk ? ` ${escapeHtml(phoneticUk)}` : "";
    const usText = phoneticUs ? ` ${escapeHtml(phoneticUs)}` : (phonetic ? ` ${escapeHtml(phonetic)}` : "");
    const phoneticHtml = `<div class="ww-dt-phonetics">
      <span class="ww-dt-pn-group"><button class="ww-dt-speak" data-accent="uk" data-word="${ew}" title="英式发音">${speakerSvg}</button><span class="ww-dt-pn-label">UK</span>${ukText}</span>
      <span class="ww-dt-pn-sep">|</span>
      <span class="ww-dt-pn-group"><button class="ww-dt-speak" data-accent="us" data-word="${ew}" title="美式发音">${speakerSvg}</button><span class="ww-dt-pn-label">US</span>${usText}</span>
    </div>`;

    // English definitions
    const enDefs = Array.isArray(definitionEn) ? definitionEn.filter(Boolean) : [];
    const enDefsHtml = !loading && enDefs.length
      ? `<div class="ww-dt-en-defs">
          <div class="ww-dt-en-label">English</div>
          ${enDefs.map((d) => `<div class="ww-dt-en-item">${escapeHtml(d)}</div>`).join("")}
        </div>`
      : "";

    const metaParts = [];
    if (typeof exposureRemaining === "number") {
      metaParts.push(`本轮还会提示 ${Math.max(0, exposureRemaining)} 次`);
    }
    if (typeof manualLookupCount === "number" && manualLookupCount > 0) {
      metaParts.push(`主动查词 ${manualLookupCount} 次`);
    }

    panel.innerHTML = `
      <div class="ww-dt-header">
        <span class="ww-dt-word">${escapeHtml(word)}</span>
        ${pos ? `<span class="ww-dt-pos">${escapeHtml(pos)}</span>` : ""}
      </div>
      ${phoneticHtml}
      <div class="ww-dt-meaning">${escapeHtml(headingMeaning)}</div>
      ${loading ? `<div class="ww-dt-empty">加载中...</div>` : detailMeaningsHtml}
      ${enDefsHtml}
      ${sentenceZh ? `<div class="ww-dt-context">${escapeHtml(sentenceZh)}</div>` : (context && !loading ? `<div class="ww-dt-context ww-dt-ctx-loading">${highlightWord(context, word)}</div>` : "")}
      ${metaParts.length ? `<div class="ww-dt-meta">${metaParts.map(escapeHtml).join(" · ")}</div>` : ""}
      <div class="ww-dt-actions">
        <button class="ww-btn-add" data-action="add" data-word="${escapeHtml(word)}" data-chinese="${escapeHtml(headingMeaning)}">+ 生词本</button>
        <button class="ww-btn-know" data-action="know" data-word="${escapeHtml(word)}">我认识</button>
        <button class="ww-btn-ignore" data-action="ignore" data-word="${escapeHtml(word)}">本页隐藏</button>
      </div>
    `;
    panel.style.display = "block";
  }

  function hideDetail() {
    stopPronunciation();
    if (detailPanel) detailPanel.style.display = "none";
    currentDetailWord = null;
  }

  // === LLM 状态提示 ===
  let llmBannerEl = null;
  let llmBannerTimer = null;

  function showLlmWarning(detail = "") {
    if (llmBannerEl) return; // 已经在显示
    const suffix = detail ? `：${escapeHtml(String(detail).slice(0, 120))}` : "";
    llmBannerEl = document.createElement("div");
    llmBannerEl.id = "ww-banner";
    llmBannerEl.innerHTML = `
      <svg style="width:16px;height:16px;vertical-align:-2px;margin-right:6px" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span>AI 翻译服务未连接 — 当前使用本地词典${suffix}</span>
      <button class="ww-banner-close" title="关闭">&times;</button>
    `;
    document.body.appendChild(llmBannerEl);
    requestAnimationFrame(() => llmBannerEl.classList.add("ww-show"));
    llmBannerEl.querySelector(".ww-banner-close").addEventListener("click", dismissLlmWarning);
    // 15秒后自动消失
    llmBannerTimer = setTimeout(dismissLlmWarning, 15000);
  }

  function dismissLlmWarning() {
    if (llmBannerTimer) { clearTimeout(llmBannerTimer); llmBannerTimer = null; }
    if (!llmBannerEl) return;
    llmBannerEl.classList.remove("ww-show");
    setTimeout(() => { llmBannerEl?.remove(); llmBannerEl = null; }, 350);
  }

  async function lookupWord(word, sentence, triggerCycle) {
    const result = await sendMsg({
      type: "lookup_word",
      word,
      sentence,
      pageUrl: window.location.href,
      triggerCycle,
    });
    if (!result.error) {
      storeAnnotationEntry(result);
    }
    return result;
  }

  async function showDetailForAnnotation(el) {
    const rect = el.getBoundingClientRect();
    const word = el.dataset.wwWord;
    const entry = getAnnotationEntry(word) || { brief: el.dataset.wwChinese || "", meanings: [] };
    const context = getContextText(el);
    const cachedZh = entry.sentenceZh || null;

    stopPronunciation();
    positionDetailPanel(rect);
    // 直接用本地缓存数据渲染，不等 LLM
    renderDetailPanel({
      word,
      brief: entry.brief,
      pos: entry.pos,
      phonetic: entry.phonetic,
      phoneticUk: entry.phoneticUk,
      phoneticUs: entry.phoneticUs,
      meanings: entry.meanings,
      definitionEn: entry.definitionEn,
      sentenceZh: cachedZh,
      exposureRemaining: entry.exposureRemaining,
      manualLookupCount: entry.manualLookupCount,
      context,
    });

    // 后台静默请求 lookup（记录曝光、补充更多数据），不阻塞 UI
    const detail = await lookupWord(word, context, false);
    if (detail.error || currentDetailWord !== word) return;

    // 只有当 lookup 返回了更丰富的数据时才更新面板
    const hasNewData = (
      (detail.phonetic_uk && !entry.phoneticUk) ||
      (detail.phonetic_us && !entry.phoneticUs) ||
      (detail.definition_en?.length && !entry.definitionEn?.length) ||
      (detail.sentence_zh && !cachedZh) ||
      (detail.meanings?.length > (entry.meanings?.length || 0))
    );
    if (hasNewData) {
      stopPronunciation();
      positionDetailPanel(rect);
      renderDetailPanel({
        word,
        brief: detail.brief || entry.brief,
        pos: detail.pos || entry.pos,
        phonetic: detail.phonetic || entry.phonetic,
        phoneticUk: detail.phonetic_uk || entry.phoneticUk,
        phoneticUs: detail.phonetic_us || entry.phoneticUs,
        meanings: detail.meanings?.length ? detail.meanings : entry.meanings,
        definitionEn: detail.definition_en?.length ? detail.definition_en : entry.definitionEn,
        sentenceZh: detail.sentence_zh || cachedZh,
        exposureRemaining: detail.exposure_remaining,
        manualLookupCount: detail.manual_lookup_count,
        context,
      });
    }

    // 更新缓存
    storeAnnotationEntry(detail);
  }

  function getSelectionPayload() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

    const raw = selection.toString().trim();
    const word = normalizeWord(raw);
    if (!word || /\s/.test(raw) || !shouldProcess(word)) return null;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;

    return {
      word,
      rect,
      context: getContextText(selection.anchorNode),
    };
  }

  async function handleSelectionLookup() {
    const payload = getSelectionPayload();
    if (!payload) return;

    stopPronunciation();
    positionDetailPanel(payload.rect);
    renderDetailPanel({
      word: payload.word,
      brief: "",
      meanings: [],
      definitionEn: [],
      sentenceZh: null,
      context: payload.context,
      loading: true,
    });

    const detail = await lookupWord(payload.word, payload.context, true);
    if (detail.error || currentDetailWord !== payload.word) return;

    stopPronunciation();
    annotationMap[payload.word] = {
      brief: detail.brief,
      pos: detail.pos || null,
      phonetic: detail.phonetic || null,
      phoneticUk: detail.phonetic_uk || null,
      phoneticUs: detail.phonetic_us || null,
      meanings: normalizeMeanings(detail.meanings),
      definitionEn: Array.isArray(detail.definition_en) ? detail.definition_en : [],
      sentenceZh: detail.sentence_zh || null,
      exposureRemaining: detail.exposure_remaining,
      manualLookupCount: detail.manual_lookup_count,
    };

    annotateDOM(getArticleRoot());
    positionDetailPanel(payload.rect);
    renderDetailPanel({
      word: payload.word,
      brief: detail.brief,
      pos: detail.pos,
      phonetic: detail.phonetic,
      phoneticUk: detail.phonetic_uk,
      phoneticUs: detail.phonetic_us,
      meanings: detail.meanings,
      definitionEn: detail.definition_en,
      sentenceZh: detail.sentence_zh || null,
      exposureRemaining: detail.exposure_remaining,
      manualLookupCount: detail.manual_lookup_count,
      context: payload.context,
    });
  }

  // === Event listeners ===
  function setupListeners() {
    document.body.addEventListener("click", (event) => {
      const cn = event.target.closest(".ww-cn");
      if (cn) {
        event.preventDefault();
        event.stopPropagation();
        void showDetailForAnnotation(cn);
        return;
      }

      const speakBtn = event.target.closest("#ww-detail .ww-dt-speak");
      if (speakBtn) {
        event.preventDefault();
        event.stopPropagation();
        playPronunciation(speakBtn.dataset.word, speakBtn.dataset.accent);
        return;
      }

      // Click on an alternative meaning item → switch the inline translation
      const meaningItem = event.target.closest("#ww-detail .ww-dt-meaning-item");
      if (meaningItem && !meaningItem.classList.contains("is-current")) {
        event.preventDefault();
        event.stopPropagation();
        const w = meaningItem.dataset.word;
        const m = meaningItem.dataset.meaning;
        changeAnnotationMeaning(w, m);
        // Re-render the panel so the new meaning shows as "current"
        const entry = getAnnotationEntry(w);
        if (entry) {
          renderDetailPanel({
            word: w,
            brief: entry.brief,
            pos: entry.pos,
            phonetic: entry.phonetic,
            phoneticUk: entry.phoneticUk,
            phoneticUs: entry.phoneticUs,
            meanings: entry.meanings,
            definitionEn: entry.definitionEn,
            sentenceZh: entry.sentenceZh,
            exposureRemaining: entry.exposureRemaining,
            manualLookupCount: entry.manualLookupCount,
          });
          // Keep panel anchored to the annotation on page
          const anchor = document.querySelector(`.ww-cn[data-ww-word="${w}"]`);
          if (anchor) positionDetailPanel(anchor.getBoundingClientRect());
        }
        return;
      }

      const btn = event.target.closest("#ww-detail button[data-action]");
      if (btn) {
        event.preventDefault();
        event.stopPropagation();
        const action = btn.dataset.action;
        const word = btn.dataset.word;

        if (action === "know") {
          void sendMsg({ type: "update_word_status", lemma: word, status: "mastered" });
          removeAnnotation(word);
        } else if (action === "add") {
          void sendMsg({
            type: "encounter_word",
            word: {
              lemma: word,
              definition_cn: btn.dataset.chinese || "",
              source_url: window.location.href,
              clicked_translation: true,
            },
          });
          const existing = getAnnotationEntry(word) || { brief: btn.dataset.chinese || "", meanings: [] };
          existing.exposureRemaining = 10;
          existing.manualLookupCount = (existing.manualLookupCount || 0) + 1;
          annotationMap[word] = existing;
          btn.textContent = "已加入 ✓";
          btn.style.opacity = "0.6";
        } else if (action === "ignore") {
          removeAnnotation(word);
        }
        hideDetail();
        return;
      }

      if (!event.target.closest("#ww-detail")) hideDetail();
    });

    document.addEventListener("mouseup", () => {
      clearTimeout(selectionLookupTimer);
      selectionLookupTimer = setTimeout(() => {
        void handleSelectionLookup();
      }, SELECTION_LOOKUP_DELAY_MS);
    });
  }

  function removeAnnotation(word) {
    document.querySelectorAll(`.ww-cn[data-ww-word="${word}"]`).forEach((el) => el.remove());
    delete annotationMap[word];
  }

  /** 切换某个词在文本中显示的中文释义 */
  function changeAnnotationMeaning(word, newMeaning) {
    if (!word || !newMeaning) return;
    const lemma = word.toLowerCase();

    // 1. 更新页面上所有该词的标注
    document.querySelectorAll(`.ww-cn[data-ww-word="${lemma}"]`).forEach((el) => {
      el.textContent = `(${newMeaning})`;
      el.dataset.wwChinese = newMeaning;
    });

    // 2. 更新本地 annotationMap（brief 作为当前显示的释义）
    const existing = getAnnotationEntry(lemma);
    if (existing) {
      const meanings = Array.isArray(existing.meanings) ? existing.meanings.slice() : [];
      // 把新释义放到首位，旧的 brief 加到 meanings 里（如果没有的话）
      if (existing.brief && existing.brief !== newMeaning && !meanings.includes(existing.brief)) {
        meanings.unshift(existing.brief);
      }
      const deduped = Array.from(new Set([newMeaning, ...meanings.filter((m) => m !== newMeaning)]));
      annotationMap[lemma] = {
        ...existing,
        brief: newMeaning,
        meanings: deduped,
      };
    } else {
      annotationMap[lemma] = { brief: newMeaning, meanings: [newMeaning] };
    }

    // 3. 持久化到后端（更新该词的主释义）
    void sendMsg({
      type: "encounter_word",
      word: {
        lemma,
        definition_cn: newMeaning,
        source_url: window.location.href,
      },
    });
  }

  function clearAllAnnotations() {
    document.querySelectorAll(".ww-cn").forEach((el) => el.remove());
    annotationMap = {};
    scannedWords = new Set();
    _articleRoot = null; // 重新检测文章区域
  }

  async function rescanPage() {
    clearAllAnnotations();
    await scanPage();
  }

  // 监听来自 popup/background 的消息（如切换等级后重新扫描）
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "rescan_page") {
      rescanPage().then(() => sendResponse({ ok: true }));
      return true;
    }
  });

  // === Article Summary Sidebar ===
  let summaryPanel = null;
  let summaryFab = null;
  let summaryData = null;
  let summaryLang = "zh"; // "zh" | "en" | "bilingual"

  function extractArticleText() {
    const root = getArticleRoot();
    const blocks = root.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, blockquote, figcaption");
    const parts = [];
    for (const block of blocks) {
      if (block.closest(NON_ARTICLE_SELECTORS)) continue;
      const text = block.textContent?.trim();
      if (text && text.length > 5) parts.push(text);
    }
    return parts.join("\n\n");
  }

  function ensureSummaryFab() {
    if (summaryFab) return summaryFab;
    summaryFab = document.createElement("button");
    summaryFab.id = "ww-summary-fab";
    summaryFab.title = "AI 文章摘要";
    summaryFab.innerHTML = `
      <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
      <span class="ww-fab-badge"></span>
    `;
    document.body.appendChild(summaryFab);

    summaryFab.addEventListener("click", (e) => {
      e.stopPropagation();
      if (summaryData) {
        toggleSummaryPanel();
      } else {
        requestSummary();
      }
    });

    return summaryFab;
  }

  function ensureSummaryPanel() {
    if (summaryPanel) return summaryPanel;
    summaryPanel = document.createElement("div");
    summaryPanel.id = "ww-summary";
    document.body.appendChild(summaryPanel);
    return summaryPanel;
  }

  function toggleSummaryPanel() {
    const panel = ensureSummaryPanel();
    const isVisible = panel.classList.contains("ww-show");
    if (isVisible) {
      panel.classList.remove("ww-show");
    } else {
      panel.classList.add("ww-show");
    }
  }

  // Build the persistent shell used during streaming. Sections are appended
  // into .ww-sum-body as they arrive. Shows a full skeleton (title +
  // overview + 4 placeholder sections) so the panel reads as "loading"
  // without any spinning icon.
  function renderSummaryShell(lang) {
    const panel = ensureSummaryPanel();
    const langBtns = ["zh", "en", "bilingual"].map((l) => {
      const label = l === "zh" ? "中" : l === "en" ? "EN" : "双";
      const active = l === lang ? " active" : "";
      return `<button class="ww-sum-lang-btn${active}" data-lang="${l}">${label}</button>`;
    }).join("");

    const placeholderSections = Array.from({ length: 4 }).map(() => `
      <div class="ww-sum-section ww-sum-section-pending">
        <div class="ww-sum-section-head">
          <span class="ww-sum-section-dot ww-sum-section-dot-pending"></span>
          <span class="ww-sum-skeleton ww-sum-skeleton-heading"></span>
        </div>
        <div class="ww-sum-points">
          <div class="ww-sum-point-pending"><span class="ww-sum-skeleton"></span></div>
          <div class="ww-sum-point-pending"><span class="ww-sum-skeleton"></span></div>
        </div>
      </div>
    `).join("");

    panel.innerHTML = `
      <div class="ww-sum-header">
        <div class="ww-sum-brand">
          <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
          <span class="ww-sum-brand-text">Overview</span>
          <span class="ww-sum-thinking" aria-hidden="true"><span></span><span></span><span></span></span>
        </div>
        <div class="ww-sum-actions">
          ${langBtns}
          <button class="ww-sum-close" title="关闭">✕</button>
        </div>
        <div class="ww-sum-progress" aria-hidden="true"></div>
      </div>
      <div class="ww-sum-body">
        <div class="ww-sum-title ww-sum-title-pending"><span class="ww-sum-skeleton"></span></div>
        <div class="ww-sum-overview ww-sum-overview-pending"><span class="ww-sum-skeleton"></span><span class="ww-sum-skeleton"></span></div>
        ${placeholderSections}
      </div>
    `;
    panel.classList.add("ww-streaming");

    panel.querySelectorAll(".ww-sum-lang-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        summaryLang = btn.dataset.lang;
        if (summaryData) renderSummary(summaryData, summaryLang);
      });
    });
    panel.querySelector(".ww-sum-close").addEventListener("click", (e) => {
      e.stopPropagation();
      panel.classList.remove("ww-show");
    });
    panel.classList.add("ww-show");
    return panel;
  }

  function removeSummaryPlaceholders(panel) {
    panel.querySelectorAll(".ww-sum-section-pending").forEach((el) => el.remove());
  }

  /**
   * Split text into animatable tokens (words for English, chars for CJK).
   * Returns HTML where each token is wrapped in <span class="ww-tok" style="--i:N">...</span>
   * `startIndex` lets multiple lines share a continuous stagger.
   */
  function tokenizeForReveal(text, startIndex = 0) {
    if (!text) return { html: "", count: 0 };
    const str = String(text);
    let i = startIndex;
    let html = "";
    // Split into runs of (CJK char | non-CJK chunk separated by spaces)
    // Strategy: iterate codepoints; group ASCII into words, treat CJK as single tokens.
    let buffer = "";
    const flushAscii = () => {
      if (!buffer) return;
      // Split on spaces, keep spaces as static separators
      const parts = buffer.split(/(\s+)/);
      for (const part of parts) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          html += part;
        } else {
          html += `<span class="ww-tok" style="--i:${i}">${escapeHtml(part)}</span>`;
          i++;
        }
      }
      buffer = "";
    };
    for (const ch of str) {
      const code = ch.codePointAt(0);
      // CJK Unified Ideographs / Hiragana / Katakana / Hangul / fullwidth punct
      const isCJK = (
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3000 && code <= 0x303f) ||
        (code >= 0x3040 && code <= 0x30ff) ||
        (code >= 0xac00 && code <= 0xd7af) ||
        (code >= 0xff00 && code <= 0xffef)
      );
      if (isCJK) {
        flushAscii();
        html += `<span class="ww-tok" style="--i:${i}">${escapeHtml(ch)}</span>`;
        i++;
      } else {
        buffer += ch;
      }
    }
    flushAscii();
    return { html, count: i - startIndex };
  }

  function applyMetaToShell(panel, meta, lang) {
    const isZh = lang === "zh";
    const isBi = lang === "bilingual";
    const titleEl = panel.querySelector(".ww-sum-title");
    const overviewEl = panel.querySelector(".ww-sum-overview");
    if (titleEl) {
      titleEl.classList.remove("ww-sum-title-pending");
      titleEl.innerHTML = "";
      let i = 0;
      if (isBi) {
        const a = tokenizeForReveal(meta.title_zh || "", i); i += a.count;
        const b = tokenizeForReveal(meta.title_en || "", i); i += b.count;
        titleEl.innerHTML = `${a.html}<br><span style="font-weight:500;font-size:13px;color:#64748b">${b.html}</span>`;
      } else {
        const txt = isZh ? (meta.title_zh || meta.title_en) : (meta.title_en || meta.title_zh);
        titleEl.innerHTML = tokenizeForReveal(txt || "", 0).html;
      }
    }
    if (overviewEl) {
      overviewEl.classList.remove("ww-sum-overview-pending");
      overviewEl.innerHTML = "";
      // Title may have ~10 tokens; start overview shortly after but not too late
      let i = 8;
      if (isBi) {
        const a = tokenizeForReveal(meta.overview_zh || "", i); i += a.count;
        const b = tokenizeForReveal(meta.overview_en || "", i); i += b.count;
        overviewEl.innerHTML = `${a.html}<br><span style="color:#94a3b8">${b.html}</span>`;
      } else {
        const txt = isZh ? (meta.overview_zh || meta.overview_en) : (meta.overview_en || meta.overview_zh);
        overviewEl.innerHTML = tokenizeForReveal(txt || "", i).html;
      }
    }
  }

  function appendSectionToShell(panel, sec, lang) {
    const body = panel.querySelector(".ww-sum-body");
    if (!body) return;
    const isZh = lang === "zh";
    const isBi = lang === "bilingual";

    let tokIdx = 0;
    let heading;
    if (isBi) {
      const a = tokenizeForReveal(sec.heading_zh || "", tokIdx); tokIdx += a.count;
      const b = tokenizeForReveal(sec.heading_en || "", tokIdx); tokIdx += b.count;
      heading = `${a.html}<span style="font-weight:400;color:#94a3b8;font-size:11px;margin-left:6px">${b.html}</span>`;
    } else {
      const txt = isZh ? (sec.heading_zh || sec.heading_en) : (sec.heading_en || sec.heading_zh);
      const r = tokenizeForReveal(txt || "", tokIdx); tokIdx += r.count;
      heading = r.html;
    }

    const points = isZh ? (sec.points_zh || sec.points_en || []) : (sec.points_en || sec.points_zh || []);
    const pointsBi = isBi ? (sec.points_en || []) : [];
    const pointsHtml = points.map((pt, idx) => {
      let html = `<div class="ww-sum-point">`;
      const r = tokenizeForReveal(pt || "", tokIdx); tokIdx += r.count;
      html += r.html;
      if (isBi && pointsBi[idx]) {
        const r2 = tokenizeForReveal(pointsBi[idx], tokIdx); tokIdx += r2.count;
        html += `<br><span style="color:#94a3b8;font-size:11px">${r2.html}</span>`;
      }
      html += `</div>`;
      return html;
    }).join("");

    const wrap = document.createElement("div");
    wrap.className = "ww-sum-section ww-sum-section-enter";
    wrap.innerHTML = `
      <div class="ww-sum-section-head">
        <span class="ww-sum-section-dot"></span>
        <span class="ww-sum-section-title">${heading}</span>
      </div>
      <div class="ww-sum-points">${pointsHtml}</div>
    `;
    // Insert before the first placeholder (so placeholders get pushed down
    // and consumed one-by-one as real sections arrive).
    const firstPending = body.querySelector(".ww-sum-section-pending");
    if (firstPending) {
      body.insertBefore(wrap, firstPending);
      firstPending.remove();
    } else {
      body.appendChild(wrap);
    }
  }

  function renderSummaryError(msg) {
    const panel = ensureSummaryPanel();
    panel.innerHTML = `
      <div class="ww-sum-header">
        <div class="ww-sum-brand">
          <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
          <span class="ww-sum-brand-text">Overview</span>
        </div>
        <div class="ww-sum-actions">
          <button class="ww-sum-close" title="关闭">✕</button>
        </div>
      </div>
      <div class="ww-sum-error">${escapeHtml(msg)}</div>
    `;
    panel.querySelector(".ww-sum-close").addEventListener("click", () => {
      panel.classList.remove("ww-show");
    });
    panel.classList.add("ww-show");
  }

  function renderSummary(data, lang) {
    const panel = ensureSummaryPanel();
    const isZh = lang === "zh";
    const isBi = lang === "bilingual";

    const title = isBi
      ? `${escapeHtml(data.title_zh || "")}<br><span style="font-weight:500;font-size:13px;color:#64748b">${escapeHtml(data.title_en || "")}</span>`
      : escapeHtml(isZh ? (data.title_zh || data.title_en) : (data.title_en || data.title_zh));

    const overview = isBi
      ? `${escapeHtml(data.overview_zh || "")}<br><span style="color:#94a3b8">${escapeHtml(data.overview_en || "")}</span>`
      : escapeHtml(isZh ? (data.overview_zh || data.overview_en) : (data.overview_en || data.overview_zh));

    const sections = Array.isArray(data.sections) ? data.sections : [];
    const sectionsHtml = sections.map((sec) => {
      const heading = isBi
        ? `${escapeHtml(sec.heading_zh || "")}<span style="font-weight:400;color:#94a3b8;font-size:11px;margin-left:6px">${escapeHtml(sec.heading_en || "")}</span>`
        : escapeHtml(isZh ? (sec.heading_zh || sec.heading_en) : (sec.heading_en || sec.heading_zh));

      const points = isZh ? (sec.points_zh || sec.points_en || []) : (sec.points_en || sec.points_zh || []);
      const pointsBi = isBi ? (sec.points_en || []) : [];

      const pointsHtml = points.map((pt, i) => {
        let html = `<div class="ww-sum-point">${escapeHtml(pt)}`;
        if (isBi && pointsBi[i]) {
          html += `<br><span style="color:#94a3b8;font-size:11px">${escapeHtml(pointsBi[i])}</span>`;
        }
        html += `</div>`;
        return html;
      }).join("");

      return `
        <div class="ww-sum-section">
          <div class="ww-sum-section-head">
            <span class="ww-sum-section-dot"></span>
            <span class="ww-sum-section-title">${heading}</span>
          </div>
          <div class="ww-sum-points">${pointsHtml}</div>
        </div>
      `;
    }).join("");

    const langBtns = ["zh", "en", "bilingual"].map((l) => {
      const label = l === "zh" ? "中" : l === "en" ? "EN" : "双";
      const active = l === lang ? " active" : "";
      return `<button class="ww-sum-lang-btn${active}" data-lang="${l}">${label}</button>`;
    }).join("");

    panel.innerHTML = `
      <div class="ww-sum-header">
        <div class="ww-sum-brand">
          <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
          <span class="ww-sum-brand-text">Overview</span>
        </div>
        <div class="ww-sum-actions">
          ${langBtns}
          <button class="ww-sum-close" title="关闭">✕</button>
        </div>
      </div>
      <div class="ww-sum-body">
        <div class="ww-sum-title">${title}</div>
        <div class="ww-sum-overview">${overview}</div>
        ${sectionsHtml}
      </div>
    `;

    // Language switch handlers
    panel.querySelectorAll(".ww-sum-lang-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        summaryLang = btn.dataset.lang;
        renderSummary(summaryData, summaryLang);
      });
    });

    panel.querySelector(".ww-sum-close").addEventListener("click", (e) => {
      e.stopPropagation();
      panel.classList.remove("ww-show");
    });

    panel.classList.add("ww-show");
  }

  async function requestSummary() {
    const text = extractArticleText();
    const fab = ensureSummaryFab();
    if (!text || text.length < 100) {
      renderSummaryError("当前页面没有足够的正文内容可以生成摘要");
      return;
    }

    fab.classList.add("ww-loading");
    // Show the full skeleton shell immediately so the panel is alive on click.
    const panel = renderSummaryShell(summaryLang);

    const accumulator = { sections: [] };
    let gotError = false;
    let port;
    try {
      port = chrome.runtime.connect({ name: "ww-summarize" });
    } catch (err) {
      fab.classList.remove("ww-loading");
      renderSummaryError(err?.message || String(err));
      return;
    }

    port.onMessage.addListener((evt) => {
      if (!evt || !evt.type) return;
      if (evt.type === "meta") {
        Object.assign(accumulator, evt.data || {});
        applyMetaToShell(panel, evt.data || {}, summaryLang);
      } else if (evt.type === "section") {
        accumulator.sections.push(evt.data || {});
        appendSectionToShell(panel, evt.data || {}, summaryLang);
      } else if (evt.type === "error") {
        gotError = true;
        fab.classList.remove("ww-loading");
        panel.classList.remove("ww-streaming");
        renderSummaryError(evt.data?.message || "未知错误");
      } else if (evt.type === "done") {
        // Persist final data so language switcher and re-opens work.
        summaryData = accumulator;
        fab.classList.remove("ww-loading");
        fab.classList.add("ww-has-summary");
        removeSummaryPlaceholders(panel);
        panel.classList.remove("ww-streaming");
      }
    });

    port.onDisconnect.addListener(() => {
      fab.classList.remove("ww-loading");
      panel.classList.remove("ww-streaming");
      removeSummaryPlaceholders(panel);
      // Disconnect without "done" or "error" — fall back to partial / error.
      if (gotError) return;
      if (!summaryData && (accumulator.title_en || accumulator.sections.length)) {
        // Stream cut early but partial content arrived; treat partial as final.
        summaryData = accumulator;
        fab.classList.add("ww-has-summary");
      } else if (!summaryData) {
        renderSummaryError("摘要服务连接中断，请重试");
      }
    });

    port.postMessage({
      type: "start",
      text,
      pageUrl: window.location.href,
    });
  }

  function initSummaryFab() {
    // Always show the FAB so the user has a fixed entry point.
    // The click handler will show a friendly message if the page has no article.
    const fab = ensureSummaryFab();
    fab.classList.add("ww-show");
  }

  // === Main scan ===
  async function scanPage() {
    if (!isEnabled) return;
    if (isScanning) {
      scanQueued = true;
      return;
    }
    isScanning = true;
    scanQueued = false;

    try {
      const wordContexts = extractWordsFromParagraphs()
        .filter((wc) => {
          const lemma = normalizeWord(wc.word);
          return lemma && !scannedWords.has(lemma);
        });
      if (wordContexts.length === 0) return;

      for (const wc of wordContexts) {
        scannedWords.add(normalizeWord(wc.word));
      }

      for (let i = 0; i < wordContexts.length; i += MAX_WORDS_PER_BATCH) {
        const batch = wordContexts.slice(i, i + MAX_WORDS_PER_BATCH);
        const result = await sendMsg({
          type: "scan_page",
          words: batch,
          page_url: window.location.href,
          pageSessionId,
        });

        if (result.error) {
          for (const item of batch) scannedWords.delete(normalizeWord(item.word));
          continue;
        }

        // LLM 状态检测
        if (result.llm_ok === false) {
          showLlmWarning(result.llm_error || "");
        }

        for (const item of result.annotations || []) {
          annotationMap[item.word.toLowerCase()] = {
            brief: item.chinese,
            meanings: [],
          };
        }
      }

      annotateDOM(getArticleRoot());
    } finally {
      isScanning = false;
      if (scanQueued) {
        scanQueued = false;
        clearTimeout(scanTimeout);
        scanTimeout = setTimeout(() => {
          void scanPage();
        }, SCAN_DEBOUNCE_MS);
      }
    }
  }

  // === Dynamic content ===
  let scanTimeout = null;
  function observeDynamicContent() {
    const observer = new MutationObserver((mutations) => {
      let hasNew = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (
            node.nodeType === Node.ELEMENT_NODE &&
            !node.classList.contains("ww-cn") &&
            !node.closest("#ww-detail, #ww-banner, #ww-summary, #ww-summary-fab")
          ) {
            hasNew = true;
            break;
          }
        }
        if (hasNew) break;
      }
      if (!hasNew) return;
      clearTimeout(scanTimeout);
      scanTimeout = setTimeout(() => {
        void scanPage();
      }, SCAN_DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // === Init ===
  async function init() {
    const { enabled } = await sendMsg({ type: "get_enabled" });
    isEnabled = enabled;
    if (!isEnabled) return;

    setupListeners();
    initSummaryFab();
    setTimeout(async () => {
      await scanPage();
      observeDynamicContent();
    }, 1000);
  }

  if (window.location.protocol === "chrome-extension:") return;

  init();
})();

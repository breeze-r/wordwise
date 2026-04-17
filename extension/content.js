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

  function extractWordsFromParagraphs() {
    const articleRoot = getArticleRoot();
    const blocks = articleRoot.querySelectorAll("p, li, td, h1, h2, h3, h4, h5, h6, blockquote, figcaption");
    const wordContexts = [];
    const seen = new Set();

    for (const block of blocks) {
      // 跳过嵌套在非正文区域里的元素
      if (block.closest(NON_ARTICLE_SELECTORS)) continue;
      const text = block.textContent || "";
      if (!text.trim() || text.length < 10) continue;
      // 整段文本用于 LLM 段落级语义消歧（截取前500字）
      const paragraph = text.trim().slice(0, 500);

      const regex = /[a-zA-Z'-]+/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const clean = normalizeWord(match[0]);
        if (!shouldProcess(clean)) continue;
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

  function showLlmWarning() {
    if (llmBannerEl) return; // 已经在显示
    llmBannerEl = document.createElement("div");
    llmBannerEl.id = "ww-banner";
    llmBannerEl.innerHTML = `
      <svg style="width:16px;height:16px;vertical-align:-2px;margin-right:6px" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span>AI 翻译服务未连接 — 当前使用本地词典，请在扩展设置中检查 API 配置</span>
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

  function renderSummaryLoading() {
    const panel = ensureSummaryPanel();
    panel.innerHTML = `
      <div class="ww-sum-header">
        <div class="ww-sum-brand">
          <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
          <span class="ww-sum-brand-text">Overview</span>
        </div>
      </div>
      <div class="ww-sum-loading">正在生成摘要...</div>
    `;
    panel.classList.add("ww-show");
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
    if (!text || text.length < 100) return;

    const fab = ensureSummaryFab();
    fab.classList.add("ww-loading");
    renderSummaryLoading();

    const result = await sendMsg({
      type: "summarize_article",
      text,
      pageUrl: window.location.href,
    });

    fab.classList.remove("ww-loading");

    if (result.error) {
      renderSummaryError(result.error);
      return;
    }

    summaryData = result;
    fab.classList.add("ww-has-summary");
    renderSummary(summaryData, summaryLang);
  }

  function initSummaryFab() {
    // Only show FAB on pages with substantial text content
    const text = extractArticleText();
    if (text && text.length >= 300) {
      const fab = ensureSummaryFab();
      // Delay showing FAB to not distract from initial page load
      setTimeout(() => fab.classList.add("ww-show"), 2000);
    }
  }

  // === Main scan ===
  async function scanPage() {
    if (!isEnabled) return;

    const wordContexts = extractWordsFromParagraphs();
    if (wordContexts.length === 0) return;

    for (let i = 0; i < wordContexts.length; i += MAX_WORDS_PER_BATCH) {
      const batch = wordContexts.slice(i, i + MAX_WORDS_PER_BATCH);
      const result = await sendMsg({
        type: "scan_page",
        words: batch,
        page_url: window.location.href,
        pageSessionId,
      });

      if (result.error) {
        /* scan error — silently ignored */
        continue;
      }

      // LLM 状态检测
      if (result.llm_ok === false) {
        showLlmWarning();
      }

      for (const item of result.annotations || []) {
        annotationMap[item.word.toLowerCase()] = {
          brief: item.chinese,
          meanings: [],
        };
      }
    }

    annotateDOM(getArticleRoot());
  }

  // === Dynamic content ===
  let scanTimeout = null;
  function observeDynamicContent() {
    const observer = new MutationObserver((mutations) => {
      let hasNew = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && !node.closest("#ww-detail, #ww-banner, #ww-summary")) {
            hasNew = true;
            break;
          }
        }
        if (hasNew) break;
      }
      if (!hasNew) return;
      clearTimeout(scanTimeout);
      scanTimeout = setTimeout(() => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && !SKIP_TAGS.has(node.tagName)) {
              annotateDOM(node);
            }
          }
        }
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
    setTimeout(async () => {
      await scanPage();
      observeDynamicContent();
      initSummaryFab();
    }, 1000);
  }

  if (window.location.protocol === "chrome-extension:") return;

  init();
})();

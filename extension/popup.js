const $ = (id) => document.getElementById(id);
const DEFAULT_TRANSLATOR_CONFIG = {
  mode: "hybrid",
  apiKey: "",
  apiUrl: "",
  model: "",
};

function sendMsg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      resolve(res || { error: "no response" });
    });
  });
}

// === Host permission helper ===
async function ensureHostPermission(url) {
  if (!url || !url.trim()) return true;
  try {
    const urlObj = new URL(url.trim());
    // localhost is already granted via manifest host_permissions
    if (urlObj.hostname === "localhost" || urlObj.hostname === "127.0.0.1") return true;
    const origin = `${urlObj.protocol}//${urlObj.host}/*`;
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return true;
    // Request permission (must be in user gesture context, e.g. click handler)
    return await chrome.permissions.request({ origins: [origin] });
  } catch (e) {
    return false;
  }
}

function showView(view) {
  $("loadingView").style.display = "none";
  $("dashboardView").style.display = "none";

  if (view === "loading") $("loadingView").style.display = "block";
  if (view === "dashboard") $("dashboardView").style.display = "block";
}

function setSettingsStatus(msg, isError = false) {
  const el = $("settingsStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = isError ? "#e53935" : "#777";
}

// === Vocab Level ===
let currentVocabLevel = "high_school";
let vocabLevelsData = [];

async function loadVocabLevels() {
  const levels = await sendMsg({ type: "get_vocab_levels" });
  if (levels?.error || !Array.isArray(levels)) return;
  vocabLevelsData = levels;
  renderLevelChips();
}

function renderLevelChips() {
  const grid = $("levelGrid");
  if (!grid) return;
  grid.innerHTML = "";
  for (const lvl of vocabLevelsData) {
    const chip = document.createElement("span");
    chip.className = "chip" + (lvl.key === currentVocabLevel ? " active" : "");
    chip.dataset.level = lvl.key;
    chip.textContent = lvl.label;
    const countSpan = document.createElement("span");
    countSpan.className = "chip-count";
    countSpan.textContent = lvl.word_count.toLocaleString();
    chip.appendChild(countSpan);
    chip.addEventListener("click", () => onLevelClick(lvl.key));
    grid.appendChild(chip);
  }
}

async function onLevelClick(level) {
  if (level === currentVocabLevel) return;
  const statusEl = $("levelStatus");
  statusEl.textContent = "保存中...";
  statusEl.style.color = "#777";

  const result = await sendMsg({ type: "set_vocab_level", level });
  if (result?.error) {
    statusEl.textContent = "保存失败: " + result.error;
    statusEl.style.color = "#e53935";
    return;
  }
  currentVocabLevel = level;
  renderLevelChips();
  const matched = vocabLevelsData.find((l) => l.key === level);
  statusEl.textContent = `已切换到「${matched?.label || level}」，正在刷新页面标注...`;
  statusEl.style.color = "#777";
  // 同步更新词汇量显示
  if (matched?.word_count) {
    $("statVocab").textContent = matched.word_count.toLocaleString();
  }
  // 通知当前活跃标签页重新扫描
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: "rescan_page" });
    }
  } catch (e) { /* ignore if no active tab */ }
  statusEl.textContent = `已切换到「${matched?.label || level}」，${matched?.word_count?.toLocaleString() || "?"}词以下不再标注`;
  statusEl.style.color = "#4caf50";
}

// === Dict Packs ===
let allPacks = [];
let enabledPackIds = [];

async function loadDictPacks() {
  const [packs, enabled] = await Promise.all([
    sendMsg({ type: "get_dict_packs" }),
    sendMsg({ type: "get_enabled_packs" }),
  ]);
  if (Array.isArray(packs)) allPacks = packs;
  if (Array.isArray(enabled)) enabledPackIds = enabled;
  renderPackChips();
}

function renderPackChips() {
  const grid = $("packsGrid");
  if (!grid) return;
  grid.innerHTML = "";

  // 按类别分组显示
  for (const pack of allPacks) {
    const isActive = enabledPackIds.includes(pack.id);
    const chip = document.createElement("span");
    chip.className = "pack-chip" + (isActive ? " active" : "");
    chip.dataset.packId = pack.id;
    chip.title = pack.description;
    const iconSpan = document.createElement("span");
    iconSpan.className = "pack-icon";
    // pack.icon is trusted SVG markup from our own backend config
    iconSpan.innerHTML = pack.icon;
    chip.appendChild(iconSpan);
    chip.appendChild(document.createTextNode(pack.name));
    const countSpan = document.createElement("span");
    countSpan.className = "pack-count";
    countSpan.textContent = pack.word_count;
    chip.appendChild(countSpan);
    chip.addEventListener("click", () => onPackToggle(pack.id));
    grid.appendChild(chip);
  }
}

async function onPackToggle(packId) {
  const statusEl = $("packsStatus");
  const idx = enabledPackIds.indexOf(packId);
  if (idx >= 0) {
    enabledPackIds.splice(idx, 1);
  } else {
    enabledPackIds.push(packId);
  }
  statusEl.textContent = "保存中...";
  statusEl.style.color = "#777";
  await sendMsg({ type: "set_enabled_packs", packs: enabledPackIds });
  renderPackChips();

  const names = enabledPackIds
    .map((id) => allPacks.find((p) => p.id === id)?.name)
    .filter(Boolean);
  statusEl.textContent = names.length
    ? `已启用：${names.join("、")}`
    : "未启用任何词典包";
  statusEl.style.color = "#4caf50";
  // 通知当前页面重新扫描
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "rescan_page" });
  } catch (e) { /* ignore */ }
}

function normalizeTranslatorConfig(raw = {}) {
  return {
    mode: ["local_wordbook", "hybrid", "remote"].includes(raw.mode)
      ? raw.mode
      : DEFAULT_TRANSLATOR_CONFIG.mode,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
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

function renderTranslatorConfig(config) {
  const normalized = normalizeTranslatorConfig(config);
  $("translatorMode").value = normalized.mode;
  $("translatorApiUrl").value = normalized.apiUrl;
  $("translatorModel").value = normalized.model;
  $("translatorApiKey").value = normalized.apiKey;
  syncTranslatorFields();
}

function collectTranslatorConfig() {
  return normalizeTranslatorConfig({
    mode: $("translatorMode").value,
    apiUrl: $("translatorApiUrl").value,
    model: $("translatorModel").value,
    apiKey: $("translatorApiKey").value,
  });
}

function syncTranslatorFields() {
  const mode = $("translatorMode").value;
  const disabled = mode === "local_wordbook";
  $("translatorApiUrl").disabled = disabled;
  $("translatorModel").disabled = disabled;
  $("translatorApiKey").disabled = disabled;
  if (disabled) {
    setSettingsStatus("当前使用本地词典，不会请求 LLM。");
  } else {
    setSettingsStatus("");
  }
}

async function loadBackendUrl() {
  const baseResult = await sendMsg({ type: "get_api_base" });
  if (baseResult?.apiBase) {
    $("backendUrl").value = baseResult.apiBase;
  }
}

async function loadTranslatorConfig() {
  const config = await sendMsg({ type: "get_translator_config" });
  if (config?.error) {
    setSettingsStatus("读取 LLM 设置失败", true);
    renderTranslatorConfig(DEFAULT_TRANSLATOR_CONFIG);
    return;
  }
  renderTranslatorConfig(config);
}

// === Init ===
async function init() {
  showView("loading");
  await loadDashboard();

  // Listen for LLM status changes from scan results
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.llmOk) {
      const v = changes.llmOk.newValue;
      if (typeof v !== "boolean") updateLlmStatus("unknown");
      else updateLlmStatus(v ? "ok" : "error");
    }
  });
}

// === Dashboard ===
// status: "ok" | "error" | "unknown"
function updateLlmStatus(status) {
  const wrap = $("llmStatus");
  const dot = $("llmDot");
  const text = $("llmStatusText");
  if (!wrap) return;

  // Backward compat: accept boolean
  if (typeof status === "boolean") status = status ? "ok" : "error";

  wrap.classList.add("active");
  wrap.classList.toggle("ok", status === "ok");
  dot.className = "llm-dot " + (status === "ok" ? "ok" : status === "error" ? "error" : "unknown");

  if (status === "ok") {
    text.textContent = "AI 翻译服务正常运行中";
  } else if (status === "error") {
    text.textContent = "AI 翻译服务未连接 — 当前使用本地词典，请检查下方 LLM 设置";
  } else {
    text.textContent = "AI 翻译服务状态未知 — 打开任一英文网页触发检测";
  }
}

async function loadDashboard() {
  showView("dashboard");
  setSettingsStatus("");

  // Load local profile
  const user = await sendMsg({ type: "get_user" });
  if (user.error) {
    setSettingsStatus("无法连接本地后端，请确认服务已启动。", true);
    $("statVocab").textContent = "-";
    return;
  }
  // 词汇量先占位，等等级数据加载后同步
  $("statVocab").textContent = user.estimated_vocabulary || "-";

  // Load stats
  const stats = await sendMsg({ type: "get_stats" });
  if (!stats.error && stats.by_status) {
    $("statNew").textContent = stats.by_status.new_word || 0;
    $("statLearning").textContent = stats.by_status.learning || 0;
    $("statMastered").textContent = stats.by_status.mastered || 0;
    if (stats.estimated_vocabulary) {
      $("statVocab").textContent = stats.estimated_vocabulary.toLocaleString();
    }
  }

  // Load toggle state
  const { enabled } = await sendMsg({ type: "get_enabled" });
  const toggle = $("enableToggle");
  toggle.classList.toggle("on", enabled);

  // Load vocab level & sync vocabulary count
  currentVocabLevel = user.vocab_level || "high_school";
  await loadVocabLevels();
  // 如果没有做过词汇测试，用等级对应的词汇量
  if (!user.estimated_vocabulary) {
    const matched = vocabLevelsData.find((l) => l.key === currentVocabLevel);
    if (matched?.word_count) {
      $("statVocab").textContent = matched.word_count.toLocaleString();
    }
  }

  await loadBackendUrl();
  await loadDictPacks();
  await loadTranslatorConfig();

  // LLM 状态呼吸灯
  const llmStatus = await sendMsg({ type: "get_llm_status" });
  if (!llmStatus?.known) {
    updateLlmStatus("unknown");
  } else {
    updateLlmStatus(llmStatus.ok ? "ok" : "error");
  }
}

// === Toggle ===
$("enableToggle").addEventListener("click", async () => {
  const toggle = $("enableToggle");
  const newState = !toggle.classList.contains("on");
  toggle.classList.toggle("on", newState);
  await sendMsg({ type: "set_enabled", enabled: newState });
});

// === Backend URL ===
async function saveBackendUrl() {
  const url = $("backendUrl").value.trim();
  const statusEl = $("backendStatus");
  if (!url) return;

  // Request host permission for non-localhost URLs
  const granted = await ensureHostPermission(url);
  if (!granted) {
    statusEl.textContent = "需要授权访问该地址，请重试并在弹出的对话框中确认";
    statusEl.style.color = "#e53935";
    return;
  }

  statusEl.textContent = "保存中...";
  statusEl.style.color = "#777";
  await sendMsg({ type: "set_api_base", apiBase: url });
  statusEl.textContent = "已保存，重新打开页面生效";
  statusEl.style.color = "#4caf50";
}
$("backendUrl").addEventListener("change", saveBackendUrl);

$("translatorMode").addEventListener("change", () => {
  syncTranslatorFields();
});

$("saveSettingsBtn").addEventListener("click", async () => {
  const config = collectTranslatorConfig();
  if (config.mode !== "local_wordbook" && !config.apiKey) {
    setSettingsStatus("使用 LLM 时需要填写 API Key。", true);
    return;
  }

  // Request host permission for non-localhost LLM API URL
  if (config.mode !== "local_wordbook" && config.apiUrl) {
    const granted = await ensureHostPermission(config.apiUrl);
    if (!granted) {
      setSettingsStatus("需要授权访问 LLM API 地址，请重试并在弹出的对话框中确认", true);
      return;
    }
  }

  setSettingsStatus("保存中...");
  const result = await sendMsg({ type: "set_translator_config", config });
  if (result?.error) {
    setSettingsStatus("保存失败：" + result.error, true);
    return;
  }

  renderTranslatorConfig(result);
  setSettingsStatus("已保存，新的阅读请求会使用这组配置。");

  // 保存后重置状态为"待验证"，下次扫描会更新
  if (result.mode === "local_wordbook") {
    updateLlmStatus("ok");
  } else {
    // Clear stored status so it's re-detected on next scan
    await chrome.storage.local.remove("llmOk");
    updateLlmStatus("unknown");
  }
});

init();

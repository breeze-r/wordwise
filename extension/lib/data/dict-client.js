// Front-end dictionary client.
// Loads compact dictionary JSON once and caches in memory for fast lookup.
// Long-tail words fall through to the LLM via translator-client.

let _dictPromise = null;

async function _loadDict() {
  if (_dictPromise) return _dictPromise;
  _dictPromise = (async () => {
    try {
      const url = chrome.runtime.getURL("lib/data/dict-core.json");
      const res = await fetch(url);
      const data = await res.json();
      return data || {};
    } catch (e) {
      console.warn("[dict] failed to load core dictionary", e);
      return {};
    }
  })();
  return _dictPromise;
}

/**
 * Look up a single word.
 * Returns: { word, brief, meanings[], pos, phonetic, definitionEn[] } or null.
 * Compact JSON keys are expanded to readable names here.
 */
async function dictLookup(word) {
  if (!word) return null;
  const lemma = String(word).toLowerCase().trim();
  if (!lemma) return null;
  const dict = await _loadDict();
  const entry = dict[lemma];
  if (!entry) return null;
  return {
    word: lemma,
    brief: entry.b || "",
    meanings: Array.isArray(entry.m) ? entry.m.slice(0, 4) : [],
    pos: entry.s || null,
    phonetic: entry.p || null,
    definitionEn: Array.isArray(entry.e) ? entry.e : [],
  };
}

/**
 * Batch lookup — returns { word: entry } map, missing words are absent.
 */
async function dictLookupBatch(words) {
  const dict = await _loadDict();
  const out = {};
  for (const raw of words || []) {
    const lemma = String(raw).toLowerCase().trim();
    if (!lemma) continue;
    const entry = dict[lemma];
    if (entry) {
      out[lemma] = {
        word: lemma,
        brief: entry.b || "",
        meanings: Array.isArray(entry.m) ? entry.m.slice(0, 4) : [],
        pos: entry.s || null,
        phonetic: entry.p || null,
        definitionEn: Array.isArray(entry.e) ? entry.e : [],
      };
    }
  }
  return out;
}

/** Return Set of words the dict knows. */
async function dictHas(word) {
  const dict = await _loadDict();
  return Boolean(dict[String(word).toLowerCase().trim()]);
}

self.dictClient = { dictLookup, dictLookupBatch, dictHas };

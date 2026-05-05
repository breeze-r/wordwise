// Vocabulary level / frequency client.
// Replaces backend services/frequency.py.

let _freqPromise = null;
let _knownByLevel = null;  // Map<level, Set<word>>

async function _loadFreq() {
  if (_freqPromise) return _freqPromise;
  _freqPromise = (async () => {
    try {
      const url = chrome.runtime.getURL("lib/data/frequency.json");
      const res = await fetch(url);
      const data = await res.json();
      // Pre-build Sets for O(1) lookup
      _knownByLevel = {};
      for (const [level, words] of Object.entries(data.words_below || {})) {
        _knownByLevel[level] = new Set(words);
      }
      return data;
    } catch (e) {
      console.warn("[freq] failed to load frequency data", e);
      return { level_order: [], level_labels: {}, words_below: {}, level_word_counts: {} };
    }
  })();
  return _freqPromise;
}

/** Return list of {key, label, word_count} for the popup level chips. */
async function getVocabLevels() {
  const data = await _loadFreq();
  return (data.level_order || []).map((key) => ({
    key,
    label: data.level_labels?.[key] || key,
    word_count: data.level_word_counts?.[key] || 0,
  }));
}

/** Return Set of words the user "already knows" at the given level. */
async function getKnownWords(level) {
  await _loadFreq();
  return _knownByLevel?.[level] || new Set();
}

/** Filter a list of candidate words, removing those the user already knows. */
async function filterUnknown(level, words) {
  const known = await getKnownWords(level);
  return (words || []).filter((w) => !known.has(String(w).toLowerCase()));
}

self.freqClient = { getVocabLevels, getKnownWords, filterUnknown };

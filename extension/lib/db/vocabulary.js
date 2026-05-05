// IndexedDB-based vocabulary store.
// Replaces the SQLite UserVocabulary table on the backend.
//
// Schema (object store: "vocabulary"):
//   {
//     lemma: string (key),
//     status: "new_word" | "learning" | "mastered",
//     definition_cn: string,
//     pos: string,
//     phonetic: string,
//     meanings_json: string,         // JSON array of strings
//     definition_en: string[],
//     source_url: string,
//     context_sentence: string,
//     sentence_zh: string,
//     encounter_count: number,
//     manual_lookup_count: number,
//     last_seen_at: number,          // epoch ms
//     last_manual_lookup_at: number,
//     first_seen_at: number,
//     exposure_limit: number,
//     exposure_remaining: number,
//     last_exposure_session_id: string | null,
//     last_clicked_translation: boolean,
//   }

const DB_NAME = "wordwise";
const DB_VERSION = 1;
const STORE = "vocabulary";
const META_STORE = "meta";  // user prefs (vocab_level, etc)

const DEFAULT_EXPOSURE_LIMIT = 10;

let _dbPromise = null;

function _openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "lemma" });
        s.createIndex("status", "status", { unique: false });
        s.createIndex("last_seen_at", "last_seen_at", { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function _tx(stores, mode = "readonly") {
  const db = await _openDb();
  return db.transaction(stores, mode);
}

function _idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ─── Vocabulary CRUD ────────────────────────────────────────────

async function getVocab(lemma) {
  const tx = await _tx([STORE]);
  return _idbReq(tx.objectStore(STORE).get(String(lemma).toLowerCase()));
}

async function getVocabBatch(lemmas) {
  const tx = await _tx([STORE]);
  const store = tx.objectStore(STORE);
  const out = {};
  for (const l of lemmas || []) {
    const lemma = String(l).toLowerCase();
    const v = await _idbReq(store.get(lemma));
    if (v) out[lemma] = v;
  }
  return out;
}

async function putVocab(record) {
  if (!record?.lemma) throw new Error("vocab record needs a lemma");
  record.lemma = String(record.lemma).toLowerCase().trim();
  const tx = await _tx([STORE], "readwrite");
  await _idbReq(tx.objectStore(STORE).put(record));
  return record;
}

async function upsertVocab(lemma, partial) {
  const lk = String(lemma).toLowerCase().trim();
  if (!lk) return null;
  const tx = await _tx([STORE], "readwrite");
  const store = tx.objectStore(STORE);
  const existing = await _idbReq(store.get(lk));
  const now = Date.now();
  const merged = {
    lemma: lk,
    status: "new_word",
    encounter_count: 0,
    manual_lookup_count: 0,
    first_seen_at: now,
    last_seen_at: now,
    exposure_limit: DEFAULT_EXPOSURE_LIMIT,
    exposure_remaining: DEFAULT_EXPOSURE_LIMIT,
    last_exposure_session_id: null,
    last_clicked_translation: false,
    ...(existing || {}),
    ...partial,
  };
  await _idbReq(store.put(merged));
  return merged;
}

async function deleteVocab(lemma) {
  const tx = await _tx([STORE], "readwrite");
  await _idbReq(tx.objectStore(STORE).delete(String(lemma).toLowerCase()));
}

async function getAllVocab() {
  const tx = await _tx([STORE]);
  return _idbReq(tx.objectStore(STORE).getAll());
}

async function getStats() {
  const all = await getAllVocab();
  const counts = {
    unseen: 0,
    suspected_known: 0,
    new_word: 0,
    learning: 0,
    mastered: 0,
    forgotten: 0,
  };
  for (const v of all) {
    const s = v.status || "new_word";
    if (counts[s] != null) counts[s]++;
  }
  return {
    total_words: all.length,
    by_status: counts,
  };
}

// ─── Meta (user prefs) ──────────────────────────────────────────

async function getMeta(key, fallback = null) {
  const tx = await _tx([META_STORE]);
  const result = await _idbReq(tx.objectStore(META_STORE).get(key));
  return result?.value ?? fallback;
}

async function setMeta(key, value) {
  const tx = await _tx([META_STORE], "readwrite");
  await _idbReq(tx.objectStore(META_STORE).put({ key, value }));
  return value;
}

// ─── Reading session helpers ────────────────────────────────────

async function applyAnnotationExposure(lemma, pageSessionId) {
  const lk = String(lemma).toLowerCase();
  const v = await getVocab(lk);
  if (!v) return null;
  if (pageSessionId && v.last_exposure_session_id === pageSessionId) {
    return v;  // already counted this session
  }
  if (v.exposure_remaining == null || v.exposure_remaining < 0) {
    v.exposure_limit = v.exposure_limit || DEFAULT_EXPOSURE_LIMIT;
    v.exposure_remaining = v.exposure_limit;
  }
  v.exposure_remaining = Math.max(0, (v.exposure_remaining || 0) - 1);
  v.encounter_count = (v.encounter_count || 0) + 1;
  v.last_seen_at = Date.now();
  if (pageSessionId) v.last_exposure_session_id = pageSessionId;
  await putVocab(v);
  return v;
}

async function resetExposureCycle(lemma) {
  const lk = String(lemma).toLowerCase();
  const v = await getVocab(lk);
  if (!v) return null;
  v.exposure_limit = v.exposure_limit || DEFAULT_EXPOSURE_LIMIT;
  v.exposure_remaining = v.exposure_limit;
  v.last_exposure_session_id = null;
  await putVocab(v);
  return v;
}

self.vocabDb = {
  getVocab, getVocabBatch, putVocab, upsertVocab, deleteVocab,
  getAllVocab, getStats,
  getMeta, setMeta,
  applyAnnotationExposure, resetExposureCycle,
  DEFAULT_EXPOSURE_LIMIT,
};

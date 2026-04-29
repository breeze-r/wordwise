// Offscreen document — runs PDF.js to extract text from PDFs.
// Speaks via chrome.runtime messages so background.js can forward
// requests from content scripts.

import * as pdfjsLib from "./lib/pdfjs/pdf.min.mjs";

// Tell PDF.js where to find the worker. Must be inside the extension
// (otherwise CSP / CORS blocks loading the worker URL).
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  "lib/pdfjs/pdf.worker.min.mjs"
);

/**
 * Smart text selection for academic papers / financial reports.
 *
 * Backend has its own depth-aware truncation (1.5k / 5k / 12k / 18k chars
 * depending on length tier), so here we just need to:
 *   1. Strip out References / Bibliography (low-signal, eats tokens)
 *   2. Keep up to ~25k chars of body (above which even deep summaries
 *      gain little from extra input).
 *
 * For ultra-long docs (>25k after refs strip) we sample head + middle + tail
 * so the summary still touches conclusion / methodology / abstract.
 */
function selectImportantText(pages) {
  const joined = pages.join("\n\n");
  // Detect references section — usually at the end, low signal
  const refIdx = joined.search(
    /\n\s*(References|REFERENCES|Bibliography|BIBLIOGRAPHY|Works Cited|参考文献|引用文献|参考资料)[\s\S]{0,40}\n/
  );
  const cleaned = refIdx > 0 ? joined.slice(0, refIdx) : joined;

  const HARD_CAP = 25000;
  if (cleaned.length <= HARD_CAP) return cleaned;

  // Three-window sample: 50% head + 25% middle + 25% tail
  const headLen = Math.floor(HARD_CAP * 0.5);
  const midLen = Math.floor(HARD_CAP * 0.25);
  const tailLen = HARD_CAP - headLen - midLen;

  const midStart = Math.floor((cleaned.length - midLen) / 2);
  const head = cleaned.slice(0, headLen);
  const middle = cleaned.slice(midStart, midStart + midLen);
  const tail = cleaned.slice(-tailLen);

  return head +
    "\n\n[...中间略...]\n\n" +
    middle +
    "\n\n[...略...]\n\n" +
    tail;
}

async function extractPdfText(arrayBuffer) {
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;
  const pages = [];

  // Cap at 60 pages — covers full papers (≤30 pages) and most financial
  // reports (10-K filings can hit 100+ pages but the first 60 contain
  // everything except exhibits). Backend then does smart text-level truncation.
  const cap = Math.min(numPages, 60);

  for (let i = 1; i <= cap; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // PDF text comes as a list of items (each is a span / line fragment).
    // PDF.js gives us `hasEOL` flags on items so we can preserve paragraph breaks.
    let pageText = "";
    for (const item of content.items) {
      pageText += item.str;
      if (item.hasEOL) pageText += "\n";
      else pageText += " ";
    }
    pages.push(pageText.trim());
  }

  const finalText = selectImportantText(pages);
  return {
    text: finalText,
    numPages,
    pagesProcessed: cap,
    truncated: numPages > cap || finalText.length < pages.join(" ").length,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen") return;

  if (msg.type === "extract_pdf_text") {
    (async () => {
      try {
        if (typeof msg.bytesBase64 !== "string" || !msg.bytesBase64) {
          throw new Error("无效的 PDF 数据");
        }
        // Decode base64 → Uint8Array → ArrayBuffer
        const binary = atob(msg.bytesBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        const result = await extractPdfText(bytes.buffer);
        sendResponse({ ok: true, ...result });
      } catch (err) {
        console.error("[offscreen] PDF parse error:", err);
        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();
    return true; // async response
  }
});

// Signal readiness so background.js can know the offscreen doc is alive
chrome.runtime.sendMessage({ type: "offscreen_ready" }).catch(() => {});

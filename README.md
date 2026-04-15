<p align="center">
  <img src="extension/icons/icon128.png" width="80" height="80" alt="WordWise icon">
</p>

<h1 align="center">WordWise</h1>

<p align="center">
  <strong>Read to Learn English — Smart inline annotations for every webpage</strong>
</p>

<p align="center">
  <a href="./README.zh-CN.md">中文说明</a> &middot;
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="https://github.com/breeze-r/wordwise/issues">Issues</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/license/breeze-r/wordwise?color=0d9488" alt="License">
  <img src="https://img.shields.io/badge/manifest-v3-0d9488" alt="Manifest V3">
  <img src="https://img.shields.io/badge/version-1.0.1-0d9488" alt="Version">
</p>

---

<p align="center">
  <img src="docs/hero-preview.png?v=2" width="960" alt="WordWise in action — inline annotations, detail panel, and AI summary sidebar">
</p>

## What is WordWise?

WordWise is an open-source Chrome extension that helps you **learn English while reading**. It automatically detects unfamiliar words on any webpage, annotates them inline with Chinese translations, and provides detailed definitions on click.

Unlike flashcard apps that require separate study sessions, WordWise turns your everyday browsing into a passive learning experience.

## Features

<table>
<tr>
<td width="50%">

### Inline Annotations
Words you don't know are annotated with concise Chinese translations right in the text flow. No popups, no interruptions.

<img src="docs/annotation-preview.png" width="100%" alt="Inline annotation example">

</td>
<td width="50%">

### Extension Popup
Track your vocabulary stats, configure vocabulary level, enable domain-specific word packs, and manage LLM settings — all from the popup.

<img src="docs/popup-preview.png" width="260" alt="Popup dashboard">

</td>
</tr>
<tr>
<td width="50%">

### AI Article Summary
One-click bilingual structured outline of any article. Extracts title, overview, and key sections — switch between Chinese, English, or bilingual display.

<img src="docs/summary-preview.png" width="260" alt="AI summary sidebar">

</td>
<td width="50%">

### Word Detail Panel
Click any annotated word to see phonetics, part-of-speech tags, multiple definitions, and the word used in its original context.

<img src="docs/detail-preview.png" width="280" alt="Word detail panel">

</td>
</tr>
</table>

### Core Capabilities

- **Smart Word Detection** — Filters out common words based on your vocabulary level. Only annotates words you actually need to learn.
- **Click-to-Expand Detail Panel** — Phonetics, POS tags, multiple senses, contextual usage, and "add to vocabulary" in one panel.
- **AI Article Summary** — One-click structured outline with title, overview, and section-by-section bullet points. Supports CN / EN / Bilingual switching.
- **Three Translation Modes**:
  - `Local Dictionary Only` — Offline-capable, powered by ECDICT (350k+ entries)
  - `Hybrid` — Local dictionary first, LLM fills the gaps
  - `Remote LLM Only` — Full AI-powered contextual translations
- **Vocabulary Level Filtering** — Choose your level (middle school through postgrad) and words below that level won't be annotated.
- **Domain Word Packs** — Enable specialized packs for GRE, TOEFL, Medical, Tech, Legal, Business, and more.
- **BYOK (Bring Your Own Key)** — Your API key stays in browser local storage. It's only attached to translation requests, never stored on any server.
- **Spaced Repetition** — Built-in vocabulary tracking with exposure-based review system.
- **Privacy First** — No account required. All learning data stored locally.

## Architecture

```
                  Chrome Extension                         Local Backend
              ┌─────────────────────┐              ┌──────────────────────┐
  Webpage ──> │  content.js         │   HTTP/JSON  │  FastAPI (Python)    │
              │  - word detection   │ ──────────── │  - vocabulary DB     │
              │  - inline annotate  │              │  - ECDICT lookup     │
              │  - detail panel     │              │  - LLM proxy         │
              │  - summary sidebar  │              │  - spaced repetition │
              ├─────────────────────┤              └──────────────────────┘
              │  background.js      │                        │
              │  - API routing      │                  ┌─────┴─────┐
              │  - config storage   │                  │ LLM API   │
              ├─────────────────────┤                  │ (OpenAI,  │
              │  popup.html/js      │                  │  Claude,  │
              │  - settings UI      │                  │  etc.)    │
              └─────────────────────┘                  └───────────┘
```

## Quick Start

### 1. Start the backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # edit .env if needed
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder

### 3. Configure (optional)

Open the extension popup and configure:

| Setting | Description |
|---------|-------------|
| **Backend URL** | Default `http://localhost:8000`. Change if your backend runs elsewhere. |
| **Translation Mode** | `Local Dictionary Only` / `Hybrid` / `Remote LLM Only` |
| **LLM API URL** | e.g. `https://api.openai.com/v1/chat/completions` |
| **Model** | e.g. `gpt-4o-mini`, `claude-sonnet-4-20250514`, etc. |
| **API Key** | Your key. Stored locally, never sent to our servers. |

> **Tip:** You can use WordWise in `Local Dictionary Only` mode without any API key. It works great for basic translations using the built-in 350k-entry ECDICT dictionary.

## Project Structure

```
wordwise/
├── extension/           # Chrome extension (Manifest V3)
│   ├── manifest.json
│   ├── background.js    # Service worker, API routing
│   ├── content.js       # Page annotation, detail panel, summary
│   ├── content.css      # All annotation/panel/summary styles
│   ├── popup.html/js    # Extension popup UI
│   └── icons/           # Extension icons
├── backend/             # FastAPI local backend
│   ├── main.py          # App entry, CORS, router registration
│   ├── routers/         # API endpoints
│   │   ├── reading.py   # /scan, /lookup, /summarize
│   │   ├── vocabulary.py
│   │   ├── review.py
│   │   ├── test.py
│   │   └── dict_packs.py
│   ├── services/        # Business logic
│   │   ├── translator.py      # LLM integration
│   │   ├── local_dictionary.py
│   │   ├── frequency.py
│   │   └── spaced_repetition.py
│   ├── models.py        # SQLAlchemy ORM
│   ├── settings.py      # Env config
│   └── data/            # Dictionary data (not tracked)
└── docs/                # Screenshots & diagrams
```

## Dictionary Data

The repository does **not** include large dictionary files. To enable the full local dictionary:

1. Download [ECDICT](https://github.com/skywind3000/ECDICT)
2. Place CSV data in `backend/data/`
3. Build the SQLite index:

```bash
cd backend && python3 scripts/build_ecdict_index.py
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension | Chrome Manifest V3, vanilla JS, CSS |
| Backend | Python 3.11+, FastAPI, SQLAlchemy, SQLite |
| Dictionary | ECDICT (350k+ entries) |
| LLM | Any OpenAI-compatible API (BYOK) |

## Contributing

Contributions are welcome! Feel free to open issues or submit PRs.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## License

[MIT](./LICENSE)

---

<p align="center">
  <sub>Built with curiosity. Read more, learn more.</sub>
</p>

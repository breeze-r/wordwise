# WordWise

[中文说明](./README.zh-CN.md)

![WordWise overview](./docs/wordwise-overview.svg)

WordWise is an open-source reading companion for English webpages.
It annotates unfamiliar words inline, lets you inspect richer definitions on click, and keeps a lightweight local learning profile with optional spaced repetition.

This repository currently ships as:

- A Chrome extension in [`extension/`](./extension)
- A local FastAPI backend in [`backend/`](./backend)
- A privacy-first BYOK flow where your model key stays in browser storage

## Features

- Inline annotations for unfamiliar English words while browsing
- Local dictionary mode for fast offline-friendly lookups
- Hybrid or remote LLM mode for context-aware translations
- Click-to-open detail panel with POS, multiple senses, UK/US pronunciation, and English definitions
- Vocabulary level filtering and optional domain-specific word packs
- Vocabulary test and review endpoints for a lightweight learning loop
- Anonymous local profile mode, no account required in the current version

## Architecture

![WordWise architecture](./docs/wordwise-architecture.svg)

## Project structure

```text
backend/
  main.py
  routers/
  services/
  scripts/
extension/
  manifest.json
  background.js
  content.js
  popup.html
  popup.js
docs/
```

## Quick start

### 1. Run the backend locally

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

The current extension build points to `http://localhost:8000`.

### 2. Load the Chrome extension

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select the `extension/` folder

### 3. Configure translation mode

You can use:

- `Local dictionary only`
- `Hybrid`
- `Remote LLM only`

When using an LLM mode, fill in:

- API URL
- model name
- API key

The key is stored locally in Chrome storage and attached only to reading requests.

## Dictionary data

The repo does **not** track large generated dictionary files.

Ignored on purpose:

- `backend/data/ecdict.db`
- `backend/data/ecdict.csv`
- `backend/data/ECDICT-master/`
- local runtime databases such as `backend/wordwise.db`

If you want richer local definitions, download ECDICT yourself and build the SQLite index:

```bash
cd backend
source .venv/bin/activate
python3 scripts/build_ecdict_index.py
```

You may also override the dictionary paths through `.env`.

## Open source notes

- License: MIT
- ECDICT upstream data included in your own setup should keep its original license notice
- This repository is currently local-first and developer-oriented

## Current limitations

- The extension still targets a local backend by default instead of a hosted public API
- Some enriched word-detail fields are not persisted yet and may trigger repeated LLM lookups
- Dynamic content rescanning is still conservative on heavily client-rendered pages

## Roadmap

- Configurable backend base URL or hosted service
- Better caching for enriched word details
- Improved SPA / infinite-scroll rescanning
- Chrome Web Store packaging flow

## Development tips

- Extension UI: `extension/popup.html`, `extension/popup.js`
- Page annotation logic: `extension/content.js`
- Backend entry: `backend/main.py`
- Reading pipeline: `backend/routers/reading.py`
- Translator logic: `backend/services/translator.py`

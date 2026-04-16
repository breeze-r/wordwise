# Privacy Policy — WordWise

**Last updated:** April 16, 2026

## Overview

WordWise is a reading assistant Chrome extension. We are committed to protecting your privacy. This policy explains what data WordWise handles and how.

## Data Collection

WordWise does **NOT** collect, transmit, or store any personal data on external servers.

### What stays on your device

- **Vocabulary data** — Words you encounter, learning status, and review history are stored in a local SQLite database on your machine.
- **Extension settings** — Vocabulary level, enabled word packs, translation mode, and backend URL are stored in Chrome's local storage (`chrome.storage.local`).
- **API Key** — If you configure an LLM API key, it is stored only in Chrome's local storage on your device. It is never sent to our servers.

### What is sent to external services

- **LLM API requests** — When using Hybrid or Remote translation mode, the text of words (and surrounding sentence context) is sent to the LLM API endpoint **you configure** (e.g., OpenAI, Anthropic, or other providers). Your API key is attached to these requests as an Authorization header. WordWise does not operate any intermediate server for these requests.
- **Local backend** — WordWise communicates with a backend service running on **your own machine** (default: `localhost:8000`). No data leaves your local network unless you configure an external backend URL.

## Data Storage

All data is stored locally:

- Chrome extension storage (`chrome.storage.local`)
- Local SQLite database (`wordwise.db`)

No cloud storage, no remote databases, no analytics.

## Third-Party Services

WordWise does not integrate any analytics, tracking, or advertising services. The only third-party communication is with the LLM API provider **you choose and configure yourself**.

## Permissions Explained

| Permission | Why it's needed |
|-----------|----------------|
| `storage` | Save your settings, vocabulary data, and API key locally |
| `activeTab` | Access the current tab to annotate words on the page |
| `tabs` | Send rescan messages when settings change |
| `host_permissions (http/https)` | Make requests to your local backend and your configured LLM API |

## Children's Privacy

WordWise does not knowingly collect any information from children under 13.

## Changes

If this privacy policy changes, the updated version will be published in this repository.

## Contact

For privacy questions, open an issue at [github.com/breeze-r/wordwise](https://github.com/breeze-r/wordwise/issues).

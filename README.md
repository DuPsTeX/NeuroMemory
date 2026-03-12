# NeuroMemory — SillyTavern Extension

A persistent, AI-powered long-term memory system for SillyTavern. NeuroMemory automatically extracts, stores, and retrieves memories from your conversations — giving your AI characters a real sense of continuity and recall across sessions.

![NeuroMemory Settings Panel](docs/screenshot_settings.png)

---

## Features

- **Automatic Memory Extraction** — After each AI response, NeuroMemory silently analyzes the last few messages and extracts meaningful memories using your configured AI model.
- **4 Memory Types** — Episodic (events), Semantic (facts/knowledge), Emotional (feelings/bonds), and Relational (character dynamics).
- **Associative Memory Network** — Memories are interconnected via a graph of entities and keywords, enabling spreading-activation retrieval (like the human brain).
- **Memory Decay** — Memories naturally fade over time (configurable half-life), with emotional memories decaying more slowly.
- **Smart Retrieval** — Relevant memories are automatically injected into the context before each generation based on semantic similarity, entity matching, and memory strength.
- **Memory Browser** — View, inspect, and manage all stored memories per character directly in the UI.
- **Export / Import** — Back up and restore memories per character as JSON files.
- **DeepSeek-Reasoner Support** — Full compatibility with reasoning models that output in `reasoning_content` instead of `content`.
- **Works with all SillyTavern APIs** — DeepSeek, OpenAI, Claude, OpenRouter, and all other chat-completion providers.

---

## Screenshots

### Settings Panel
![Settings Panel](docs/screenshot_settings.png)

### Memory Browser
![Memory Browser](docs/screenshot_browser.png)

---

## Installation

### Via SillyTavern Extension Installer (recommended)

1. Open SillyTavern → Extensions (puzzle icon) → Install Extension
2. Paste the GitHub URL of this repository
3. Click Install

### Manual Installation

1. Clone or download this repository
2. Copy the `neuro-memory` folder into:
   ```
   SillyTavern/data/default-user/extensions/neuro-memory/
   ```
3. Restart SillyTavern
4. Enable the extension under Extensions → NeuroMemory

---

## How It Works

```
User sends message
       ↓
AI responds (MESSAGE_RECEIVED event)
       ↓
[1.5s delay — non-blocking]
       ↓
Last N messages sent to AI for extraction
       ↓
AI returns JSON array of memories
       ↓
Memories saved to IndexedDB (localforage)
       ↓
Next generation: relevant memories injected into context
```

### Memory Structure

Each memory contains:
| Field | Description |
|---|---|
| `content` | The memory text |
| `type` | `episodic` / `semantic` / `emotional` / `relational` |
| `entities` | People/places/things mentioned |
| `keywords` | Searchable tags |
| `importance` | 0.0–1.0 score |
| `emotionalValence` | -1.0 (negative) to +1.0 (positive) |
| `emotionalIntensity` | 0.0–1.0 strength of emotion |
| `retrievability` | Current memory strength (decays over time) |
| `connections` | Links to related memories/entities |

---

## Configuration

All settings are accessible in the SillyTavern Extensions panel under **NeuroMemory**.

### Retrieval
| Setting | Default | Description |
|---|---|---|
| Top-K Memories | 10 | Max memories injected per generation |
| Max Context Tokens | 500 | Token budget for injected memories |
| Injection Depth | 2 | How deep in the message stack to inject |

### Extraction
| Setting | Default | Description |
|---|---|---|
| Extract every N messages | 1 | Run extraction every N AI responses |
| Context messages | 4 | How many recent messages to analyze |

### Memory Behavior
| Setting | Default | Description |
|---|---|---|
| Half-life (days) | 30 | How quickly memories fade |
| Emotion factor | 0.5 | How much emotion slows decay |
| Consolidate every N | 10 | How often similar memories are merged |
| Max memories per char | 500 | Cap on stored memories |
| Activation hops | 3 | Spreading activation depth |
| Activation threshold | 0.15 | Min strength for spreading activation |

---

## Compatibility

- **SillyTavern** 1.12.0 or newer
- **APIs**: OpenAI, DeepSeek (incl. deepseek-reasoner), Claude, OpenRouter, Mistral, and all other chat-completion providers
- **Storage**: Browser IndexedDB via localforage (persists across sessions)

---

## Technical Notes

### DeepSeek-Reasoner Support

DeepSeek's `deepseek-reasoner` model outputs all content in `reasoning_content` instead of `content`. NeuroMemory uses a direct API call to `/api/backends/chat-completions/generate` and parses both fields, wrapping reasoning in `<think>` tags for JSON extraction.

### Non-Blocking Design

Memory extraction runs completely asynchronously with a 1.5-second delay after `MESSAGE_RECEIVED`, so it never blocks or slows down the normal chat flow.

### Data Storage

Memories are stored per-character in the browser's IndexedDB using `localforage`. Each character gets its own isolated store keyed by character avatar filename.

---

## License

MIT License — feel free to use, modify, and distribute.

---

## Author

Built as a SillyTavern third-party extension. Contributions welcome!

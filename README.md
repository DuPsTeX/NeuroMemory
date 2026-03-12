# NeuroMemory — SillyTavern Extension

A persistent, AI-powered long-term memory system for SillyTavern. NeuroMemory automatically extracts, stores, and retrieves memories from your conversations — giving your AI characters a real sense of continuity and recall across sessions.

![Settings Panel](docs/screenshot_settings.png)

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
- **Works with all SillyTavern APIs** — DeepSeek, OpenAI, Claude, OpenRouter, Mistral, and all other chat-completion providers.

---

## Screenshots

### Settings Panel & Stats
![Settings Panel](docs/screenshot_settings.png)

### Memory Browser
![Memory Browser](docs/screenshot_browser.png)

### Entity Graph
![Entities](docs/screenshot_entities.png)

---

## Installation

### Via SillyTavern Extension Installer (recommended)

1. Open SillyTavern → Extensions (puzzle icon) → Install Extension
2. Paste this URL:
   ```
   https://github.com/DuPsTeX/NeuroMemory
   ```
3. Click Install — done!

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
| `entities` | People, places, things mentioned |
| `keywords` | Searchable tags |
| `importance` | 0.0–1.0 score |
| `emotionalValence` | -1.0 (negative) to +1.0 (positive) |
| `emotionalIntensity` | 0.0–1.0 strength of emotion |
| `retrievability` | Current memory strength (decays over time) |
| `connections` | Links to related memories and entities |

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

DeepSeek's `deepseek-reasoner` model outputs all content in `reasoning_content` instead of `content`. NeuroMemory bypasses SillyTavern's standard `generateQuietPrompt` and makes a direct call to `/api/backends/chat-completions/generate`, parsing both `content` and `reasoning_content` from the raw response.

### Non-Blocking Design

Memory extraction runs completely asynchronously with a 1.5-second delay after `MESSAGE_RECEIVED`, so it never blocks or slows down the normal chat flow.

### Data Storage

Memories are stored per-character in the browser's IndexedDB using `localforage`. Each character gets its own isolated store keyed by character avatar filename.

---

## Changelog

### v1.3.0
- **Anpassbarer Extraction-Prompt**: Unter dem "Enabled"-Schalter gibt es jetzt ein aufklappbares Panel **"Extraction Prompt"**. Dort kann der System-Prompt für die Memory-Extraktion direkt eingesehen und individuell angepasst werden. Ein "Reset to Default"-Button setzt den Prompt jederzeit auf den eingebauten Standard zurück. Der benutzerdefinierte Prompt wird persistent in den SillyTavern-Settings gespeichert.
- **Bugfix**: `extractMemories` verwendete intern eine nicht-definierte Variable (`EXTRACT_SYSTEM`) statt der konfigurierbaren `_extractSystem`-Variable — die Extraktion verwendete daher nie den gespeicherten Prompt. Behoben.

### v1.2.0
- **Memory-Injection fix (kritisch)**: Das Event `GENERATE_BEFORE_COMBINE_PROMPTS` feuert bei SillyTavern **nicht** für Chat-Completion-APIs (OpenAI, DeepSeek, etc.). Umgestellt auf `GENERATION_STARTED`, das für alle APIs zuverlässig feuert. Dadurch werden Memories jetzt tatsächlich in jeden Prompt injiziert.
- **Spreading Activation**: `updateMemoryConnections()` wird nach jeder Extraktion aufgerufen, sodass Memory-zu-Memory-Verbindungen (via gemeinsame Entities) für das assoziative Netzwerk aufgebaut werden.
- **Injection-Position**: Umgestellt von `IN_PROMPT` auf `IN_CHAT` mit Tiefe 2 — Memories erscheinen direkt vor den letzten Nachrichten im Kontext (relevanter für die KI).
- **Diagnose-Logging**: Detailliertes Logging in `onGenerateBefore` — zeigt Query, Kontext-Länge und Anzahl injizierter Memories.

### v1.1.0
- **Persistente Speicherung**: Memories werden jetzt in SillyTaverms `settings.json` gespeichert (server-seitig). Daten überleben Browser-Neustarts, Cache-Löschungen und SillyTavern-Neustarts zuverlässig. Localforage dient nur noch als Backup, alte Daten werden automatisch migriert.
- **Auto-Load bei Chat-Wechsel**: Beim Wechsel des Charakters oder der Chat-Session werden gespeicherte Memories sofort automatisch geladen und im Status angezeigt (`"5 Memories geladen"`).
- **DeepSeek-Reasoner Fix**: Vollständige Unterstützung für `deepseek-reasoner` und andere Reasoning-Modelle, die JSON-Output in `reasoning_content` statt `content` liefern. NeuroMemory umgeht SillyTaverms Standard-Pipeline und parst die rohe API-Antwort direkt.
- **max_tokens erhöht**: Standardwert für die Extraktion auf 8192 erhöht, damit Reasoning-Modelle genug Platz für Output haben.
- **Status-Anzeige**: Nach jeder Aktion (Extraktion, Laden, Fehler) wird ein Status direkt im Settings-Panel angezeigt.
- **Test-Button**: Neuer "Test Extraction"-Button zum manuellen Testen der Extraktions-Pipeline direkt aus dem UI.

### v1.0.0
- Erste Version
- 4 Speichertypen: Episodisch, Semantisch, Emotional, Relational
- Automatische Extraktion nach jeder AI-Antwort
- Assoziatives Speichernetzwerk mit Spreading Activation
- Memory Decay (konfigurierbare Halbwertszeit)
- Automatische Kontext-Injektion vor jeder Generation
- Memory-Browser, Export/Import
- Unterstützung für alle SillyTavern Chat-Completion-APIs

---

## License

MIT License — feel free to use, modify, and distribute.

---

## Author

**DuPsTeX** — [github.com/DuPsTeX](https://github.com/DuPsTeX)

Built as a SillyTavern third-party extension. Contributions welcome!

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

### v1.8.0
- **Tiered Memory Injection**: Der KI-Kontext ist jetzt strukturiert statt eine flache Liste — `[Character Essence]` (Digest), `[Current Emotional State]`, `[Defining Memories — High Emotional Weight]` (intensive Memories mit ★-Labels), `[Recent Events]` (episodische Memories), `[Background Knowledge]` (Fakten & Beziehungen), `[Sudden Recall]` (Flashback). Die KI weiß sofort WIE sie jede Erinnerung verwenden soll.
- **Emotional State Tracking**: Automatische Berechnung des aktuellen Gemütszustands (`joyful` / `content` / `calm` / `conflicted` / `troubled` / `grieving`) + Trend-Signal (`trending hopeful` / `darkening`) — injiziert als `[Current Emotional State: troubled, darkening]` vor den Memories.
- **Memory Surprise / Flashback**: Mit 15% Wahrscheinlichkeit wird eine high-intensity Memory (≥ 0.6) als `[Sudden Recall]` Block injiziert — simuliert spontane emotionale Erinnerungen wie beim Menschen.
- **Fading Memory Alert**: Im Stats-Panel erscheint `⚠️ N Memories verblassen` wenn Memories unter retrievability 0.25 fallen. "🔄 Auffrischen" stabilisiert alle verblassenden Memories mit sanftem Boost.
- **Text-to-Memory Import**: Neuer "📋 Text zu Memories importieren"-Drawer — beliebigen Text (Session-Recap, Lore, Charakternotizen) einfügen → KI extrahiert passende Memories automatisch.

### v1.7.0
- **Emotionale KI-Kalibrierung**: `formatMemoryContext()` bettet jetzt emotionale Labels direkt in den Prompt ein (`★★★ highly negative`, `★★ positive`, `★ slightly mixed`). Die KI bekommt konkrete Gewichtungs-Signale statt rohe Zahlen — intensiv negative Memories werden als solche erkannt und beeinflussen Ton und Tiefe der Antwort.
- **Emotion-Gewichtung erhöht**: Im Retrieval-Scoring wurde `emotion` von 0.15 auf 0.25 angehoben (activation 0.35→0.30, retrievability 0.20→0.15). Entspricht besser der menschlichen Psychologie: emotional aufgeladene Memories werden bevorzugt erinnert.
- **Stimmungsbild im Stats-Panel**: Unter den Memory-Statistiken erscheint jetzt `💭 X% positiv · Y% neutral · Z% negativ` plus die stärkste Erinnerung des Charakters — sofortiger emotionaler Überblick ohne Memory Browser öffnen.
- **Visuelle Intensitätskodierung**: Im Memory Browser skaliert die Border-Stärke mit der emotionalen Intensität (dünn = neutral, dick = intensiv), der Hintergrund tönt sich leicht grünlich (positiv) oder rötlich (negativ), und intensive Memories ab 0.6 erhalten ein ⚡-Badge (ab 0.85 ⚡⚡).
- **Emotions-Slider beim manuellen Hinzufügen**: Das "Memory manuell hinzufügen"-Formular hat jetzt zwei Slider — Valenz (😔→😊, -1 bis +1) und Intensität (0 bis 1). Manuell erstellte Memories können jetzt vollständige emotionale Metadaten tragen.
- **Digest berücksichtigt emotionale Intensität**: `generateDigest()` nimmt jetzt auch Memories mit `emotionalIntensity ≥ 0.7` auf — auch wenn ihre `importance` niedrig ist. Stark emotional aufgeladene Momente fließen in die Charakter-Narration ein.

### v1.6.0
- **Character Card Auto-Import**: Neues "📥 Aus Character Card importieren"-Panel erscheint automatisch bei Charakteren ohne Memories. Ein Klick extrahiert Backstory-Fakten (Persönlichkeit, Fähigkeiten, Beziehungen, Geschichte) direkt aus der Character Card via LLM — mit einem speziell angepassten Extraction-Prompt für Backstory (nur `semantic`/`relational` Memories, keine episodischen). Nach erfolgreichem Import verschwindet der Button dauerhaft.
- **Memory Digest**: Der Memory Browser zeigt jetzt einen "📝 Character Summary"-Block — eine KI-generierte 2-3 Satz Narration der wichtigsten Memories. Der Digest wird **automatisch in den Prompt injiziert** (vor den Bullet-Point-Memories), sodass die KI den Charakter kontextuell erfasst. Auto-Regenerierung alle N neuen Memories (Standard: 15). Manuell mit "🔄"-Button neu generieren.
- **Emotional Arc Timeline**: Visueller Timeline-Strip im Memory Browser — alle Memories mit emotionalem Gehalt sortiert nach Erstellungszeitpunkt als Farbbalken (grün = positiv, rot = negativ, grau = neutral, Höhe = Intensität). Zeigt den emotionalen Verlauf der Geschichte auf einen Blick.
- **Proaktive Memory-Nutzung**: Neues optionales Setting — wenn aktiviert, wird ein kurzer System-Hinweis injiziert, der die KI auffordert, Memories natürlich in die Antwort einzubauen, ohne sie explizit als "Erinnerungen" zu labeln.

### v1.5.0
- **Memory Pinning**: Jede Memory kann jetzt mit 📌 angepinnt werden. Gepinnte Memories werden **immer** in den Prompt injiziert (unabhängig vom Relevanz-Score), verfallen nicht durch den Decay-Algorithmus, und werden beim maxMemories-Limit nicht gelöscht. Ideal für wichtige Backstory-Fakten.
- **Manuell Memories hinzufügen**: Neues aufklappbares "Memory manuell hinzufügen"-Panel im Debug-Bereich. Nutzer können Memories direkt eingeben (Content, Typ, Wichtigkeit, Entities) und optional sofort anpinnen. Manuell erstellte Memories sind mit ✋ markiert.
- **Inline Memory-Editing**: Jede Memory bekommt einen ✏️-Button zum direkten Bearbeiten des Inhalts — ohne Löschen und Neu-Erstellen.
- **Suche & Filter im Memory Browser**: Neues Suchfeld und Typ-Filter-Buttons (Alle / Episodic / Semantic / Emotional / Relational / Pinned / Manuell) über der Memory-Liste.

### v1.4.0
- **Injection-Fix (kritisch)**: Injection funktionierte nicht bei deutschsprachigen Chats, weil gespeicherte Memories englische Keywords haben (Extraction-Prompt ist Englisch), aber User-Nachrichten auf Deutsch sind → kein BM25-Treffer. Zwei Fixes: (1) BM25 läuft jetzt zusätzlich auf dem Memory-Content (nicht nur Keywords), (2) Fallback: wenn gar kein Query-Signal → werden die Top-K wichtigsten/neuesten Memories trotzdem injiziert. Außerdem: Entity-Matching ist jetzt case-insensitive und prüft auch direkte Namensnennungen im Message-Text.
- **Memory löschen**: Im "Show Memories"-Panel hat jede Memory jetzt einen ✕-Button zum einzelnen Löschen.
- **Settings reset-Fix**: Einstellungen wurden nach Neustart im UI falsch angezeigt (UI zeigte Default-Werte, intern waren sie richtig). Jetzt wird das UI nach dem Laden der Settings synchronisiert (`syncUIFromSettings`).
- **Extraction-Prompt Textarea**: Zeigt jetzt immer den tatsächlich verwendeten Prompt (Standard oder Custom), nicht mehr leer. Beim Bearbeiten: Wenn der Text mit dem Standard übereinstimmt, wird automatisch "Standard" gespeichert (kein Speichern von doppeltem Text).

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

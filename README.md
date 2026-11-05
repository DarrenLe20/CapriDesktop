# Capri Desktop

<p align="center">
  <img src="src/renderer/src/assets/capri/walking/walking.gif" alt="Capri walking" width="260">
</p>

**Capri Desktop** is a cyberpunk desktop companion for Windows built with **Electron**, **Vite**, **React**, **TypeScript** and **TailwindCSS**. It puts **Capri**, an animated netrunner inspired by *Cyberpunk: Edgerunners*, on your desktop: she walks around your screen, talks to you with a neural voice, listens to you, controls Spotify and your apps, comments on your **League of Legends** and **Cyberpunk 2077** matches in real time, runs voice macros, builds small coding projects for you, and even draws in Paint. Everything AI-related runs **locally** (Ollama + Whisper).

---

## Table of Contents

1. [Who is Capri?](#1-who-is-capri)
2. [Voice: speaking and listening](#2-voice-speaking-and-listening)
3. [How it works](#3-how-it-works)
4. [Components](#4-components)
5. [What Capri stores](#5-what-capri-stores)
6. [Languages](#6-languages)
7. [Commands and examples](#7-commands-and-examples)
8. [Autonomous drawing in Paint](#8-autonomous-drawing-in-paint)
9. [Live game integrations (LoL & Cyberpunk 2077)](#9-live-game-integrations-lol--cyberpunk-2077)
10. [Permissions and system access](#10-permissions-and-system-access)
11. [Installation and development](#11-installation-and-development)
12. [License and credits](#12-license-and-credits)

---

## 1. Who is Capri?

Capri is a netrunner companion inspired by *Cyberpunk: Edgerunners*: playful, mischievous and very confident, she lives on your desktop and helps you out (and teases you) while you work and play. On first launch she asks **what she should call you** and uses that name everywhere.

**To talk to her:** press `↓` and speak, then `↓` again when you're done, or `Ctrl + Click` on her and type. All the keys and commands are in [Commands and examples](#7-commands-and-examples).

---

## 2. Voice: speaking and listening

### A. Voice providers (Edge-TTS / Fish Audio / ElevenLabs)
The provider is picked in **TTS CONFIG** in the Dev Deck:
- **Edge-TTS** (default, free): Microsoft neural voices, e.g. `en-US-AriaNeural` for English and `es-AR-ElenaNeural` for Spanish, plus `ja-JP-NanamiNeural` for Japanese.
- **Fish Audio** / **ElevenLabs** (optional, API key required): more expressive voices. With Fish Audio you can use any voice model ID from its library or your own.

Configuration is split in two files:
- `voice_config.json`: public settings (voices, pitch, preset).
- `voice_config.local.json`: **API keys** and the active provider. Git-ignored, takes precedence over the first one (see `voice_config.example.json`).

### B. Acoustic post-processing (FFmpeg)
`scripts/capri_voice.py` applies FFmpeg filter chains to give Capri a cybernetic sound:
- `cyber_android`: multi-tap stereo delay + subtle flanger + presence EQ at 3.2 kHz.
- `synth_hologram`: soft analog phaser + light reverb.
- `robot_vocoder`: resonant modulation for emergency-comms style speech.

### C. Disk cache
Every synthesized line is cached under a hash of `provider + text + voice + pitch + rate + preset + Fish voice`, so recurring lines play instantly and offline. Cached lines are kept for **30 days**.
- If the selected provider (Fish Audio / ElevenLabs) fails and Edge-TTS is used as a fallback, that audio is **never cached**, so the next attempt uses the real voice again.
- Fish Audio retries up to 3 times on transient errors (rate limits, timeouts, 5xx).
- When Cyberpunk 2077 is detected, Capri **pre-generates all quickhack lines** with the selected voice so they play instantly in combat.

### D. Laughter and voice actions
The LLM can write voice actions in brackets, e.g. `[laugh]`, `[giggles]`, `[laughs hard]`, `[teasing]`, `[excited]`:
- **Fish Audio**: tags are sent as-is and Capri **actually laughs**.
- **Edge-TTS**: can't laugh, so `[laugh]` / `[laughs hard]` become written laughter (`jajaja` with Spanish voices, `hahaha` otherwise), `[giggles]` becomes `jiji` / `hehe`, and other tags are dropped.

### E. Speech recognition (local Whisper)
Transcription uses **faster-whisper** on your GPU (falls back to the CPU automatically), model `small` by default, with a vocabulary of Capri, Cyberpunk and LoL terms. Set the `CAPRI_WHISPER_MODEL` environment variable (e.g. `medium`, `large-v3-turbo`) for more accuracy at the cost of more VRAM. In automatic mode it only considers English, Spanish and Japanese, and in a close call decides between Spanish and English, which avoids accented English being transcribed as Spanish.

### F. Always listening ("OÍDO")
Press the **Right arrow (→)** and Capri listens all the time, but **only answers when you talk to her**:
- The mic stays open with a local voice-activity detector: audio is only transcribed when someone speaks (it learns the background noise level and keeps half a second of pre-roll so the start of the sentence isn't cut).
- She answers when she hears her name anywhere in the sentence (`"Capri, what's next?"`, `"che Capri, qué hacemos?"`), including common Whisper mishearings like *Kapri*, *Cabri* or *Capricornio*.
- Your **voice macro** phrases work without saying her name.
- After she answers you have **8 seconds** to keep talking without repeating her name.
- It pauses while she speaks, while you use push-to-talk (↓) and while she runs a task, so she never hears herself.
- The state is remembered between sessions; the **OÍDO** button on her toolbar shows whether it's on.

---

## 3. How it works

```
┌─────────────────────────────────────────────────────────────┐
│ 1. USER INPUT (chat text, push-to-talk or always-listening) │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. SPEECH-TO-TEXT (voice only)                              │
│    WebAudio / MediaRecorder -> local faster-whisper         │
│    always-listening: wake word or macro phrase filter       │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. ROUTING (CapriLocalAgent)                                │
│ ├─ Voice macros                                             │
│ ├─ Coding agent ("build me a landing page")                 │
│ ├─ Language switching                                       │
│ ├─ Spotify / YouTube / web search                           │
│ ├─ Screen context (what you're watching / listening to)     │
│ ├─ Paint drawing (LLM-planned)                              │
│ ├─ League of Legends (LCU + Live Client Data API)           │
│ ├─ Cyberpunk 2077 (CET mod telemetry)                       │
│ ├─ Launch / close games and apps                            │
│ ├─ Fast-path answers                                        │
│ └─ Local LLM (Ollama: capri / qwen2.5-coder) with tools     │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. TOOLS (ToolExecutor / Win32)                             │
│    paint_drawer.ps1 · media_controller.ps1 · LCU REST API · │
│    Cyberpunk telemetry server (port 2077) · files / shell   │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. VOICE + VISUAL FEEDBACK                                  │
│    TTS (Edge / Fish / ElevenLabs) -> FFmpeg -> playback     │
│    synced with Capri's animations and speech bubble         │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Components

| Component | File / location | Responsibility |
| :--- | :--- | :--- |
| **Electron main process** | `src/main/index.ts` | App lifecycle, transparent frameless windows, global shortcuts and the IPC bridge. |
| **Capri Local Agent** | `src/main/agents/capri-local-agent.ts` | Capri's brain: intent routing, fast-path answers, system prompts and personality. |
| **Coding Agent** | `src/main/agents/coding-agent.ts` | Multi-step plan → write → verify → fix loop for "build me X" requests. |
| **Macro Service** | `src/main/services/macro-service.ts` | Voice macros created from natural language, fuzzy trigger matching. |
| **Wake word** | `src/main/services/wake-word.ts` | Decides whether an always-listening utterance was addressed to Capri. |
| **Setup Service** | `src/main/services/setup-service.ts` | First-run installation of the voice engine, FFmpeg, Ollama and the models. |
| **User profile** | `src/main/services/user-profile.ts` | How Capri calls you: fills the `{name}` placeholder in every line and prompt. |
| **App paths** | `src/main/services/app-paths.ts` | Resolves scripts, assets, the Python environment and writable data in dev and installed mode. |
| **LLM drawing planner** | `src/main/services/paint/llm-drawing-planner.ts` | Plans drawings with the local LLM on a 100x100 grid, validation and retries. |
| **Paint drawer** | `scripts/paint_drawer.ps1` | Win32 `SendInput` / `SetCursorPos` drawing with human-like motion and an `Esc` panic key. |
| **LCU Service** | `src/main/services/lol/lcu-service.ts` | Local HTTPS connection to the League client: auto-accept, picks and bans. |
| **LoL Live Adapter + Commentator** | `src/main/services/game/adapters/lol/` | Live Client Data API (port 2999) polling, counter-item advice and LLM-written commentary. |
| **Cyberpunk Adapter** | `src/main/services/game/adapters/cyberpunk/` | Local telemetry server (port 2077) fed by the CET mod. |
| **Reaction Engine** | `src/main/services/game/reaction-engine.ts` | Game event bus with priorities, cooldowns and in-character reactions. |
| **Tool Executor** | `src/main/agents/tools/tool-executor.ts` | Launch/close apps, files, shell commands, media keys, web search. |
| **Voice Service** | `src/main/services/voice-service.ts` | Runs the Python voice engine (TTS, STT worker, translation for spoken language). |
| **Python voice engine** | `scripts/capri_voice.py` | `edge-tts` / Fish Audio / ElevenLabs TTS, faster-whisper STT and FFmpeg filters. |
| **Media controller** | `scripts/media_controller.ps1` | Native Win32 (`PostMessage`, `WM_APPCOMMAND`) Spotify control in the background. |
| **Consciousness Service** | `src/main/services/consciousness-service.ts` | Persistent memory: boots/shutdowns, user name, language settings, learned drawings. |
| **Roaming Manager** | `src/main/roaming/roaming-manager.ts` | Capri walking around the screen and perching on browser tabs. |
| **Renderer** | `src/renderer/src/` | React UI: animated sprites, speech bubble, Dev Deck, code editor, onboarding wizard. |

---

## 5. What Capri stores

Everything lives on your PC, in `%APPDATA%\Capri Desktop` (or `%APPDATA%\Cyber Companion`, if you installed her before the rename):

- **`capri_consciousness.json`**: boot/shutdown counters (she comments on them), your name, language settings and onboarding state.
- **`capri_macros.json`**: your voice macros.
- **`capri_voice/`**: voice configuration, API keys (`voice_config.local.json`) and the audio cache.
- **`python-env/`**: the Python environment of the voice engine (installed by the first-run wizard).
- **`learned_drawings/`**: drawings Capri learned through the scanner.

In development (`npm run dev`) the voice configuration and learned drawings stay in the repository's `assets/` folder instead.

---

## 6. Languages

### Language panel (Dev Deck → **IDIOMA**)
Three independent settings, remembered between sessions:

| Setting | What it controls | `Automatic` |
| :--- | :--- | :--- |
| **Capri's text** | Language she writes in: chat, bubbles and game reactions (LoL, Cyberpunk). | She answers in the language you talk to her in. |
| **Capri's voice** | Language she speaks in. If it differs from the text, each line is translated by the local LLM (keeping `[laugh]` and other tags) before being spoken: she can write in Spanish and speak in English. | Same as the text. |
| **Microphone** | Language Whisper expects. Fixing it is more accurate than auto-detection. | Whisper picks between Spanish and English. |

Available languages: English, Spanish and Japanese.

> Spoken-language translation uses `qwen2.5-coder:7b`. The model is warmed up when you pick a voice language (and when the app starts). If it's still loading, the first line is spoken in the original language and the translation is ready for the next one.

### Voice commands
- `Hey Capri, talk in Spanish` / `Capri, habla en español` (also English and Japanese)
- `Hey Capri, talk in auto language` / `Capri, habla en cualquier idioma` returns to automatic mode.

---

## 7. Commands and examples

Capri understands commands in both English and Spanish.

### Global hotkeys
| Key | Action |
| :--- | :--- |
| `↓` (Down arrow) / `Ctrl+Alt+V` | Push-to-talk: start / stop talking to Capri. |
| `Esc` while she's listening | Cancels what you were saying. |
| `→` (Right arrow) | Toggle always-listening mode. |
| `←` (Left arrow) | Open / close Capri's chat (same as `Ctrl + Click` on her). |
| `Ctrl+Alt+S` | Open the optical scanner / scan. |
| Hold `Ctrl` in Game Mode | In Game Mode Capri lets clicks pass through to the game; hold `Ctrl` over her to move or touch her. |
| `Ctrl+Alt+G` in Game Mode (Linux) | Same as holding `Ctrl`, which Linux can't detect in that mode. |

> **Note:** while another app has the focus, those arrows are reserved for her. You can turn that off in the voice settings; `Ctrl+Alt+V` always works. In her own windows the arrows work normally in text fields.

### Mouse
| Action | What it does |
| :--- | :--- |
| `Click` on Capri | Opens the Dev Deck. |
| `Ctrl + Click` | Opens / closes her chat. |
| `Shift + Drag` | Moves her around the screen. |
| `Shift + Right Click` | Gives her a headpat. |

### General
| Command | Action |
| :--- | :--- |
| `show me your red eye` / `mostrame tu ojo rojo` | Changes her look. Also `your eye` / `tu ojo` and `your big eyes` / `tus ojos`. |
| `why did you pick that?` / `¿por qué elegiste eso?` | She answers about what she just said or did on her own. |
| `what's new?` / `¿qué hay de nuevo?` | Reads the notes of this version. |
| `update yourself` / `actualizate` | Looks for a new version. |
| `clip that` / `clipeá eso` | Saves the last moments of your game with ShadowPlay (`F8`). |
| `are you bored?` / `¿estás aburrida?` | She finds something to do: music, a video or a search. |

The drawing, League of Legends and Cyberpunk 2077 commands are in [section 8](#8-autonomous-drawing-in-paint) and [section 9](#9-live-game-integrations-lol--cyberpunk-2077).

### Voice macros
| Command | Action |
| :--- | :--- |
| `when I say "it's game time", open League, play phonk on Spotify and turn on game mode` / `cuando yo diga "its game time", abrí el lol...` | Creates a macro. The local LLM turns the sentence into actions: open/close apps, Spotify, URLs, media controls, game mode, say something, wait, or run a command. |
| `it's game time` | Runs the macro (tolerates Whisper variations like *"Capri, it's game time!"*). |
| `list macros` / `mis macros` | Lists saved macros. |
| `delete the "it's game time" macro` / `borrá el macro its game time` | Deletes a macro. |

### Coding agent
| Command | Action |
| :--- | :--- |
| `build me a landing page on my desktop for a cyberpunk coffee shop with html, css and javascript` | Plans the project, writes the files, verifies them, fixes problems and opens the result in your browser. |
| `make a calculator in javascript` / `build me a todo app` | Same for any small web project. |

- Runs a multi-step loop with the largest *coder* model you have in Ollama (e.g. `qwen2.5-coder:14b`).
- Checks for missing referenced files, incomplete HTML, JavaScript syntax (`node --check`) and unbalanced CSS braces.
- Projects are created in a new Desktop folder; it can't write outside that folder and blocks destructive commands.

### Music and Spotify
| Command | Action |
| :--- | :--- |
| `play bohemian rhapsody on spotify` / `pon bohemian rhapsody en spotify` | Opens Spotify if needed, searches the song and plays it. |
| `skip song` / `cambia la canción` | Next track. |
| `previous track` / `canción anterior` | Previous track. |
| `pause the music` / `pausa la música` | Pause. |
| `resume the music` / `play` | Resume. |

### Web and YouTube
| Command | Action |
| :--- | :--- |
| `search the web for what Soulkiller is` / `busca en el navegador qué es Soulkiller` | Opens your browser with a Google search. |
| `open youtube and play cyberpunk edgerunners ost` | Opens YouTube with the matching video. |

### Games and apps
| Command | Action |
| :--- | :--- |
| `open league of legends` / `abrí el lol` | Starts the Riot client / League of Legends. |
| `open cyberpunk` | Launches Cyberpunk 2077 through Steam or GOG. |
| `open steam` / `open discord` / `open obs` | Launches Steam, Discord or OBS Studio. |
| `close league` / `close chrome` / `cerrá discord` | Closes the process. |

### Desktop interaction
| Command | Action |
| :--- | :--- |
| `sit on tabs` / `sentate en la pestaña` | Capri perches on your browser tabs. |
| `sit on the desktop` / `sentate en el escritorio` | She goes back to the desktop. |
| `what are you doing?` | She tells you how she feels and what she's up to. |

---

## 8. Autonomous drawing in Paint

Capri can draw in **MS Paint** by moving your mouse, with drawings planned on the fly by the local LLM.

### A. Style and planning
- Loose, clean cyber-sketch style: stick figures, simple silhouettes, logos and geometric outlines, each element drawn once without repeated strokes.
- Apart from a few calibration tests, every drawing is planned live by the LLM by breaking the subject into simple shapes.

### B. Stroke language (100x100 grid)
The LLM describes the drawing on a normalized grid from `0` to `100` (`(0,0)` top-left, `(100,100)` bottom-right):
- **`line`**: `{ type: "line", x1, y1, x2, y2 }`
- **`polyline`**: `{ type: "polyline", points: [[x, y], ...], closed?: boolean }`
- **`circle`**: `{ type: "circle", cx, cy, r }`
- **`ellipse`**: `{ type: "ellipse", cx, cy, rx, ry }`
- **`arc`**: `{ type: "arc", cx, cy, rx, ry, startAngle, endAngle }` (degrees, 0 to 360)
- **`curve`**: `{ type: "curve", p0: [x,y], p1: [x,y], p2: [x,y], p3?: [x,y] }` (quadratic / cubic Bézier)

### C. Validation and retries
- **`StrokeValidator`** clamps out-of-range coordinates, drops invalid / `NaN` values and limits drawings to 25 shapes.
- If the LLM returns broken JSON or invalid coordinates, it retries up to twice with the exact errors so the model can fix them.
- If Ollama isn't running, Capri falls back to a procedural plan (cat, house, sun or stick figure) and tells you she improvised.

### D. Win32 executor and human-like strokes
- `scripts/paint_drawer.ps1` finds the Paint window (`EnumWindows`, `GetWindowRect`), restores and focuses it.
- It computes the safe canvas area, avoiding the ribbon and the status bar.
- `SetCursorPos` + `mouse_event` with interpolated points, ease-in/ease-out and ~1px micro-jitter emulate a human hand.
- It uses the active tool and default color to stay robust across DPI scaling (100%, 125%, 150%).

### E. Safety and panic key (`Escape`)
- Before touching the mouse Capri warns you by voice and waits 1.8 seconds.
- If Paint loses focus the drawing is aborted.
- Pressing **`Escape`** at any time releases the mouse button immediately (`MOUSEEVENTF_LEFTUP`), cancels the task and hands control back to you.

### F. Learning drawings with the optical scanner
1. Open the scanner: `Capri, open the scanner` / `Capri, abrí el escáner`, or `Ctrl+Alt+S`.
2. Place the translucent frame over the sketch or logo you want to teach.
3. Say `Capri, learn how to draw X` / `Capri, aprendé a dibujar X`.
4. Capri captures that region and uses a local vision model (LLaVA or similar) to extract the main lines and proportions as shapes on the 100x100 grid.
5. The technique is saved in her memory and in `learned_drawings/<subject>.json`.
6. Next time you ask `Capri, draw X`, she uses what you taught her.

### G. Drawing commands
- **Teach through the scanner**: `Capri, look at this logo`, `Capri, learn how to draw a cat`, `Capri, aprendé el logo de Arasaka`.
- **Calibration tests**: `Capri, probá dibujo monigote` / `casa` / `sol`.
- **LLM-planned (or learned) drawings**: `Capri, draw a cute robot`, `Capri, draw the Arasaka logo`, `Capri, dibujá un gato`, `Capri, draw the last logo I showed you`.

---

## 9. Live game integrations (LoL & Cyberpunk 2077)

### A. League of Legends (LCU & Live Client Data API)

#### 1. Champion select (LCU)
Capri connects to the local Riot client API (`LeagueClientUx.exe`) over authenticated HTTPS:
- **Auto-accept**: `Capri, turn on auto accept` / `activá el auto aceptar`, and `turn off auto accept`.
- **Queue**: `Capri, find a match` / `busca partida`, `accept the match`, `cancel the queue`.
- **Picks and bans**: `Capri, ban Blitzcrank`, `Capri, pick Caitlyn`.
- **Combined plans**: `Capri, find a match, ban Zed and pick Ahri` chains everything in one command.

#### 2. In game
Capri polls Riot's official local API (`https://127.0.0.1:2999/liveclientdata/allgamedata`):
- **Counter-item advice**: reads enemy items (Spanish or English names, or item IDs), checks `assets/game_data/lol_item_advice.json` and tells you what to buy (e.g. armor penetration against heavy armor stacking). At the start of every match she gives you a tip about your lane opponent and the enemy jungler.
- **LLM-written commentary**: every event (kills, deaths, multikills, objectives, KDA, fed or feeding players, match start/end) is sent to the local LLM with real match facts (champions, roles, KDA, level, CS, item gold, whether it was a jungle gank) and Capri writes her own line with emotions (`[excited]`, `[laugh]`, `[teasing]`...). Fixed lines are only used as a fallback if the LLM takes longer than ~4 seconds, and lines in the wrong language are discarded.
- **"Can we beat that Garen?"**: compares level, item gold and KDA against that champion and gives a verdict (*"we're so fed, LET'S GO!"*, *"don't even think about it"* or *"coin flip"*). She remembers it: if you kill him she says *"told you so"*, if he kills you she rubs it in, and if minutes pass without you going for it she asks what you're waiting for.
- **Kill streaks**: celebrates Killing Spree, Rampage, Unstoppable... and reacts when your streak gets shut down.
- **Roasts**: mocks whoever is feeding, warns you about fed enemies and hypes teammates who carry (at most one comment per player every few minutes).
- **Verified objectives**: impossible events (e.g. a dragon before minute 5) are ignored.
- **Recommended model**: `qwen2.5-coder:7b` (~1 s per line), warmed up on the GPU when the match starts.
- **Game Mode**: Capri docks in a corner and doesn't block game clicks (hold `Ctrl` over her to move her).

### B. Cyberpunk 2077 (CET mod telemetry)
- **Local telemetry server** on port `2077`, fed by Capri's own mod for **Cyber Engine Tweaks**, `assets/game_data/cyberpunk_mod/init.lua`. See [Installing the Cyberpunk 2077 mod](#installing-the-cyberpunk-2077-mod).
- **Events**: combat start/end, low health, wanted level, kills, civilian kills, driving speed and crashes, cyberware (Sandevistan, Kerenzikov, Berserk...).
- **Real locations read from the map**: ripperdocs, gun shops, bars, gigs, tarot cards, NCPD hustles and cyberpsychos are read from the game's own map icons when you open the map (`M`) and cached in `capri_locations.json`. No made-up coordinates.
  - `mark the nearest ripperdoc`, `take me to Lizzie's bar`, `mark the nearest tarot card`, `find me a cyberpsycho`, `mark a gang hustle`.
- **"What should we do next?"**: suggests your tracked quest, a nearby gig from the map or an activity (races, clearing gangs, cyberpsychos, fighting MaxTac).
- **Quickhacks**: recognizes the quickhack you upload (Overheat, Short Circuit, Contagion, Synapse Burnout...) and the one an enemy netrunner is uploading to you, and reacts to each.
- **HUD banner**: markers show `[CAPRI] RIPPERDOC // name (distance)` in the middle of the screen.
- **Crash safety**: the mod never enumerates the quest journal (that native call crashes the game) and keeps a breadcrumb file (`capri_crumb.txt` / `capri_unsafe.json`) to automatically disable any call that crashed.
- **Only CET is required**: the mod doesn't use RED4ext, redscript, Codeware or any other framework.
- **CET console**: `GetMod("capri").dump()` writes `capri_debug.json` with the detected icons; `GetMod("capri").remember("bar", "Lizzie's Bar")` saves your current position with a name.

---

## 10. Permissions and system access

| Feature | Privileges | APIs / resources | Binaries | Network | Safety |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Optical scanner** | Standard user | Capture of the scanner frame region (`desktopCapturer`), local multimodal inference | Electron, `ollama.exe` | Loopback `127.0.0.1:11434` | Only the scanner rectangle is captured; images are processed locally and discarded. |
| **Paint drawing** | Standard user | Win32 `SetCursorPos`, `mouse_event`, `EnumWindows`, `GetWindowRect`, `GetAsyncKeyState` | `powershell.exe`, `mspaint.exe` | Loopback (Ollama) | **`Escape` panic key**; only draws while Paint is focused. |
| **LoL champion select** | Standard user | Reads `LeagueClientUx.exe` command line for the local token and port | `LeagueClientUx.exe` | Local HTTPS to the LCU port | Standard champion-select actions only. |
| **LoL in-game** | Standard user | Riot's official Live Client Data API | `League of Legends.exe` | Local HTTPS `127.0.0.1:2999` | Read-only official API, no memory access. |
| **Cyberpunk telemetry** | Standard user | Local TCP listener | Capri + CET Lua mod | `127.0.0.1:2077` | Listens on localhost only. |
| **Spotify control** | Standard user | Win32 `PostMessage` with `WM_APPCOMMAND` | `Spotify.exe`, `powershell.exe` | None | No code injection; standard media commands. |
| **Speech recognition** | Microphone permission | WebAudio / `MediaRecorder` | `python.exe` (`faster-whisper`) | None (100% local) | Revocable in Windows privacy settings. |
| **Always listening** | Microphone permission | WebAudio with a local voice-activity detector | `python.exe` (`faster-whisper`) | None | Toggled with `→`. Anything not addressed to Capri is discarded and never stored. |
| **Voice macros** | Standard user | `capri_macros.json` in the app data folder | Apps the macro opens or closes | Loopback (Ollama) | Only runs the actions you defined. |
| **Coding agent** | Standard user | Writes files in a new Desktop folder, `node --check` | `cmd.exe`, `node.exe` | Loopback (Ollama) | Can't write outside the project folder; destructive commands are blocked. |
| **Text-to-speech** | Standard user | Child processes (`child_process.spawn`) | `python.exe` (`edge-tts`), `ffmpeg.exe` | HTTPS to Microsoft Edge TTS, Fish Audio or ElevenLabs depending on the provider | Frequent lines are cached locally. |
| **Local LLM** | Standard user | HTTP to the Ollama daemon | `ollama.exe` | Loopback `127.0.0.1:11434` | Fully local: conversations never leave your PC. |
| **Roaming on screen** | Standard user | Transparent frameless window, Win32 `GetForegroundWindow` | Electron | None | Click-through (`setIgnoreMouseEvents`) except over Capri. |

---

## 11. Installation and development

### Install (Windows)

1. Download `CapriDesktop-Setup-x.y.z.exe` from the repository's **Releases** page and run it.
2. Pick the installer language and the install folder.
3. When it finishes, Capri opens the **first-run wizard**:
   - the language you'll speak;
   - **what she should call you**;
   - component setup: Python + Whisper + Edge-TTS (voice and hearing), FFmpeg, Ollama, the `qwen2.5-coder:7b` model and the `capri` personality (built with your name). Everything is downloaded with `winget` / `pip` and runs locally.

Components can be installed later; features that depend on them (voice, local AI) start working once they're ready.

### Install (Linux)

1. Download the `.deb` from **Releases**. It works on Debian-based distros (Debian, Ubuntu, Mint, Kali).
2. Install it with its helpers: `sudo apt install ./CapriDesktop-x.y.z.deb python3-venv zstd xdotool wmctrl playerctl`.
   On other distributions, extract the `.tar.gz` and run `capridesktop`, with the same helpers from your package manager.
3. Open Capri and follow the same first-run wizard. Use an X11 session.

Paint drawing isn't available on Linux. Everything that differs from Windows is listed in [REQUIREMENTS.md](REQUIREMENTS.md#13-linux).

### Requirements
- **OS**: Windows 10 or 11 (64-bit), or Linux x64 with X11. macOS is not supported yet.
- **Minimum PC**: 6-core CPU, 16 GB of RAM and 10 GB of free disk. It works without a GPU, but replies are slow.
- **Recommended PC**: the same, plus an NVIDIA GPU with 6 GB+ VRAM and 20 GB of free disk. To play a game at the same time, 12 GB+ VRAM. See [REQUIREMENTS.md](REQUIREMENTS.md) for the measurements.
- **Internet**: for the first-run setup and for the Edge-TTS voice.
- **Spotify Desktop (optional)**: native media control.
- **Cyber Engine Tweaks (optional)**: live Cyberpunk 2077 telemetry, together with Capri's mod. See [Installing the Cyberpunk 2077 mod](#installing-the-cyberpunk-2077-mod).
- **Fish Audio / ElevenLabs (optional)**: API key in `voice_config.local.json` (see `voice_config.example.json`).

### Choosing a disk

If you install her on a disk other than the system's, her requirements go there too, in a `CapriData` folder: Python, the voice environment, Whisper, FFmpeg, Ollama and its models. Requirements you already have stay where they are. You can pick another folder in the first-run setup, under **Where to install**.

### If she doesn't hear you

Open the voice settings and press **Test** next to the microphone: it records a few seconds and shows what she understood.

- **No sound coming in:** pick another microphone in the same place, or check that the system isn't blocking it.
- **Sound, but no words:** run the setup again from the model settings. Her hearing may be incomplete.
- **The first time** she also downloads her hearing, about 500 MB, and tells you while it's loading.

### Uninstalling

Your memories, settings and API keys are kept apart from the program, so a new install finds them. On Windows the uninstaller asks whether to delete them too. On Linux, `sudo apt remove capridesktop` keeps them; to delete them, remove `~/.config/capridesktop`. In both cases Ollama's models stay.

To run the first-run setup again, or finish a step you skipped: **model settings > Run setup again**.

### Installing the Cyberpunk 2077 mod

Two pieces are needed: **Cyber Engine Tweaks (CET)**, which loads mods, and **Capri's mod**, which sends the game's events to her.

1. Close the game.
2. Install CET from [GitHub](https://github.com/maximegmd/CyberEngineTweaks/releases) or [Nexus Mods](https://www.nexusmods.com/cyberpunk2077/mods/107), in the version that matches your copy of the game, and extract it into the game folder. You should end up with `Cyberpunk 2077\bin\x64\plugins\cyber_engine_tweaks`. If CET doesn't start, install the [Visual C++ Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe).
3. Open the game once. CET asks you to choose a key for its overlay. Close the game.
4. Open Capri. When she finds CET in your Steam libraries or in the default GOG and Epic folders, she installs her mod and keeps it up to date.
5. Check that this file exists: `Cyberpunk 2077\bin\x64\plugins\cyber_engine_tweaks\mods\capri\init.lua`.
6. Open Capri first, then the game, and load a save. She reacts when you get into a fight.

**Manual install**, if the file from step 5 isn't there (the game is in another folder, or Windows didn't let her write there): download `CapriCyberpunkMod-1.0.0.zip` from [Releases](https://github.com/nunezValen/CapriDesktop/releases/latest) and extract it into the `Cyberpunk 2077` folder, so `bin` merges with the one already there. CET is still needed.

**On Linux**, the game runs through Proton and CET needs this in the game's Steam launch options:

```
WINEDLLOVERRIDES="version=n,b" %command%
```

### Development

```powershell
git clone https://github.com/nunezValen/CapriDesktop.git
cd CapriDesktop
npm install

# Voice environment (Python 3.10 - 3.13)
py -3.11 -m venv .venv
.venv\Scripts\python -m pip install -r scripts/requirements.txt

# Ollama + models
ollama pull qwen2.5-coder:7b
ollama create capri -f scripts/Modelfile.capri   # replace {name} with your name first, or create it from the wizard

npm run dev
```

On Linux, create the environment with `python3 -m venv .venv` and `.venv/bin/python -m pip install -r scripts/requirements.txt`.

In development the app uses the repository's `scripts/`, `assets/` and `.venv/`. Installed, it uses the bundled resources and keeps everything writable (voice settings, cache, Python environment, learned drawings) in `%APPDATA%\Capri Desktop`, or `~/.config/Capri Desktop` on Linux. An older install keeps using its `Cyber Companion` folder.

### Build the installer

```powershell
npm run dist:win     # -> release/CapriDesktop-Setup-<version>.exe
npm run dist:linux   # -> release/CapriDesktop-<version>.deb (run it on Linux)
```

### Dev Deck
Clicking on Capri opens the **Dev Deck**:
- **chat & vision**: chat with the agent over Capri's eyes (*new chat* button to start over).
- **code editor**: real folder tree (lazy-loaded, per-type file icons), CodeMirror editor with syntax highlighting, tabs with unsaved markers, `Ctrl+S` to save and a collapsible Capri panel with *Explain*, *Find bugs* and *Refactor* for the open file.
- The model picker only lists models installed in Ollama.

### Type checking and builds

```powershell
npm run typecheck   # main + renderer
npm run build       # main, preload and renderer bundles
```

---

## 12. License and credits

- **Author**: [nunezValen](https://github.com/nunezValen).
- **License**: code released under the [MIT](LICENSE) license.
- **Inspiration**: a fan project inspired by *Cyberpunk 2077* and *Cyberpunk: Edgerunners*. Not affiliated with or endorsed by CD PROJEKT RED or Studio Trigger; trademarks and characters belong to their respective owners.

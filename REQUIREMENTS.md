# Capri (Project Capricorn) // System & Software Requirements

This document specifies all system dependencies, runtimes, AI models, and software requirements needed to run Capri, the autonomous cyberpunk desktop companion and her Neural Scanner Mode.

---

## 1. System Requirements

| Requirement | Minimum (no GPU, slow replies) | Recommended | Playing a game with Capri |
|---|---|---|---|
| **Operating System** | Windows 10 64-bit (build 19041+) | Windows 11 64-bit | Windows 11 64-bit |
| **Processor** | 6-core x64 (Ryzen 5 5600X class) | 6+ cores | 6+ cores |
| **RAM** | 16 GB | 16 GB | 16 GB, 32 GB to keep other apps open |
| **GPU** | Not required | NVIDIA with 6 GB+ VRAM | NVIDIA with 12 GB+ VRAM |
| **Free disk space** | 10 GB | 20 GB | 20 GB, plus the game |
| **Internet** | For the first-run setup and for Capri's Edge-TTS voice | Same | Same |

Linux (x64) is supported, see [section 1.3](#13-linux). macOS is not supported yet.

### 1.1 What these numbers are based on

Measured on a Ryzen 5 5600X, 16 GB of RAM and an RTX 2060 12 GB, with 60-token replies:

| Model | Runs on | Memory used | Speed |
|---|---|---|---|
| `qwen2.5-coder:7b` (the default) | GPU | 4.8 GB VRAM | 42 tokens/s |
| `qwen2.5-coder:7b` (the default) | CPU | 5.1 GB RAM | 6 tokens/s |
| `qwen2.5-coder:1.5b` | CPU | 1.2 GB RAM | 23 tokens/s |

- **Without a GPU** Capri works, but a line of about 100 tokens takes about 17 seconds. That's too slow for live game commentary.
- **With 8 GB of RAM** the default model doesn't leave enough room. Use `qwen2.5-coder:1.5b` from the model picker: it's much lighter, but its replies are simpler.
- **While playing**, the game and the model share the same VRAM. If they don't fit, Ollama moves part of the model to the CPU and replies slow down. The 12 GB figure is the configuration tested, not a measured lower limit.
- **Whisper** uses the GPU only on NVIDIA cards with CUDA available. Otherwise it switches to the CPU on its own, and transcription is slower.
- **Loading the default model** took about 38 s on this machine, so the first reply after it has been unloaded takes that much longer.

### 1.2 Disk space

| Component | Size | Needed |
|---|---|---|
| Capri app | 325 MB (101 MB installer) | Always |
| Ollama | 3.1 GB | For local AI |
| `qwen2.5-coder:7b` | 4.7 GB | Default model |
| `capri` personality | Almost nothing extra (built on the model above) | Default |
| Whisper `small` | 464 MB | Microphone |
| Python, voice packages and FFmpeg | About 1 GB (estimate) | Voice and hearing |
| `llava` | 4.7 GB | Optional: optical scanner |
| `qwen2.5-coder:14b` | 9 GB | Optional: coding agent |

### 1.3 Linux

Tested on Ubuntu 26.04 with X11 (Openbox on a virtual display). Not yet tested on a physical Linux PC, with a GPU, or on Wayland. The hardware numbers above were measured on Windows.

The first-run wizard downloads FFmpeg and Ollama into the app's own folder without asking for a password. It only asks for one if Python is missing.

| Package | Needed for | Without it |
|---|---|---|
| `python3` and `python3-venv` (3.10 to 3.14) | Voice and hearing | No voice, no microphone |
| `zstd` | Installing Ollama without a password | The wizard runs Ollama's official installer, which asks for the password |
| `xdotool` | Gaming Mode and scanner click-through, active window, game detection, clip key | Capri stays click-through without reacting to the mouse, and doesn't notice games |
| `wmctrl` | Perching on windows, detecting videos in the browser | She doesn't perch or comment on what you're watching |
| `playerctl` | Play, pause and skip on the player that's running, and what it's playing | Play and skip still work through D-Bus, she doesn't know what's playing |
| `xdg-utils` | Opening links and apps | Links and unknown apps don't open |
| `pkexec` (polkit) | The wizard's password prompt | The wizard shows the command to run by hand |

```bash
sudo apt install python3-venv zstd xdotool wmctrl playerctl   # Debian, Ubuntu, Mint, Kali
```

The installer is a `.deb`, so other distros run Capri from source. They need the same helpers:

```bash
sudo dnf install python3 zstd xdotool wmctrl playerctl        # Fedora
sudo pacman -S python zstd xdotool wmctrl playerctl           # Arch
```

**Use an X11 session.** On Wayland, windows can't see each other, so perching and game detection only work with apps running through XWayland, and global hotkeys depend on the desktop's portal support.

Differences from Windows:

- **Paint drawing** isn't available: it controls MS Paint. Capri says so when asked.
- **League of Legends and VALORANT** need Vanguard, which doesn't run on Linux, so their commentary doesn't apply.
- **Cyberpunk 2077** runs through Proton. Capri looks for the mod in your Steam libraries (native or Flatpak) and in Heroic.
- **Clips** press F8, for whichever recorder you bind to that key. ShadowPlay doesn't exist on Linux.
- **Gaming Mode**: `Ctrl+Alt+G` turns click-through on and off, because Linux can't report Ctrl while she is click-through.
- **Updates**: Capri opens the release page, because installing a `.deb` needs your password.

---

## 2. Core Software & Runtimes

### 2.1 Node.js & Package Manager
- **Node.js**: `v18.0.0` or higher (`v20.x LTS` recommended).
- **npm**: `v9.x` or higher.
- Verification:
  ```powershell
  node --version
  npm --version
  ```

### 2.2 Ollama (Local AI Brain)
- **Runtime**: Ollama for Windows (https://ollama.com/download/windows).
- Ollama service runs automatically at `http://127.0.0.1:11434`.
- Verification:
  ```powershell
  ollama --version
  ```

### 2.3 Python (Voice: Whisper STT + TTS)
- **Python**: `3.10` or `3.11`.
- Virtual environment at `.venv` in the project folder.
- Core packages:
  - `edge-tts` (Neural TTS voice synthesis, also the fallback when Fish Audio / ElevenLabs fail)
  - `faster-whisper` (local speech-to-text on the GPU; model `small` by default, override with the `CAPRI_WHISPER_MODEL` env var)
  - `sounddevice`, `numpy`
- **FFmpeg** in the PATH (audio conversion and the voice DSP filters).

### 2.3.1 Optional cloud voices
- **Fish Audio** or **ElevenLabs**: put the API key and provider in `assets/capri_voice/voice_config.local.json` (git-ignored, see `voice_config.example.json`). With Fish Audio, laughter tags like `[laugh]` / `[giggles]` are performed as real laughs; with Edge-TTS they are written as "jajaja" / "hahaha".

### 2.3.2 Microphone
- Required for push-to-talk (`↓`) and the always-listening mode (`→`). Transcription is 100% local.

### 2.4 PowerShell
- **PowerShell**: 5.1 (built into Windows) or PowerShell 7+.
- Execution policy should allow local scripts (`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`).
- Used by native background helpers:
  - `scripts/apple_music.ps1` (Apple Music through the Windows media session and UI Automation)
  - Window geometry and active app detection for perching on browser tabs.

---

## 3. Required Ollama AI Models

Capri utilizes local Ollama models for both conversation/actions and multimodal visual analysis.

### 3.1 Text & Agent Logic Models (Install at least one)
```powershell
# 1. Custom Capri Edgerunner Model (Created from Modelfile)
ollama run capri

# 2. Or standard Qwen2.5-Coder (Fast, powerful tool calling and coding)
ollama pull qwen2.5-coder:7b
ollama pull qwen2.5-coder:1.5b

# 3. Recommended for the coding agent ("build me a landing page"): the largest coder model your GPU fits
ollama pull qwen2.5-coder:14b
```

| Feature | Recommended model | Notes |
|---|---|---|
| Chat / commands / macros | `capri` or `qwen2.5-coder:7b` | Selected in the Dev Deck model picker |
| LoL live commentary | `qwen2.5-coder:7b` | ~1 s per line; warmed up when the match starts |
| Coding agent | `qwen2.5-coder:14b` | Picked automatically (largest *coder* model installed) |

### 3.2 Multimodal Vision Models for "Modo Scanner" (Required for Neural Scanner Frame)
The Neural Scanner captures regions of your screen (drawings, Paint, code, games, UI) and sends them to a multimodal vision model.

```powershell
# Standard Recommended Vision Model (Installed & Verified)
ollama pull llava

# Alternative high-performance vision models supported automatically:
ollama pull qwen2.5-vl
ollama pull moondream
```

---

## 4. Node.js & Project Dependencies

Installed automatically via `npm install` in the project folder:

### Production Dependencies
- **`electron`**: `^32.x` (Desktop application shell with transparent windows)
- **`react`**: `^18.3.1` (UI rendering)
- **`react-dom`**: `^18.3.1`
- **`lucide-react`**: `^0.453.0` (Cyberpunk HUD and control icons)

### Development & Build Tooling
- **`electron-vite`**: `^2.3.0` (Fast Vite-based Electron bundler)
- **`vite`**: `^6.x`
- **`typescript`**: `^5.6.3`
- **`tailwindcss`**: `^3.4.14` (Cyberpunk styling engine)
- **`postcss`**: `^8.4.47`
- **`autoprefixer`**: `^10.4.20`

---

## 5. Third-Party Application Integrations

- **Apple Music for Windows**: Plays the songs you ask for ("reproduce canción", "play <song>"). Pause, skip and "what am I listening to" work with any player that shows up in the Windows media controls ("cambia de canción", "pausa la música"). On Linux, songs open on the Apple Music website.
- **Web Browsers (Chrome / Edge / Firefox / Opera)**: Supported for tab perched resting pose and web search breaches.
- **Drawing Tools (MS Paint / Photoshop / Figma)**: Supported through the Neural Scanner Frame's click-through transparent layer.

---

## 6. Setup & Verification Steps

1. **Clone the repository and navigate to the folder**:
   ```powershell
   git clone https://github.com/nunezValen/CapriDesktop.git
   cd CapriDesktop
   ```

   > End users don't need any of this: the Windows installer ships a first-run wizard that installs Python, FFmpeg, Ollama and the models.

2. **Install JavaScript dependencies**:
   ```powershell
   npm install
   ```

3. **Verify and pull Ollama models**:
   ```powershell
   ollama list
   # If missing:
   ollama pull qwen2.5-coder:7b
   ollama create capri -f scripts/Modelfile.capri   # replace {name} with your name first
   ollama pull llava
   ```

4. **Verify TypeScript compilation**:
   ```powershell
   npm run typecheck
   ```

5. **Build and launch**:
   ```powershell
   # Production build:
   npm run build

   # Launch companion in dev mode:
   npm run dev
   ```

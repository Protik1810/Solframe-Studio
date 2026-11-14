# ✨ Solframe Studio v1.1.5

**The Sovereign Desktop Generative AI Workstation** — by **Protik**

## 🆕 What's new in v1.1.5

### 🎥 Third video engine: MiniMax H3 (FreeVideo)

Video Studio gains a third model — **MiniMax H3**, running through the installed FreeVideo headless engine (Video DeltaNet / VDN-H3, int8) right on your GPU. It appears in the model picker as "MiniMax H3" with its own engine-managed defaults; guidance and chunking are handled by the engine, single runs up to 15 s. The duration slider now adapts to the selected model instead of a fixed 60 s, and clamps instantly when you switch models.

### 🔄 Automatic updates (OTA)

The Windows app now keeps itself current: it checks GitHub Releases at startup and every 6 hours, downloads a new version silently in the background, and applies it the next time you restart the app. No installer hunting, no manual re-download — the About page still shows what version you're on and what's latest. (The portable exe is single-file by design and still updates the manual way.)

### 🔧 Installer fix

v1.1.4's installed build could fail on launch with `Cannot find module '../video_backend.cjs'` — the Video Studio backend module shipped outside the app archive the code required it from. Fixed for good: the module is packed into the asar and the loader falls back to the resources copy, so both install layouts work.

---

# ✨ Solframe Studio v1.1.4 (previous)

**The Sovereign Desktop Generative AI Workstation** — by **Protik**

[![License: GPL v3](https://img.shields.io/badge/License-GNU%20GPL%20v3.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue.svg)](https://github.com/Protik1810/Solframe-Studio)
[![CI](https://github.com/Protik1810/Solframe-Studio/actions/workflows/ci.yml/badge.svg)](https://github.com/Protik1810/Solframe-Studio/actions/workflows/ci.yml)

---

Solframe Studio is a standalone, self-contained desktop app for 100% private, offline generative AI — image synthesis, video generation, and LLM chat running as native inference directly on your own GPU, with zero cloud calls, zero subscriptions, and zero telemetry.

## 🆕 What's new in v1.1.4

**Solframe Studio generates video now.** A new **Video Studio** tab puts text-to-video and image-to-video generation behind the same private, on-your-GPU philosophy as everything else — no cloud, no queue you don't control.

### 🎬 Video Studio

- **Two engines, same tab**: LTX-Video 2B (0.9.5) and Wan 2.2 TI2V 5B, picked per job with per-model defaults handled for you (LTX: 50 steps, guidance 3.0; Wan: 30 steps, guidance 5.0).
- **Full control**: prompt and negative prompt, duration slider (2–60 s), resolution presets (704×480, 832×480, 1280×720), steps, guidance, chunk length, and seed.
- **Image-to-video done properly**: attach a first frame — or don't, and the image pipeline generates one for you automatically. Then the engine renders your shot as consecutive chunks, each conditioned on the previous chunk's last frame, and concatenates them losslessly with ffmpeg. The boundary between chunk 1 and chunk 2 is the same shot continuing — no hard cuts, no visible seam. Proven on a real run: an 18.7-second continuous video from 4 chained chunks, with frames taken 0.25 s apart across a chunk boundary indistinguishable from frames inside one chunk.
- **Live progress and playback**: an elapsed timer while it renders, an in-app player when it's done, and a generated-library grid listing everything the engine has produced.
- **OpenAI-compatible API**: the video server (`video_server.py`, bundled with the Windows installer) exposes `POST /v1/video/generations` on port 8766 next to the image API's 8765 — point any OpenAI-SDK-style client at it. The desktop app routes its own `/api/video` through the same backend in both production (Electron) and development (Vite middleware), so what you test with `npm run dev` is what ships.

### 🌐 Redesigned product page

The landing page (`product.html`) got a full redesign — new feature grid, an interactive install terminal, and a coverflow gallery — with every screenshot embedded as a base64 data URI, so it renders 100% self-contained even offline. The app entry (`index.html`) is restored to its job, no longer overwritten by the showcase.

---

## 🆕 What's new in v1.1.3

**Linux is now a real platform.** Previously the Linux build shipped no inference engine at all — it launched, scanned models, and could not generate a single image. It now ships working engines and stands alongside Windows and macOS.

### 🐧 Linux
- **Real image generation and chat.** Vulkan and CPU builds of `stable-diffusion.cpp`, plus `llama.cpp` — checksum-verified from upstream like every other platform.
- **CUDA engine for NVIDIA cards**, compiled from source and bundled with its own CUDA runtime, so you install no toolkit. Neither upstream project publishes a prebuilt Linux CUDA binary, which is why this one had to be built rather than downloaded. Non-NVIDIA machines fall through to Vulkan automatically.
- **Picks the right GPU on hybrid-graphics laptops.** The engine defaults to GPU 0 — usually the integrated chip — and runs out of memory immediately while the discrete card sits idle. The discrete GPU is now detected and selected explicitly.
- **The app icon shows up.** The window could not be linked to its desktop entry, so the desktop environment had no icon to display.
- The library health panel used to report missing Windows `.exe`/`.dll` files on Linux — paths that could never exist there.

### 📦 One download per platform
The Windows installer, the Linux `.deb`, and the macOS Apple Silicon `.zip`. The Windows Lightweight installer, the macOS `.dmg`, and the Intel Mac build are gone — none of them was the build anyone should pick.

**No more AppImage.** Every AppImage needs the legacy `libfuse2`, which current Ubuntu no longer ships, so it simply failed to launch. The `.deb` needs no workaround.

macOS is Apple Silicon only: Metal inference requires an M-series GPU, so an Intel bundle shipped a UI that could not generate anything.

### 🐛 Also fixed
- Engine binaries could ship without their executable bit (Python's `zip` extraction drops Unix permissions), so `sd-cli` could not be spawned at all.
- On Linux the app reported "CUDA" while actually running Vulkan; the backend it names is now the one it uses.

---

## 🆕 What's new in v1.1.2

A maintenance release — repo hardening and one real UI bug fix, no new user-facing features.

### 🚀 New: guided first run

- **Starter Packs.** A fresh install has no models, and neither image pipeline works until the right *combination* of files is present — one all-in-one checkpoint for the standard pipeline, or a diffusion model + text encoder + VAE for FLUX, none of which is useful alone. Model Hub now offers a known-good set matched to your GPU (fp8 builds under 16 GB VRAM, full precision above), downloads it, and files each piece where its pipeline looks. A first run with nothing installed opens on this tab.
- **Models now download somewhere you can find them** — `Downloads/Solframe Studio/` instead of the hidden app-data folder, changeable in Settings. Your existing folder stays on the scan list, so nothing you already have disappears and nothing is moved.

### 🐛 Fixed
- **Adding your own model folder silently did nothing in packaged builds.** The picker reported success and the folder was gone on the next read — the setting was being written inside the app bundle, which is a single archive file, so every save failed invisibly. Custom folders now persist properly.
- **The splash screen logo never rendered** (broken-image icon) — it was loaded via `file://` from a `data:` URL page, which the browser engine blocks.
- **Packaged builds (Windows, macOS, Linux) could crash shortly after launch.** An internal path used by the automatic update check pointed at a location that never actually existed in any packaged build, and the resulting error wasn't caught — every launch had a chance of taking the app down within the first second or two. Fixed at the root, and the download links below now point at rebuilt, verified artifacts (all three platforms were re-tested end-to-end, including a real image generation through the packaged Windows app and a live headless run on Linux).
- **The GPU badge in Image Studio's Studio Controls panel now shows your actual detected GPU.** It was a hardcoded "RTX 4070 Ti (12GB)" string that never reflected real hardware — the canvas header's GPU badge was always correct, this second one just wasn't wired up.

### 🔒 Security
- Content-Security-Policy and `X-Content-Type-Options` headers on every response (dev and production alike).
- Electron now denies camera/mic/geolocation/notification permission requests outright — the app never needs them.
- Dependency updates now flow through Dependabot (npm + GitHub Actions, weekly), and CI runs a non-blocking `npm audit` on every push.
- Every CI-built release artifact now carries a GitHub build-provenance attestation (`gh attestation verify`).
- `SECURITY.md` expanded into a full threat model.

### ⚙️ Engines
- Windows CUDA/Vulkan/CPU (`stable-diffusion.cpp`) and llama.cpp CUDA binaries refreshed to their current upstream releases via the new `fetch-engines.js`, checksum-verified against `engines-lock.json`.

### 🛠️ For contributors
- `scripts/fetch-engines.js` — fetches and SHA-256-verifies the `stable-diffusion.cpp`/`llama.cpp` engine binaries automatically, instead of grabbing them by hand.
- A real UI test suite (jsdom + Testing Library) alongside the existing engine/scanner tests, plus a golden-snapshot test locking FLUX's CLI argument construction.
- `ARCHITECTURE.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `RELEASING.md`, and issue/PR templates.
- `ImageStudio.tsx` and `ChatStudio.tsx` internal state each collapsed into a single reducer (behavior-identical, verified live); `index.css` split into 4 focused files.

---

## 🆕 What's new in v1.1.1

### ⚡ FLUX Performance & Correctness
- **Flash attention runs by default** on every FLUX generation (`--diffusion-fa`) — mathematically exact, not an approximation. This also fixed a real bug: large Klein models were silently overflowing VRAM and falling back to the CUDA driver's own paging, which is ~30-40x slower than a clean fit and gave no visible error — just a generation that quietly took minutes longer than it should have.
- **Smarter RAM offload**: replaced the old CPU text-encoder offload with `--offload-to-cpu`, which keeps FLUX weights staged in system RAM but still computes entirely on the GPU — faster than the old approach, and now **auto-enables itself** once resolution exceeds ~512x512 so large images don't silently hit the same VRAM overflow. Still fully manual-overridable.
- Fixed the FLUX prediction flag for current `stable-diffusion.cpp` builds (`--prediction flux2_flow` → `flux_flow`) — the old flag is rejected outright by newer engine binaries.
- FLUX.2 Klein's "base" (non-distilled) model variants now get correct default steps/cfg automatically. Previously, loading a base model kept the fast distilled-model defaults and silently rendered malformed output — no error, just a wrong image.

### 🎨 Image Studio
- **New: reference-image editing.** Attach an existing image (FLUX pipeline only) and describe the change instead of generating from scratch — FLUX Kontext-style editing via `-r/--ref-image`. Requires a Kontext/edit-capable FLUX model; not every FLUX checkpoint supports it, and there's no reliable way to detect that from the filename alone.
- Image generation now uses **safetensors models only** — GGUF is reserved for LLM Chat. If you were pointing the diffusion model or text encoder at a GGUF file, switch to its safetensors equivalent.
- **Negative prompt is now available for FLUX** too (previously standard-pipeline only) — optional, empty by default, and only has a visible effect once real CFG guidance is active (e.g. a "base" Klein model).
- Fixed generated images never displaying when running the app via `npm run dev` — a dev/production parity gap, not a generation bug.
- Fixed the model scanner missing text-encoder files using a hyphenated `text-encoder` filename outside a dedicated `/clip/` folder.

### 💬 Chat
- **New: image attachments for vision-capable models.** Attach a photo and ask about it — wires up `llama-server`'s `--mmproj` multimodal projector support. Pick an optional vision projector alongside your GGUF model in the sidebar; projector files now get their own category in the model scanner instead of being hidden.
- **New: reasoning/"thinking" model support.** For DeepSeek-R1-style reasoning models, the model's reasoning trace now renders in a collapsible "Thinking" panel above its final answer instead of leaking `<think>` tags into the visible reply. Toggle it on per-session in the sidebar. (Support depends on the specific model's thinking-tag convention matching what `llama.cpp` recognizes — not every "reasoning" model uses the same tags.)
- **New: document attachments.** Attach a `.txt`, `.md`, or `.pdf` file and its text gets added as context for your question — PDF text extraction runs fully offline (no cloud service involved), loaded on demand so it doesn't add to the app's normal startup cost.
- Renamed the "Uncensored Creative Writer" persona to **"Unfiltered Storyteller."**

### 🌐 Website
- Fixed the Linux AppImage and macOS `.zip` download buttons on the landing page, which were genuinely 404ing (confirmed against the live release) due to a filename-sanitization mismatch that a prior fix never actually reached.
- Corrected a landing-page claim that the Linux build ships native Vulkan/AVX2 engine kernels — it doesn't yet; Linux remains UI-shell-only (see Platform status below).
- The download section now collapses to your detected platform by default, with other platforms available behind a toggle.

---

## 🆕 What's new in v1.1.0

### 🍎 Real macOS support (Apple Silicon + Intel)
- Native Metal-accelerated inference — `stable-diffusion.cpp` and `llama.cpp`, universal binaries covering both Apple Silicon and Intel Macs.
- Hardware detection now correctly identifies your Apple chip and reports Metal, instead of falling back to a Windows-only "CPU AVX2" message that never applied on Mac.
- Model auto-discovery now scans `/Volumes/*` (Mac's equivalent of drive letters) and the correct `~/Library/Application Support/Solframe Studio/models` folder.
- Verified end-to-end on an actual Apple M4.

### 🎨 Image Studio
- **New resolution presets**: 1080p, 1440p, 2K, and 4K, plus a **Custom** width/height option. Note: SDXL/FLUX are trained around ~1024px and this app has no tiling/hires-fix pass, so the higher presets trade off quality — 4K is a ceiling this UI offers, not a quality guarantee.
- The prompt box now always starts empty and clears itself after every generation — a compact, translucent **prompt viewer** appears over the generated image instead, showing exactly what produced it, with a one-click **"Use Again"** button to reuse it without retyping.
- The generated image and your in-progress settings now **survive switching tabs** instead of resetting — a manual **Reset** button clears the canvas when you actually want to.
- The sidebar's Image Studio icon now shows a live generation progress ring, plus a "ready to view" badge once a result is waiting for you on another tab.

### 🗄️ Model Hub & Downloads
- Fixed three curated presets that were pointing at renamed/moved files (404s on download) and removed three that were either off-topic or fundamentally incompatible with this app's single-file model loading.
- Downloads now save to `Downloads/Solframe Studio` — a folder you can actually find — instead of the app's own install folder, which silently failed or lost files on Linux AppImage, `.deb`, and packaged macOS builds.
- "Rescan" buttons now actually trigger a fresh scan instead of re-reading a stale cache — a freshly downloaded model shows up without restarting the app.
- A cancelled download no longer leaves a corrupt partial file that gets mistakenly reported as "Installed."
- Download failures (bad URL, gated repo, disk full) now surface as a real error message instead of the progress bar silently vanishing.
- The download progress bar now shows a percentage, not just a fill bar.

### 🔧 Packaging fix
- The Windows installers were unintentionally bundling the new macOS engine binaries (~175MB of unrelated `.dylib`/Unix files) due to an overly broad resource-copying rule. Fixed — Windows builds only ever contain Windows binaries again.

---

### 🎨 Image Studio (from v1.0.0)
- **FLUX.2-Klein & SDXL Lightning** via native `stable-diffusion.cpp` — CUDA, Vulkan, Metal, or CPU, auto-detected.
- **LoRA support** with a live strength slider, applied via `sd-cli`'s own `<lora:name:strength>` prompt-tag mechanism.
- **Cancel Generation** — abort a run mid-flight instead of waiting it out or force-closing the app.

### 💬 Uncensored Local LLM Chat
- **Native `llama.cpp` GPU server**, streaming tokens in real time from any GGUF model on disk.
- **LM Studio-style load parameters** — Context Length, GPU Layers, Batch Size, Flash Attention, and K/V Cache Quantization.
- Custom personas, with one-click handoff of a written prompt straight into Image Studio.
- A visible disclaimer wherever uncensored models are used — see [TERMS.md](TERMS.md) for the full terms.

### 🌌 Six Ambient Themes
Dark Void, Neon Cyber, Cinema Gold (default), Synthwave Sunset, Anime Fantasy, and Emerald Matrix.

### 🔒 Security & Privacy
- The local control server validates every request's Origin before acting on it.
- Every mutating endpoint (rescan, engine start/stop, downloads, generation) is POST-only and path-traversal-guarded.
- 100% offline by design: no telemetry, no analytics, no phone-home of any kind.

---

### 📦 Downloads

| Platform | File | Size | Direct Link |
|---|---|---|---|
| 🪟 Windows | Complete Setup | ~927 MB | [Solframe-Studio-Setup-1.1.3.exe](https://github.com/Protik1810/Solframe-Studio/releases/download/v1.1.3/Solframe-Studio-Setup-1.1.3.exe) |
| 🍎 macOS | Apple Silicon `.zip` | ~225 MB | [Solframe.Studio-1.1.3-arm64-mac.zip](https://github.com/Protik1810/Solframe-Studio/releases/download/v1.1.3/Solframe.Studio-1.1.3-arm64-mac.zip) |
| 🐧 Linux | `.deb` | ~726 MB | [solframe-studio_1.1.3_amd64.deb](https://github.com/Protik1810/Solframe-Studio/releases/download/v1.1.3/solframe-studio_1.1.3_amd64.deb) |

**Verified on:** image generation confirmed on macOS (MacBook Air, Apple M2, 16 GB unified memory — **Metal**) and on Linux (AMD CPU, 16 GB LPDDR5, NVIDIA RTX 4060 8 GB — **CUDA**, with no CUDA toolkit installed on that machine; the runtime ships with the app). Around 8 GB of VRAM is the practical floor for the FLUX pipeline.

**Platform note:** one download per platform. All three now ship real local inference — CUDA/Vulkan/CPU on Windows, Metal on macOS (Apple Silicon only, since Metal needs an M-series GPU), and CUDA/Vulkan/CPU on Linux. The Linux `.deb` is large because it carries a CUDA engine built from source (upstream ships none for Linux) plus NVIDIA's cuBLAS runtime; it falls back to Vulkan automatically on non-NVIDIA GPUs. The Linux AppImage has been dropped in favour of the `.deb`: every AppImage needs the legacy `libfuse2`, which current Ubuntu no longer ships, so it failed to launch out of the box.

#### 🔐 Verify Your Download (SHA-256)
Published as [CHECKSUMS.txt](https://raw.githubusercontent.com/Protik1810/Solframe-Studio/main/CHECKSUMS.txt) — download it, then verify with `sha256sum -c CHECKSUMS.txt` (Linux/macOS) or `Get-FileHash <file> -Algorithm SHA256` (Windows PowerShell).

#### 🪟 Windows
Download an installer above. There is currently no winget package.

#### 🍎 macOS
Download the `.zip` matching your Mac above, unzip, move to Applications. Unsigned build — **Control-click → Open** on first launch (or `xattr -cr` the `.app` in Terminal if macOS calls it "damaged").

#### 🐧 Linux
```bash
sudo dpkg -i solframe-studio_1.1.3_amd64.deb
```
Ships real inference engines: CUDA for NVIDIA (built from source — upstream publishes none for Linux), Vulkan for everything else, plus a CPU fallback and `llama.cpp` for chat. On a hybrid-graphics laptop the discrete GPU is selected automatically. No AppImage: every AppImage needs the legacy `libfuse2`, which current Ubuntu no longer ships.

#### 🐧 Linux & 🍎 macOS — Build From Source
```bash
git clone https://github.com/Protik1810/Solframe-Studio.git && cd Solframe-Studio && npm install && npm run electron:build:linux
```
*(swap `electron:build:linux` for `electron:build:mac` on macOS)*

---

### 📜 License

Released under the **GNU General Public License v3.0 (GPL-3.0)**.
Powered by [`stable-diffusion.cpp`](https://github.com/leejet/stable-diffusion.cpp) & [`llama.cpp`](https://github.com/ggerganov/llama.cpp).

*Created & Engineered by **[Protik](https://github.com/Protik1810)**.*

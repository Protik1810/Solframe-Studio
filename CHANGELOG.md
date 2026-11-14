# Changelog

All notable changes to Solframe Studio are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

This file is the terse, technical record. [RELEASE_NOTES.md](RELEASE_NOTES.md)
carries the fuller, user-facing writeup for the latest release (and doubles
as the GitHub Release body) — the two overlap on content, not on purpose.

## [1.1.5] — 2026-11-14

### Added

- **MiniMax H3 (FreeVideo) video model.** A third video model,
  `minimax-h3-freevideo`, now runs through the installed FreeVideo headless
  engine (Video DeltaNet / VDN-H3 edge, int8). The video server accepts
  `h3`/`freevideo`/`minimax` aliases, reports engine readiness via the
  FreeVideo `machine.json`, and returns a full model card (`pipeline`,
  `max_seconds`, engine-managed guidance/chunking notes) on
  `GET /v1/video/models`. Guidance and chunking are engine-managed; a single
  run is capped at 15s in this release (chained H3 shots are a v1.2 item).
- **Acceptance test for the H3 path.** `scripts/test_video_server_h3.py`
  (`run_h3_test.bat` wrapper): `--models` asserts the H3 card is listed with
  `max_seconds`; `--render` runs a real 4s H3 job end-to-end through the server
  and verifies the returned file is a valid, non-trivial mp4.

### Changed

- **Video Studio UI** (`VideoStudio.tsx`): H3 shows as "MiniMax H3" in the model
  picker; the duration slider is capped by the active model's `max_seconds`
  instead of a fixed 60s and clamps immediately on model switch; the chunked-
  segment count is only shown for chunk-chained models (LTX/Wan), not H3.

## [1.1.4] — 2026-11-13

### Added

- **Video Studio** — a new tab for motion generation alongside Image Studio and
  Chat. Model picker (LTX-Video 2B, Wan 2.2 TI2V 5B), prompt/negative inputs,
  duration slider, resolution presets, steps/guidance/chunk-length/seed
  controls, optional first-frame upload for image-to-video, live progress, an
  in-app player, and a generated-video library grid.
- **Chunk-chained continuous video.** The standalone video server
  (`video_server.py` + `video_server.json` + `run_video_server.bat`, OpenAI-style
  `POST /v1/video/generations` on port 8766) renders long shots as consecutive
  chunks — each chunk conditions on the previous chunk's last frame, then
  everything is concatenated losslessly with ffmpeg (`-c copy`), so segment
  boundaries are seamless instead of hard cuts. Without a supplied first frame it
  generates one automatically through the image pipeline.
- **`video_backend.cjs`** — shared video API layer: the Electron server routes
  `/api/video` to it in production, the Vite dev server wires the same middleware
  in development, and it stops the video server cleanly on shutdown.
- **Bundled with the Windows installer** — the video server files ship inside the
  desktop build via `extraResources`.

### Changed

- The product landing page was redesigned (`product.html`): new feature grid,
  interactive install terminal, coverflow gallery; all artwork embedded as base64
  data URIs so it renders fully offline. `index.html` is again the Vite app
  entry — the standalone showcase no longer clobbers the Electron build.

## [1.1.3] — 2026-09-03

### Added

- **Linux is a real platform.** `backend/linux/**` now ships working
  inference engines instead of nothing: Vulkan and CPU builds of
  `stable-diffusion.cpp` plus `llama.cpp`, fetched and checksum-verified by
  `fetch-engines.js` like every other platform's.
- **CUDA engine for Linux**, built from source by `scripts/build-linux-cuda.sh`
  and bundled with its `libcudart`/`libcublas`/`libcublasLt` runtime, so end
  users install no toolkit. Neither upstream project publishes a prebuilt
  Linux CUDA binary (both ship CUDA for Windows only), which is why this one
  is compiled rather than downloaded. Optional: without it the app falls
  through to Vulkan, which drives NVIDIA, AMD and Intel alike.
- Automatic discrete-GPU selection for Vulkan. On a hybrid-graphics laptop
  `sd-cli` defaults to device 0 — the integrated chip — and dies with
  `ErrorOutOfDeviceMemory` while the real GPU idles; the discrete device is
  now detected via `--list-devices` and pinned explicitly.

### Changed

- **One download per platform**: the Windows installer, the Linux `.deb`,
  and the macOS Apple Silicon `.zip`. The Windows Lightweight installer,
  the macOS `.dmg`, and the Intel Mac build are no longer published.
- The Linux AppImage is dropped rather than fixed. Every AppImage requires
  the legacy `libfuse2`, which current Ubuntu no longer ships, so it failed
  to launch out of the box; the `.deb` has no such dependency.
- macOS is Apple Silicon only — Metal inference needs an M-series GPU, so
  an x86_64 bundle shipped a UI that could not generate.

### Fixed

- `LD_LIBRARY_PATH` is set when spawning engines on Linux. The CUDA engine
  links its runtime dynamically, so without this the bundled libraries were
  invisible on exactly the machines the bundling was meant to serve.
- The Linux library health panel listed Windows `.exe`/`.dll` paths under
  `backend/win/`, which can never exist there — Linux had been falling
  through to the Windows definitions.
- An NVIDIA GPU on Linux is no longer labelled "CUDA" when the app is
  actually running Vulkan; the reported backend now matches the engine in
  use.
- The app icon is missing on Linux desktops: `desktopName` (read from the
  package.json root, not the build config) plus `syncDesktopName` were
  unset, so the window's `WM_CLASS` never matched the installed `.desktop`
  entry.
- Engine extraction picks an extractor by capability rather than platform,
  sniffs the real archive format instead of trusting a temp filename,
  flattens llama.cpp's versioned wrapper directory, and restores the
  executable bit that Python's `zipfile` silently drops — the last of which
  shipped `sd-cli` binaries that could not be spawned at all.

## [1.1.2] — 2026-09-02

### Added

- Content-Security-Policy and `X-Content-Type-Options` headers on every
  response, applied identically in dev and production.
- Electron permission handler denying camera/mic/geolocation/notification
  requests outright — the app's UI never needs any of them.
- `.github/dependabot.yml` (npm + GitHub Actions, weekly) and a
  non-blocking `npm audit` step in CI.
- GitHub build-provenance attestations on every CI-built release artifact.
- `scripts/fetch-engines.js` — downloads and SHA-256-verifies the
  `stable-diffusion.cpp`/`llama.cpp` engine binaries from upstream releases
  into `backend/win/`/`backend/mac/`, checked against `engines-lock.json`.
- jsdom + Testing Library UI test suite (`src/tests/ui/`), a golden-snapshot
  test locking the full FLUX CLI argument array, and a coverage gate in CI.
- `ARCHITECTURE.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue/PR
  templates.
- Real generated/edited image examples with prompts in the README.

### Changed

- `electron-builder` bumped to a version released after Electron 36 existed.
- `ImageStudio.tsx` (31 `useState` calls) and `ChatStudio.tsx` (~14) each
  collapsed into a single `useReducer`.
- `index.css` split into `src/styles/base.css`, `themes.css`,
  `components.css`, `studio.css`.
- `SECURITY.md` expanded into a full threat model (internal API's no-auth
  design, the Agent API's key-gating, model files as a trust boundary, why
  there's no auto-updater yet).

### Fixed

- Image Studio's GPU badge in Studio Controls showed a literal hardcoded
  "RTX 4070 Ti (12GB)" string, unconnected to actual hardware detection —
  now shows the real detected GPU, matching the canvas header's badge.
- Packaged builds (Windows, macOS, Linux) crashed shortly after launch:
  `getPaths()` pointed `rootDir` at `resources/app`, but with `asar: true`
  and no `asarUnpack`, app code actually lives packed inside
  `resources/app.asar` — `resources/app` never existed on any platform.
  Every launch's automatic update check required a `package.json` from
  that nonexistent path and crashed on the unhandled rejection. The v1.1.2
  release assets have been rebuilt with the fix.

## [1.1.1] — 2026-09-01

### Added

- FLUX Kontext-style reference-image editing (`-r/--ref-image`) in Image
  Studio — attach an image, describe the change.
- Chat: image attachments for vision-capable models via `llama-server`'s
  `--mmproj`; reasoning/"thinking" model support with a collapsible
  "Thinking" panel; document attachments (`.txt`/`.md`/`.pdf`, extracted
  fully offline).
- Negative prompt support for the FLUX pipeline (previously standard-only).

### Fixed

- Flash attention now runs by default on every FLUX generation
  (`--diffusion-fa`) — fixes large Klein models silently overflowing VRAM
  and falling back to ~30-40x-slower CUDA driver paging with no visible
  error.
- FLUX.2 Klein "base" (non-distilled) variants now get correct default
  steps/cfg automatically instead of silently rendering malformed output
  under distilled-model defaults.
- FLUX prediction flag corrected for current `stable-diffusion.cpp` builds
  (`--prediction flux2_flow` → `flux_flow`, rejected outright by newer
  binaries).
- Generated images not displaying under `npm run dev` (a dev/prod parity
  gap).
- Model scanner missing hyphenated `text-encoder` filenames outside a
  dedicated `/clip/` folder.
- Landing page: broken Linux AppImage/macOS `.zip` download links, and an
  inaccurate claim that Linux ships native Vulkan/AVX2 kernels.

### Changed

- Replaced CPU text-encoder offload with `--offload-to-cpu` (keeps FLUX
  weights in system RAM, computes entirely on GPU) — auto-enables above
  ~512x512 resolution, still manually overridable.
- Image generation now uses safetensors models only; GGUF is reserved for
  LLM Chat.
- Renamed the "Uncensored Creative Writer" persona to "Unfiltered
  Storyteller."

## [1.1.0] — 2026-08-31

### Added

- Real macOS support (Apple Silicon + Intel): native Metal-accelerated
  `stable-diffusion.cpp`/`llama.cpp`, universal binaries, correct hardware
  detection, `/Volumes/*` model scanning.
- Image Studio: 1080p/1440p/2K/4K resolution presets plus Custom
  width/height; a translucent prompt viewer with "Use Again"; generated
  image and in-progress settings now survive switching tabs; sidebar
  generation-progress ring and "ready to view" badge.

### Fixed

- Three curated Model Hub presets pointing at renamed/moved files (404s);
  removed three off-topic/incompatible presets.
- Downloads now save to the portable `AppData/Solframe Studio` location
  instead of the app's install folder, which silently failed or lost files
  on Linux AppImage, `.deb`, and packaged macOS builds.
- "Rescan" now triggers a real fresh scan instead of re-reading a stale
  cache.
- A cancelled download no longer leaves a corrupt partial file mistakenly
  reported as "Installed."
- Download failures now surface a real error message instead of the
  progress bar silently vanishing.
- Windows installers were unintentionally bundling ~175MB of unrelated
  macOS `.dylib` binaries due to an overly broad resource-copying rule.

## [1.0.0] — 2026-08-30

Initial public release.

### Added

- FLUX.2-Klein and SDXL Lightning image generation via native
  `stable-diffusion.cpp` (CUDA/Vulkan/Metal/CPU, auto-detected).
- LoRA support with a live strength slider.
- Cancel Generation (abort mid-flight).
- Native `llama.cpp` GPU server with real-time token streaming from any
  local GGUF model.
- LM Studio-style load parameters (Context Length, GPU Layers, Batch Size,
  Flash Attention, K/V Cache Quantization).
- Custom chat personas with one-click prompt handoff to Image Studio.
- Six ambient UI themes.
- Local control server: Origin validation on every request, path-traversal
  guards, POST-only mutating endpoints.

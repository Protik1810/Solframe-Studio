#!/usr/bin/env python
"""Solframe Studio — Video Generation Module (added 2026-11).

Chunked continuous long-video generation on a single 12GB RTX 4070 Ti.
New standalone server on port 8766 (the packaged image agent server on
8765 is NOT modified and MUST keep running untouched).

Endpoints (OpenAI-compatible style, same Bearer auth as the image API):
  GET  /health
  GET  /v1/models               -> proxied from 8765 + video models appended
  GET  /v1/video/models         -> video model info
  POST /v1/video/generations    -> chunked continuous I2V generation
  GET  /v1/files/<name>         -> serve generated videos (and proxy image
                                    files from the 8765 agent server)
  POST /v1/images/generations   -> transparent proxy to 127.0.0.1:8765
                                    (image endpoint code paths untouched)

POST /v1/video/generations body:
  prompt          (str, required)
  negative_prompt (str, optional)
  first_frame     (optional image: http(s) URL, data:base64 URL, local path,
                   or relative /v1/files/<name> served by Solframe)
                   If absent, a first frame is generated through the existing
                   image pipeline (POST /v1/images/generations on 8765).
  seconds         (float, 1..60, default 16)
  fps             (int, default 24)
  resolution      (str "WxH", default per model; must be divisible by the
                   model's spatial multiple — 32 for LTX, 16 for Wan)
  model           (str, optional: "ltx-video-2b-0.9.5" (default),
                   "wan2.2-ti2v-5b", or "minimax-h3-freevideo" (FreeVideo
                   engine, engine-managed resolution/guidance, <=15s);
                   aliases "ltx"/"wan"/"h3" accepted)
  seed            (int, optional)
  steps           (int, default per model: LTX 50, Wan 30)
  guidance_scale  (float, default per model: LTX 3.0, Wan 5.0)

Chunking: target duration is split into segments of the model's native clip
length (~5s => 121 frames @ 24fps, frame count = 8k+1). Segment 1 is image-to-
video from the first frame. Every later segment is image-to-video conditioned
on the LAST FRAME of the previous segment, so motion carries across chunks.
Segments are concatenated losslessly with ffmpeg into one continuous mp4.
"""
import base64
import io
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, unquote

# ---------------------------------------------------------------- config ----
REPO_ROOT = Path(r"D:\genimg_comic")
CONFIG_PATH = Path(r"D:\genimg_comic\video_server.json")
MODEL_DIR = Path(r"D:\models\LTX-Video-0.9.5")
WAN_MODEL_DIR = Path(r"D:\models\Wan2.2-TI2V-5B-Diffusers")
FREEVIDEO_ROOT = Path(r"D:\ComfyUI\ComfyUI_windows_portable\ComfyUI\custom_nodes\FreeVideo")
H3_MODEL_ID = "minimax-h3-freevideo"
H3_MAX_SECONDS = 15.0   # single FreeVideo run; longer jobs are a v1.2 item
OUT_DIR = REPO_ROOT / "outputs" / "videos"
LOG_PATH = REPO_ROOT / "video_server.log"
UPSTREAM = "http://127.0.0.1:8765"  # packaged Solframe agent server (untouched)
HOST = "0.0.0.0"
PORT = 8766

FFMPEG_CANDIDATES = [
    shutil.which("ffmpeg"),
    r"C:\Users\proti\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin\ffmpeg.exe",
]
FFMPEG = next((p for p in FFMPEG_CANDIDATES if p), None)

OUT_DIR.mkdir(parents=True, exist_ok=True)

API_KEYS = set()
if CONFIG_PATH.exists():
    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        API_KEYS.add(cfg.get("apiKey", ""))
    except Exception:
        pass
API_KEYS.discard("")

def log(msg):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass

def load_config_upstream_key():
    """The real image-API key as configured by the packaged agent server."""
    for p in (Path(r"C:\Users\proti\.solframe\agent_server.json"),):
        try:
            k = json.loads(p.read_text(encoding="utf-8")).get("apiKey", "")
            if k and "..." not in k:
                return k
        except Exception:
            pass
    return ""

# ------------------------------------------------------------ generation ----
_GEN_LOCK = threading.Lock()
_GEN_STATE = {"busy": False, "job": None, "started": None}
_PIPES = {}          # model_id -> loaded pipeline (only one resident at a time)
_LOADED_ID = None

def unload_pipe():
    """Free the resident pipeline's RAM/VRAM. The LTX pipe holds ~10GB commit;
    the GGUF first-frame subprocess needs ~17GB, so the pipe must be released
    before spawning it (commit exhaustion crashes c10.dll, not Python OOM)."""
    global _LOADED_ID
    import gc
    if _LOADED_ID in _PIPES:
        log(f"Unloading {_LOADED_ID} pipe to free commit")
        del _PIPES[_LOADED_ID]
        _LOADED_ID = None
        gc.collect()
        import torch
        torch.cuda.empty_cache()

# Per-model spec: dir, resolution multiple, and default sampling params.
# Wan needs dims divisible by 16; LTX needs 32.
MODEL_REGISTRY = {
    "ltx-video-2b-0.9.5": {
        "dir": MODEL_DIR, "mult": 32, "steps": 50, "guidance": 3.0,
        "fallback_res": (704, 480),
        "pipeline": "LTXConditionPipeline",  # image conditioning (chunk chaining)
    },
    "wan2.2-ti2v-5b": {
        "dir": WAN_MODEL_DIR, "mult": 16, "steps": 30, "guidance": 5.0,
        "fallback_res": (832, 480),
    },
}
DEFAULT_MODEL = "ltx-video-2b-0.9.5"


def resolve_model_id(v):
    """Accept 'ltx'/'wan'/'h3' aliases and the full ids; unknown -> default."""
    if not v:
        return DEFAULT_MODEL
    v = str(v).strip().lower().replace(" ", "")
    if v in MODEL_REGISTRY:
        return v
    if v == H3_MODEL_ID:
        return H3_MODEL_ID
    if v.startswith("h3") or v.startswith("freevideo") or v.startswith("minimax"):
        return H3_MODEL_ID
    if v.startswith("ltx"):
        return "ltx-video-2b-0.9.5"
    if v.startswith("wan"):
        return "wan2.2-ti2v-5b"
    return DEFAULT_MODEL


def get_pipe(model_id):
    """Load on demand; only one pipeline resident at a time (12GB VRAM,
    and both repos together would not fit host RAM either)."""
    global _LOADED_ID
    if model_id == _LOADED_ID and model_id in _PIPES:
        return _PIPES[model_id]
    import gc
    import torch
    from diffusers import DiffusionPipeline
    spec = MODEL_REGISTRY[model_id]
    if _LOADED_ID in _PIPES:
        log(f"Unloading {_LOADED_ID} before loading {model_id}")
        del _PIPES[_LOADED_ID]
        _LOADED_ID = None
        gc.collect()
        torch.cuda.empty_cache()
    log(f"Loading {model_id} from {spec['dir']} (exists={spec['dir'].exists()}) ...")
    import diffusers as _diff
    pipe_cls = getattr(_diff, spec["pipeline"]) if spec.get("pipeline") else _diff.DiffusionPipeline
    pipe = pipe_cls.from_pretrained(str(spec["dir"]), torch_dtype=torch.bfloat16,
                                    attn_implementation="sdpa")
    pipe.enable_model_cpu_offload()   # T5/UMT5 encoded then offloaded; fits 12GB
    # LTXConditionPipeline has NO pipe-level enable_vae_tiling in diffusers 0.35.1,
    # so the old hasattr(pipe,...) check silently skipped tiling -> full-tensor VAE
    # decode of 121-frame segments spiked memory and took c10.dll down (0xc0000005).
    vae = getattr(pipe, "vae", None)
    if vae is not None:
        if hasattr(vae, "enable_tiling"):
            vae.enable_tiling()
            log("VAE tiling enabled")
        if hasattr(vae, "enable_slicing"):
            vae.enable_slicing()
            log("VAE slicing enabled")
    _PIPES[model_id] = pipe
    _LOADED_ID = model_id
    log(f"{model_id} pipeline loaded ({pipe.__class__.__name__}).")
    return pipe

def _fetch_bytes(url, bearer=None):
    req = urllib.request.Request(url)
    if bearer:
        req.add_header("Authorization", f"Bearer {bearer}")
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()

def resolve_first_frame(ff, bearer):
    """first_frame may be: data URL, http(s) URL, local path, /v1/files/<name>."""
    from PIL import Image
    if not ff:
        return None
    if ff.startswith("data:"):
        b64 = ff.split(",", 1)[1]
        raw = base64.b64decode(b64)
    elif ff.startswith("http://") or ff.startswith("https://"):
        raw = _fetch_bytes(ff, bearer)
    elif ff.startswith("/v1/files/"):
        raw = _fetch_bytes(UPSTREAM + ff, bearer)
    else:
        raw = Path(ff).read_bytes()
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    return img

def generate_first_frame_gguf(prompt, seed=None):
    """First frame via the native GGUF FLUX lane (proven: Q4_K transformer,
    Q5_K_M T5, clip_l, taef1 — no ComfyUI). Runs as a subprocess with the LTX
    pipe unloaded: the two models cannot share commit. ~60s incl. load."""
    import subprocess, tempfile
    ff_dir = pathlib.Path(r"D:\genimg_comic\outputs\firstframes")
    ff_dir.mkdir(parents=True, exist_ok=True)
    idx = int(time.time()) % 100000
    scene = {"i": idx, "seed": int(seed) if seed is not None else 42,
             "ff_prompt": prompt}
    tmp = pathlib.Path(tempfile.gettempdir()) / f"ff_req_{idx}.json"
    tmp.write_text(json.dumps({"scenes": [scene]}))
    PY = r"D:\GPU computation\.venv\Scripts\python.exe"
    proc = subprocess.run([PY, r"D:\genimg_comic\framegen\gguf_flux_batch.py", str(tmp)],
                          capture_output=True, text=True, timeout=900)
    out = ff_dir / f"ff_{idx:05d}.png"
    log("GGUF first-frame subprocess rc=%s" % proc.returncode)
    if proc.returncode != 0 or not out.exists() or out.stat().st_size < 10000:
        raise RuntimeError(f"gguf first-frame failed rc={proc.returncode}: {proc.stdout[-500:]} {proc.stderr[-500:]}")
    from PIL import Image
    return Image.open(out).convert("RGB")

def generate_first_frame_via_image_api(prompt, bearer, seed=None):
    """No first_frame given -> ask the EXISTING image pipeline on 8765.
    Payload mirrors the schema proven by the solframe plugin (size, n and
    model are required; the old minimal body got HTTP 400)."""
    from PIL import Image
    img_prompt = (prompt or "").strip() + ", cinematic still frame, film grain, photorealistic"
    w, h = 704, 480
    body = json.dumps({
        "prompt": img_prompt,
        "negative_prompt": "",
        "width": w, "height": h, "size": f"{w}x{h}", "n": 1,
        "steps": 6, "cfg_scale": 1.5,
        "seed": int(seed) if seed is not None else -1,
        "model": "Juggernaut_RunDiffusionPhoto2_Lightning_4Steps.safetensors",
    }).encode()
    req = urllib.request.Request(UPSTREAM + "/v1/images/generations", data=body,
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {bearer}"})
    with urllib.request.urlopen(req, timeout=900) as r:
        resp = json.loads(r.read())
    d = resp["data"][0]
    if d.get("b64_json"):                    # plugin docs: b64 or url
        raw = base64.b64decode(d["b64_json"])
    else:
        url = d.get("url", "")
        if not url.startswith("http"):
            url = UPSTREAM + url
        raw = _fetch_bytes(url, bearer)
    return Image.open(io.BytesIO(raw)).convert("RGB")

def fit_frame(img, width, height):
    """Resize (no crop) to exactly WxH — LTX wants exact dims."""
    return img.resize((width, height))

def export_segment(frames, fps, path):
    from diffusers.utils import export_to_video
    export_to_video(frames, str(path), fps=fps)

def concat_segments(seg_paths, out_path):
    if FFMPEG is None:
        raise RuntimeError("ffmpeg not found on this machine")
    list_path = out_path.with_suffix(".txt")
    with open(list_path, "w", encoding="utf-8") as f:
        for p in seg_paths:
            f.write(f"file '{p.as_posix()}'\n")
    cmd = [FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", str(list_path),
           "-c", "copy", str(out_path)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    list_path.unlink(missing_ok=True)
    if proc.returncode != 0 or not out_path.exists():
        raise RuntimeError(f"ffmpeg concat failed: {proc.stderr[-1500:]}")
    return out_path

def probe_video(path):
    ffprobe = FFMPEG.replace("ffmpeg.exe", "ffprobe.exe").replace("ffmpeg.EXE", "ffprobe.EXE") if FFMPEG else None
    if not ffprobe or not Path(ffprobe).exists():
        return None
    cmd = [ffprobe, "-v", "error", "-select_streams", "v:0",
           "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
           "-show_entries", "format=duration", "-of", "json", str(path)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        return None
    return json.loads(proc.stdout)

def run_generation(job):
    import torch
    t0 = time.time()
    prompt = job["prompt"]
    model_id = resolve_model_id(job.get("model"))
    if model_id == H3_MODEL_ID:
        return run_generation_h3(job)
    negative = job.get("negative_prompt", "") or ""
    seconds = max(1.0, min(60.0, float(job.get("seconds", 16))))
    fps = int(job.get("fps", 24) or 24)
    spec = MODEL_REGISTRY[model_id]
    mult = spec["mult"]
    res = (job.get("resolution") or "").lower().replace("×", "x")
    width = height = None
    if res:
        try:
            width, height = (int(x) for x in res.split("x"))
        except ValueError:
            width = height = None
    if not width or not height or width % mult or height % mult:
        width, height = spec["fallback_res"]
    steps = int(job.get("steps", spec["steps"]))
    guidance = float(job.get("guidance_scale", spec["guidance"]))
    seed = job.get("seed")
    if seed is not None:
        seed = int(seed)

    # Native clip: frames = 8k+1; chunk length is configurable because the
    # 2026-11-13 frame analysis showed a ~4.7s chunk drifting into bright
    # blobs within its second half — shorter chunks bound that drift.
    chunk_s = max(1.0, min(5.0, float(job.get("chunk_seconds", 5))))
    frames_per_seg = max(9, int(round(fps * chunk_s)))
    frames_per_seg = (frames_per_seg // 8) * 8 + 1  # 8k+1, LTX-compatible
    seg_seconds = (frames_per_seg - 1) / fps
    n_segments = max(1, int(-(-seconds // seg_seconds)))  # ceil
    n_segments = min(n_segments, 96)

    bearer = job["_bearer"]
    first = resolve_first_frame(job.get("first_frame"), bearer)
    if first is None:
        # Native GGUF FLUX lane first (needs the LTX pipe OUT of RAM to fit
        # commit); the 8765 image relay stays as secondary fallback.
        unload_pipe()
        try:
            log("No first_frame supplied -> generating via native GGUF FLUX lane")
            first = generate_first_frame_gguf(
                (prompt or "").strip() + ", cinematic still frame, film grain, photorealistic", seed)
        except Exception as e:
            log(f"GGUF first-frame failed ({e}) -> falling back to 8765 image API")
            first = generate_first_frame_via_image_api(prompt, bearer, seed)

    stamp = time.strftime("%Y%m%d_%H%M%S")
    job_id = f"vid_{stamp}"
    seg_paths = []
    cond_frame = fit_frame(first, width, height)

    pipe = get_pipe(model_id)
    log(f"Job model={model_id} steps={steps} guidance={guidance} {width}x{height}")
    with _GEN_LOCK:
        for i in range(n_segments):
            seg_seed = None if seed is None else seed + i * 977
            gen = torch.Generator(device="cuda").manual_seed(seg_seed) if seg_seed is not None else None
            log(f"Segment {i+1}/{n_segments}: {frames_per_seg} frames {width}x{height} seed={seg_seed}")
            t1 = time.time()
            call_kwargs = dict(prompt=prompt, negative_prompt=negative, image=cond_frame,
                               width=width, height=height, num_frames=frames_per_seg,
                               num_inference_steps=steps, guidance_scale=guidance,
                               generator=gen)
            if pipe.__class__.__name__.startswith("LTX"):
                # Lightricks-recommended decode settings for 0.9.5
                call_kwargs.update(decode_timestep=0.05, decode_noise_scale=0.025)
            out = pipe(**call_kwargs)
            frames = out.frames[0]
            log(f"Segment {i+1} done in {time.time()-t1:.0f}s")
            last_frame = frames[-1]
            # Export: drop the duplicated first frame on continuation segments
            export_frames = frames if i == 0 else frames[1:]
            sp = OUT_DIR / f"{job_id}_seg{i+1:02d}.mp4"
            export_segment(export_frames, fps, sp)
            seg_paths.append(sp)
            last_frame = frames[-1]
            if hasattr(last_frame, "shape"):  # numpy array
                import numpy as np
                if last_frame.dtype != np.uint8:
                    last_frame = (last_frame * 255).clip(0, 255).astype(np.uint8)
                last_frame = Image.fromarray(last_frame)
            if i < n_segments - 1:
                cond_frame = fit_frame(last_frame, width, height)
            if hasattr(torch, "cuda"):
                torch.cuda.empty_cache()

    out_path = OUT_DIR / f"{job_id}.mp4"
    concat_segments(seg_paths, out_path)
    for sp in seg_paths:
        sp.unlink(missing_ok=True)
    probe = probe_video(out_path)
    dur = (n_segments * (frames_per_seg - 1) + (1 if n_segments > 1 else frames_per_seg)) / fps
    log(f"Job {job_id} complete: {out_path} total {time.time()-t0:.0f}s")
    return {
        "url": f"/v1/files/{out_path.name}",
        "filename": out_path.name,
        "model": model_id,
        "segments": n_segments,
        "chunk_seconds": seg_seconds,
        "segment_frames": frames_per_seg,
        "fps": fps,
        "width": width,
        "height": height,
        "duration_s": round(dur, 2),
        "probe": probe,
    }

# ------------------------------------------------ FreeVideo (MiniMax H3) ----
def h3_machine():
    """FreeVideo engine readiness (machine.json written by its setup)."""
    try:
        m = json.loads((FREEVIDEO_ROOT / "machine.json").read_text(encoding="utf-8"))
        if m.get("ready") and m.get("cache"):
            return m
    except Exception:
        pass
    return None


def run_generation_h3(job):
    """MiniMax H3 through the installed FreeVideo engine (headless CLI).

    Diffusers never sees this model: the CLI manages its own int8 weights,
    attention-kernel selection and RAM/VRAM budgeting (needs >= 4 GB commit
    headroom, so the resident diffusers pipe is unloaded first). Resolution,
    guidance and chunking are engine-managed; seconds is capped at one
    FreeVideo run (H3_MAX_SECONDS)."""
    t0 = time.time()
    prompt = (job["prompt"] or "").strip()
    seconds = max(1.0, min(H3_MAX_SECONDS, float(job.get("seconds", 8))))
    seed = job.get("seed")
    seed = int(seed) if seed is not None else None
    steps = job.get("steps")

    machine = h3_machine()
    if not machine:
        raise RuntimeError(
            "FreeVideo engine not ready (machine.json missing/not ready) — "
            "run FreeVideo setup on this machine first")
    cache = machine["cache"]

    # The H3 engine needs the commit headroom the resident diffusers pipe holds.
    unload_pipe()

    bearer = job["_bearer"]
    first = resolve_first_frame(job.get("first_frame"), bearer)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    job_id = f"vid_{stamp}_h3"

    tmp_dir = OUT_DIR / "h3_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    # Prompt mapping: a plain studio prompt becomes a minimal i2va/t2va H3
    # prompt; a prompt that already carries H3 sections passes verbatim.
    structured = any(line.strip().startswith(("integrated_multimodal_description:",
                                              "subject_definitions:", "summary:",
                                              "detailed_description:"))
                     for line in prompt.splitlines())
    if structured:
        body = prompt
    else:
        desc = prompt
        if not desc.startswith("[Shot"):
            desc = "[Shot 1] Live-action, cinematic. " + desc
        if "subtitles" not in desc.lower() and "on-screen text" not in desc.lower():
            desc += " No subtitles, no on-screen text."
        body = ("integrated_multimodal_description: " + desc + "\n\n"
                "overall_soundscape: Ambient room tone and natural action sounds "
                "matching the scene.\n\n"
                "non_diegetic_music: N/A\n")
    prompt_path = tmp_dir / f"{job_id}_prompt.txt"
    prompt_path.write_text(body, encoding="utf-8")

    cmd = ["cmd", "/c", str(FREEVIDEO_ROOT / "freevideo.cmd"), "generate",
           "--cache", str(cache), "--prompt-file", str(prompt_path)]
    if first is not None:
        ff_path = tmp_dir / f"{job_id}_first.png"
        first.save(ff_path)
        media_path = tmp_dir / f"{job_id}_media.json"
        media_path.write_text(json.dumps({"version": 1, "first": str(ff_path)}),
                              encoding="utf-8")
        cmd += ["--media", str(media_path)]
    if seed is not None:
        cmd += ["--seed", str(seed)]
    # steps >= 9 maps to a single pass of that many steps (FreeVideo "high/max"
    # territory); the default of 8 keeps the two-pass light path.
    if steps:
        bs = max(8, min(20, int(steps)))
        if bs > 8:
            cmd += ["--base-steps", str(bs)]
    out_path = OUT_DIR / f"{job_id}.mp4"
    cmd += ["--out", str(out_path)]

    log(f"H3 job {job_id}: {seconds}s seed={seed} steps={steps} "
        f"first_frame={'yes' if first is not None else 'auto'}")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
        if proc.returncode != 0 or not out_path.exists():
            tail = (proc.stdout or "")[-1500:] + (proc.stderr or "")[-1500:]
            raise RuntimeError(f"FreeVideo generate failed rc={proc.returncode}: {tail}")
    finally:
        for p in tmp_dir.glob(f"{job_id}_*"):
            p.unlink(missing_ok=True)

    probe = probe_video(out_path)
    width = height = None
    duration = None
    if probe:
        st = (probe.get("streams") or [{}])[0]
        width, height = st.get("width"), st.get("height")
        try:
            duration = float((probe.get("format") or {}).get("duration") or 0) or None
        except (TypeError, ValueError):
            duration = None
    log(f"H3 job {job_id} complete: {out_path.name} total {time.time()-t0:.0f}s")
    return {
        "url": f"/v1/files/{out_path.name}",
        "filename": out_path.name,
        "model": H3_MODEL_ID,
        "segments": 1,
        "chunk_seconds": seconds,
        "segment_frames": 0,
        "fps": 24,
        "width": width or 1344,
        "height": height or 768,
        "duration_s": round(duration or seconds, 2),
        "engine_seconds": round(time.time() - t0, 1),
        "probe": probe,
    }


# ------------------------------------------------------------- http layer ---
def check_auth(handler):
    if not API_KEYS:
        return True
    auth = handler.headers.get("Authorization", "")
    if auth.startswith("Bearer ") and auth[7:].strip() in API_KEYS:
        return True
    return False

def read_json_body(handler):
    length = int(handler.headers.get("Content-Length", 0) or 0)
    raw = handler.rfile.read(length) if length else b""
    if not raw:
        return {}
    return json.loads(raw)

def proxy_to_upstream(handler, path):
    body = handler.rfile.read(int(handler.headers.get("Content-Length", 0) or 0))
    req = urllib.request.Request(UPSTREAM + path, data=body if body else None, method=handler.command)
    for h in ("Authorization", "Content-Type", "Accept"):
        v = handler.headers.get(h)
        if v:
            req.add_header(h, v)
    try:
        with urllib.request.urlopen(req, timeout=1800) as r:
            data = r.read()
            handler.send_response(r.status)
            handler.send_header("Content-Type", r.headers.get("Content-Type", "application/json"))
            handler.send_header("Content-Length", str(len(data)))
            handler.end_headers()
            handler.wfile.write(data)
    except urllib.error.HTTPError as e:
        data = e.read()
        handler.send_response(e.code)
        handler.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)

def send_json(handler, code, obj):
    data = json.dumps(obj).encode()
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)

VIDEO_MODELS = [{
    "id": "ltx-video-2b-0.9.5",
    "object": "model",
    "owned_by": "solframe-video",
    "video": {
        "pipeline": "LTXImageToVideoPipeline (chunked continuous)",
        "repo": "Lightricks/LTX-Video-0.9.5",
        "native_clip_s": 5.0,
        "fps": [24, 30],
        "max_seconds": 60,
        "min_resolution": "480x320",
        "recommended_resolution": "704x480",
        "chunking": "each segment conditioned on the last frame of the previous segment",
    },
}, {
    "id": "wan2.2-ti2v-5b",
    "object": "model",
    "owned_by": "solframe-video",
    "video": {
        "pipeline": "DiffusionPipeline (Wan 2.2 TI2V-5B, chunked continuous I2V)",
        "repo": "Wan-AI/Wan2.2-TI2V-5B-Diffusers",
        "license": "Apache-2.0",
        "native_clip_s": 5.0,
        "fps": [24],
        "max_seconds": 60,
        "native_resolution": "1280x720",
        "recommended_resolution": "704x480 (12GB-safe) or 1280x720 (may OOM)",
        "default_steps": 30,
        "default_guidance": 5.0,
        "chunking": "each segment conditioned on the last frame of the previous segment",
    },
}, {
    "id": H3_MODEL_ID,
    "object": "model",
    "owned_by": "solframe-video",
    "video": {
        "pipeline": "FreeVideo headless engine (Video DeltaNet / VDN-H3 edge, int8)",
        "repo": "OpenVDN/vdn-minimax-h3-edge",
        "license": "MiniMax H3 Community License (territorial/acceptable-use restrictions apply)",
        "native_clip_s": 15.0,
        "fps": [24],
        "max_seconds": int(H3_MAX_SECONDS),
        "native_resolution": "1344x768 (engine-managed)",
        "recommended_resolution": "engine-managed",
        "default_steps": 8,
        "audio": "native generated audio (VA task)",
        "chunking": "engine-managed; single run per job in v1.1.5 (max 15s)",
        "notes": "resolution/guidance ignored; steps>8 run one-pass; engine RAM-admitted per job",
    },
}]

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log(f"{self.client_address[0]} {fmt % args}")

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            return send_json(self, 200, {"ok": True, "busy": _GEN_STATE["busy"], "job": _GEN_STATE["job"]})
        if path == "/v1/video/models":
            return send_json(self, 200, {"object": "list", "data": VIDEO_MODELS})
        if path == "/v1/video/files":
            items = []
            try:
                for f in sorted(OUT_DIR.glob("*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True):
                    items.append({
                        "name": f.name,
                        "url": f"/v1/files/{f.name}",
                        "size_bytes": f.stat().st_size,
                        "modified": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(f.stat().st_mtime)),
                    })
            except Exception as e:
                log(f"/v1/video/files error: {e}")
            return send_json(self, 200, {"object": "list", "data": items})
        if path == "/v1/models":
            try:
                with urllib.request.urlopen(urllib.request.Request(UPSTREAM + "/v1/models",
                        headers={"Authorization": self.headers.get("Authorization", "")}), timeout=15) as r:
                    data = json.loads(r.read())
                data.setdefault("data", []).extend(VIDEO_MODELS)
                return send_json(self, 200, data)
            except Exception as e:
                return send_json(self, 200, {"object": "list", "data": VIDEO_MODELS, "upstream_error": str(e)})
        if path.startswith("/v1/files/"):
            name = unquote(path.split("/", 3)[3])
            local = OUT_DIR / Path(name).name
            if local.exists():
                ctype = "video/mp4" if local.suffix == ".mp4" else "application/octet-stream"
                data = local.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                return self.wfile.write(data)
            return proxy_to_upstream(self, path)  # image files live on 8765
        if path.startswith("/v1/images/"):
            return proxy_to_upstream(self, path)
        send_json(self, 404, {"error": f"unknown path {path}"})

    def do_POST(self):
        path = urlparse(self.path).path
        if not check_auth(self):
            return send_json(self, 401, {"error": "invalid bearer token"})
        if path == "/v1/images/generations":
            return proxy_to_upstream(self, path)
        if path == "/v1/video/generations":
            if _GEN_STATE["busy"]:
                return send_json(self, 409, {"error": "a video generation is already running",
                                             "job": _GEN_STATE["job"]})
            try:
                body = read_json_body(self)
            except Exception as e:
                return send_json(self, 400, {"error": f"bad json body: {e}"})
            if not body.get("prompt"):
                return send_json(self, 400, {"error": "prompt is required"})
            body["_bearer"] = self.headers.get("Authorization", "")[7:].strip()
            _GEN_STATE["busy"] = True
            _GEN_STATE["job"] = body.get("prompt", "")[:60]
            _GEN_STATE["started"] = time.time()
            try:
                result = run_generation(body)
                return send_json(self, 200, {"created": int(time.time()),
                                             "data": [result]})
            except Exception as e:
                log(f"GENERATION FAILED: {type(e).__name__}: {e}")
                import traceback
                traceback.print_exc()
                return send_json(self, 500, {"error": f"{type(e).__name__}: {e}"})
            finally:
                _GEN_STATE["busy"] = False
                _GEN_STATE["job"] = None
        send_json(self, 404, {"error": f"unknown path {path}"})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

def main():
    log(f"Solframe video server starting on {HOST}:{PORT} (upstream {UPSTREAM})")
    log(f"Model dir: {MODEL_DIR} (exists={MODEL_DIR.exists()})")
    log(f"ffmpeg: {FFMPEG}")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.serve_forever()

if __name__ == "__main__":
    main()

/**
 * Solframe Music Video Backend — one pipeline, one result:
 * song (generated via ACE-Step or uploaded) -> scene plan synced to lyrics ->
 * AI keyframes (app image engine) -> AI video clips (video server, 8766) ->
 * ffmpeg assembly (cross-fades, lyric timing, title card) -> single MP4.
 *
 * Mounted at /api/musicvideo by electron/server.cjs and vite.config.ts,
 * same pattern as video_backend.cjs. All heavy lifting is delegated to the
 * already-running local engines; this module only orchestrates, tracks job
 * state, and shells out to ffmpeg for assembly.
 *
 * Routes:
 *   GET    /api/musicvideo/config          -> adapter availability probe
 *   POST   /api/musicvideo/start           -> {jobId}
 *   GET    /api/musicvideo/status?job=<id> -> job snapshot
 *   DELETE /api/musicvideo/cancel?job=<id> -> cooperative cancel
 *   GET    /api/musicvideo/file/<name>     -> stream job artifact
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
// video_backend.cjs: repo root in dev; extraResource next to app.asar in a
// packaged build (same resolution rule as server.cjs — e500dde).
const _vb = [
  path.join(__dirname, '..', '..', 'video_backend.cjs'),
  path.join(process.resourcesPath || '', 'video_backend.cjs'),
].find(p => { try { return fs.existsSync(p); } catch { return false; } });
const { ensureVideoServer, probePort, stopVideoServer } = require(_vb || path.join(__dirname, '..', '..', 'video_backend.cjs'));

const _mb = [
  path.join(__dirname, '..', '..', 'electron', 'engine', 'music_backend.cjs'),
  path.join(__dirname, 'music_backend.cjs'),
].find(p => { try { return fs.existsSync(p); } catch { return false; } });
const { ensureAceServer } = require(_mb || path.join(__dirname, 'music_backend.cjs'));

const ACE_HOST = '127.0.0.1';
const ACE_PORT_DEFAULT = 8001;
const VIDEO_PORT = 8766;

// ─── config ────────────────────────────────────────────────────────────────
function findSystemFfmpeg() {
  const cands = [
    'D:\\genimg_comic\\ffmpeg\\bin\\ffmpeg.exe',
    '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg',
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return 'ffmpeg'; // PATH fallback
}

function findVideoConfigJson(rootDir, resourcesPath) {
  const candidates = [
    path.join(rootDir || '', 'video_server.json'),
    path.join(resourcesPath || '', 'video_server.json'),
    'D:\\genimg_comic\\video_server.json',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function readConfig(rootDir, resourcesPath) {
  const candidates = [
    path.join(rootDir || '', 'music_server.json'),
    path.join(resourcesPath || '', 'music_server.json'),
    'D:\\genimg_comic\\music_server.json',
  ];
  let cfg = {};
  for (const c of candidates) {
    if (c && fs.existsSync(c)) { try { cfg = JSON.parse(fs.readFileSync(c, 'utf8')); break; } catch (e) {} }
  }
  // Bearer key for the video server: music_server.json may override, else the
  // same video_server.json the video backend uses (single source of truth).
  // Placeholder keys (containing "...") are ignored — the real key lives in
  // the machine's own config, which is also how video_server.py treats them.
  let videoApiKey = typeof cfg.videoApiKey === 'string' && !cfg.videoApiKey.includes('...') ? cfg.videoApiKey : '';
  if (!videoApiKey) {
    const vc = findVideoConfigJson(resourcesPath, rootDir) || findVideoConfigJson(rootDir, resourcesPath);
    if (vc) {
      try {
        const v = JSON.parse(fs.readFileSync(vc, 'utf8'));
        if (typeof v.apiKey === 'string' && v.apiKey && !v.apiKey.includes('...')) videoApiKey = v.apiKey;
      } catch (e) {}
    }
  }
  return {
    aceUrl: cfg.aceUrl || `http://${ACE_HOST}:${ACE_PORT_DEFAULT}`,
    aceApiKey: typeof cfg.aceApiKey === 'string' ? cfg.aceApiKey : '',
    // weights for the bundled music engine live in a stable, writable,
    // app-managed location (HF-downloaded via Model Manager)
    musicModelsDir: cfg.musicModelsDir
      || process.env.SOLFRAME_MUSIC_MODELS
      || path.join(os.homedir(), 'SolframeStudio', 'music-models'),
    videoPort: Number(cfg.videoPort) || VIDEO_PORT,
    videoApiKey,
    imageModel: typeof cfg.imageModel === 'string' ? cfg.imageModel : '',
    ffmpegPath: cfg.ffmpegPath || process.env.SOLFRAME_FFMPEG || findSystemFfmpeg(),
  };
}

// ─── job store ─────────────────────────────────────────────────────────────
const jobs = new Map(); // id -> job object

function jobDir(outputsDir) {
  const d = path.join(outputsDir, 'musicvideo');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}

// ─── small http helpers ────────────────────────────────────────────────────
function httpJson(url, method = 'GET', body = null, headers = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, json: JSON.parse(text), text }); }
        catch (e) { resolve({ status: res.statusCode, json: { raw: text }, text }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function httpDownload(url, destFile, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'GET', timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`download HTTP ${res.statusCode}`)); }
      const out = fs.createWriteStream(destFile);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(destFile)));
      out.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('download timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// ─── ACE-Step adapter (song + LRC) ────────────────────────────────────────
async function aceGenerateSong(cfg, job, spec) {
  const g = spec.generateSong || {};
  const body = {
    prompt: spec.songPrompt || g.prompt || 'upbeat electronic song',
    audio_duration: Math.max(10, Math.min(600, Number(g.duration) || 180)),
    sample_mode: !!g.sampleMode,
    thinking: !!g.thinking,
  };
  if (cfg.aceApiKey) body.ai_token = cfg.aceApiKey;
  job.message = 'Submitting song generation to ACE-Step...';
  // Reload models if a previous run in this session unloaded them (the video
  // stage frees VRAM via /v1/unload; /v1/reinitialize restores from cache).
  try {
    const h = await httpJson(`${cfg.aceUrl}/health`, 'GET', null, {}, 15000);
    const hd = h.json && h.json.data;
    if (hd && (hd.models_initialized === false || (hd.llm_initialized === false && !hd.loaded_model))) {
      job.message = 'Reloading ACE-Step models...';
      await httpJson(`${cfg.aceUrl}/v1/reinitialize`, 'POST', {}, {}, 600000);
      job.log = (job.log || []).concat(['ACE-Step models reinitialized']);
    }
  } catch (e) { /* health probe failed — let /release_task surface the real error */ }
  const sub = await httpJson(`${cfg.aceUrl}/release_task`, 'POST', body, {}, 120000);
  const d0 = sub.json && sub.json.data;
  const taskId = d0 && (d0.task_id || d0.taskId || (d0.data && d0.data.task_id));
  if (!taskId) throw new Error(`ACE-Step rejected task: ${JSON.stringify(sub.json).slice(0, 300)}`);
  job.message = 'ACE-Step is composing...';
  for (let i = 0; i < 180; i++) { // up to 30 min
    if (job.cancel.cancelled) throw new Error('cancelled');
    await new Promise((r) => setTimeout(r, 10000));
    // NOTE: the query parameter is task_id_list (per API docs), not task_ids.
    const q = await httpJson(`${cfg.aceUrl}/query_result`, 'POST', { task_id_list: [taskId] }, {}, 30000);
    const d = q.json && q.json.data && (Array.isArray(q.json.data) ? q.json.data[0] : q.json.data);
    const st = d && d.status;
    if (st === 2) {
      let msg = 'ACE-Step task failed';
      try { msg += ': ' + JSON.parse(d.result)[0].error; } catch (e) {}
      throw new Error(msg);
    }
    if (st === 1) {
      // result is a JSON string: [{file: "/v1/audio?path=...", status: 1, ...}]
      let audioUrl = null, lrcUrl = null;
      try {
        const res = JSON.parse(d.result || '[]');
        const first = Array.isArray(res) ? res[0] : res;
        if (first && first.file) audioUrl = first.file.startsWith('/') ? `${cfg.aceUrl}${first.file}` : first.file;
      } catch (e) {}
      return { audioUrl, lrcUrl };
    }
  }
  throw new Error('ACE-Step generation timed out (30 min)');
}

// ─── scene planning ───────────────────────────────────────────────────────
const DEFAULT_BEATS = [
  'establishing wide shot, slow push in', 'character at work, close detail',
  'machines and cables, macro detail', 'evening city lights through a window',
  'rhythmic machinery, abstract motion', 'interplay of light and shadow',
  'quiet dawn, calm atmosphere', 'rising energy, particles streaming',
  'climactic wide vista at sunrise', 'finale, hopeful horizon, slow fade',
];

function parseLrc(text) {
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.match(/^\s*\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
    if (m) lines.push({ t: Number(m[1]) * 60 + Number(m[2]), text: m[3].trim() });
    else if (raw.trim() && lines.length && !/^\[/.test(raw)) lines[lines.length - 1].text += ' ' + raw.trim();
  }
  return lines.filter((l) => l.text);
}

function planScenes(spec, durationS) {
  const n = Math.max(1, Math.min(24, Number(spec.sceneCount) || 9));
  const lrc = parseLrc(spec.lrc);
  const scenes = [];
  const style = spec.stylePrompt || 'cinematic, moody teal-green grade, volumetric light, no text, no watermark';
  if (lrc.length >= n) {
    const per = Math.ceil(lrc.length / n);
    for (let i = 0; i < n; i++) {
      const li0 = Math.min(i * per, lrc.length - 1);
      const li1 = Math.min((i + 1) * per, lrc.length - 1);
      const start = lrc[li0].t;
      const end = i + 1 < n ? lrc[li1].t : durationS;
      const lines = lrc.slice(li0, li1 + (i + 1 < n ? 0 : 1)).map((l) => l.text).join(' ');
      scenes.push({
        name: `scene_${String(i + 1).padStart(2, '0')}`,
        prompt: `${style} — ${lines.slice(0, 160)}`,
        startTime: Math.min(start, Math.max(0, durationS - 1)),
        duration: Math.max(2, end - start),
      });
    }
  } else {
    const seg = durationS / n;
    for (let i = 0; i < n; i++) {
      scenes.push({
        name: `scene_${String(i + 1).padStart(2, '0')}`,
        prompt: `${style}, ${DEFAULT_BEATS[i % DEFAULT_BEATS.length]}`,
        startTime: i * seg,
        duration: seg,
      });
    }
  }
  return scenes;
}

// ─── pipeline ──────────────────────────────────────────────────────────────
async function runPipeline(job, spec, cfg, ctx) {
  const dir = job.dir;
  const step = async (stage, pct, msg) => { job.stage = stage; job.progress = pct; job.message = msg; };
  const canceled = () => job.cancel.cancelled;
  const guard = () => { if (canceled()) throw new Error('cancelled'); };

  // 0. blank fallback image (used when a scene has neither still nor clip)
  const blankPng = path.join(dir, `${job.id}_blank.png`);
  await new Promise((resolve) => {
    const p = spawn(cfg.ffmpegPath, ['-y', '-f', 'lavfi', '-i', `color=c=0x101418:s=${spec.resolution || '704x480'}`, '-frames:v', '1', blankPng], { windowsHide: true });
    p.on('close', resolve); p.on('error', resolve);
  });

  // 1. song
  let audioFile = null, lrcText = spec.lrc || '';
  await step('song', 5, 'Preparing song...');
  guard();
  if (spec.generateSong && spec.generateSong.enabled) {
    if (!spec.songPrompt) throw new Error('songPrompt required when generateSong is enabled');
    // Music engine lives INSIDE the app since v1.2.0: if no ACE server is
    // running, start the bundled one (resources/music) before submitting.
    const ace = await ensureAceServer(ctx.rootDir, ctx.resourcesPath, {
      aceUrl: cfg.aceUrl,
      modelsDir: cfg.musicModelsDir,
    });
    if (!ace.ok) {
      throw new Error('Music engine unavailable: ' + (ace.error || 'ACE server not reachable')
        + ' — download the music models in Model Manager and retry.');
    }
    job.log = (job.log || []).concat([`ACE-Step server: ${ace.source}`]);
    const r = await aceGenerateSong(cfg, job, spec);
    if (!r.audioUrl) throw new Error('ACE-Step returned no audio file');
    audioFile = path.join(dir, `${job.id}_song.wav`);
    job.message = 'Downloading generated song...';
    await httpDownload(r.audioUrl, audioFile);
    if (r.lrcUrl) {
      try {
        const lr = await httpJson(r.lrcUrl.startsWith('/') ? `${cfg.aceUrl}${r.lrcUrl}` : r.lrcUrl, 'GET', null, {}, 60000);
        lrcText = lr.text || lrcText;
      } catch (e) { job.log = (job.log || []).concat([`lrc fetch failed: ${e.message}`]); }
    }
  } else {
    if (!spec.audioBase64) throw new Error('audioBase64 required when generateSong is disabled');
    const ext = ((spec.audioName || 'song.wav').split('.').pop() || 'wav').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'wav';
    audioFile = path.join(dir, `${job.id}_song.${ext}`);
    fs.writeFileSync(audioFile, Buffer.from(spec.audioBase64, 'base64'));
  }

  // 2. probe duration + plan scenes
  await step('plan', 12, 'Planning scenes...');
  const dur = await new Promise((resolve) => {
    const p = spawn(cfg.ffmpegPath, ['-i', audioFile, '-f', 'null', '-'], { windowsHide: true });
    let out = '';
    p.stderr.on('data', (d) => { out += d.toString(); });
    p.on('close', () => {
      const m = out.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 180);
    });
    p.on('error', () => resolve(180));
  });
  const scenes = planScenes({ ...spec, lrc: lrcText }, dur);
  job.scenes = scenes.map((s) => ({ ...s }));

  // 2b. free VRAM for the video engine: ACE-Step keeps its models resident
  // (vllm KV pool + DiT ≈ 10 GB on a 12 GB card), which crashes LTX renders.
  // The patched /v1/unload route drops them; /v1/reinitialize reloads them
  // lazily before the next song generation.
  if (spec.generateSong && spec.generateSong.enabled && cfg.aceUrl) {
    job.message = 'Freeing VRAM for video engine...';
    try {
      await httpJson(`${cfg.aceUrl}/v1/unload`, 'POST', {}, {}, 120000);
      job.log = (job.log || []).concat(['ACE-Step models unloaded for video stage']);
    } catch (e) {
      job.log = (job.log || []).concat([`ACE-Step unload skipped: ${e.message}`]);
    }
  }

  // 3. stills (app image engine via engineCore)
  await step('stills', 18, 'Generating keyframes...');
  const stillFiles = [];
  for (let i = 0; i < scenes.length; i++) {
    guard();
    job.message = `Keyframe ${i + 1}/${scenes.length}`;
    job.progress = 18 + Math.round((i / scenes.length) * 27);
    let stillPath = null;
    if (ctx.engineCore && cfg.imageModel) {
      try {
        const [w, h] = String(spec.resolution || '704x480').split('x').map(Number);
        const r = await ctx.engineCore.generateImage({
          prompt: scenes[i].prompt,
          negative_prompt: 'text, watermark, subtitles, letters, captions',
          modelPath: cfg.imageModel, width: w, height: h, steps: 6,
        }, {});
        stillPath = r && r.outputPath;
      } catch (e) { job.log = (job.log || []).concat([`still ${i + 1}: ${e.message}`]); }
    }
    if (!(stillPath && fs.existsSync(stillPath))) stillPath = null;
    stillFiles.push(stillPath);
    job.scenes[i].stillUrl = stillPath ? `/api/musicvideo/file/${encodeURIComponent(path.basename(stillPath))}` : null;
  }

  // 4. clips (video server)
  await step('clips', 46, 'Rendering video clips...');
  const vst = await ensureVideoServer(ctx.rootDir, ctx.resourcesPath);
  if (!vst.running) throw new Error('video server offline: ' + (vst.error || 'unavailable'));
  const clipFiles = [];
  const fps = 24;
  for (let i = 0; i < scenes.length; i++) {
    guard();
    job.message = `Clip ${i + 1}/${scenes.length}`;
    job.progress = 46 + Math.round((i / scenes.length) * 44);
    const seconds = Math.min(30, Math.max(2, Math.round(scenes[i].duration)));
    const body = {
      prompt: scenes[i].prompt + ', smooth continuous motion, no text, no watermark',
      negative_prompt: 'text, watermark, subtitles, letters',
      seconds, fps, resolution: spec.resolution || '704x480', chunk_seconds: 5,
    };
    if (stillFiles[i]) body.first_frame = stillFiles[i];
    else if (spec.firstFrameDataUrl) body.first_frame = spec.firstFrameDataUrl;
    // The video engine is fragile across consecutive jobs (access violations,
    // transient 500s) — render each clip with up to 3 attempts, restarting
    // the server between attempts. A clip that already downloaded passes.
    const local = path.join(dir, `${job.id}_${scenes[i].name}.mp4`);
    let lastClipErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await httpJson(`http://${ACE_HOST}:${cfg.videoPort}/v1/video/generations`, 'POST', body,
          { Authorization: `Bearer ${cfg.videoApiKey}` }, 0);
        const item = r.json && r.json.data && r.json.data[0];
        const url = item && (item.url || item.filename);
        if (!url) throw new Error(`clip ${i + 1} failed: ${JSON.stringify(r.json).slice(0, 300)}`);
        if (/^https?:/i.test(url)) await httpDownload(url, local);
        else if (url.startsWith('/')) await httpDownload(`http://${ACE_HOST}:${cfg.videoPort}${url.startsWith('/v1') ? url : '/v1/files/' + path.basename(url)}`, local);
        else if (fs.existsSync(url)) fs.copyFileSync(url, local);
        else throw new Error(`clip ${i + 1}: cannot resolve ${url}`);
        lastClipErr = null;
        break;
      } catch (e) {
        lastClipErr = e;
        if (canceled()) throw new Error('cancelled', { cause: e });
        if (attempt < 3) {
          job.log = (job.log || []).concat([`clip ${i + 1} attempt ${attempt}: ${e.message} — restarting engine`]);
          try { stopVideoServer(); } catch (e2) {}
          await new Promise((r2) => setTimeout(r2, 5000));
          const st2 = await ensureVideoServer(ctx.rootDir, ctx.resourcesPath);
          if (!st2.running) throw new Error('video server offline after restart: ' + (st2.error || 'unavailable'), { cause: e });
        }
      }
    }
    if (lastClipErr) throw lastClipErr;
    clipFiles.push(local);
    job.scenes[i].clipUrl = `/api/musicvideo/file/${encodeURIComponent(path.basename(local))}`;
  }

  // 5. assemble — ffmpeg xfade chain + title card + song mux (port of bfs_assemble_v3)
  await step('assemble', 91, 'Assembling final cut...');
  guard();
  const XF = 0.6;
  const [W, H] = String(spec.resolution || '704x480').split('x').map(Number);
  const fps2 = 24;
  const durs = scenes.map((s) => s.duration + XF);
  const inputs = [], parts = [];
  for (let i = 0; i < scenes.length; i++) {
    const dur = durs[i];
    if (clipFiles[i] && fs.existsSync(clipFiles[i])) {
      inputs.push('-i', clipFiles[i]);
      parts.push(`[${i}:v]scale=${W}:${H},fps=${fps2},trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p,settb=AVTB[b${i}]`);
    } else {
      const img = stillFiles[i] || blankPng;
      inputs.push('-loop', '1', '-t', dur.toFixed(3), '-i', img);
      parts.push(`[${i}:v]scale=${W}:${H},fps=${fps2},trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p,settb=AVTB[b${i}]`);
    }
  }
  let chain = '[b0]', t = 0;
  const links = [];
  for (let i = 1; i < scenes.length; i++) {
    t += durs[i - 1] - XF;
    links.push(`${chain}[b${i}]xfade=transition=fade:duration=${XF}:offset=${t.toFixed(2)}[x${i}]`);
    chain = `[x${i}]`;
  }
  const total = durs.reduce((a, b) => a + b, 0) - XF * (scenes.length - 1);
  const title = spec.titleCard || { line1: 'MUSIC VIDEO', line2: 'made with Solframe Studio' };
  const esc = (s) => String(s || '').replace(/['\\:%]/g, '');
  const font = os.platform() === 'win32' ? "'C\\:/Windows/Fonts/arialbd.ttf'" : '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const t1 = Math.max(3, total - 4), t2 = Math.max(1.5, total - 2.5);
  const alpha = `if(lt(t,0.8),0,if(lt(t,2.3),(t-0.8)/1.5,if(lt(t,5),1,if(lt(t,6.5),(6.5-t)/1.5,0))))`;
  const outMp4 = path.join(dir, `${job.id}_final.mp4`);
  const filter = parts.concat(links).join(';') + ';' +
    `${chain}drawtext=fontfile=${font}:text='${esc(title.line1)}':fontsize=${Math.round(H / 10)}:fontcolor=0xE8E8E8:x=(w-text_w)/2:y=h*0.42:alpha='${alpha}',` +
    `drawtext=fontfile=${font}:text='${esc(title.line2)}':fontsize=${Math.round(H / 20)}:fontcolor=0x9AE6B4:x=(w-text_w)/2:y=h*0.55:alpha='${alpha}'[vout]`;
  const args = ['-y'].concat(inputs, ['-i', audioFile, '-filter_complex', filter,
    '-map', '[vout]', '-map', `${scenes.length}:a`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(fps2),
    '-c:a', 'aac', '-b:a', '192k', '-shortest', outMp4]);
  await new Promise((resolve, reject) => {
    const p = spawn(cfg.ffmpegPath, args, { windowsHide: true });
    let lastErr = '';
    p.stderr.on('data', (d) => { lastErr = d.toString(); job.message = 'Assembling... ' + (d.toString().match(/time=\S+/) || [''])[0]; });
    p.on('close', (code) => {
      if (canceled()) return reject(new Error('cancelled'));
      if (code === 0) resolve(); else reject(new Error(`ffmpeg exit ${code}: ${lastErr.slice(-400)}`));
    });
    p.on('error', reject);
  });
  job.result = {
    url: `/api/musicvideo/file/${encodeURIComponent(path.basename(outMp4))}`,
    filename: path.basename(outMp4),
    duration_s: Math.round(total * 100) / 100,
    width: W, height: H,
  };
  job.stage = 'done'; job.progress = 100; job.message = 'Done';
}

// ─── request handling ──────────────────────────────────────────────────────
async function handleMusicVideoApi(req, res, ctx = {}) {
  const cfg = readConfig(ctx.rootDir, ctx.resourcesPath);
  const outDir = jobDir(ctx.userOutputsDir || ctx.rootDir || process.cwd());
  let p = req.url || '';
  if (p.startsWith('/api/musicvideo')) p = p.replace('/api/musicvideo', '');
  const pathname = p.split('?')[0] || '';
  const q = new URL('http://x' + (p || '/')).searchParams;
  const sendJson = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };

  if (pathname === '/config' && req.method === 'GET') {
    let ace = false;
    try { const h = await httpJson(`${cfg.aceUrl}/health`, 'GET', null, {}, 4000); ace = h.status === 200; } catch (e) {}
    const video = await probePort(cfg.videoPort);
    return sendJson(200, {
      ace: { url: cfg.aceUrl, configured: ace },
      video: { ok: video },
      ffmpeg: { found: !!cfg.ffmpegPath },
      imageModel: cfg.imageModel || null,
    });
  }
  if (pathname === '/start' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let spec;
      try { spec = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (e) { return sendJson(400, { error: 'invalid JSON body' }); }
      const id = `mv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const job = { id, stage: 'queued', progress: 0, message: 'Queued', cancel: { cancelled: false }, dir: outDir, startedAt: Date.now() };
      jobs.set(id, job);
      (async () => {
        try { await runPipeline(job, spec, cfg, ctx); }
        catch (e) { job.stage = 'error'; job.error = e.message; job.message = 'Failed: ' + e.message; }
      })();
      return sendJson(200, { jobId: id });
    });
    return;
  }
  if (pathname === '/status') {
    const job = jobs.get(q.get('job'));
    if (!job) return sendJson(404, { error: 'unknown job' });
    return sendJson(200, {
      jobId: job.id, stage: job.stage, progress: job.progress, message: job.message,
      error: job.error, scenes: job.scenes, result: job.result,
    });
  }
  if (pathname === '/cancel' && req.method === 'DELETE') {
    const job = jobs.get(q.get('job'));
    if (!job) return sendJson(404, { error: 'unknown job' });
    job.cancel.cancelled = true;
    return sendJson(200, { ok: true });
  }
  if (pathname.startsWith('/file/')) {
    const name = decodeURIComponent(pathname.slice('/file/'.length)).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const file = path.join(outDir, name);
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const types = { '.mp4': 'video/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.png': 'image/png', '.flac': 'audio/flac' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Content-Length': fs.statSync(file).size });
    return fs.createReadStream(file).pipe(res);
  }
  sendJson(404, { error: `unknown musicvideo route ${pathname}` });
}

module.exports = { handleMusicVideoApi };

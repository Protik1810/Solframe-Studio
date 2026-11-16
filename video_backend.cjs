/**
 * Solframe Video Backend — shared by the Electron engine (server.cjs) and the
 * vite dev middlewares (vite.config.ts).
 *
 * Responsibilities:
 *  - Lazily start the Python video generation server (video_server.py, port 8766)
 *    if it is not already listening (scheduled task instance wins if present).
 *  - Proxy /api/video/* calls to 127.0.0.1:8766 with the configured Bearer key.
 *
 * Bundled runtime resolution (same pattern as music_backend.cjs): packaged
 * builds ship a relocatable runtime archive, video-runtime.tar.xz (venv/
 * with torch + server/video_server.py), and reuse the music runtime's
 * extractor python under resources/music/python. On first video use:
 *   1. already-extracted runtime
 *        backend/<win|linux>/video  (dev machines stage it here)
 *        resources/video            (bundled archive, extracted once)
 *        ~/SolframeStudio/video     (user-data archive, extracted once)
 *   2. archive dropped by the user in ~/SolframeStudio/video-runtime.tar.xz
 *      → extracted once into ~/SolframeStudio/video
 *   3. archive bundled in resources (fully-bundled builds)
 *      → extracted once into resources/video
 * Extraction is performed by the bundled python's own tarfile module — no
 * external tools required. A venv copied off the build machine carries a
 * stale pyvenv.cfg `home` pointing at the build box's interpreter, so
 * ensureVideoServer() rewrites it to the bundled python dir
 * (resources/video/python when the build bundles one, else
 * resources/music/python) before the first launch (idempotent).
 *
 * Spawn environment: when the packaged/userData runtime is in use the server
 * is started with SOLFRAME_VIDEO_ROOT=~/SolframeStudio/video and
 * SOLFRAME_VIDEO_MODELS=<the app's model-manager download root, resolved via
 * pathUtils.getUserModelsRoot() so user-downloaded LTX/Wan/FreeVideo weights
 * are found without configuration> — video_server.py derives its outputs/,
 * log, config path and weight dirs from these. A dev runtime under backend/
 * keeps the current behavior: no env overrides unless they are already set.
 * The port-bind deadline is 180s — cold torch imports on a fresh extraction
 * are slow.
 *
 * Routes handled (pathname prefixes under /api/video):
 *   GET  /api/video/health       -> video server /health
 *   GET  /api/video/models       -> video server /v1/video/models
 *   GET  /api/video/files        -> video server /v1/video/files (generated mp4 list)
 *   GET  /api/video/file/<name>  -> video server /v1/files/<name> (stream mp4)
 *   GET  /api/video/runtime       -> bundled runtime install/extract status
 *   POST /api/video/runtime/download -> start release-page archive download
 *   POST /api/video/runtime/import   -> import an already-downloaded archive
 *   POST /api/video/generate     -> video server /v1/video/generations (sync, long)
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const VIDEO_PORT = 8766;
const VIDEO_HOST = '127.0.0.1';
const RUNTIME_ASSET = 'video-runtime.tar.xz';
const REPO_SLUG = 'Protik1810/Solframe-Studio';
const VIDEO_ARCHIVE = RUNTIME_ASSET;

let videoProc = null;          // child process we spawned (if any)
let videoProcRoot = null;      // repo root the child was started from
let ensurePromise = null;

/** Where users drop the runtime archive they download from the release page. */
function defaultUserDataDir() {
  return path.join(os.homedir(), 'SolframeStudio');
}

function venvPythonPath(rt) {
  return process.platform === 'win32'
    ? path.join(rt, 'venv', 'Scripts', 'python.exe')
    : path.join(rt, 'venv', 'bin', 'python');
}

/**
 * A runtime is usable when it carries a venv with a working interpreter and
 * the server entry point. Candidates in order — dev staging tree, extracted
 * bundled archive, user-data extraction.
 */
function findVideoRuntime(rootDir, resourcesPath, userDataDir) {
  const sub = process.platform === 'win32' ? 'win' : 'linux';
  const candidates = [
    rootDir && path.join(rootDir, 'backend', sub, 'video'),
    // dev on either platform may stage the runtime under its own backend dir
    rootDir && path.join(rootDir, 'backend', 'win', 'video'),
    resourcesPath && path.join(resourcesPath, 'video'),
    userDataDir && path.join(userDataDir, 'video'),
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (fs.existsSync(path.join(c, 'venv'))
        && fs.existsSync(venvPythonPath(c))
        && fs.existsSync(path.join(c, 'server', 'video_server.py'))) return c;
  }
  return null;
}

/**
 * Packaged-install fallback: the runtime archive plus the extractor python.
 * Archive candidates in order — (1) user-data copy, (2) archive bundled under
 * resources. The extracted tree goes next to whichever archive was found; the
 * bundled music/python dir in resources is always the extractor and the venv
 * base interpreter (same extractor music_backend.cjs uses).
 */
function findVideoRuntimeArchive(resourcesPath, userDataDir) {
  userDataDir = userDataDir || defaultUserDataDir();
  const pythonExe = process.platform === 'win32'
    ? path.join(resourcesPath || '', 'music', 'python', 'python.exe')
    : path.join(resourcesPath || '', 'music', 'python', 'bin', 'python');
  const archiveCandidates = [
    path.join(userDataDir, VIDEO_ARCHIVE),
    resourcesPath && path.join(resourcesPath, VIDEO_ARCHIVE),
  ];
  for (const archive of archiveCandidates) {
    if (!archive || !fs.existsSync(archive)) continue;
    if (!fs.existsSync(pythonExe)) continue;
    const destDir = path.dirname(archive) === path.resolve(userDataDir)
      ? path.join(userDataDir, 'video')
      : path.join(resourcesPath, 'video');
    return { archive, pythonExe, destDir };
  }
  return null;
}

function extractRuntimeArchive(archive, pythonExe, destDir) {
  const script = 'import sys, tarfile; tarfile.open(sys.argv[1]).extractall(sys.argv[2])';
  return new Promise((resolve) => {
    fs.mkdirSync(destDir, { recursive: true });
    const p = spawn(pythonExe, ['-c', script, archive, destDir], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => {
      const ok = code === 0 && fs.existsSync(path.join(destDir, 'venv'));
      resolve(ok ? null : `video runtime extraction failed (exit ${code})${err ? ': ' + err.slice(-400) : ''}`);
    });
    p.on('error', (e) => resolve(`video runtime extraction failed to start: ${e.message}`));
  });
}

/** Rewrite the copied venv's pyvenv.cfg home → bundled python. Idempotent. */
function bootstrapVenv(rt, pythonDir) {
  try {
    const cfgPath = path.join(rt, 'venv', 'pyvenv.cfg');
    // the venv base interpreter: python/ inside the runtime when present
    // (bundled extraction), otherwise the extractor python shipped in
    // resources (user-data extraction)
    const homeDir = pythonDir || path.join(rt, 'python');
    if (!fs.existsSync(cfgPath) || !fs.existsSync(homeDir)) return false;
    const cur = fs.readFileSync(cfgPath, 'utf8');
    const want = `home = ${homeDir}`;
    if (cur.split(/\r?\n/).some((l) => l.trim() === want.trim())) return true;
    const next = cur.replace(/^home\s*=.*$/m, want);
    if (next !== cur) { fs.writeFileSync(cfgPath, next); return true; }
    return true;
  } catch (e) { return false; }
}

function findVideoServerPy(rootDir, resourcesPath, runtime) {
  const candidates = [
    runtime && path.join(runtime, 'server', 'video_server.py'),
    path.join(rootDir || '', 'video_server.py'),
    path.join(resourcesPath || '', 'video_server.py'),
    path.join(resourcesPath || '', 'app', 'video_server.py'),
    'D:\\genimg_comic\\video_server.py',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function findConfigJson(rootDir, resourcesPath, userDataDir) {
  const candidates = [
    path.join(rootDir || '', 'video_server.json'),
    // packaged runtime: the server reads its config under the video root
    path.join(userDataDir || '', 'video', 'video_server.json'),
    path.join(resourcesPath || '', 'video', 'server', 'video_server.json'),
    path.join(resourcesPath || '', 'video_server.json'),
    'D:\\genimg_comic\\video_server.json',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function readConfig(rootDir, resourcesPath) {
  const cfgFile = findConfigJson(rootDir, resourcesPath, defaultUserDataDir());
  let cfg = {};
  if (cfgFile) {
    try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) {}
  }
  return {
    apiKey: typeof cfg.apiKey === 'string' ? cfg.apiKey : '',
    port: Number(cfg.port) || VIDEO_PORT,
  };
}

function probePort(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: VIDEO_HOST, port });
    const done = (ok) => { try { sock.destroy(); } catch (e) {} resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/**
 * Python for the server: the runtime's own venv interpreter first, then the
 * machine-specific dev candidates (SOLFRAME_PYTHON, the D:\ work venv, uv
 * cpython, PATH python) so dev machines without the packaged runtime keep
 * working.
 */
function pickRuntimePython(runtime) {
  const candidates = [
    runtime && venvPythonPath(runtime),
    process.env.SOLFRAME_PYTHON,
    'D:\\GPU computation\\.venv\\Scripts\\python.exe',
    path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming', 'uv', 'python', 'cpython-3.11.15-windows-x86_64-none', 'python.exe'),
    'python',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === 'python' || fs.existsSync(c)) return c;
  }
  return 'python';
}

/** True when the runtime lives in the dev tree (backend/<sub>/video). */
function isDevRuntime(runtime, rootDir) {
  if (!runtime || !rootDir) return false;
  const sub = process.platform === 'win32' ? 'win' : 'linux';
  return [
    path.join(rootDir, 'backend', sub, 'video'),
    path.join(rootDir, 'backend', 'win', 'video'),
  ].some((d) => {
    try { return path.resolve(d) === path.resolve(runtime); } catch (e) { return false; }
  });
}

/** Release-asset URL for the runtime archive, keyed off the app's version. */
function releaseDownloadUrl(rootDir) {
  try {
    const pkg = require(path.join(rootDir, 'package.json'));
    return pkg && pkg.version
      ? `https://github.com/${REPO_SLUG}/releases/download/v${pkg.version}/${RUNTIME_ASSET}`
      : null;
  } catch (e) {
    return null;
  }
}

/**
 * Stream the runtime archive from the release page to destPath. Uses Node's
 * own fetch (same stance as the music runtime's downloader — no external
 * curl). Progress is reported through onProgress(received, totalBytes).
 */
async function downloadRuntimeArchive(url, destPath, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`runtime download failed: HTTP ${res.status} for ${url}`);
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const out = fs.createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    res.body.on('data', (chunk) => {
      received += chunk.length;
      out.write(chunk);
      if (onProgress) { try { onProgress(received, total); } catch (e) {} }
    });
    res.body.on('error', reject);
    res.body.on('end', () => out.end(resolve));
    out.on('error', reject);
  });
  if (received < 1024 * 1024) {
    try { fs.unlinkSync(destPath); } catch (e) {}
    throw new Error(`runtime download too small (${received} bytes) — aborted`);
  }
  return { destPath, bytes: received };
}

/**
 * Weights root for SOLFRAME_VIDEO_MODELS — the SAME root the app's Model
 * Manager downloads into, so user-downloaded LTX/Wan/H3 weights are found
 * without configuration. Resolved through pathUtils.getUserModelsRoot()
 * (repo tree in dev, inside app.asar when packaged); falls back to the
 * video-models dir under the user data dir.
 */
function resolveVideoModelsRoot(rootDir, resourcesPath, userDataDir) {
  const candidates = [
    path.join(rootDir || '', 'electron', 'engine', 'pathUtils.cjs'),
    path.join(process.resourcesPath || '', 'app.asar', 'electron', 'engine', 'pathUtils.cjs'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const { getUserModelsRoot } = require(p);
      const root = typeof getUserModelsRoot === 'function' ? getUserModelsRoot() : null;
      if (root && typeof root === 'string') return root;
    } catch (e) { /* fall through to the next candidate */ }
  }
  return path.join(userDataDir || defaultUserDataDir(), 'video-models');
}

async function ensureVideoServer(rootDir, resourcesPath) {
  const alive = await probePort(VIDEO_PORT);
  if (alive) return { started: false, running: true };
  if (ensurePromise) return ensurePromise;
  const userDataDir = defaultUserDataDir();
  let runtime = findVideoRuntime(rootDir, resourcesPath, userDataDir);
  if (!runtime) {
    // Packaged installs ship the runtime as an archive; extract it once on
    // first video use with the bundled python's own tarfile module.
    const ar = findVideoRuntimeArchive(resourcesPath, userDataDir);
    if (ar) {
      const extractErr = await extractRuntimeArchive(ar.archive, ar.pythonExe, ar.destDir);
      if (extractErr) return { started: false, running: false, error: extractErr };
      runtime = findVideoRuntime(rootDir, resourcesPath, userDataDir);
    }
  }
  if (!runtime) {
    return { started: false, running: false, error: `no video runtime found and no ${VIDEO_ARCHIVE} next to the app or in ${userDataDir}` };
  }
  const script = findVideoServerPy(rootDir, resourcesPath, runtime);
  if (!script) return { started: false, running: false, error: 'video_server.py not found' };
  const py = pickRuntimePython(runtime);
  // venv base interpreter: resources/video/python when the build bundles one,
  // otherwise the extractor python under resources/music. Dev venvs created
  // locally keep their own (already-correct) pyvenv.cfg because neither dir
  // exists there.
  const venvBaseDir = fs.existsSync(path.join(resourcesPath || '', 'video', 'python'))
    ? path.join(resourcesPath, 'video', 'python')
    : path.join(resourcesPath || '', 'music', 'python');
  bootstrapVenv(runtime, venvBaseDir);

  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
  };
  // Only the packaged/userData runtime runs against user-writable roots; a
  // dev runtime under backend/ keeps the current behavior (video_server.py's
  // own defaults, no env overrides unless they are already set).
  if (!isDevRuntime(runtime, rootDir)) {
    const videoRoot = path.join(userDataDir, 'video');
    const modelsRoot = resolveVideoModelsRoot(rootDir, resourcesPath, userDataDir);
    try {
      fs.mkdirSync(videoRoot, { recursive: true });
      fs.mkdirSync(modelsRoot, { recursive: true });
    } catch (e) {}
    env.SOLFRAME_VIDEO_ROOT = videoRoot;
    env.SOLFRAME_VIDEO_MODELS = modelsRoot;
    const cfgFile = path.join(videoRoot, 'video_server.json');
    if (fs.existsSync(cfgFile)) env.SOLFRAME_VIDEO_CONFIG = cfgFile;
  }

  console.log(`[Solframe Video] Starting video server: ${py} ${script}`);
  ensurePromise = new Promise((resolve) => {
    try {
      videoProc = spawn(py, [script], {
        cwd: path.dirname(script),
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      videoProcRoot = rootDir;
      videoProc.stdout?.on('data', (d) => console.log('[video-server]', d.toString().trim()));
      videoProc.stderr?.on('data', (d) => console.log('[video-server!]', d.toString().trim()));
      videoProc.on('close', (code) => {
        console.log(`[Solframe Video] video server exited (${code})`);
        videoProc = null;
        ensurePromise = null;
      });
    } catch (e) {
      ensurePromise = null;
      return resolve({ started: false, running: false, error: e.message });
    }
    // Wait for the port to open. Warm torch imports take ~5-15s; cold imports
    // on a freshly extracted runtime are far slower — 180s bind deadline.
    const deadline = Date.now() + 180000;
    const poll = async () => {
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await probePort(VIDEO_PORT, 500)) return resolve({ started: true, running: true });
        if (videoProc === null) break; // died at startup
      }
      resolve({ started: true, running: false, error: 'video server did not bind port in time' });
    };
    poll();
  });
  return ensurePromise;
}

function stopVideoServer() {
  if (videoProc) {
    try { videoProc.kill(); } catch (e) {}
    videoProc = null;
    ensurePromise = null;
  }
}

function proxyToVideoServer(req, res, targetPath) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const upstream = http.request({
      host: VIDEO_HOST,
      port: VIDEO_PORT,
      path: targetPath,
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'Authorization': `Bearer ${currentApiKey}`,
      },
      // video generation is synchronous and can run for many minutes
      timeout: 0,
    }, (up) => {
      res.writeHead(up.statusCode || 500, {
        'Content-Type': up.headers['content-type'] || 'application/json',
      });
      up.pipe(res);
    });
    upstream.on('error', (e) => {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
      }
      try { res.end(JSON.stringify({ error: `video server unreachable: ${e.message}` })); } catch (e2) {}
    });
    if (body.length) upstream.write(body);
    upstream.end();
  });
}

let currentApiKey = '';

// video runtime acquisition state (module-level: survives across requests;
// one download/import at a time — same pattern as music_video.cjs)
const runtimeDownload = {
  phase: 'idle', // idle | downloading | importing | ready | error
  received: 0,
  total: 0,
  error: null,
  source: null, // 'download' | 'import'
  startedAt: 0,
  finishedAt: 0,
};

function startRuntimeAcquire(source, fn) {
  runtimeDownload.phase = source === 'download' ? 'downloading' : 'importing';
  runtimeDownload.received = 0;
  runtimeDownload.total = 0;
  runtimeDownload.error = null;
  runtimeDownload.source = source;
  runtimeDownload.startedAt = Date.now();
  runtimeDownload.finishedAt = 0;
  (async () => {
    try {
      await fn((received, total) => {
        runtimeDownload.received = received;
        if (total) runtimeDownload.total = total;
      });
      runtimeDownload.phase = 'ready';
      runtimeDownload.finishedAt = Date.now();
    } catch (e) {
      runtimeDownload.phase = 'error';
      runtimeDownload.error = e.message;
      runtimeDownload.finishedAt = Date.now();
    }
  })();
}

const sendJson = (res, code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };

async function handleVideoApi(req, res, ctx = {}) {
  const rootDir = ctx.rootDir || process.cwd();
  const resourcesPath = ctx.resourcesPath || rootDir;
  const cfg = readConfig(rootDir, resourcesPath);
  currentApiKey = cfg.apiKey || currentApiKey;

  // req.url may or may not carry the mount prefix depending on the host layer.
  let p = req.url || '';
  if (p.startsWith('/api/video')) p = p.replace('/api/video', '');
  const pathname = (p.split('?')[0] || '');

  // Runtime status for the video tab's setup banner, plus acquisition routes
  // mirroring the music pipeline's (/api/musicvideo/runtime/*).
  if (pathname === '/runtime') {
    return sendJson(res, 200, {
      ...runtimeStatus(rootDir, resourcesPath),
      download: {
        phase: runtimeDownload.phase,
        received: runtimeDownload.received,
        total: runtimeDownload.total,
        error: runtimeDownload.error,
        source: runtimeDownload.source,
      },
    });
  }
  if (pathname === '/runtime/download' && req.method === 'POST') {
    const rt = runtimeStatus(rootDir, resourcesPath);
    if (rt.installed) return sendJson(res, 200, { ok: true, message: 'runtime already installed' });
    if (runtimeDownload.phase === 'downloading' || runtimeDownload.phase === 'importing') {
      return sendJson(res, 200, { ok: true, message: `already ${runtimeDownload.phase}` });
    }
    if (!rt.downloadUrl) return sendJson(res, 400, { error: 'no download URL — app version unknown' });
    startRuntimeAcquire('download', (onProgress) =>
      downloadRuntimeArchive(rt.downloadUrl, rt.expectedArchivePath, onProgress));
    return sendJson(res, 202, { ok: true, url: rt.downloadUrl, dest: rt.expectedArchivePath });
  }
  if (pathname === '/runtime/import' && req.method === 'POST') {
    if (runtimeDownload.phase === 'downloading' || runtimeDownload.phase === 'importing') {
      return sendJson(res, 409, { error: `another acquisition is ${runtimeDownload.phase}` });
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (e) { return sendJson(res, 400, { error: 'invalid JSON body' }); }
      const src = typeof body.archivePath === 'string' ? body.archivePath.trim() : '';
      if (!src) return sendJson(res, 400, { error: 'archivePath required' });
      let st;
      try { st = fs.statSync(src); } catch (e) { return sendJson(res, 400, { error: `file not found: ${src}` }); }
      if (!st.isFile()) return sendJson(res, 400, { error: `not a file: ${src}` });
      if (st.size < 1024 * 1024) return sendJson(res, 400, { error: `file too small (${st.size} bytes) to be the video runtime` });
      const rt = runtimeStatus(rootDir, resourcesPath);
      if (rt.installed) return sendJson(res, 200, { ok: true, message: 'runtime already installed' });
      const dest = rt.expectedArchivePath;
      if (path.resolve(src) === path.resolve(dest)) return sendJson(res, 200, { ok: true, message: 'already in place' });
      startRuntimeAcquire('import', async (onProgress) => {
        await new Promise((resolve, reject) => {
          let tick;
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          tick = setInterval(() => {
            try { onProgress(fs.statSync(dest).size, st.size); } catch (e) {}
          }, 500);
          fs.copyFile(src, dest, (err) => {
            clearInterval(tick);
            err ? reject(err) : resolve();
          });
        });
        return { dest, bytes: st.size };
      });
      return sendJson(res, 202, { ok: true, dest });
    });
    return;
  }

  // Health probe auto-starts the backend so the UI can show "waking" state.
  if (pathname === '/health' || pathname === '/status') {
    const st = await ensureVideoServer(rootDir, resourcesPath);
    if (!st.running) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: false, busy: false, error: st.error || 'video server offline' }));
    }
    return proxyToVideoServer(req, res, '/health');
  }
  if (pathname === '/models') {
    const st = await ensureVideoServer(rootDir, resourcesPath);
    if (!st.running) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: st.error || 'video server offline' }));
    }
    return proxyToVideoServer(req, res, '/v1/video/models');
  }
  if (pathname === '/files') {
    return proxyToVideoServer(req, res, '/v1/video/files');
  }
  if (pathname.startsWith('/file/')) {
    const name = decodeURIComponent(pathname.slice('/file/'.length)).replace(/[^a-zA-Z0-9_.-]/g, '_');
    return proxyToVideoServer(req, res, `/v1/files/${name}`);
  }
  if (pathname === '/generate' || pathname === '/generations') {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      return res.end('Method Not Allowed');
    }
    const st = await ensureVideoServer(rootDir, resourcesPath);
    if (!st.running) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: st.error || 'video server offline' }));
    }
    return proxyToVideoServer(req, res, '/v1/video/generations');
  }
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: `unknown video route ${pathname}` }));
}

/**
 * Where the video pipeline stands, for the tab's setup banner:
 *   installed       — extracted runtime already usable
 *   archivePresent  — archive on disk (user-data or bundled), extracts on
 *                     first use
 *   otherwise       — needs the installer's bundled archive (or a user drop)
 */
function runtimeStatus(rootDir, resourcesPath, opts = {}) {
  const userDataDir = opts.userDataDir || defaultUserDataDir();
  const rt = findVideoRuntime(rootDir, resourcesPath, userDataDir);
  const ar = findVideoRuntimeArchive(resourcesPath, userDataDir);
  const archivePath = ar ? ar.archive : path.join(userDataDir, VIDEO_ARCHIVE);
  let archiveBytes = 0;
  try { archiveBytes = fs.existsSync(archivePath) ? fs.statSync(archivePath).size : 0; } catch (e) {}
  return {
    installed: !!rt,
    runtimeDir: rt || null,
    archivePresent: !!ar,
    archivePath: ar ? ar.archive : null,
    archiveBytes,
    destDir: ar ? ar.destDir : path.join(userDataDir, 'video'),
    downloadUrl: releaseDownloadUrl(rootDir),
  };
}

module.exports = {
  handleVideoApi, ensureVideoServer, stopVideoServer, probePort,
  findVideoRuntime, findVideoRuntimeArchive, bootstrapVenv,
  defaultUserDataDir, pickRuntimePython, resolveVideoModelsRoot, runtimeStatus,
  releaseDownloadUrl, downloadRuntimeArchive,
};

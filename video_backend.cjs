/**
 * Solframe Video Backend — shared by the Electron engine (server.cjs) and the
 * vite dev middlewares (vite.config.ts).
 *
 * Responsibilities:
 *  - Lazily start the Python video generation server (video_server.py, port 8766)
 *    if it is not already listening (scheduled task instance wins if present).
 *  - Proxy /api/video/* calls to 127.0.0.1:8766 with the configured Bearer key.
 *
 * Routes handled (pathname prefixes under /api/video):
 *   GET  /api/video/health       -> video server /health
 *   GET  /api/video/models       -> video server /v1/video/models
 *   GET  /api/video/files        -> video server /v1/video/files (generated mp4 list)
 *   GET  /api/video/file/<name>  -> video server /v1/files/<name> (stream mp4)
 *   POST /api/video/generate     -> video server /v1/video/generations (sync, long)
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VIDEO_PORT = 8766;
const VIDEO_HOST = '127.0.0.1';

let videoProc = null;          // child process we spawned (if any)
let videoProcRoot = null;      // repo root the child was started from
let ensurePromise = null;

function findVideoServerPy(rootDir, resourcesPath) {
  const candidates = [
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

function findConfigJson(rootDir, resourcesPath) {
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
  const cfgFile = findConfigJson(rootDir, resourcesPath);
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

function pickPython(rootDir) {
  const candidates = [
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

async function ensureVideoServer(rootDir, resourcesPath) {
  const alive = await probePort(VIDEO_PORT);
  if (alive) return { started: false, running: true };
  if (ensurePromise) return ensurePromise;
  const script = findVideoServerPy(rootDir, resourcesPath);
  if (!script) return { started: false, running: false, error: 'video_server.py not found' };
  const py = pickPython(rootDir);
  console.log(`[Solframe Video] Starting video server: ${py} ${script}`);
  ensurePromise = new Promise((resolve) => {
    try {
      videoProc = spawn(py, [script], {
        cwd: path.dirname(script),
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
    // Wait for the port to open (model-free server binds fast; torch import ~5-15s)
    const deadline = Date.now() + 90000;
    const poll = async () => {
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await probePort(VIDEO_PORT, 500)) return resolve({ started: true, running: true });
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

async function handleVideoApi(req, res, ctx = {}) {
  const rootDir = ctx.rootDir || process.cwd();
  const resourcesPath = ctx.resourcesPath || rootDir;
  const cfg = readConfig(rootDir, resourcesPath);
  currentApiKey = cfg.apiKey || currentApiKey;

  // req.url may or may not carry the mount prefix depending on the host layer.
  let p = req.url || '';
  if (p.startsWith('/api/video')) p = p.replace('/api/video', '');
  const pathname = (p.split('?')[0] || '');

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

module.exports = { handleVideoApi, ensureVideoServer, stopVideoServer, probePort };

/**
 * music_backend.cjs — lifecycle for the BUNDLED ACE-Step music server.
 *
 * The v1.2.0 installers ship the full ACE-Step runtime inside the app:
 *   music/python/              — uv-managed standalone CPython (relocatable);
 *                                also the extractor for the runtime archive
 *   music-runtime.tar.xz       — the ACE-Step dependency env (venv/) + the
 *                                ACE-Step source tree (ace/), extracted once
 *                                on first use into resources/music/
 *
 * A plain install dir (PrivilegesRequired=lowest) is user-writable, so the
 * archive self-extracts next to the bundled python and every later launch
 * finds the runtime already in place.
 *
 * A venv copied off the build machine carries a stale pyvenv.cfg `home`
 * pointing at the build box's interpreter — every spawned process would
 * resolve python.exe from the venv and immediately fall back to that missing
 * base interpreter. ensureAceServer() therefore rewrites `home` to the
 * bundled python dir before the first launch (idempotent, plain-text edit).
 *
 * Model weights are NOT shipped (multi-GB): they live in a music-models dir
 * under the app's user data and are provisioned through the app's model
 * manager / first-run flow. The server is started with ACESTEP_NO_INIT so it
 * binds fast and loads weights on demand (/v1/reinitialize).
 *
 * Same resolution + port-probe pattern as video_backend.cjs (e500dde).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ACE_PORT_DEFAULT = 8001;
let aceProc = null;

function httpProbe(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname, method: 'GET', timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
      req.end();
    } catch (e) { resolve(false); }
  });
}

function findRuntime(rootDir, resourcesPath) {
  const sub = process.platform === 'win32' ? 'win' : 'linux';
  const candidates = [
    rootDir && path.join(rootDir, 'backend', sub, 'music'),
    // dev on either platform may stage the runtime under its own backend dir
    rootDir && path.join(rootDir, 'backend', 'win', 'music'),
    resourcesPath && path.join(resourcesPath, 'music'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'venv'))) return c;
  }
  return null;
}

/**
 * Packaged-install fallback: the runtime archive (music-runtime.tar.xz) plus
 * the extractor python are shipped under resources; the extracted tree is not.
 * Extraction is one-time (~2-4 min on first music use), performed by the
 * bundled python's own tarfile module — no external tools required.
 */
function findRuntimeArchive(resourcesPath) {
  if (!resourcesPath) return null;
  const archive = path.join(resourcesPath, 'music-runtime.tar.xz');
  const pythonExe = process.platform === 'win32'
    ? path.join(resourcesPath, 'music', 'python', 'python.exe')
    : path.join(resourcesPath, 'music', 'python', 'bin', 'python');
  if (!fs.existsSync(archive) || !fs.existsSync(pythonExe)) return null;
  return { archive, pythonExe, destDir: path.join(resourcesPath, 'music') };
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
      resolve(ok ? null : `music runtime extraction failed (exit ${code})${err ? ': ' + err.slice(-400) : ''}`);
    });
    p.on('error', (e) => resolve(`music runtime extraction failed to start: ${e.message}`));
  });
}

/** Rewrite the copied venv's pyvenv.cfg home → bundled python. Idempotent. */
function bootstrapVenv(rt) {
  try {
    const cfgPath = path.join(rt, 'venv', 'pyvenv.cfg');
    const homeDir = path.join(rt, 'python');
    if (!fs.existsSync(cfgPath) || !fs.existsSync(homeDir)) return false;
    const cur = fs.readFileSync(cfgPath, 'utf8');
    const want = `home = ${homeDir}`;
    if (cur.split(/\r?\n/).some((l) => l.trim() === want.trim())) return true;
    const next = cur.replace(/^home\s*=.*$/m, want);
    if (next !== cur) { fs.writeFileSync(cfgPath, next); return true; }
    return true;
  } catch (e) { return false; }
}

function acePython(rt) {
  const py = process.platform === 'win32'
    ? path.join(rt, 'venv', 'Scripts', 'python.exe')
    : path.join(rt, 'venv', 'bin', 'python');
  return fs.existsSync(py) ? py : null;
}

/**
 * Ensure an ACE-Step server is reachable. Order:
 *   1. an external ACE at aceUrl (or 127.0.0.1:8001) already up → done
 *   2. bundled runtime present → bootstrap + spawn it on the default port
 * Returns { ok, url, source: 'external'|'bundled'|'none', error? }.
 */
async function ensureAceServer(rootDir, resourcesPath, opts = {}) {
  const url = opts.aceUrl || `http://127.0.0.1:${ACE_PORT_DEFAULT}`;
  if (await httpProbe(`${url}/health`)) return { ok: true, url, source: 'external' };

  const rt = findRuntime(rootDir, resourcesPath);
  if (!rt) {
    const ar = findRuntimeArchive(resourcesPath);
    if (!ar) return { ok: false, url, source: 'none', error: 'no bundled music runtime and no external ACE server' };
    const extractErr = await extractRuntimeArchive(ar.archive, ar.pythonExe, ar.destDir);
    if (extractErr) return { ok: false, url, source: 'none', error: extractErr };
  }
  const runtime = rt || findRuntime(rootDir, resourcesPath);
  if (!runtime) return { ok: false, url, source: 'none', error: 'music runtime archive extracted but runtime still not found' };

  const py = acePython(runtime);
  if (!py) return { ok: false, url, source: 'none', error: `bundled runtime incomplete (no venv python): ${runtime}` };
  bootstrapVenv(runtime);

  if (opts.modelsDir) {
    try { fs.mkdirSync(opts.modelsDir, { recursive: true }); } catch (e) {}
  }
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    ACESTEP_CONFIG_PATH: 'acestep-v15-turbo',
    ACESTEP_LM_MODEL_PATH: 'acestep-5Hz-lm-1.7B',
    ACESTEP_LM_BACKEND: 'pt',
    ACESTEP_DEVICE: 'auto',
    ACESTEP_INIT_LLM: 'auto',
    ACESTEP_NO_INIT: 'true',
    ACESTEP_CHECKPOINTS_DIR: opts.modelsDir || path.join(runtime, 'checkpoints'),
    PORT: String(ACE_PORT_DEFAULT),
  };
  aceProc = spawn(py, ['ace/api_server.py'], {
    cwd: path.join(runtime, 'ace'),
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  aceProc.stdout.on('data', () => {});
  aceProc.stderr.on('data', () => {});
  aceProc.on('exit', () => { aceProc = null; });

  // server binds fast (NO_INIT), model init happens on demand
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await httpProbe(`${url}/health`)) return { ok: true, url, source: 'bundled' };
    if (aceProc === null) break; // died at startup
  }
  return { ok: false, url, source: 'none', error: `bundled ACE server failed to become healthy at ${url}` };
}

function stopAceServer() {
  if (aceProc) {
    try { aceProc.kill(); } catch (e) {}
    aceProc = null;
  }
}

module.exports = { ensureAceServer, stopAceServer, findRuntime, findRuntimeArchive, bootstrapVenv };

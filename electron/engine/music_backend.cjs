/**
 * music_backend.cjs — lifecycle for the BUNDLED ACE-Step music server.
 *
 * The v1.2.0 Windows installers ship the runtime in two pieces (GitHub caps
 * release assets at 2 GiB, and the full env does not fit under one file):
 *   music/python/              — uv-managed standalone CPython (relocatable);
 *                                also the extractor for the runtime archive
 *   Setup-1.2.0.exe            — app + engines only
 *   music-runtime.tar.xz       — release-page asset; the ACE-Step dependency
 *                                env (venv/) + the ACE-Step source tree (ace/)
 *
 * Resolution order on first music use:
 *   1. already-extracted runtime (resources/music or ~/SolframeStudio/music)
 *   2. archive dropped by the user in ~/SolframeStudio/music-runtime.tar.xz
 *      → extracted once into ~/SolframeStudio/music
 *   3. archive bundled in resources (fully-bundled builds)
 *      → extracted once into resources/music
 * Extraction is performed by the bundled python's own tarfile module — no
 * external tools required. A plain install dir (PrivilegesRequired=lowest)
 * is user-writable, but ~/SolframeStudio is writable on every layout, so the
 * user-data variant is the primary fallback path.
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
const os = require('os');
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

function findRuntime(rootDir, resourcesPath, userDataDir) {
  const sub = process.platform === 'win32' ? 'win' : 'linux';
  const candidates = [
    rootDir && path.join(rootDir, 'backend', sub, 'music'),
    // dev on either platform may stage the runtime under its own backend dir
    rootDir && path.join(rootDir, 'backend', 'win', 'music'),
    resourcesPath && path.join(resourcesPath, 'music'),
    userDataDir && path.join(userDataDir, 'music'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'venv'))) return c;
  }
  return null;
}

/** Where users drop the runtime archive they download from the release page. */
function defaultUserDataDir() {
  return path.join(os.homedir(), 'SolframeStudio');
}

/**
 * Packaged-install fallback: the runtime archive plus the extractor python.
 * Archive candidates in order — (1) user-data copy downloaded from the
 * release page, (2) archive bundled under resources. The extracted tree goes
 * next to whichever archive was found; the bundled python/ dir in resources
 * is always the extractor and the venv base interpreter.
 */
function findRuntimeArchive(resourcesPath, userDataDir) {
  userDataDir = userDataDir || defaultUserDataDir();
  const pythonExe = process.platform === 'win32'
    ? path.join(resourcesPath || '', 'music', 'python', 'python.exe')
    : path.join(resourcesPath || '', 'music', 'python', 'bin', 'python');
  const archiveCandidates = [
    path.join(userDataDir, 'music-runtime.tar.xz'),
    resourcesPath && path.join(resourcesPath, 'music-runtime.tar.xz'),
  ];
  for (const archive of archiveCandidates) {
    if (!archive || !fs.existsSync(archive)) continue;
    if (!fs.existsSync(pythonExe)) continue;
    const destDir = path.dirname(archive) === path.resolve(userDataDir)
      ? path.join(userDataDir, 'music')
      : path.join(resourcesPath, 'music');
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
      resolve(ok ? null : `music runtime extraction failed (exit ${code})${err ? ': ' + err.slice(-400) : ''}`);
    });
    p.on('error', (e) => resolve(`music runtime extraction failed to start: ${e.message}`));
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
  const userDataDir = opts.userDataDir || defaultUserDataDir();
  if (await httpProbe(`${url}/health`)) return { ok: true, url, source: 'external' };

  const rt = findRuntime(rootDir, resourcesPath, userDataDir);
  if (!rt) {
    const ar = findRuntimeArchive(resourcesPath, userDataDir);
    if (!ar) {
      return {
        ok: false, url, source: 'none',
        error: `no music runtime found and no music-runtime.tar.xz in ${userDataDir} — download it from the release page and drop it there`,
      };
    }
    const extractErr = await extractRuntimeArchive(ar.archive, ar.pythonExe, ar.destDir);
    if (extractErr) return { ok: false, url, source: 'none', error: extractErr };
  }
  const runtime = rt || findRuntime(rootDir, resourcesPath, userDataDir);
  if (!runtime) return { ok: false, url, source: 'none', error: 'music runtime archive extracted but runtime still not found' };

  const py = acePython(runtime);
  if (!py) return { ok: false, url, source: 'none', error: `bundled runtime incomplete (no venv python): ${runtime}` };
  // venv base interpreter: inside the runtime if extracted next to a bundled
  // python/, otherwise the extractor python under resources
  const venvPythonDir = fs.existsSync(path.join(runtime, 'python'))
    ? path.join(runtime, 'python')
    : path.join(resourcesPath, 'music', 'python');
  bootstrapVenv(runtime, venvPythonDir);

  if (opts.modelsDir) {
    try { fs.mkdirSync(opts.modelsDir, { recursive: true }); } catch (e) {}
  }
  // entry point: the staged tree may carry api_server.py at the repo root
  // or inside the acestep package — resolve whichever exists instead of
  // hard-coding a layout (a wrong guess makes the server die at spawn)
  const aceDir = path.join(runtime, 'ace');
  const aceEntry = [
    path.join(aceDir, 'api_server.py'),
    path.join(aceDir, 'acestep', 'api_server.py'),
  ].find((p) => fs.existsSync(p));
  if (!aceEntry) {
    return { ok: false, url, source: 'none', error: `ACE entry point not found under ${aceDir}` };
  }

  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    // the acestep package lives at the root of the staged ace tree; the
    // script's own dir is not enough for `import acestep` when the entry
    // sits inside the package
    PYTHONPATH: aceDir,
    ACESTEP_CONFIG_PATH: 'acestep-v15-turbo',
    ACESTEP_LM_MODEL_PATH: 'acestep-5Hz-lm-1.7B',
    ACESTEP_LM_BACKEND: 'pt',
    ACESTEP_DEVICE: 'auto',
    ACESTEP_INIT_LLM: 'auto',
    ACESTEP_NO_INIT: 'true',
    ACESTEP_CHECKPOINTS_DIR: opts.modelsDir || path.join(runtime, 'checkpoints'),
    PORT: String(ACE_PORT_DEFAULT),
  };
  aceProc = spawn(py, [aceEntry], {
    cwd: aceDir,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  aceProc.stdout.on('data', () => {});
  aceProc.stderr.on('data', () => {});
  aceProc.on('exit', () => { aceProc = null; });

  // server binds fast (NO_INIT — weights lazy-load on demand), but cold
  // imports are the real cost: a fresh extraction has no __pycache__, so
  // the first boot compiles the whole stack (~30-60s+). Give it room.
  for (let i = 0; i < 120; i++) {
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

const RUNTIME_ASSET = 'music-runtime.tar.xz';
const REPO_SLUG = 'Protik1810/Solframe-Studio';

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
 * Where the music pipeline stands, for the tab's setup banner:
 *   installed       — extracted runtime already usable
 *   archivePresent  — archive on disk (user-data or bundled), extracts on
 *                     first use
 *   otherwise       — needs the release download (or an import)
 */
function runtimeStatus(rootDir, resourcesPath, opts = {}) {
  const userDataDir = opts.userDataDir || defaultUserDataDir();
  const rt = findRuntime(rootDir, resourcesPath, userDataDir);
  const ar = findRuntimeArchive(resourcesPath, userDataDir);
  const archivePath = ar ? ar.archive : path.join(userDataDir, RUNTIME_ASSET);
  let archiveBytes = 0;
  try { archiveBytes = fs.existsSync(archivePath) ? fs.statSync(archivePath).size : 0; } catch (e) {}
  return {
    installed: !!rt,
    runtimeDir: rt || null,
    archivePresent: !!ar,
    archivePath: ar ? ar.archive : null,
    expectedArchivePath: archivePath,
    archiveBytes,
    destDir: ar ? ar.destDir : path.join(userDataDir, 'music'),
    downloadUrl: releaseDownloadUrl(rootDir),
  };
}

/**
 * Stream the runtime archive from the release page to destPath. Uses Node's
 * own fetch (same stance as the HF downloader — no external curl). Progress
 * is reported through onProgress(received, totalBytes).
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

module.exports = { ensureAceServer, stopAceServer, findRuntime, findRuntimeArchive, bootstrapVenv, defaultUserDataDir, runtimeStatus, downloadRuntimeArchive };

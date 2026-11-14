const http = require('http');
const path = require('path');
const fs = require('fs');

// ─── Shared Engine Modules ────────────────────────────────────────────────────
const {
  getSdCliExecutable: _getSdCliExec,
  getLlamaExecutable: _getLlamaExec,
  resolveModelFullPath
} = require('./engine/pathUtils.cjs');
const { getOutputDir } = require('./engine/sdEngine.cjs');
const { createApiRouter } = require('./engine/apiRoutes.cjs');
const {
  loadCustomScanPaths: userLoadCustomScanPaths,
  saveCustomScanPaths: userSaveCustomScanPaths
} = require('./engine/userSettings.cjs');
const { safeJoin } = require('./engine/security.cjs');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
};
const { handleVideoApi, stopVideoServer } = (() => {
  // In dev, ../video_backend.cjs is the repo root. In a packaged build the
  // relative path resolves inside the asar; the real file ships as an
  // extraResource next to app.asar. Try both, dev layout first.
  const candidates = [
    path.join(__dirname, '..', 'video_backend.cjs'),
    path.join(process.resourcesPath || '', 'video_backend.cjs'),
  ];
  const modPath = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  return require(modPath || candidates[0]);
})();

function createServer(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const resourcesPath = options.resourcesPath || rootDir;
  const distDir = options.distDir || path.join(rootDir, 'dist');
  const publicDir = options.publicDir || path.join(rootDir, 'public');
  const port = options.port || 1420;

  // Custom scan paths persist via userSettings (~/.solframe/settings.json),
  // not next to the app: in a packaged build the app is a single asar
  // archive, so the old "<app>/models/custom_paths.json" write always
  // failed with ENOTDIR — silently, because the API still returned success.
  const loadCustomScanPaths = () => userLoadCustomScanPaths();
  const saveCustomScanPaths = pathsList => userSaveCustomScanPaths(pathsList);

  const userHome = process.env.USERPROFILE || process.env.HOME || '';
  const cacheFilePaths = {
    globalCacheDir: path.join(userHome, '.solframe'),
    globalCacheFile: path.join(userHome, '.solframe', 'scan_cache.json'),
    // No second copy inside the app bundle — same ENOTDIR problem, and the
    // global cache above already covers every platform.
    localCacheFile: null
  };

  const userOutputsDir = getOutputDir(publicDir);

  const apiRouter = createApiRouter({
    rootDir,
    resourcesPath,
    port,
    getSdCliExecutable: () => _getSdCliExec({ rootDir, resourcesPath }),
    getLlamaExecutable: () => _getLlamaExec({ rootDir, resourcesPath }),
    resolveModel: p => resolveModelFullPath(p, rootDir, loadCustomScanPaths()),
    loadCustomScanPaths,
    saveCustomScanPaths,
    userOutputsDir,
    cacheFilePaths
  });
  apiRouter.init();

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, 'http://localhost');

    // ─── Video Generation API (Solframe video server on 8766) ───────────────
    if (parsedUrl.pathname.startsWith('/api/video')) {
      return handleVideoApi(req, res, { rootDir, resourcesPath });
    }

    const handled = await apiRouter.handle(req, res, parsedUrl);
    if (handled) return;

    // ─── Static File Serving (dist/ and public/) ─────────────────────────────
    const pathname = parsedUrl.pathname;
    let requestedFile = pathname === '/' ? '/index.html' : pathname;

    // requestedFile comes straight from the request URL — WHATWG URL
    // parsing already normalizes "..", "%2e%2e", and similar tricks out of
    // pathname before we ever see it, so this is safe today regardless, but
    // safeJoin is what every other request-driven path in this codebase
    // uses and costs nothing here.
    // /outputs/* is handled by apiRouter above (shared with dev mode) and
    // already returned by this point if matched — this is publicDir/distDir
    // static assets and SPA fallback only.
    let filePath;
    try {
      // safeJoin resolves a leading "/" as a Windows drive-root anchor
      // (path.resolve(base, "/x") discards base entirely) — strip it so
      // the segment is relative to publicDir/distDir like it should be.
      const relFile = requestedFile.replace(/^\/+/, '');
      // Check public directory (themes, icons)
      filePath = safeJoin(publicDir, relFile);
      if (!fs.existsSync(filePath)) {
        filePath = safeJoin(distDir, relFile);
      }
      // Fallback to index.html for SPA client-side routing
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(distDir, 'index.html');
      }
    } catch (e) {
      filePath = path.join(distDir, 'index.html');
    }

    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    } else {
      res.statusCode = 404;
      res.end('Not Found');
    }
  });

  return {
    server,
    listen: (listenPort, callback) => server.listen(listenPort || port, '127.0.0.1', callback),
    close: cb => {
      apiRouter.dispose();
      stopVideoServer();
      server.close(cb);
    }
  };
}

module.exports = { createServer };

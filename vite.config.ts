import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

// Dev-mode backend. This wires the same electron/engine/*.cjs modules and the
// same apiRoutes.cjs request handler used by electron/server.cjs in the
// packaged app — there is exactly one implementation of the API, shared by
// both `npm run dev` and the production Electron build.
function sdCppBackendPlugin() {
  const rootDir = process.cwd();
  const publicDir = path.join(rootDir, 'public');
  const port = 1420;

  const { getSdCliExecutable, getLlamaExecutable, resolveModelFullPath } = require('./electron/engine/pathUtils.cjs');
  const { getOutputDir } = require('./electron/engine/sdEngine.cjs');
  const { createApiRouter } = require('./electron/engine/apiRoutes.cjs');

  // Same persistence as the packaged app — see userSettings.cjs for why
  // these can't live next to the app.
  const { loadCustomScanPaths, saveCustomScanPaths } = require('./electron/engine/userSettings.cjs');

  const userHome = process.env.USERPROFILE || process.env.HOME || '';
  const cacheFilePaths = {
    globalCacheDir: path.join(userHome, '.solframe'),
    globalCacheFile: path.join(userHome, '.solframe', 'scan_cache.json'),
    localCacheFile: null
  };

  const userOutputsDir = getOutputDir(publicDir);

  const apiRouter = createApiRouter({
    rootDir,
    resourcesPath: rootDir,
    port,
    getSdCliExecutable: () => getSdCliExecutable({ rootDir, resourcesPath: rootDir }),
    getLlamaExecutable: () => getLlamaExecutable({ rootDir, resourcesPath: rootDir }),
    resolveModel: (p: string) => resolveModelFullPath(p, rootDir, loadCustomScanPaths()),
    loadCustomScanPaths,
    saveCustomScanPaths,
    userOutputsDir,
    cacheFilePaths,
    isDev: true
  });

  return {
    name: 'sd-cpp-backend-plugin',
    configureServer(server: any) {
      apiRouter.init();
      // ─── Video Generation API (Solframe video server on 8766) ──────────────
      const { handleVideoApi: handleVideoApiFn } = require('./video_backend.cjs');
      server.middlewares.use((req: any, res: any, next: any) => {
        if (req.url && req.url.startsWith('/api/video')) {
          return handleVideoApiFn(req, res, { rootDir, resourcesPath: rootDir });
        }
        next();
      });
      server.middlewares.use(async (req: any, res: any, next: any) => {
        const parsedUrl = new URL(req.url, `http://localhost:${port}`);
        const handled = await apiRouter.handle(req, res, parsedUrl);
        if (!handled) next();
      });
    }
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), sdCppBackendPlugin()],
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    // /llama-api has no proxy entry here on purpose: apiRoutes.cjs's own
    // dynamic-port proxy (registered directly in configureServer above,
    // which runs before Vite's built-in proxy middleware) already handles
    // it in both dev and production — a hardcoded-port entry here would be
    // dead code that also can't follow the engine to whatever port it
    // actually started on.
  },
  envPrefix: ['VITE_', 'TAURI_'],
})

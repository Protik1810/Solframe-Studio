const { app, BrowserWindow, shell, Menu, session } = require("electron");
const path = require("path");
const fs = require("fs");
const { createServer } = require("./server.cjs");

const PORT = 1420;
let mainWindow = null;
let splashWindow = null;
let appServer = null;

function getPaths() {
  const isPackaged = app.isPackaged;
  let rootDir = path.join(__dirname, "..");
  let resourcesPath = rootDir;
  let distDir = path.join(rootDir, "dist");
  let publicDir = path.join(rootDir, "public");

  if (isPackaged) {
    resourcesPath = process.resourcesPath;
    // This build has asar:true with no asarUnpack, so the app's own code
    // (package.json, electron/, dist/, public/) lives packed inside
    // resources/app.asar — there is no physical resources/app/ directory.
    // Electron transparently virtualizes fs/require calls for paths that
    // include the ".asar" segment, so rootDir has to name that segment
    // explicitly. Without it (verified live: a real, reproducible crash on
    // both Windows and Linux packaged builds), every launch's automatic
    // /api/check-update call threw "Cannot find module .../resources/app/
    // package.json" as an unhandled rejection — engine-spawning happened to
    // survive this same bug only because pathUtils.cjs's executable finders
    // also try resourcesPath directly as a fallback candidate; this
    // particular require() had no such fallback.
    rootDir = path.join(process.resourcesPath, "app.asar");
    distDir = path.join(__dirname, "..", "dist");
    publicDir = path.join(__dirname, "..", "public");
    if (!fs.existsSync(distDir)) {
      distDir = path.join(process.resourcesPath, "app.asar", "dist");
    }
    if (!fs.existsSync(publicDir)) {
      publicDir = path.join(process.resourcesPath, "app.asar", "public");
    }
  }

  return { rootDir, resourcesPath, isPackaged, distDir, publicDir };
}

function createSplashWindow() {
  const { publicDir } = getPaths();
  const iconPath = path.join(publicDir, "logo.png");

  // The splash page is itself a data: URL, which Chromium gives an opaque
  // origin — such a page is not allowed to pull in file:// subresources, so
  // the old <img src="file://…/logo.png"> always rendered as a broken-image
  // icon (in dev and packaged alike; in a packaged build the path also
  // points inside the asar archive). Inlining the bytes sidesteps both
  // problems, and falls back to the ✨ glyph if the file is missing.
  let iconUrl = "";
  try {
    iconUrl = "data:image/png;base64," + fs.readFileSync(iconPath).toString("base64");
  } catch (e) {
    console.warn(`[Solframe] Splash logo unavailable (${iconPath}): ${e.message}`);
  }

  splashWindow = new BrowserWindow({
    width: 460,
    height: 300,
    frame: false,
    center: true,
    alwaysOnTop: true,
    backgroundColor: "#050810",
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  splashWindow.loadURL("data:text/html," + encodeURIComponent(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"/></head>
    <body style="margin:0;background:radial-gradient(circle at center, #0f172a 0%, #050810 100%);display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:'Segoe UI',system-ui,sans-serif;color:#f8fafc;user-select:none;-webkit-app-region:drag;overflow:hidden;border:1px solid rgba(255,255,255,0.1);border-radius:14px;">
      ${iconUrl ? '<img src="' + iconUrl + '" style="width:78px;height:78px;border-radius:18px;margin-bottom:14px;box-shadow:0 0 25px rgba(6,182,212,0.4);border:1px solid rgba(255,255,255,0.2);">' : '<div style="font-size:52px;margin-bottom:12px;">✨</div>'}
      <h1 style="font-size:22px;font-weight:800;letter-spacing:-0.02em;margin:0 0 4px;background:linear-gradient(135deg,#22d3ee 0%,#a855f7 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">Solframe Studio</h1>
      <p style="color:#64748b;font-size:12px;font-weight:500;margin:0 0 20px;letter-spacing:0.06em;text-transform:uppercase;">Generative AI &bull; FLUX &bull; LLM</p>
      <div style="width:180px;height:3px;background:rgba(255,255,255,0.08);border-radius:99px;overflow:hidden;">
        <div id="bar" style="width:35%;height:100%;background:linear-gradient(90deg,#06b6d4,#8b5cf6);border-radius:99px;transition:width 0.25s;"></div>
      </div>
      <p id="msg" style="color:#475569;font-size:11px;margin-top:10px;">Initializing neural engines...</p>
      <script>
        let w=35;setInterval(()=>{w=Math.min(95,w+Math.random()*6);document.getElementById("bar").style.width=w+"%";},300);
      </script>
    </body>
    </html>
  `));
}

function createMainWindow() {
  const { publicDir } = getPaths();
  const iconPath = path.join(publicDir, "solframe-icon.png");

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 700,
    center: true,
    title: "Solframe Studio",
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: "#050810",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  Menu.setApplicationMenu(null);

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

  mainWindow.once("ready-to-show", () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
    mainWindow.show();
    mainWindow.focus();
  });

  // Substring checks like url.includes("localhost") are trivially spoofed
  // (e.g. https://evil.com/?x=127.0.0.1, https://localhost.evil.com/) and
  // would let a malicious page open a new BrowserWindow pointed at itself
  // instead of routing to the OS's default browser. Compare the parsed
  // origin instead.
  function isOwnOrigin(url) {
    try {
      const { protocol, hostname, port } = new URL(url);
      return protocol === "http:" && (hostname === "127.0.0.1" || hostname === "localhost") && port === String(PORT);
    } catch (e) {
      return false;
    }
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http") && !isOwnOrigin(url)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  // Electron security checklist #13: without this, anything that gets the
  // main window itself to navigate (a compromised remote page, a malicious
  // deep link) would load arbitrary content in the app's own window instead
  // of being routed out to the default browser.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isOwnOrigin(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Solframe Studio has no legitimate use for camera, microphone, geolocation,
// or notifications — it's an offline local image/LLM tool. Deny every
// permission request/check outright rather than leaving Electron's default
// (which varies by permission type, and for some prompts the user) in
// place, since the app's own UI never needs to ask for any of these.
function installPermissionHandlers() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
}

// ── OTA updates (electron-updater, GitHub releases) ─────────────────────────
// Packaged builds only. Checks GitHub releases silently at startup and every
// 6h, downloads in the background, and applies on the next app restart
// (autoInstallOnAppQuit). The existing /api/check-update About-page notice
// keeps its manual-download flow; this layer is the unattended path.
function setupAutoUpdater() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (e) {
    console.log(`[Solframe OTA] updater unavailable, skipping: ${e.message}`);
    return;
  }
  autoUpdater.logger = console;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[Solframe OTA] v${info.version} downloaded — applies on next restart`);
  });
  autoUpdater.on("error", (e) => {
    console.log(`[Solframe OTA] check failed: ${(e && e.message) || e}`);
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 15000); // after the engine boots
  setInterval(check, 6 * 60 * 60 * 1000);
}

app.whenReady().then(() => {
  installPermissionHandlers();
  createSplashWindow();

  const paths = getPaths();
  console.log("[Solframe Desktop] Initializing standalone engine with paths:", paths);

  appServer = createServer({ ...paths, port: PORT });
  appServer.listen(PORT, () => {
    console.log(`[Solframe Desktop] Engine listening on http://127.0.0.1:${PORT}`);
    createMainWindow();
    setupAutoUpdater();
  });
});

app.on("window-all-closed", () => {
  if (appServer) {
    try { appServer.close(); } catch (e) {}
    appServer = null;
  }
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on("before-quit", () => {
  if (appServer) {
    try { appServer.close(); } catch (e) {}
    appServer = null;
  }
});
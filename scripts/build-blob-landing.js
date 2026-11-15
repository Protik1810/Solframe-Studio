const fs = require('fs');
const path = require('path');

console.log('🔄 Copying assets alongside the showcase page...');

const rootDir = path.resolve(__dirname, '..');
const docsDir = path.join(rootDir, 'docs');
const SITE_BASE_URL = 'https://protik1810.github.io/Solframe-Studio/';
const VERSION = require(path.join(rootDir, 'package.json')).version;

// Wipe docs/ before regenerating — otherwise a renamed/removed source asset
// (e.g. the screenshots switching from .png to .webp) leaves its old file
// behind forever, since copyAsset only ever adds files, never removes them.
fs.rmSync(docsDir, { recursive: true, force: true });

// Base64-inlining every asset used to make this a genuinely single-file
// page, but it also made the page ~15MB — well past the size cap most
// link-preview crawlers (confirmed: opengraph.xyz's 5MB limit, and very
// likely WhatsApp/Facebook's) enforce before they'll even attempt to read
// og:* tags, regardless of how early those tags appear in the document.
// Copying assets as real sibling files keeps this a single generated
// output directory while letting the actual index.html stay small.
const copyAsset = (relPath, destSubpath) => {
  const src = path.join(rootDir, relPath);
  if (!fs.existsSync(src)) return '';
  const dest = path.join(docsDir, destSubpath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return destSubpath.replace(/\\/g, '/');
};

const logoUrl = copyAsset('public/logo.png', 'logo.png');
const faviconUrl = copyAsset('public/favicon.png', 'favicon.png');
// v1.2.0 media: "Night Compile" background track + the 6s ambient brand loop,
// both generated locally by Solframe's own music and video engines.
const audioUrl = copyAsset('public/audio/night_compile.mp3', 'audio/night_compile.mp3');
const videoLoopUrl = copyAsset('public/video/solframe-brand-loop.mp4', 'video/solframe-brand-loop.mp4');
// The footer links to these by relative path — without copying them here,
// they 404 on the live site since docs/ never had them.
copyAsset('LICENSE', 'LICENSE');
copyAsset('TERMS.md', 'TERMS.md');

const REPO_URL = 'https://github.com/Protik1810/Solframe-Studio';
const RELEASE_BASE = `${REPO_URL}/releases/download/v${VERSION}`;

// Real app screenshots, mapped onto the template's 5 carousel slides in
// their existing display order (FLUX synthesis / canvas / LLM chat / live
// sampling / completed render).
const screenshots = {
  SCREENSHOT_1: copyAsset('public/screenshots/showcase-lion-artwork.webp', 'screenshots/showcase-lion-artwork.webp'),
  SCREENSHOT_2: copyAsset('public/screenshots/studio-image-canvas.webp', 'screenshots/studio-image-canvas.webp'),
  SCREENSHOT_3: copyAsset('public/screenshots/llm-chat-studio.webp', 'screenshots/llm-chat-studio.webp'),
  SCREENSHOT_4: copyAsset(
    'public/screenshots/sampling-progress-step16.webp',
    'screenshots/sampling-progress-step16.webp'
  ),
  SCREENSHOT_5: copyAsset(
    'public/screenshots/sampling-progress-step44.webp',
    'screenshots/sampling-progress-step44.webp'
  )
};

// Per-theme art (hero backdrop, showcase backdrop, brand emblem) — each of
// the 6 themes gets all three, generated to match that theme's own palette.
const THEME_KEYS = ['dark-void', 'neon-cyber', 'cinema-gold', 'synthwave', 'anime-fantasy', 'emerald-matrix'];
const themeAssets = {};
for (const key of THEME_KEYS) {
  themeAssets[`HERO_${key}`] = copyAsset(`public/themes/hero/${key}.webp`, `themes/hero/${key}.webp`);
  themeAssets[`SHOWCASE_${key}`] = copyAsset(`public/themes/showcase/${key}.webp`, `themes/showcase/${key}.webp`);
  themeAssets[`EMBLEM_${key}`] = copyAsset(`public/themes/emblem/${key}.webp`, `themes/emblem/${key}.webp`);
}

console.log('✅ All assets copied successfully!');

// docs/index.html is a build artifact, not a committed file — it's gitignored,
// and .github/workflows/pages.yml runs this exact script during deploy so the
// live site is always built fresh from source. Run it locally only to preview
// (see scripts/build-product-page.js) or to eyeball a change before pushing.
// Root index.html is the separate Vite/Electron app entry point (loads
// src/main.tsx) and must never be overwritten with this marketing page again —
// doing so silently breaks `npm run build`/`electron:build` (see git history).
//
// The page itself lives in scripts/landing-template.html as plain static
// HTML/CSS/JS with {{PLACEHOLDER}} tokens — keeping it a real, reviewable
// file instead of a giant JS template literal. This script's only job is to
// copy the real assets those placeholders point at and substitute them in.
let html = fs.readFileSync(path.join(__dirname, 'landing-template.html'), 'utf8');

/**
 * SHA-256 for each download, read straight out of CHECKSUMS.txt so the page
 * cannot drift from the file that actually ships. The installers are
 * unsigned, so this is the only way a visitor can tell they got the real
 * binary — printing it on the card beats hiding it behind a collapsed
 * "verify your download" section almost nobody opened.
 *
 * Missing entries are a hard error rather than a blank card: silently
 * shipping a download with no checksum is exactly the failure this is
 * meant to prevent.
 */
function checksumTokens() {
  const checksumsFile = path.join(__dirname, '..', 'CHECKSUMS.txt');
  const text = fs.readFileSync(checksumsFile, 'utf8');
  const byFile = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([a-f0-9]{64})\s+\*?(.+?)\s*$/i);
    if (m) byFile.set(m[2], m[1].toLowerCase());
  }

  const wanted = {
    SHA_WIN_COMPLETE: `Solframe-Studio-Setup-${VERSION}.exe`,
    SHA_LINUX_DEB: `solframe-studio_${VERSION}_amd64.deb`,
    SHA_LINUX_APPIMAGE: `Solframe-Studio-${VERSION}.AppImage`,
    SHA_MAC_DMG_ARM64: `Solframe-Studio-${VERSION}-arm64.dmg`
  };

  const tokens = {};
  const missing = [];
  for (const [token, filename] of Object.entries(wanted)) {
    const sha = byFile.get(filename);
    if (!sha) missing.push(filename);
    else tokens[token] = sha;
  }
  if (missing.length) {
    throw new Error(
      `CHECKSUMS.txt has no SHA-256 for: ${missing.join(', ')} — regenerate it for v${VERSION} before building the landing page.`
    );
  }
  return tokens;
}

const replacements = {
  SITE_BASE_URL,
  FAVICON_URL: faviconUrl,
  OG_IMAGE_URL: `${SITE_BASE_URL}${logoUrl}`,
  AUDIO_NIGHT_COMPILE: audioUrl,
  VIDEO_BRAND_LOOP: videoLoopUrl,
  // electron-builder's productName ("Solframe Studio") has a space, and
  // GitHub replaces spaces with dots when it sanitizes uploaded release
  // asset filenames (confirmed against the real uploaded assets: "Solframe
  // Studio-1.1.0.AppImage" -> "Solframe.Studio-1.1.0.AppImage"). Windows
  // and .deb artifactNames are explicitly hyphenated already, so they never
  // had a space to begin with and are unaffected. A prior fix (f6c0e79)
  // corrected the stale names in RELEASE_NOTES.md/CHECKSUMS.txt but missed
  // this file — the actual generator for the live download buttons — so
  // the Linux AppImage and macOS zip buttons were 404ing on the real site.
  DOWNLOAD_WIN_COMPLETE: `${RELEASE_BASE}/Solframe-Studio-Setup-${VERSION}.exe`,
  DOWNLOAD_LINUX_DEB: `${RELEASE_BASE}/solframe-studio_${VERSION}_amd64.deb`,
  DOWNLOAD_LINUX_APPIMAGE: `${RELEASE_BASE}/Solframe-Studio-${VERSION}.AppImage`,
  DOWNLOAD_MAC_DMG_ARM64: `${RELEASE_BASE}/Solframe-Studio-${VERSION}-arm64.dmg`,
  // The arm64 build has shipped as a real release asset since v1.1.0 but
  // was never linked anywhere on the page — every Mac visitor, including
  // Apple Silicon ones, was served the Intel x64 zip. The auto-detect logic
  // in landing-template.html already computed "Apple Silicon" vs "Universal"
  // for display, it just pointed both labels at the same single download.
  DOWNLOAD_MAC_ZIP_ARM64: `${RELEASE_BASE}/Solframe.Studio-${VERSION}-arm64-mac.zip`,
  ...checksumTokens(),
  ...screenshots,
  ...themeAssets
};

for (const [token, value] of Object.entries(replacements)) {
  html = html.split(`{{${token}}}`).join(value);
}

const remaining = html.match(/\{\{[A-Za-z0-9_-]+\}\}/g);
if (remaining) {
  throw new Error(`landing-template.html has unresolved placeholders: ${[...new Set(remaining)].join(', ')}`);
}

if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
fs.writeFileSync(path.join(docsDir, 'index.html'), html, 'utf8');

console.log(
  '✅ Generated docs/index.html + copied assets (themes/, screenshots/, logo.png, favicon.png, LICENSE, TERMS.md)!'
);
console.log(
  '   This is a gitignored build output — push to main and the Pages workflow regenerates + deploys it automatically.'
);

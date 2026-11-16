const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const rootDir = path.resolve(__dirname, '..');
const unpackedExe = path.join(rootDir, 'release', 'win-unpacked', 'Solframe Studio.exe');
const { version } = require(path.join(rootDir, 'package.json'));

if (!fs.existsSync(unpackedExe)) {
  console.log('📦 release/win-unpacked not found — building it with electron-builder first...');
  execSync('npm run electron:pack', { cwd: rootDir, stdio: 'inherit' });
}

// Resolve ISCC.exe without hardcoding one machine's install path: an
// ISCC_PATH env var wins if set, then PATH (works if Inno Setup's install
// added itself, or a CI step does), then the two standard install
// locations Inno Setup's own installer offers.
function resolveIscc() {
  if (process.env.ISCC_PATH && fs.existsSync(process.env.ISCC_PATH)) {
    return process.env.ISCC_PATH;
  }
  try {
    const fromPath = execSync('where ISCC.exe', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split(/\r?\n/)[0]
      .trim();
    if (fromPath && fs.existsSync(fromPath)) return fromPath;
  } catch (e) {
    // not on PATH — fall through to the standard install locations
  }
  const standardLocations = [
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
    // winget's default (non-elevated) install location — confirmed this is
    // where `winget install JRSoftware.InnoSetup` actually puts it when run
    // without admin rights, which the two Program Files paths above miss.
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe')
  ];
  return standardLocations.find((p) => fs.existsSync(p)) || null;
}

const isccPath = resolveIscc();
const issComplete = path.resolve(__dirname, '../installer.iss');
const issLightweight = path.resolve(__dirname, '../installer-lightweight.iss');

// --lightweight-only: kept for CI parity checks. The release ships ONE
// Windows download (the Complete installer) per the v1.2.0 packaging policy —
// Lightweight and Portable variants are no longer published.
const lightweightOnly = process.argv.includes('--lightweight-only');

if (!isccPath) {
  console.error('ISCC compiler not found on PATH, via ISCC_PATH, or at a standard Inno Setup install location.');
  console.error('Install Inno Setup (https://jrsoftware.org/isinfo.php), or set ISCC_PATH to its ISCC.exe.');
  process.exit(1);
}

if (!lightweightOnly) {
  console.log(`\n🔨 Compiling Complete Solframe Studio Setup Installer v${version} (.exe)...`);
  execSync(`"${isccPath}" "/DMyAppVersion=${version}" "${issComplete}"`, { stdio: 'inherit' });
  console.log(`🎉 Installer generated at: installer-output/Solframe-Studio-Setup-${version}.exe`);
} else {
  console.log(`\n🔨 Compiling Lightweight Solframe Studio Setup Installer v${version} (.exe)...`);
  execSync(`"${isccPath}" "/DMyAppVersion=${version}" "${issLightweight}"`, { stdio: 'inherit' });
  console.log(
    `🎉 Lightweight Installer generated at: installer-output/Solframe-Studio-Setup-${version}-Lightweight.exe`
  );
}

console.log(
  `\n✅ ${lightweightOnly ? 'Lightweight installer' : 'Installer'} successfully compiled and ready in installer-output/!`
);

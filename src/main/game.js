// Finds BONELAB on this PC (Steam or Meta) and launches it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const STEAM_APPID = '1592190';
const STEAM_EXE = 'BONELAB_Steam_Windows64.exe';
const META_EXE = 'BONELAB_Oculus_Windows64.exe';
const META_FOLDER = 'stress-level-zero-inc-bonelab';

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

async function findSteam() {
  const out = await run('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
  const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/);
  const roots = [];
  if (m) roots.push(path.normalize(m[1].trim()));
  roots.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam');

  for (const root of roots) {
    if (!exists(root)) continue;
    const libs = [root];
    try {
      const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const lm of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.push(path.normalize(lm[1].replace(/\\\\/g, '\\')));
    } catch {}
    for (const lib of libs) {
      const manifest = path.join(lib, 'steamapps', `appmanifest_${STEAM_APPID}.acf`);
      if (!exists(manifest)) continue;
      let installDir = 'BONELAB';
      let build = '';
      try {
        const acf = fs.readFileSync(manifest, 'utf8');
        installDir = (acf.match(/"installdir"\s+"([^"]+)"/) || [])[1] || installDir;
        build = (acf.match(/"buildid"\s+"([^"]+)"/) || [])[1] || '';
      } catch {}
      const dir = path.join(lib, 'steamapps', 'common', installDir);
      if (exists(path.join(dir, STEAM_EXE))) {
        const steamExe = path.join(root, 'steam.exe');
        return { platform: 'steam', path: dir, exe: STEAM_EXE, build, steamExe: exists(steamExe) ? steamExe : '' };
      }
    }
  }
  return null;
}

async function findMeta() {
  const out = await run('reg', ['query', 'HKCU\\Software\\Oculus VR, LLC\\Oculus\\Libraries', '/s']);
  const libs = [];
  for (const m of out.matchAll(/OriginalPath\s+REG_SZ\s+(.+)/g)) libs.push(m[1].trim());
  libs.push('C:\\Program Files\\Oculus\\Software', 'C:\\Program Files\\Meta Horizon\\Software');
  for (const lib of libs) {
    for (const dir of [path.join(lib, 'Software', META_FOLDER), path.join(lib, META_FOLDER)]) {
      if (exists(path.join(dir, META_EXE))) return { platform: 'meta', path: dir, exe: META_EXE, build: '' };
    }
  }
  return null;
}

function fromFolder(dir) {
  if (!dir) return null;
  if (exists(path.join(dir, STEAM_EXE))) return { platform: 'steam', path: dir, exe: STEAM_EXE, build: '', custom: true };
  if (exists(path.join(dir, META_EXE))) return { platform: 'meta', path: dir, exe: META_EXE, build: '', custom: true };
  return null;
}

const mlVersionCache = new Map();

async function loaderStatus(gamePath) {
  const hasProxy = exists(path.join(gamePath, 'version.dll'));
  const hasFolder = exists(path.join(gamePath, 'MelonLoader'));
  if (!hasProxy || !hasFolder) return { installed: false, version: '' };
  let dll = path.join(gamePath, 'MelonLoader', 'net6', 'MelonLoader.dll');
  if (!exists(dll)) dll = path.join(gamePath, 'MelonLoader', 'net35', 'MelonLoader.dll');
  if (!exists(dll)) return { installed: true, version: '' };
  let stamp = '';
  try {
    stamp = dll + fs.statSync(dll).mtimeMs;
  } catch {}
  if (!mlVersionCache.has(stamp)) {
    const out = await new Promise((resolve) => {
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:BL_DLL).VersionInfo.ProductVersion'],
        { windowsHide: true, env: { ...process.env, BL_DLL: dll } },
        (err, stdout) => resolve(err ? '' : String(stdout))
      );
    });
    mlVersionCache.set(stamp, out.trim());
  }
  return { installed: true, version: cleanVersion(mlVersionCache.get(stamp)) };
}

function cleanVersion(v) {
  const m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : '';
}

async function detect(settings) {
  const [steam, meta] = await Promise.all([findSteam(), findMeta()]);
  const installs = [steam, meta].filter(Boolean);
  const custom = fromFolder(settings.customGamePath);
  let active = null;
  if (custom) active = custom;
  else if (settings.platform === 'steam') active = steam;
  else if (settings.platform === 'meta') active = meta;
  else active = steam || meta;
  if (active && active.platform === 'steam' && !active.steamExe && steam) active.steamExe = steam.steamExe;
  if (active) active.loader = await loaderStatus(active.path);
  return { installs, active, localLow: localLowMods() };
}

function localLowMods() {
  return path.join(os.homedir(), 'AppData', 'LocalLow', 'Stress Level Zero', 'BONELAB', 'Mods');
}

async function isRunning() {
  const out = await run('tasklist', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq BONELAB*']);
  return /BONELAB_(Steam|Oculus)_Windows64\.exe/i.test(out);
}

function splitArgs(s) {
  const out = [];
  for (const m of String(s || '').matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

function launch(game, settings, opts = {}) {
  const args = [];
  if (opts.noMods) args.push('--no-mods');
  if (settings.hideConsole) args.push('--melonloader.hideconsole');
  if (settings.mlDebug) args.push('--melonloader.debug');
  args.push(...splitArgs(settings.launchArgs));

  const viaSteam = game.platform === 'steam' && game.steamExe && !game.custom;
  const cmd = viaSteam ? game.steamExe : path.join(game.path, game.exe);
  const cmdArgs = viaSteam ? ['-applaunch', STEAM_APPID, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { cwd: path.dirname(cmd), detached: true, stdio: 'ignore' });
    child.once('error', (err) => reject(new Error('Could not start the game: ' + err.message)));
    child.once('spawn', () => {
      child.unref();
      resolve({ via: viaSteam ? 'steam' : 'exe', args });
    });
  });
}

module.exports = { detect, fromFolder, loaderStatus, isRunning, launch, localLowMods, mlVersionCache };

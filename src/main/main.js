const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// Portable build: keep everything in a folder beside the exe.
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
if (portableDir) app.setPath('userData', path.join(portableDir, 'BoneLaunchData'));
if (process.env.BONELAUNCH_DATA) app.setPath('userData', process.env.BONELAUNCH_DATA);

const store = require('./store');
const gameLib = require('./game');
const ts = require('./thunderstore');
const mods = require('./mods');

let win = null;
let game = null; // last detection result

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

function publicSettings() {
  const s = store.getSettings();
  let bgUrl = '';
  if (s.bgImage && fs.existsSync(s.bgImage)) {
    bgUrl = pathToFileURL(s.bgImage).href + '?t=' + Math.round(fs.statSync(s.bgImage).mtimeMs);
  }
  return { ...s, bgUrl };
}

async function detect() {
  game = await gameLib.detect(store.getSettings());
  return game;
}

function needGame() {
  if (!game || !game.active) throw new Error('BONELAB was not found. Pick the game folder in Settings.');
  return game.active;
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

// One mod job at a time, so files never get written by two jobs at once.
let chain = Promise.resolve();
function queued(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

function tempDir() {
  const d = path.join(app.getPath('temp'), 'BoneLaunch');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function depId(dep) {
  return dep.slice(0, dep.lastIndexOf('-'));
}

async function installWithDeps(id, version) {
  const active = needGame();
  const settings = store.getSettings();
  const { list } = await ts.getPackages(false);
  const byId = new Map(list.map((p) => [p.id, p]));
  const loader = await gameLib.loaderStatus(active.path);
  const queue = [];
  const seen = new Set();
  const missing = [];

  (function visit(pid, ver, isRoot) {
    if (seen.has(pid)) return;
    seen.add(pid);
    const p = byId.get(pid);
    if (!p) {
      missing.push(pid);
      return;
    }
    if (!isRoot) {
      if (pid === ts.LOADER_ID ? loader.installed : mods.isTracked(active, pid)) return;
    }
    const v = (ver && p.versions.find((x) => x.v === ver)) || p.versions[0];
    if (settings.installDeps || isRoot) {
      if (settings.installDeps) for (const d of v.deps) visit(depId(d), null, false);
    }
    queue.push({ p, v });
  })(id, version, true);

  const installed = [];
  for (let i = 0; i < queue.length; i++) {
    const { p, v } = queue[i];
    const info = { id: p.id, name: p.name, index: i + 1, count: queue.length };
    const zipPath = path.join(tempDir(), `${p.id}-${v.v}.zip`.replace(/[^\w.\-]/g, '_'));
    try {
      send('progress', { ...info, phase: 'download', done: 0, total: v.size });
      let last = 0;
      await ts.download(v.url, zipPath, (done, total) => {
        const now = Date.now();
        if (now - last > 80) {
          last = now;
          send('progress', { ...info, phase: 'download', done, total: total || v.size });
        }
      });
      send('progress', { ...info, phase: 'install' });
      mods.install(active, { id: p.id, name: p.name, owner: p.owner, version: v.v, icon: p.icon, desc: p.desc }, zipPath);
      installed.push(p.id);
    } finally {
      fs.rm(zipPath, { force: true }, () => {});
    }
  }
  gameLib.mlVersionCache.clear();
  send('progress', { phase: 'done' });
  return { installed, missing };
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      send('progress', { phase: 'done' });
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
}

function registerIpc() {
  handle('app:init', async () => ({
    settings: publicSettings(),
    game: await detect(),
    version: app.getVersion(),
    portable: !!portableDir,
    dataDir: store.dataDir(),
  }));

  handle('settings:set', (patch) => {
    store.setSettings(patch || {});
    return publicSettings();
  });
  handle('settings:reset', () => {
    store.resetSettings();
    return publicSettings();
  });

  handle('game:detect', () => detect());
  handle('game:running', () => gameLib.isRunning());
  handle('game:browse', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Pick your BONELAB folder',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const found = gameLib.fromFolder(r.filePaths[0]);
    if (!found) throw new Error('That folder does not contain BONELAB. Pick the folder with the BONELAB .exe in it.');
    store.setSettings({ customGamePath: r.filePaths[0] });
    return { settings: publicSettings(), game: await detect() };
  });
  handle('game:launch', async (opts) => {
    const active = needGame();
    const settings = store.getSettings();
    const result = await gameLib.launch(active, settings, opts || {});
    if (settings.afterLaunch === 'minimize') win.minimize();
    if (settings.afterLaunch === 'close') setTimeout(() => app.quit(), 1500);
    return result;
  });

  handle('ts:list', (force) => ts.getPackages(!!force));
  handle('ts:readme', (owner, name, version) => ts.getReadme(owner, name, version));

  handle('mods:list', () => mods.list(needGame()));
  handle('mods:install', (id, version) => queued(() => installWithDeps(id, version)));
  handle('mods:uninstall', (id) =>
    queued(async () => {
      const active = needGame();
      if (String(id).startsWith('manual:')) {
        const p = mods.manualPath(active, id);
        for (const f of [p, p + '.disabled']) if (fs.existsSync(f)) await shell.trashItem(f);
      } else {
        mods.uninstall(active, id);
      }
    })
  );
  handle('mods:toggle', (id, enabled) => queued(() => mods.setEnabled(needGame(), id, !!enabled)));
  handle('mods:applyEnabled', (ids) => queued(() => mods.applyEnabled(needGame(), ids || [])));
  handle('mods:installZip', () =>
    queued(async () => {
      const active = needGame();
      const r = await dialog.showOpenDialog(win, {
        title: 'Pick a mod zip',
        properties: ['openFile'],
        filters: [{ name: 'Mod zip', extensions: ['zip'] }],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      const zipPath = r.filePaths[0];
      const manifest = mods.readZipManifest(zipPath) || {};
      const name = String(manifest.name || path.basename(zipPath, '.zip')).slice(0, 80);
      const entry = mods.install(
        active,
        {
          id: 'local-' + name.replace(/[^\w.\-]/g, '_'),
          name,
          owner: 'From a zip file',
          version: String(manifest.version_number || ''),
          icon: '',
          desc: String(manifest.description || 'Installed from a zip file.').slice(0, 300),
          local: true,
        },
        zipPath
      );
      return entry.name;
    })
  );

  handle('ml:uninstall', () =>
    queued(async () => {
      const active = needGame();
      try {
        mods.uninstall(active, ts.LOADER_ID);
        for (const f of ['version.dll', 'dobby.dll']) fs.rmSync(path.join(active.path, f), { force: true });
        fs.rmSync(path.join(active.path, 'MelonLoader'), { recursive: true, force: true });
      } catch (err) {
        throw new Error('Could not remove MelonLoader. Close BONELAB and try again.');
      }
      gameLib.mlVersionCache.clear();
    })
  );

  handle('open:folder', async (key) => {
    const active = key === 'data' || key === 'locallow' ? null : needGame();
    const map = {
      game: () => active.path,
      mods: () => path.join(active.path, 'Mods'),
      plugins: () => path.join(active.path, 'Plugins'),
      userdata: () => path.join(active.path, 'UserData'),
      logs: () => path.join(active.path, 'MelonLoader'),
      locallow: () => gameLib.localLowMods(),
      data: () => store.dataDir(),
    };
    if (!map[key]) throw new Error('Unknown folder.');
    const target = map[key]();
    if (key === 'mods' || key === 'plugins' || key === 'userdata') fs.mkdirSync(target, { recursive: true });
    if (!fs.existsSync(target)) throw new Error('That folder does not exist yet: ' + target);
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
  });
  handle('open:url', async (url) => {
    if (!/^https:\/\//i.test(String(url))) throw new Error('Only https links can be opened.');
    await shell.openExternal(url);
  });

  handle('log:read', () => {
    const f = path.join(needGame().path, 'MelonLoader', 'Latest.log');
    if (!fs.existsSync(f)) return '';
    const size = fs.statSync(f).size;
    const max = 200 * 1024;
    const fd = fs.openSync(f, 'r');
    try {
      const len = Math.min(size, max);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  });

  handle('bg:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Pick a background picture',
      properties: ['openFile'],
      filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const ext = path.extname(r.filePaths[0]).toLowerCase();
    for (const old of fs.readdirSync(store.dataDir())) {
      if (/^background\./.test(old)) fs.rmSync(path.join(store.dataDir(), old), { force: true });
    }
    const dest = path.join(store.dataDir(), 'background' + ext);
    fs.copyFileSync(r.filePaths[0], dest);
    store.setSettings({ bgImage: dest });
    return publicSettings();
  });

  handle('cache:clear', () => {
    ts.clearCache();
    fs.rmSync(tempDir(), { recursive: true, force: true });
  });

  handle('win:min', () => win.minimize());
  handle('win:max', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  handle('win:close', () => win.close());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 980,
    minHeight: 620,
    frame: false,
    show: false,
    backgroundColor: '#07090d',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('maximize', () => send('win:state', { maximized: true }));
  win.on('unmaximize', () => send('win:state', { maximized: false }));
  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(() => {
  store.init(app.getPath('userData'));
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => app.quit());

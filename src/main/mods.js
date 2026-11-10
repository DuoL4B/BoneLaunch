// Puts mods into the game's folders and keeps track of what was put where.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const store = require('./store');
const { localLowMods } = require('./game');
const { LOADER_ID } = require('./thunderstore');

const STATE = 'mods.json';
const TOP_FOLDERS = ['Mods', 'Plugins', 'UserLibs', 'UserData', 'MelonLoader'];
const PACKAGE_FILES = /^(manifest\.json|icon\.png|readme(\..*)?|changelog(\..*)?|license(\..*)?|.*\.md)$/i;
const TOGGLEABLE = /^(game:(Mods|Plugins|UserLibs)\/.+\.dll|local:.+\/pallet\.json)$/i;
const MANUAL_ID = /^manual:(Mods|Plugins)\/[^/\\]+\.dll$/i;

function gameKey(game) {
  return path.resolve(game.path).toLowerCase();
}

function loadAll() {
  return store.read(STATE, {});
}

function load(game) {
  return loadAll()[gameKey(game)] || {};
}

function save(game, mods) {
  const all = loadAll();
  all[gameKey(game)] = mods;
  store.write(STATE, all);
}

function friendly(err) {
  if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
    return new Error('A file is in use or protected. Close BONELAB and try again.');
  }
  return err;
}

// Turns "game:Mods/Thing.dll" into a real path, refusing anything that escapes its folder.
function resolveKey(game, key) {
  const i = key.indexOf(':');
  const kind = key.slice(0, i);
  const rel = key.slice(i + 1);
  const root = path.resolve(kind === 'local' ? localLowMods() : game.path);
  const full = path.resolve(root, rel);
  if (!full.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error('Unsafe path in mod: ' + rel);
  return full;
}

// Decides where each file in a mod zip belongs.
function planRoutes(names, isLoader) {
  const clean = names.map((n) => n.replace(/\\/g, '/').replace(/^\/+/, ''));
  const palletFolders = new Set();
  for (const n of clean) {
    const parts = n.split('/');
    if (parts.length === 2 && parts[1].toLowerCase() === 'pallet.json') palletFolders.add(parts[0]);
  }
  return clean.map((n) => {
    const parts = n.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes(':'))) return null;
    if (parts.length === 1) {
      if (PACKAGE_FILES.test(n)) return null;
      return isLoader ? 'game:' + n : 'game:Mods/' + n;
    }
    const top = TOP_FOLDERS.find((t) => t.toLowerCase() === parts[0].toLowerCase());
    if (top) return 'game:' + [top, ...parts.slice(1)].join('/');
    if (isLoader) return 'game:' + n;
    if (palletFolders.has(parts[0])) return 'local:' + n;
    return 'game:Mods/' + n;
  });
}

function pruneEmptyDirs(game, key) {
  const i = key.indexOf(':');
  const root = path.resolve(key.slice(0, i) === 'local' ? localLowMods() : game.path);
  let dir = path.dirname(resolveKey(game, key));
  while (dir.length > root.length) {
    const rel = path.relative(root, dir);
    if (!rel.includes(path.sep) && TOP_FOLDERS.some((t) => t.toLowerCase() === rel.toLowerCase())) break;
    try {
      if (fs.readdirSync(dir).length) break;
      fs.rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

function removeFiles(game, mods, id) {
  const entry = mods[id];
  if (!entry) return;
  const claimed = new Set();
  for (const [other, e] of Object.entries(mods)) if (other !== id) for (const k of e.files || []) claimed.add(k);
  for (const key of entry.files || []) {
    if (claimed.has(key)) continue;
    let p;
    try {
      p = resolveKey(game, key);
    } catch {
      continue;
    }
    for (const f of [p, p + '.disabled']) {
      try {
        fs.unlinkSync(f);
      } catch (err) {
        if (err.code !== 'ENOENT') throw friendly(err);
      }
    }
    pruneEmptyDirs(game, key);
  }
}

function setFilesEnabled(game, entry, enabled) {
  for (const key of entry.files || []) {
    if (!TOGGLEABLE.test(key)) continue;
    const on = resolveKey(game, key);
    const off = on + '.disabled';
    try {
      if (enabled && fs.existsSync(off)) {
        if (fs.existsSync(on)) fs.unlinkSync(off);
        else fs.renameSync(off, on);
      } else if (!enabled && fs.existsSync(on)) {
        if (fs.existsSync(off)) fs.unlinkSync(off);
        fs.renameSync(on, off);
      }
    } catch (err) {
      throw friendly(err);
    }
  }
}

// meta: { id, name, owner, version, icon, desc }
function install(game, meta, zipPath) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  const isLoader = meta.id === LOADER_ID;
  const routes = planRoutes(entries.map((e) => e.entryName), isLoader);
  const jobs = [];
  entries.forEach((e, i) => {
    if (routes[i]) jobs.push({ entry: e, key: routes[i], dest: resolveKey(game, routes[i]) });
  });
  if (!jobs.length) throw new Error(meta.name + ' has no files BoneLaunch knows how to install.');

  const mods = load(game);
  const prev = mods[meta.id];
  if (prev) removeFiles(game, mods, meta.id);

  try {
    for (const job of jobs) {
      fs.mkdirSync(path.dirname(job.dest), { recursive: true });
      try {
        fs.unlinkSync(job.dest + '.disabled');
      } catch {}
      fs.writeFileSync(job.dest, job.entry.getData());
    }
  } catch (err) {
    throw friendly(err);
  }

  const entry = {
    ...meta,
    files: [...new Set(jobs.map((j) => j.key))],
    enabled: prev ? prev.enabled !== false : true,
    installedAt: Date.now(),
  };
  mods[meta.id] = entry;
  if (!entry.enabled) setFilesEnabled(game, entry, false);
  save(game, mods);
  return entry;
}

function uninstall(game, id) {
  const mods = load(game);
  if (!mods[id]) return;
  removeFiles(game, mods, id);
  delete mods[id];
  save(game, mods);
}

function manualPath(game, id) {
  if (!MANUAL_ID.test(id)) throw new Error('Unknown mod: ' + id);
  return resolveKey(game, 'game:' + id.slice('manual:'.length));
}

function setEnabled(game, id, enabled) {
  if (id.startsWith('manual:')) {
    if (!MANUAL_ID.test(id)) throw new Error('Unknown mod: ' + id);
    setFilesEnabled(game, { files: ['game:' + id.slice('manual:'.length)] }, enabled);
    return;
  }
  const mods = load(game);
  const entry = mods[id];
  if (!entry) throw new Error('That mod is not installed.');
  setFilesEnabled(game, entry, enabled);
  entry.enabled = enabled;
  save(game, mods);
}

function scanManual(game, mods) {
  const tracked = new Set();
  for (const e of Object.values(mods)) for (const k of e.files || []) tracked.add(k.toLowerCase());
  const out = [];
  for (const folder of ['Mods', 'Plugins']) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(game.path, folder));
    } catch {}
    for (const n of names) {
      const m = n.match(/^(.+\.dll)(\.disabled)?$/i);
      if (!m) continue;
      const key = `game:${folder}/${m[1]}`;
      if (tracked.has(key.toLowerCase())) continue;
      out.push({
        id: `manual:${folder}/${m[1]}`,
        name: m[1].replace(/\.dll$/i, ''),
        owner: folder + ' folder',
        version: '',
        icon: '',
        desc: '',
        enabled: !m[2],
        manual: true,
      });
    }
  }
  return out;
}

function list(game) {
  const mods = load(game);
  const tracked = Object.values(mods)
    .filter((e) => e.id !== LOADER_ID)
    .map((e) => {
      const { files, ...rest } = e;
      return { ...rest, fileCount: (files || []).length };
    });
  return [...tracked, ...scanManual(game, mods)];
}

function applyEnabled(game, enabledIds) {
  const want = new Set(enabledIds);
  for (const m of list(game)) {
    if (m.enabled !== want.has(m.id)) setEnabled(game, m.id, want.has(m.id));
  }
}

function readZipManifest(zipPath) {
  try {
    const zip = new AdmZip(zipPath);
    const e = zip.getEntry('manifest.json');
    if (!e) return null;
    return JSON.parse(e.getData().toString('utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function isTracked(game, id) {
  return !!load(game)[id];
}

module.exports = { install, uninstall, setEnabled, list, applyEnabled, readZipManifest, isTracked, manualPath, planRoutes };

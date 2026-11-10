// Small JSON files kept in BoneLaunch's data folder.
const fs = require('fs');
const path = require('path');

let dir = '';

const DEFAULTS = {
  platform: 'auto', // auto | steam | meta
  customGamePath: '',
  launchArgs: '',
  hideConsole: false,
  mlDebug: false,
  afterLaunch: 'stay', // stay | minimize | close
  accent: 'cyan',
  bgImage: '',
  bgDim: 45,
  bgBlur: 0,
  reduceMotion: false,
  view: 'grid',
  showNsfw: false,
  showDeprecated: false,
  hideAi: false,
  checkUpdatesOnStart: true,
  autoUpdateMods: false,
  installDeps: true,
  confirmUninstall: true,
  profiles: {},
  activeProfile: '',
};

function init(d) {
  dir = d;
  fs.mkdirSync(dir, { recursive: true });
}

function file(name) {
  return path.join(dir, name);
}

function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function write(name, data) {
  const f = file(name);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, f);
}

function getSettings() {
  return { ...DEFAULTS, ...read('settings.json', {}) };
}

function setSettings(patch) {
  const next = { ...getSettings(), ...patch };
  write('settings.json', next);
  return next;
}

function resetSettings() {
  write('settings.json', {});
  return getSettings();
}

module.exports = { init, file, read, write, getSettings, setSettings, resetSettings, dataDir: () => dir };

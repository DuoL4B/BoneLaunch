// Dev-only check: starts BoneLaunch against a pretend game folder, clicks
// through the pages, installs a real mod from Thunderstore into the pretend
// folder, and saves screenshots.
// Usage: electron scripts/smoke.js <work-folder> [real]
//   "real" = read-only look at the real game install (no installs).
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const work = path.resolve(process.argv[2] || 'smoke-out');
const real = process.argv[3] === 'real';
const fake = path.join(work, 'game');
const data = path.join(work, real ? 'data-real' : 'data');
fs.mkdirSync(fake, { recursive: true });
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(fake, 'BONELAB_Steam_Windows64.exe'), '');
if (!real) fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ customGamePath: fake }));
process.env.BONELAUNCH_DATA = data;

require('../src/main/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await wait(1500);
  const win = BrowserWindow.getAllWindows()[0];
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name) => fs.writeFileSync(path.join(work, name + '.png'), (await win.webContents.capturePage()).toPNG());
  const click = (sel) => js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'MISSING ${sel}'; e.click(); return 'ok'})()`);
  const log = (...a) => console.log('[smoke]', ...a);
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 3) log('console error:', e.message);
  });

  try {
    for (let i = 0; i < 40 && (await js('document.querySelector("#tb-status").textContent')).includes('Loading'); i++) await wait(500);
    await wait(800);
    log('status:', await js('document.querySelector("#tb-status").textContent'));
    log('platform:', await js('(document.querySelector(".platform")||{}).textContent'));
    await shot('1-home');

    await click('[data-page="browse"]');
    await wait(1200);
    log('browse count:', await js('document.querySelector("#browse-count").textContent'));
    await shot('2-browse');

    if (!real) {
      await js(`(()=>{const i=document.querySelector('[data-input="browse-q"]'); i.value='BoneLib'; i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await wait(600);
      log('open card:', await click('.card[data-id="bonelib-BoneLib"]'));
      await wait(1500);
      await shot('3-drawer');
      log('install:', await click('#drawer [data-action="install"]'));
      await wait(700);
      await shot('4-installing');
      for (let i = 0; i < 240 && !(await js('document.querySelector("#jobbar").hidden')); i++) await wait(500);
      await wait(1500);
      await click('[data-action="close-drawer"]');
      await click('[data-page="installed"]');
      await wait(800);
      await shot('5-installed');
      log('rows:', await js('document.querySelectorAll(".row").length'));
      log('toggle off:', await click('.row input[data-toggle]'));
      await wait(900);
      log('Mods folder:', fs.readdirSync(path.join(fake, 'Mods')).join(', '));
      log('toggle on:', await click('.row input[data-toggle]'));
      await wait(900);
      log('Mods folder:', fs.readdirSync(path.join(fake, 'Mods')).join(', '));
      log('game folder:', fs.readdirSync(fake).join(', '));
    } else {
      await click('[data-page="installed"]');
      await wait(800);
      await shot('5-installed-real');
      log('rows:', await js('document.querySelectorAll(".row").length'));
    }

    await click('[data-page="profiles"]');
    await wait(500);
    await shot('6-profiles');
    await click('[data-page="settings"]');
    await wait(500);
    await shot('7-settings');
    await js('document.querySelector("#main").scrollTop = 900');
    await wait(400);
    await shot('8-settings-2');
    await click('[data-page="home"]');
    await wait(900);
    await shot('9-home-after');
    log('toasts:', await js('[...document.querySelectorAll(".toast")].map(t=>t.textContent).join(" | ")'));
  } catch (err) {
    log('FAILED', err);
  }
  app.exit(0);
});

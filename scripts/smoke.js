// Dev-only check: starts the built BoneLaunch against a pretend game folder,
// clicks through the pages, installs a real mod from Thunderstore into the
// pretend folder, and saves screenshots. Drives the window over WebView2's
// debugging port.
// Usage: node scripts/smoke.js <work-folder> [real] [exe-path]
//   "real" = read-only look at the real game install (no installs).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const work = path.resolve(process.argv[2] || 'smoke-out');
const real = process.argv[3] === 'real';
const exe = path.resolve(process.argv[4] || path.join(__dirname, '..', 'src-tauri', 'target', 'release', 'bonelaunch.exe'));
const fake = path.join(work, 'game');
const data = path.join(work, real ? 'data-real' : 'data');
const PORT = 9223;

fs.rmSync(data, { recursive: true, force: true });
fs.rmSync(fake, { recursive: true, force: true });
fs.mkdirSync(fake, { recursive: true });
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(fake, 'BONELAB_Steam_Windows64.exe'), '');
if (!real) fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ customGamePath: fake }));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[smoke]', ...a);

const child = spawn(exe, [], {
  env: { ...process.env, BONELAUNCH_DATA: data, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: 'ignore',
});
log('started pid', child.pid);

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await wait(500);
  }
  throw new Error('window never appeared');
}

(async () => {
  let code = 0;
  try {
    const ws = new WebSocket(await connect());
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        log('page error:', msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        log('console error:', msg.params.entry.text);
      }
    };
    const send = (method, params = {}) =>
      new Promise((res) => {
        const id = ++seq;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
      });
    await send('Runtime.enable');
    await send('Log.enable');
    const js = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'page script failed');
      return r.result.result.value;
    };
    const shot = async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(work, name + '.png'), Buffer.from(r.result.data, 'base64'));
    };
    const click = (sel) => js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'MISSING ' + ${JSON.stringify(sel)}; e.click(); return 'ok'})()`);

    await wait(1500);
    for (let i = 0; i < 40 && String(await js('document.querySelector("#tb-status").textContent')).includes('Loading'); i++) await wait(500);
    await wait(800);
    log('status:', await js('document.querySelector("#tb-status").textContent'));
    log('platform:', await js('(document.querySelector(".platform")||{}).textContent'));
    log('launch button:', await js('(document.querySelector(".launch")||{}).textContent'));
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
      log('toasts:', await js('[...document.querySelectorAll(".toast")].map(t=>t.textContent).join(" | ")'));
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

    await click('[data-page="settings"]');
    await wait(500);
    await shot('7-settings');
    log('loader text:', await js('[...document.querySelectorAll(".opt-text span")].map(s=>s.textContent).find(t=>/Thunderstore mods need/.test(t))'));
    await click('[data-page="home"]');
    await wait(900);
    await shot('9-home-after');

    if (process.env.SMOKE_IDLE) {
      log('idling for memory measurement, pid', child.pid);
      ws.close();
      await wait(Number(process.env.SMOKE_IDLE) * 1000);
    }
  } catch (err) {
    log('FAILED', err);
    code = 1;
  }
  if (!process.env.SMOKE_KEEP) child.kill();
  process.exit(code);
})();

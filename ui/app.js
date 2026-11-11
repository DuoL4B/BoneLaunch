'use strict';

// The Rust side answers every request through one "call" command.
const api = (() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  return {
    call: (channel, ...args) =>
      invoke('call', { channel, args }).catch((err) => {
        throw new Error(typeof err === 'string' ? err : (err && err.message) || String(err));
      }),
    on: (event, cb) => listen(event, (e) => cb(e.payload)),
  };
})();
const LOADER = 'LavaGang-MelonLoader';
const HIDDEN_PACKAGES = new Set([LOADER, 'ebkr-r2modman']);
const ACCENTS = { cyan: '#5fe0ea', ember: '#ff8a3c', violet: '#a78bfa', lime: '#c4f24a', rose: '#ff6f91', ice: '#dfeff2' };
const PAGE_SIZE = 60;

const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');

const S = {
  settings: {},
  game: { installs: [], active: null },
  version: '',
  portable: false,
  dataDir: '',
  packages: [],
  byId: new Map(),
  fetchedAt: 0,
  offline: false,
  tsError: '',
  tsLoading: true,
  installed: [],
  page: 'home',
  running: false,
  launching: false,
  busy: new Set(),
  drawerId: '',
  browse: { q: '', sort: 'popular', cat: '', shown: PAGE_SIZE },
  inst: { q: '', filter: 'all' },
  modalResolve: null,
};

/* ---------- small helpers ---------- */

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function ago(date) {
  const s = (Date.now() - new Date(date).getTime()) / 1000;
  if (!isFinite(s)) return '';
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  if (s < 86400 * 45) return Math.round(s / 86400) + 'd ago';
  if (s < 86400 * 365) return Math.round(s / (86400 * 30)) + 'mo ago';
  return Math.round(s / (86400 * 365)) + 'y ago';
}

function mb(bytes) {
  const n = Number(bytes) || 0;
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

const I = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  home: I('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>'),
  browse: I('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5"/>'),
  box: I('<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>'),
  layers: I('<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>'),
  gear: I('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>'),
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l13-7.5a1 1 0 0 0 0-1.72l-13-7.5A1 1 0 0 0 7 4.5z"/></svg>',
  folder: I('<path d="M3 6h6l2 2h10v11H3z"/>'),
  down: I('<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>'),
  star: I('<path d="M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.3L12 17.5 6.5 20.4l1-6.3L3 9.7l6.2-.9z"/>'),
  clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  trash: I('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  refresh: I('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  x: I('<path d="M6 6l12 12M18 6L6 18"/>'),
  up: I('<path d="M12 20V8M7 13l5-5 5 5M5 4h14"/>'),
  monitor: I('<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>'),
  headset: I('<path d="M3 10a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3h-2.5l-1.5-2.5h-4L8.5 17H6a3 3 0 0 1-3-3z"/>'),
  link: I('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  grid: I('<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>'),
  list: I('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  copy: I('<rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>'),
};

function iconHtml(item) {
  if (item.icon && /^https:\/\/[a-z0-9]+\.thunderstore\.io\//.test(item.icon)) {
    return `<img loading="lazy" data-fallback="${esc((item.name || '?')[0])}" alt="" src="${esc(item.icon)}">`;
  }
  return `<div class="noicon">${esc((item.name || '?')[0].toUpperCase())}</div>`;
}

document.addEventListener(
  'error',
  (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.dataset.fallback !== undefined) {
      const d = document.createElement('div');
      d.className = 'noicon';
      d.textContent = t.dataset.fallback.toUpperCase();
      t.replaceWith(d);
    }
  },
  true
);

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, kind === 'err' ? 7000 : 3800);
}

function openModal(html) {
  const el = $('#modal');
  el.innerHTML = html;
  el.hidden = false;
  const focus = el.querySelector('[data-autofocus]') || el.querySelector('.btn');
  if (focus) focus.focus();
  return new Promise((resolve) => (S.modalResolve = resolve));
}

function closeModal(value) {
  const el = $('#modal');
  el.hidden = true;
  el.innerHTML = '';
  const r = S.modalResolve;
  S.modalResolve = null;
  if (r) r(value);
}

// Resolves true (ok), false (the other button) or null (dismissed).
function confirmBox({ title, text, ok = 'OK', cancel = 'Cancel', danger = false }) {
  return openModal(`
    <div class="modal-box" role="dialog" aria-modal="true">
      <h2>${esc(title)}</h2>
      <p>${esc(text)}</p>
      <div class="modal-buttons">
        <button class="btn" data-action="modal-cancel">${esc(cancel)}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-action="modal-ok" data-autofocus>${esc(ok)}</button>
      </div>
    </div>`);
}

function promptBox({ title, text = '', placeholder = '', ok = 'Save', multiline = false, value = '' }) {
  const input = multiline
    ? `<textarea class="field" id="modal-input" data-autofocus placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
    : `<input class="field" id="modal-input" data-autofocus maxlength="40" placeholder="${esc(placeholder)}" value="${esc(value)}">`;
  return openModal(`
    <div class="modal-box" role="dialog" aria-modal="true">
      <h2>${esc(title)}</h2>
      ${text ? `<p>${esc(text)}</p>` : ''}
      ${input}
      <div class="modal-buttons">
        <button class="btn" data-action="modal-cancel">Cancel</button>
        <button class="btn primary" data-action="modal-ok">${esc(ok)}</button>
      </div>
    </div>`).then((r) => (r === true ? S.modalValue : null));
}

/* ---------- derived data ---------- */

function tracked() {
  return S.installed.filter((m) => !m.manual);
}

function installedById(id) {
  return S.installed.find((m) => m.id === id);
}

function hasUpdate(m) {
  if (m.manual || m.local) return false;
  const p = S.byId.get(m.id);
  return !!p && cmpVersion(p.version, m.version) > 0;
}

function updates() {
  return S.installed.filter(hasUpdate);
}

function visiblePackages() {
  const s = S.settings;
  return S.packages.filter(
    (p) =>
      !HIDDEN_PACKAGES.has(p.id) &&
      (s.showNsfw || !p.nsfw) &&
      (s.showDeprecated || !p.deprecated) &&
      !(s.hideAi && p.cats.includes('AI Generated'))
  );
}

function browseResults() {
  const b = S.browse;
  const tokens = b.q.toLowerCase().split(/\s+/).filter(Boolean);
  let list = visiblePackages();
  if (b.cat) list = list.filter((p) => p.cats.includes(b.cat));
  if (tokens.length) {
    list = list.filter((p) => {
      const hay = (p.name + ' ' + p.owner + ' ' + p.desc).toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }
  const sorters = {
    popular: (a, c) => c.downloads - a.downloads,
    rating: (a, c) => c.rating - a.rating || c.downloads - a.downloads,
    updated: (a, c) => new Date(c.updated) - new Date(a.updated),
    newest: (a, c) => new Date(c.created) - new Date(a.created),
    name: (a, c) => a.name.localeCompare(c.name),
  };
  return [...list].sort(sorters[b.sort] || sorters.popular);
}

/* ---------- theme ---------- */

function applyTheme() {
  const s = S.settings;
  const root = document.documentElement.style;
  root.setProperty('--accent', ACCENTS[s.accent] || ACCENTS.cyan);
  root.setProperty('--bg-opacity', String(Math.max(0.08, (100 - (Number(s.bgDim) || 0)) / 100)));
  root.setProperty('--bg-blur', (Number(s.bgBlur) || 0) + 'px');
  $('#bgimg').style.backgroundImage = s.bgUrl ? `url("${s.bgUrl.replace(/"/g, '%22')}")` : '';
  document.body.classList.toggle('calm', !!s.reduceMotion);
}

async function setSetting(patch) {
  S.settings = await api.call('settings:set', patch);
  applyTheme();
}

/* ---------- chrome: nav, status ---------- */

function renderNav() {
  const ups = updates().length;
  const items = [
    ['home', 'Home', ICON.home, ''],
    ['browse', 'Browse', ICON.browse, ''],
    ['installed', 'Installed', ICON.box, ups ? `<span class="nav-count hot" title="${ups} updates">${ups}</span>` : S.installed.length ? `<span class="nav-count">${S.installed.length}</span>` : ''],
    ['profiles', 'Profiles', ICON.layers, ''],
    ['settings', 'Settings', ICON.gear, ''],
  ];
  const g = S.game.active;
  $('#nav').innerHTML =
    items
      .map(([id, label, icon, extra]) => `<button class="nav-btn ${S.page === id ? 'on' : ''}" data-action="nav" data-page="${id}">${icon}<span>${label}</span>${extra}</button>`)
      .join('') +
    `<div class="side-foot">
      <div class="stat-row"><span>${g ? `<span class="dot green"></span> ${g.platform === 'steam' ? 'Steam' : 'Meta'} copy found` : '<span class="dot red"></span> Game not found'}</span></div>
      ${S.page !== 'home' ? `<button class="btn go mini-launch" data-action="launch" ${!g || S.running || S.launching ? 'disabled' : ''}>${ICON.play} ${S.running ? 'Running' : S.launching ? 'Starting' : 'Launch'}</button>` : ''}
    </div>`;

  const st = $('#tb-status');
  if (S.tsLoading) st.textContent = 'Loading Thunderstore…';
  else if (S.tsError) st.innerHTML = '<span class="dot red"></span> Thunderstore unreachable';
  else st.innerHTML = `<span class="dot ${S.offline ? 'ember' : 'green'}"></span> ${S.offline ? 'Offline, showing saved list' : fmt(S.packages.length) + ' mods on Thunderstore'}`;
}

/* ---------- pages ---------- */

function platformChip() {
  const g = S.game.active;
  if (!g) return '';
  const label = g.platform === 'steam' ? 'Steam' : 'Meta';
  const icon = g.platform === 'steam' ? ICON.monitor : ICON.headset;
  const canSwitch = S.game.installs.length > 1 && !g.custom;
  return canSwitch
    ? `<button class="platform" data-action="platform-switch" title="Both copies found. Click to switch.">${icon} ${label} <span class="chip">switch</span></button>`
    : `<span class="platform">${icon} ${label}</span>`;
}

function launchButton() {
  const g = S.game.active;
  const on = S.installed.filter((m) => m.enabled).length;
  let label = 'Launch';
  let sub = g ? (on ? `${on} mod${on === 1 ? '' : 's'} switched on` : 'no mods switched on') : 'game not found';
  if (S.running) [label, sub] = ['Running', 'BONELAB is open'];
  else if (S.launching) [label, sub] = ['Starting', 'hang tight'];
  return `<button class="launch ${S.running ? 'running' : ''}" data-action="launch" ${!g || S.running || S.launching ? 'disabled' : ''}>
    ${ICON.play}<div>${label}<small>${esc(sub)}</small></div></button>`;
}

function renderHome() {
  const g = S.game.active;
  const ups = updates();
  const on = S.installed.filter((m) => m.enabled).length;
  const profiles = Object.keys(S.settings.profiles || {});
  const fresh = [...visiblePackages()].sort((a, c) => new Date(c.updated) - new Date(a.updated)).slice(0, 4);

  const loader = !g
    ? ''
    : g.loader.installed
      ? `<div class="stat-row"><div class="stat-value">${g.loader.version ? 'v' + esc(g.loader.version) : 'Ready'}</div><span class="chip green"><span class="dot green"></span> installed</span></div>`
      : `<div class="stat-row"><div class="stat-value"><small>Not installed</small></div><button class="btn sm go" data-action="ml-install" ${S.busy.has(LOADER) ? 'disabled' : ''}>${S.busy.has(LOADER) ? 'Working…' : 'Install'}</button></div>`;

  return `
  <div class="home">
    <section class="hero">
      ${g ? '' : `<div class="panel notice"><span class="dot ember"></span><p><b>BONELAB wasn't found.</b> Point BoneLaunch at your game folder to get going.</p><button class="btn sm warn" data-action="browse-game">Pick folder</button></div>`}
      <div class="kicker">Mod launcher for BONELAB</div>
      <h1 class="wordmark">Bone<span>Launch</span></h1>
      <div class="hero-meta">
        ${platformChip()}
        ${g ? `<span class="path" title="${esc(g.path)}">&lrm;${esc(g.path)}</span>` : ''}
      </div>
      <div class="launch-row">
        ${launchButton()}
        <button class="btn" data-action="launch-nomods" ${!g || S.running || S.launching ? 'disabled' : ''}>Launch without mods</button>
        <button class="btn ghost" data-action="open-folder" data-key="mods" ${g ? '' : 'disabled'}>${ICON.folder} Mods folder</button>
      </div>
    </section>

    <aside class="home-side">
      <div class="stat-pair">
        <div class="panel stat"><div class="stat-label">Switched on</div><div class="stat-value">${on}<small>of ${S.installed.length}</small></div></div>
        <div class="panel stat"><div class="stat-label">Updates</div><div class="stat-value">${ups.length}</div></div>
      </div>
      ${ups.length ? `<button class="btn warn" data-action="update-all">${ICON.up} Update ${ups.length} mod${ups.length === 1 ? '' : 's'}</button>` : ''}
      ${g ? `<div class="panel stat"><div class="stat-label">MelonLoader</div>${loader}</div>` : ''}
      <div class="panel stat">
        <div class="stat-label">Profile</div>
        ${
          profiles.length
            ? `<select class="field" data-input="profile-pick" aria-label="Active profile">
                <option value="">None</option>
                ${profiles.map((n) => `<option ${n === S.settings.activeProfile ? 'selected' : ''}>${esc(n)}</option>`).join('')}
              </select>`
            : `<div class="stat-row"><span class="sub">Save sets of mods to swap between.</span><button class="btn sm" data-action="nav" data-page="profiles">Set up</button></div>`
        }
      </div>
    </aside>

    ${
      fresh.length
        ? `<section class="fresh"><h2>Fresh on Thunderstore</h2><div class="fresh-row">
            ${fresh.map((p) => `<button class="tile" data-action="details" data-id="${esc(p.id)}">${iconHtml(p)}<div><b>${esc(p.name.replace(/_/g, ' '))}</b><span>${esc(p.owner)} · ${ago(p.updated)}</span></div></button>`).join('')}
          </div></section>`
        : ''
    }
  </div>`;
}

function installButton(p, small = true) {
  const m = installedById(p.id);
  const cls = small ? 'btn sm' : 'btn';
  if (S.busy.has(p.id)) return `<button class="${cls}" disabled>Working…</button>`;
  if (m && hasUpdate(m)) return `<button class="${cls} warn" data-action="install" data-id="${esc(p.id)}">${ICON.up} Update</button>`;
  if (m) return `<button class="${cls} done" disabled>Installed</button>`;
  return `<button class="${cls} go" data-action="install" data-id="${esc(p.id)}">${ICON.down} Install</button>`;
}

function cardHtml(p) {
  return `
  <article class="card" data-action="details" data-id="${esc(p.id)}" tabindex="0">
    ${iconHtml(p)}
    <div class="card-body">
      <h3>${esc(p.name.replace(/_/g, ' '))}</h3>
      <div class="by">${esc(p.owner)} · v${esc(p.version)}${p.deprecated ? ' · deprecated' : ''}${p.nsfw ? ' · NSFW' : ''}</div>
      <p>${esc(p.desc)}</p>
    </div>
    <div class="card-foot">
      <span class="meta" title="Downloads">${ICON.down}${fmt(p.downloads)}</span>
      <span class="meta" title="Likes">${ICON.star}${fmt(p.rating)}</span>
      <span class="meta" title="Last updated">${ICON.clock}${ago(p.updated)}</span>
      <span class="spacer"></span>
      ${installButton(p)}
    </div>
  </article>`;
}

function renderBrowse() {
  const cats = new Map();
  for (const p of visiblePackages()) for (const c of p.cats) cats.set(c, (cats.get(c) || 0) + 1);
  const catList = [...cats.entries()].sort((a, c) => c[1] - a[1]);
  const b = S.browse;
  return `
  <div class="page">
    <div class="page-head"><h1>Browse</h1><span class="sub" id="browse-count"></span><span class="spacer"></span>
      <button class="btn sm ghost" data-action="refresh-ts" title="Fetch the newest list">${ICON.refresh} Refresh</button>
    </div>
    <div class="toolbar">
      <label class="search">${ICON.browse}<input class="field" data-input="browse-q" placeholder="Search mods, authors, descriptions" value="${esc(b.q)}" aria-label="Search mods"></label>
      <select class="field" data-input="browse-sort" aria-label="Sort by">
        ${[['popular', 'Most downloaded'], ['rating', 'Top rated'], ['updated', 'Recently updated'], ['newest', 'Newest'], ['name', 'Name A to Z']]
          .map(([v, l]) => `<option value="${v}" ${b.sort === v ? 'selected' : ''}>${l}</option>`)
          .join('')}
      </select>
      <button class="btn icon" data-action="view" data-view="${S.settings.view === 'list' ? 'grid' : 'list'}" title="Switch between grid and list" aria-label="Switch between grid and list">${S.settings.view === 'list' ? ICON.grid : ICON.list}</button>
    </div>
    <div class="cats">
      <button class="chip ${b.cat ? '' : 'on'}" data-action="cat" data-cat="">All</button>
      ${catList.map(([c, n]) => `<button class="chip ${b.cat === c ? 'on' : ''}" data-action="cat" data-cat="${esc(c)}">${esc(c)} <span>${n}</span></button>`).join('')}
    </div>
    <div id="results"></div>
  </div>`;
}

function fillResults() {
  const box = $('#results');
  if (!box) return;
  if (S.tsLoading) {
    box.innerHTML = `<div class="empty"><b>Loading mods</b>Fetching the list from Thunderstore…</div>`;
    return;
  }
  if (S.tsError) {
    box.innerHTML = `<div class="empty"><b>Can't reach Thunderstore</b>${esc(S.tsError)}<br><button class="btn" data-action="refresh-ts">${ICON.refresh} Try again</button></div>`;
    return;
  }
  const list = browseResults();
  const count = $('#browse-count');
  if (count) count.textContent = `${list.length.toLocaleString()} mod${list.length === 1 ? '' : 's'}`;
  if (!list.length) {
    box.innerHTML = `<div class="empty"><b>Nothing matches</b>Try a different search or clear the category.</div>`;
    return;
  }
  const shown = list.slice(0, S.browse.shown);
  box.innerHTML = `<div class="grid ${S.settings.view === 'list' ? 'list' : ''}">${shown.map(cardHtml).join('')}</div>${list.length > shown.length ? '<div id="more" style="height:1px"></div>' : ''}`;
  const more = $('#more');
  if (more) {
    new IntersectionObserver((entries, obs) => {
      if (entries.some((e) => e.isIntersecting)) {
        obs.disconnect();
        S.browse.shown += PAGE_SIZE;
        const top = main.scrollTop;
        fillResults();
        main.scrollTop = top;
      }
    }, { root: main, rootMargin: '600px' }).observe(more);
  }
}

function rowHtml(m) {
  const p = S.byId.get(m.id);
  const up = hasUpdate(m);
  const busy = S.busy.has(m.id);
  const nameBtn = p
    ? `<button class="link" data-action="details" data-id="${esc(m.id)}"><span>${esc(m.name.replace(/_/g, ' '))}</span></button>`
    : `<span>${esc(m.name)}</span>`;
  return `
  <div class="row ${m.enabled ? '' : 'off'}">
    ${iconHtml(m)}
    <div style="min-width:0">
      <h3>${nameBtn}${m.manual ? '<span class="chip">added by hand</span>' : ''}${m.local ? '<span class="chip">from zip</span>' : ''}${up ? `<span class="chip ember">v${esc(p.version)} available</span>` : ''}</h3>
      <div class="by">${esc(m.owner)}${m.version ? ' · v' + esc(m.version) : ''}${m.desc ? ' · ' + esc(m.desc) : ''}</div>
    </div>
    <div class="row-actions">
      ${busy ? '<button class="btn sm" disabled>Working…</button>' : up ? `<button class="btn sm warn" data-action="install" data-id="${esc(m.id)}">${ICON.up} Update</button>` : ''}
      <button class="btn sm icon ghost" data-action="uninstall" data-id="${esc(m.id)}" title="Remove" aria-label="Remove ${esc(m.name)}" ${busy ? 'disabled' : ''}>${ICON.trash}</button>
    </div>
    <label class="switch" title="${m.enabled ? 'Switched on' : 'Switched off'}"><input type="checkbox" data-toggle="${esc(m.id)}" ${m.enabled ? 'checked' : ''} aria-label="Switch ${esc(m.name)} on or off"><i></i></label>
  </div>`;
}

function installedRows() {
  const f = S.inst;
  const q = f.q.toLowerCase().trim();
  let list = [...S.installed].sort((a, c) => a.name.localeCompare(c.name));
  if (q) list = list.filter((m) => (m.name + ' ' + m.owner).toLowerCase().includes(q));
  if (f.filter === 'on') list = list.filter((m) => m.enabled);
  if (f.filter === 'off') list = list.filter((m) => !m.enabled);
  if (f.filter === 'updates') list = list.filter(hasUpdate);
  if (!S.installed.length) {
    return `<div class="empty"><b>No mods yet</b>Find something in Browse and hit Install.<br><button class="btn go" data-action="nav" data-page="browse">${ICON.browse} Browse mods</button></div>`;
  }
  if (!list.length) return `<div class="empty"><b>Nothing matches</b>No installed mods fit that filter.</div>`;
  return `<div class="rows">${list.map(rowHtml).join('')}</div>`;
}

function renderInstalled() {
  const g = S.game.active;
  const ups = updates().length;
  const f = S.inst;
  if (!g) return `<div class="page"><div class="page-head"><h1>Installed</h1></div><div class="empty"><b>Game not found</b>Pick your BONELAB folder first.<br><button class="btn warn" data-action="browse-game">Pick folder</button></div></div>`;
  return `
  <div class="page">
    <div class="page-head"><h1>Installed</h1><span class="sub">${S.installed.length} mod${S.installed.length === 1 ? '' : 's'}, ${S.installed.filter((m) => m.enabled).length} switched on</span><span class="spacer"></span>
      ${ups ? `<button class="btn sm warn" data-action="update-all">${ICON.up} Update all (${ups})</button>` : ''}
      <button class="btn sm" data-action="install-zip">${ICON.down} Install from zip</button>
      <button class="btn sm ghost" data-action="open-folder" data-key="mods">${ICON.folder} Mods folder</button>
    </div>
    <div class="toolbar">
      <label class="search">${ICON.browse}<input class="field" data-input="inst-q" placeholder="Filter installed mods" value="${esc(f.q)}" aria-label="Filter installed mods"></label>
      ${[['all', 'All'], ['on', 'On'], ['off', 'Off'], ['updates', 'Updates']].map(([v, l]) => `<button class="chip ${f.filter === v ? 'on' : ''}" data-action="inst-filter" data-filter="${v}">${l}</button>`).join('')}
      <button class="btn sm ghost" data-action="all-on">All on</button>
      <button class="btn sm ghost" data-action="all-off">All off</button>
    </div>
    <div id="inst-rows">${installedRows()}</div>
  </div>`;
}

function renderProfiles() {
  const profiles = S.settings.profiles || {};
  const names = Object.keys(profiles);
  return `
  <div class="page">
    <div class="page-head"><h1>Profiles</h1><span class="sub">Saved sets of switched-on mods</span><span class="spacer"></span>
      <button class="btn sm" data-action="profile-import">${ICON.down} Import code</button>
      <button class="btn sm primary" data-action="profile-save">Save current as profile</button>
    </div>
    ${
      names.length
        ? `<div class="profiles">${names
            .map((n) => {
              const ids = profiles[n] || [];
              const active = n === S.settings.activeProfile;
              const here = ids.filter((id) => installedById(id)).length;
              return `<div class="panel profile ${active ? 'on' : ''}">
                <h3>${esc(n)} ${active ? '<span class="chip green"><span class="dot green"></span> active</span>' : ''}</h3>
                <div class="sub" style="color:var(--muted)">${ids.length} mod${ids.length === 1 ? '' : 's'} switched on${here < ids.length ? `, ${ids.length - here} no longer installed` : ''}</div>
                <div class="row-actions">
                  <button class="btn sm ${active ? '' : 'go'}" data-action="profile-apply" data-name="${esc(n)}" ${active ? 'disabled' : ''}>${active ? 'In use' : 'Use'}</button>
                  <button class="btn sm" data-action="profile-export" data-name="${esc(n)}">${ICON.copy} Copy share code</button>
                  <button class="btn sm icon ghost" data-action="profile-delete" data-name="${esc(n)}" title="Delete profile" aria-label="Delete profile ${esc(n)}">${ICON.trash}</button>
                </div>
              </div>`;
            })
            .join('')}</div>
          <p class="fine" style="margin-top:14px">While a profile is active, switching mods on or off updates that profile. Share codes list the Thunderstore mods in a profile so a friend can install the same set.</p>`
        : `<div class="empty"><b>No profiles yet</b>Switch on the mods you want, then save them as a profile. Make one for co-op, one for a clean game, and swap in a click.</div>`
    }
  </div>`;
}

function opt(title, text, control) {
  return `<div class="opt"><div class="opt-text"><b>${title}</b>${text ? `<span>${text}</span>` : ''}</div>${control}</div>`;
}

function sw(key) {
  return `<label class="switch"><input type="checkbox" data-setting="${key}" ${S.settings[key] ? 'checked' : ''}><i></i></label>`;
}

function renderSettings() {
  const s = S.settings;
  const g = S.game.active;
  const found = S.game.installs.map((i) => (i.platform === 'steam' ? 'Steam' : 'Meta')).join(' and ') || 'nothing';
  const loaderPkg = S.byId.get(LOADER);
  const busyMl = S.busy.has(LOADER);
  return `
  <div class="page">
    <div class="page-head"><h1>Settings</h1></div>
    <div class="settings">

      <section class="panel set"><h2>Game</h2>
        ${opt('Where you play', `Found on this PC: ${esc(found)}.`, `<select class="field" data-setting="platform">
          <option value="auto" ${s.platform === 'auto' ? 'selected' : ''}>Detect for me</option>
          <option value="steam" ${s.platform === 'steam' ? 'selected' : ''}>Steam</option>
          <option value="meta" ${s.platform === 'meta' ? 'selected' : ''}>Meta (Oculus)</option></select>`)}
        ${opt('Game folder', g ? esc(g.path) + (g.custom ? ' (picked by you)' : '') : 'Not found', `<div class="opt-buttons">
          ${s.customGamePath ? '<button class="btn sm" data-action="clear-game">Back to auto-detect</button>' : ''}
          <button class="btn sm" data-action="browse-game">Pick folder</button>
          <button class="btn sm ghost" data-action="rescan">${ICON.refresh} Scan again</button></div>`)}
      </section>

      <section class="panel set"><h2>MelonLoader</h2>
        ${opt('Mod loader', !g ? 'Find the game first.' : g.loader.installed ? `Installed${g.loader.version ? ', version ' + esc(g.loader.version) : ''}. Thunderstore mods need this to run.` : 'Not installed. Thunderstore mods need this to run.', `<div class="opt-buttons">
          <select class="field" id="ml-version" style="width:130px" aria-label="MelonLoader version" ${loaderPkg ? '' : 'disabled'}>
            ${(loaderPkg ? loaderPkg.versions : []).map((v, i) => `<option value="${esc(v.v)}">${esc(v.v)}${i === 0 ? ' (newest)' : ''}</option>`).join('')}
          </select>
          <button class="btn sm go" data-action="ml-install" ${!g || !loaderPkg || busyMl ? 'disabled' : ''}>${busyMl ? 'Working…' : g && g.loader.installed ? 'Install this version' : 'Install'}</button>
          ${g && g.loader.installed ? '<button class="btn sm danger" data-action="ml-uninstall">Remove</button>' : ''}</div>`)}
        ${opt('Hide the console window', 'Stops the black MelonLoader text window from opening with the game.', sw('hideConsole'))}
        ${opt('Debug mode', 'Extra detail in the log. Handy when a mod misbehaves.', sw('mlDebug'))}
      </section>

      <section class="panel set"><h2>Launching</h2>
        ${opt('After pressing Launch', '', `<select class="field" data-setting="afterLaunch">
          <option value="stay" ${s.afterLaunch === 'stay' ? 'selected' : ''}>Keep BoneLaunch open</option>
          <option value="minimize" ${s.afterLaunch === 'minimize' ? 'selected' : ''}>Minimize BoneLaunch</option>
          <option value="close" ${s.afterLaunch === 'close' ? 'selected' : ''}>Close BoneLaunch</option></select>`)}
        ${opt('Free memory when minimized', 'BoneLaunch closes its window and waits in the system tray, next to the clock. Click the tray icon to bring it back.', sw('sleepInTray'))}
        ${opt('Update mods before launching', 'Installs any waiting updates first.', sw('autoUpdateMods'))}
        ${opt('Extra launch options', 'For advanced use. Added to the game\'s start command.', `<input class="field wide" data-setting="launchArgs" value="${esc(s.launchArgs)}" placeholder="e.g. --melonloader.agfregenerate" spellcheck="false">`)}
      </section>

      <section class="panel set"><h2>Mods</h2>
        ${opt('Install required mods too', 'When a mod needs other mods, get them at the same time.', sw('installDeps'))}
        ${opt('Tell me about updates at startup', '', sw('checkUpdatesOnStart'))}
        ${opt('Ask before removing a mod', '', sw('confirmUninstall'))}
      </section>

      <section class="panel set"><h2>Browse</h2>
        ${opt('Hide AI-generated mods', 'Thunderstore tags these; this hides them from Browse.', sw('hideAi'))}
        ${opt('Show deprecated mods', 'Mods their authors have retired.', sw('showDeprecated'))}
        ${opt('Show NSFW mods', '', sw('showNsfw'))}
      </section>

      <section class="panel set"><h2>Look</h2>
        ${opt('Accent color', 'The Launch button always stays green.', `<div class="swatches">${Object.entries(ACCENTS).map(([k, c]) => `<button class="swatch ${s.accent === k ? 'on' : ''}" style="--c:${c}" data-action="accent" data-accent="${k}" title="${k}" aria-label="${k} accent"></button>`).join('')}</div>`)}
        ${opt('Background picture', s.bgImage ? 'Using your own picture.' : 'Using the built-in picture.', `<div class="opt-buttons"><button class="btn sm" data-action="bg-pick">Choose picture</button>${s.bgImage ? '<button class="btn sm ghost" data-action="bg-reset">Use default</button>' : ''}</div>`)}
        ${opt('Fade the picture', 'Further right is more faded.', `<input type="range" min="0" max="90" step="5" data-setting="bgDim" value="${Number(s.bgDim) || 0}" aria-label="Fade the picture">`)}
        ${opt('Blur the picture', '', `<input type="range" min="0" max="12" step="1" data-setting="bgBlur" value="${Number(s.bgBlur) || 0}" aria-label="Blur the picture">`)}
        ${opt('Less motion', 'Turns off animations.', sw('reduceMotion'))}
      </section>

      <section class="panel set"><h2>Folders</h2>
        <div class="folders">
          <button class="btn sm" data-action="open-folder" data-key="game">${ICON.folder} Game</button>
          <button class="btn sm" data-action="open-folder" data-key="mods">${ICON.folder} Mods</button>
          <button class="btn sm" data-action="open-folder" data-key="plugins">${ICON.folder} Plugins</button>
          <button class="btn sm" data-action="open-folder" data-key="userdata">${ICON.folder} UserData</button>
          <button class="btn sm" data-action="open-folder" data-key="locallow">${ICON.folder} mod.io mods</button>
          <button class="btn sm" data-action="open-folder" data-key="logs">${ICON.folder} MelonLoader</button>
          <button class="btn sm" data-action="open-folder" data-key="data">${ICON.folder} BoneLaunch data</button>
        </div>
      </section>

      <section class="panel set"><h2>Upkeep</h2>
        ${opt('Latest game log', 'What MelonLoader wrote the last time the game ran.', '<button class="btn sm" data-action="view-log">View log</button>')}
        ${opt('Mod list', S.fetchedAt ? 'Last fetched ' + ago(S.fetchedAt) + '.' : '', `<div class="opt-buttons"><button class="btn sm" data-action="refresh-ts">${ICON.refresh} Refresh now</button><button class="btn sm ghost" data-action="clear-cache">Clear saved list</button></div>`)}
        ${opt('Reset settings', 'Puts every option back to how it started. Your mods and profiles stay.', '<button class="btn sm danger" data-action="reset-settings">Reset</button>')}
      </section>

      <p class="fine">BoneLaunch ${esc(S.version)}${S.portable ? ' (portable)' : ''}. A fan-made tool, not affiliated with Stress Level Zero, Thunderstore, Valve or Meta.</p>
    </div>
  </div>`;
}

function render() {
  const top = main.scrollTop;
  const samePage = document.body.dataset.page === S.page;
  document.body.dataset.page = S.page;
  renderNav();
  const pages = { home: renderHome, browse: renderBrowse, installed: renderInstalled, profiles: renderProfiles, settings: renderSettings };
  const active = document.activeElement;
  const keep = active && active.dataset && active.dataset.input ? { key: active.dataset.input, pos: active.selectionStart } : null;
  main.innerHTML = pages[S.page]();
  if (S.page === 'browse') fillResults();
  main.scrollTop = samePage ? top : 0;
  if (keep) {
    const el = main.querySelector(`[data-input="${keep.key}"]`);
    if (el) {
      el.focus();
      if (keep.pos != null && el.setSelectionRange) el.setSelectionRange(keep.pos, keep.pos);
    }
  }
  if (S.drawerId) renderDrawer();
}

/* ---------- drawer ---------- */

function renderDrawer() {
  const p = S.byId.get(S.drawerId);
  const el = $('#drawer');
  if (!p) return closeDrawer();
  const m = installedById(p.id);
  const prevReadme = $('#readme') && el.dataset.id === p.id ? $('#readme').textContent : '';
  const prevVersion = $('#drawer-version') && el.dataset.id === p.id ? $('#drawer-version').value : '';
  el.dataset.id = p.id;
  el.innerHTML = `
    <div class="drawer-head">
      ${iconHtml(p)}
      <div><h2>${esc(p.name.replace(/_/g, ' '))}</h2><div class="by">by ${esc(p.owner)}</div>
        <div class="chips" style="margin-top:8px">${p.deprecated ? '<span class="chip red">deprecated</span>' : ''}${p.nsfw ? '<span class="chip red">NSFW</span>' : ''}${m ? `<span class="chip green">installed v${esc(m.version)}</span>` : ''}</div>
      </div>
      <button class="btn icon ghost" data-action="close-drawer" title="Close" aria-label="Close details">${ICON.x}</button>
    </div>
    <div class="drawer-body">
      <div class="drawer-actions">
        <select class="field" id="drawer-version" aria-label="Version">${p.versions.map((v, i) => `<option value="${esc(v.v)}" ${v.v === prevVersion ? 'selected' : ''}>v${esc(v.v)}${i === 0 ? ' (newest)' : ''}</option>`).join('')}</select>
        ${
          S.busy.has(p.id)
            ? '<button class="btn" disabled>Working…</button>'
            : `<button class="btn ${m && !hasUpdate(m) ? '' : m ? 'warn' : 'go'}" data-action="install" data-id="${esc(p.id)}" data-from="drawer">${ICON.down} ${m ? (hasUpdate(m) ? 'Update' : 'Install this version') : 'Install'}</button>`
        }
        ${m ? `<button class="btn danger" data-action="uninstall" data-id="${esc(p.id)}">${ICON.trash} Remove</button>` : ''}
      </div>
      <p>${esc(p.desc)}</p>
      <div class="drawer-stats">
        <div><b>${fmt(p.downloads)}</b><span>downloads</span></div>
        <div><b>${fmt(p.rating)}</b><span>likes</span></div>
        <div><b>${mb(p.size)}</b><span>size</span></div>
        <div><b>${ago(p.updated)}</b><span>updated</span></div>
      </div>
      <div class="chips">${p.cats.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>
      ${
        p.deps.length
          ? `<div><div class="section-title">Needs these</div><div class="deps">${p.deps
              .map((d) => {
                const id = d.slice(0, d.lastIndexOf('-'));
                const dp = S.byId.get(id);
                const have = id === LOADER ? S.game.active && S.game.active.loader.installed : !!installedById(id);
                const status = have ? '<span class="chip green">installed</span>' : '';
                if (id === LOADER) return `<div class="dep"><span>MelonLoader</span>${status}</div>`;
                return dp ? `<button class="dep" data-action="details" data-id="${esc(id)}"><span>${esc(dp.name.replace(/_/g, ' '))} <small style="color:var(--muted)">by ${esc(dp.owner)}</small></span>${status}</button>` : `<div class="dep"><span>${esc(id)}</span><span class="chip">not on Thunderstore</span></div>`;
              })
              .join('')}</div></div>`
          : ''
      }
      <div class="drawer-actions">
        <button class="btn sm" data-action="open-url" data-url="${esc(p.url)}">${ICON.link} Thunderstore page</button>
        ${/^https:\/\//.test(p.site) ? `<button class="btn sm" data-action="open-url" data-url="${esc(p.site)}">${ICON.link} Website</button>` : ''}
      </div>
      <div><div class="section-title">Read me</div><div class="readme" id="readme">Loading…</div></div>
    </div>`;
  if (prevReadme && prevReadme !== 'Loading…') {
    $('#readme').textContent = prevReadme;
  } else {
    const id = p.id;
    api
      .call('ts:readme', p.owner, p.name, p.version)
      .then((text) => {
        if (S.drawerId === id && $('#readme')) $('#readme').textContent = text.trim() || 'This mod has no read me.';
      })
      .catch(() => {
        if (S.drawerId === id && $('#readme')) $('#readme').textContent = 'Could not load the read me.';
      });
  }
}

function openDrawer(id) {
  if (!S.byId.get(id)) return;
  S.drawerId = id;
  renderDrawer();
  $('#drawer').classList.add('on');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('on');
}

function closeDrawer() {
  S.drawerId = '';
  $('#drawer').classList.remove('on');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').classList.remove('on');
}

/* ---------- data loading ---------- */

async function reloadInstalled() {
  try {
    S.installed = S.game.active ? await api.call('mods:list') : [];
  } catch {
    S.installed = [];
  }
}

async function redetect() {
  S.game = await api.call('game:detect');
  await reloadInstalled();
}

async function loadPackages(force) {
  S.tsLoading = true;
  renderNav();
  if (S.page === 'browse') fillResults();
  try {
    const r = await api.call('ts:list', force);
    S.packages = r.list;
    S.byId = new Map(r.list.map((p) => [p.id, p]));
    S.fetchedAt = r.fetchedAt;
    S.offline = !!r.offline;
    S.tsError = '';
  } catch (err) {
    S.tsError = err.message;
  }
  S.tsLoading = false;
  render();
}

async function syncActiveProfile() {
  const name = S.settings.activeProfile;
  if (!name || !S.settings.profiles[name]) return;
  const profiles = { ...S.settings.profiles, [name]: S.installed.filter((m) => m.enabled).map((m) => m.id) };
  await setSetting({ profiles });
}

/* ---------- actions ---------- */

function requireGame() {
  if (S.game.active) return true;
  toast('BONELAB was not found. Pick the game folder in Settings.', 'err');
  return false;
}

async function doInstall(id, version, quiet) {
  if (!requireGame() || S.busy.has(id)) return false;
  const p = S.byId.get(id);
  S.busy.add(id);
  render();
  let ok = false;
  try {
    const r = await api.call('mods:install', id, version || null);
    ok = true;
    if (!quiet) {
      const extra = r.installed.length - 1;
      toast(`${p ? p.name.replace(/_/g, ' ') : id} installed${extra > 0 ? ` with ${extra} required mod${extra === 1 ? '' : 's'}` : ''}.`, 'ok');
      if (r.installed.includes(LOADER)) toast('MelonLoader installed. The first launch afterwards takes a few minutes while it sets up.');
    }
    if (r.missing.length) toast('Not on Thunderstore, skipped: ' + r.missing.join(', '), 'err');
  } catch (err) {
    toast(err.message, 'err');
  }
  S.busy.delete(id);
  await redetect();
  await syncActiveProfile();
  render();
  return ok;
}

async function updateAll() {
  const list = updates();
  let done = 0;
  for (const m of list) if (await doInstall(m.id, null, true)) done++;
  if (list.length) toast(`Updated ${done} of ${list.length} mod${list.length === 1 ? '' : 's'}.`, done === list.length ? 'ok' : 'err');
}

async function doUninstall(id) {
  const m = installedById(id);
  if (!m) return;
  if (S.settings.confirmUninstall) {
    const yes = await confirmBox({
      title: 'Remove this mod?',
      text: m.manual ? `${m.name} will be moved to the Recycle Bin.` : `${m.name} and its files will be deleted from your game folder.`,
      ok: 'Remove',
      danger: true,
    });
    if (!yes) return;
  }
  try {
    await api.call('mods:uninstall', id);
    toast(`${m.name.replace(/_/g, ' ')} removed.`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  await reloadInstalled();
  await syncActiveProfile();
  render();
}

async function doToggle(id, enabled) {
  try {
    await api.call('mods:toggle', id, enabled);
  } catch (err) {
    toast(err.message, 'err');
  }
  await reloadInstalled();
  await syncActiveProfile();
  render();
}

async function applyEnabled(ids) {
  try {
    await api.call('mods:applyEnabled', ids);
  } catch (err) {
    toast(err.message, 'err');
  }
  await reloadInstalled();
}

async function launch(noMods) {
  if (!requireGame() || S.running || S.launching) return;
  const g = S.game.active;
  if (!noMods && !g.loader.installed) {
    const answer = await confirmBox({
      title: 'MelonLoader is missing',
      text: 'Mods need MelonLoader to load. Install it now?\nBONELAB still starts without it, just with no mods.',
      ok: 'Install MelonLoader',
      cancel: 'Launch anyway',
    });
    if (answer === null) return;
    if (answer) {
      await doInstall(LOADER);
      return;
    }
  }
  if (!noMods && S.settings.autoUpdateMods && updates().length) await updateAll();
  try {
    const r = await api.call('game:launch', { noMods: !!noMods });
    toast(`Starting BONELAB${r.via === 'steam' ? ' through Steam' : ''}${noMods ? ' without mods' : ''}.`, 'ok');
    S.launching = true;
    render();
    setTimeout(() => {
      S.launching = false;
      render();
    }, 15000);
  } catch (err) {
    toast(err.message, 'err');
  }
}

function profileCode(name) {
  const ids = S.settings.profiles[name] || [];
  const modsList = ids.map((id) => installedById(id)).filter((m) => m && !m.manual && !m.local).map((m) => m.id);
  const json = JSON.stringify({ n: name, m: modsList });
  return 'BL1:' + btoa(String.fromCharCode(...new TextEncoder().encode(json)));
}

async function importProfile() {
  const code = await promptBox({ title: 'Import a profile', text: 'Paste a BoneLaunch share code. Missing mods get installed for you.', placeholder: 'BL1:…', ok: 'Import', multiline: true });
  if (!code) return;
  let data;
  try {
    const raw = atob(code.trim().replace(/^BL1:/, ''));
    data = JSON.parse(new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0))));
    if (!data || !Array.isArray(data.m)) throw new Error();
  } catch {
    return toast("That doesn't look like a BoneLaunch share code.", 'err');
  }
  if (!requireGame()) return;
  const ids = data.m.filter((id) => typeof id === 'string' && S.byId.has(id)).slice(0, 200);
  for (const id of ids) if (!installedById(id)) await doInstall(id, null, true);
  let name = String(data.n || 'Imported').slice(0, 40);
  while (S.settings.profiles[name]) name += ' (2)';
  await applyEnabled(ids);
  await setSetting({ profiles: { ...S.settings.profiles, [name]: S.installed.filter((m) => m.enabled).map((m) => m.id) }, activeProfile: name });
  toast(`Profile "${name}" imported and in use.`, 'ok');
  render();
}

const ACTIONS = {
  nav(el) {
    S.page = el.dataset.page;
    closeDrawer();
    render();
  },
  'win-min': () => api.call('win:min'),
  'win-max': () => api.call('win:max'),
  'win-close': () => api.call('win:close'),
  launch: () => launch(false),
  'launch-nomods': () => launch(true),
  async 'open-folder'(el) {
    try {
      await api.call('open:folder', el.dataset.key);
    } catch (err) {
      toast(err.message, 'err');
    }
  },
  'open-url': (el) => api.call('open:url', el.dataset.url).catch((err) => toast(err.message, 'err')),
  details: (el) => openDrawer(el.dataset.id),
  'close-drawer': () => closeDrawer(),
  install(el) {
    const version = el.dataset.from === 'drawer' && $('#drawer-version') ? $('#drawer-version').value : null;
    doInstall(el.dataset.id, version);
  },
  uninstall: (el) => doUninstall(el.dataset.id),
  'update-all': () => updateAll(),
  async 'install-zip'() {
    if (!requireGame()) return;
    try {
      const name = await api.call('mods:installZip');
      if (name) toast(`${name} installed from zip.`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
    await reloadInstalled();
    await syncActiveProfile();
    render();
  },
  async 'all-on'() {
    await applyEnabled(S.installed.map((m) => m.id));
    await syncActiveProfile();
    render();
  },
  async 'all-off'() {
    await applyEnabled([]);
    await syncActiveProfile();
    render();
  },
  'inst-filter'(el) {
    S.inst.filter = el.dataset.filter;
    render();
  },
  cat(el) {
    S.browse.cat = el.dataset.cat;
    S.browse.shown = PAGE_SIZE;
    render();
    main.scrollTop = 0;
  },
  async view(el) {
    await setSetting({ view: el.dataset.view });
    render();
  },
  'refresh-ts': () => loadPackages(true).then(() => !S.tsError && toast('Mod list refreshed.', 'ok')),
  async 'platform-switch'() {
    const next = S.game.active.platform === 'steam' ? 'meta' : 'steam';
    await setSetting({ platform: next });
    await redetect();
    toast(`Switched to your ${next === 'steam' ? 'Steam' : 'Meta'} copy.`, 'ok');
    render();
  },
  async 'browse-game'() {
    try {
      const r = await api.call('game:browse');
      if (!r) return;
      S.settings = r.settings;
      S.game = r.game;
      await reloadInstalled();
      toast('Game folder set.', 'ok');
      render();
    } catch (err) {
      toast(err.message, 'err');
    }
  },
  async 'clear-game'() {
    await setSetting({ customGamePath: '' });
    await redetect();
    render();
  },
  async rescan() {
    await redetect();
    toast(S.game.active ? 'Found BONELAB.' : 'Still no BONELAB found.', S.game.active ? 'ok' : 'err');
    render();
  },
  'ml-install'() {
    const pick = $('#ml-version');
    doInstall(LOADER, pick ? pick.value : null);
  },
  async 'ml-uninstall'() {
    const yes = await confirmBox({ title: 'Remove MelonLoader?', text: 'Your mods stay in their folders, but none will load until MelonLoader is installed again.', ok: 'Remove', danger: true });
    if (!yes) return;
    try {
      await api.call('ml:uninstall');
      toast('MelonLoader removed.', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
    await redetect();
    render();
  },
  async 'profile-save'() {
    const name = await promptBox({ title: 'Name this profile', text: 'Saves which mods are switched on right now.', placeholder: 'e.g. Co-op night' });
    if (!name || !name.trim()) return;
    const key = name.trim().slice(0, 40);
    await setSetting({ profiles: { ...S.settings.profiles, [key]: S.installed.filter((m) => m.enabled).map((m) => m.id) }, activeProfile: key });
    toast(`Profile "${key}" saved.`, 'ok');
    render();
  },
  async 'profile-apply'(el) {
    await useProfile(el.dataset.name);
  },
  async 'profile-delete'(el) {
    const name = el.dataset.name;
    const yes = await confirmBox({ title: 'Delete this profile?', text: `"${name}" will be forgotten. Your mods are not touched.`, ok: 'Delete', danger: true });
    if (!yes) return;
    const profiles = { ...S.settings.profiles };
    delete profiles[name];
    await setSetting({ profiles, activeProfile: S.settings.activeProfile === name ? '' : S.settings.activeProfile });
    render();
  },
  async 'profile-export'(el) {
    try {
      await navigator.clipboard.writeText(profileCode(el.dataset.name));
      toast('Share code copied.', 'ok');
    } catch {
      toast('Could not copy to the clipboard.', 'err');
    }
  },
  'profile-import': () => importProfile(),
  async accent(el) {
    await setSetting({ accent: el.dataset.accent });
    render();
  },
  async 'bg-pick'() {
    try {
      const s = await api.call('bg:pick');
      if (!s) return;
      S.settings = s;
      applyTheme();
      render();
    } catch (err) {
      toast(err.message, 'err');
    }
  },
  async 'bg-reset'() {
    await setSetting({ bgImage: '' });
    render();
  },
  async 'clear-cache'() {
    await api.call('cache:clear');
    toast('Saved mod list cleared.', 'ok');
    loadPackages(true);
  },
  async 'reset-settings'() {
    const yes = await confirmBox({ title: 'Reset all settings?', text: 'Every option goes back to how it started. Profiles are cleared too. Installed mods stay.', ok: 'Reset', danger: true });
    if (!yes) return;
    S.settings = await api.call('settings:reset');
    applyTheme();
    await redetect();
    render();
  },
  async 'view-log'() {
    try {
      const text = await api.call('log:read');
      openModal(`<div class="modal-box big" role="dialog" aria-modal="true"><h2>Latest game log</h2><div class="log" id="log-text"></div>
        <div class="modal-buttons"><button class="btn" data-action="open-folder" data-key="logs">${ICON.folder} Open folder</button><button class="btn primary" data-action="modal-cancel" data-autofocus>Close</button></div></div>`);
      const box = $('#log-text');
      box.textContent = text || 'No log yet. One appears after the game runs with MelonLoader.';
      box.scrollTop = box.scrollHeight;
    } catch (err) {
      toast(err.message, 'err');
    }
  },
  'modal-ok'() {
    const input = $('#modal-input');
    S.modalValue = input ? input.value : '';
    closeModal(true);
  },
  'modal-cancel': () => closeModal(false),
};

async function useProfile(name) {
  const ids = S.settings.profiles[name];
  if (!ids) return;
  if (!requireGame()) return;
  await applyEnabled(ids);
  await setSetting({ activeProfile: name });
  toast(`Profile "${name}" is in use.`, 'ok');
  render();
}

/* ---------- events ---------- */

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  // A button inside a card wins over the card itself.
  const fn = ACTIONS[el.dataset.action];
  if (fn) fn(el);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#modal').hidden) closeModal(null);
    else if (S.drawerId) closeDrawer();
  }
  if (e.key === 'Enter') {
    if (e.target.id === 'modal-input' && e.target.tagName === 'INPUT') ACTIONS['modal-ok']();
    else if (e.target.classList && e.target.classList.contains('card')) openDrawer(e.target.dataset.id);
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    if (S.page !== 'browse' && S.page !== 'installed') {
      S.page = 'browse';
      render();
    }
    const box = main.querySelector('.search input');
    if (box) box.focus();
  }
});

$('#modal').addEventListener('mousedown', (e) => {
  if (e.target.id === 'modal') closeModal(null);
});

let typing = 0;
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.input === 'browse-q') {
    clearTimeout(typing);
    typing = setTimeout(() => {
      S.browse.q = t.value;
      S.browse.shown = PAGE_SIZE;
      fillResults();
      main.scrollTop = 0;
    }, 120);
  } else if (t.dataset.input === 'inst-q') {
    S.inst.q = t.value;
    const box = $('#inst-rows');
    if (box) box.innerHTML = installedRows();
  } else if (t.type === 'range' && t.dataset.setting) {
    S.settings[t.dataset.setting] = Number(t.value);
    applyTheme();
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.toggle) return doToggle(t.dataset.toggle, t.checked);
  if (t.dataset.input === 'browse-sort') {
    S.browse.sort = t.value;
    S.browse.shown = PAGE_SIZE;
    fillResults();
    return;
  }
  if (t.dataset.input === 'profile-pick') {
    if (t.value) return useProfile(t.value);
    await setSetting({ activeProfile: '' });
    return render();
  }
  const key = t.dataset.setting;
  if (!key) return;
  const value = t.type === 'checkbox' ? t.checked : t.type === 'range' ? Number(t.value) : t.value;
  await setSetting({ [key]: value });
  if (key === 'platform') await redetect();
  if (t.type !== 'range' && t.type !== 'text') render();
});

api.on('progress', (p) => {
  const bar = $('#jobbar');
  if (p.phase === 'done') {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const step = p.count > 1 ? ` (${p.index} of ${p.count})` : '';
  const name = String(p.name || '').replace(/_/g, ' ');
  if (p.phase === 'download') {
    const pct = p.total ? Math.min(100, (p.done / p.total) * 100) : 0;
    bar.innerHTML = `<div>Downloading <b>${esc(name)}</b>${step} · ${mb(p.done)}${p.total ? ' of ' + mb(p.total) : ''}</div><div class="bar"><i style="width:${pct}%"></i></div>`;
  } else {
    bar.innerHTML = `<div>Installing <b>${esc(name)}</b>${step}</div><div class="bar busy"><i></i></div>`;
  }
});

async function pollRunning() {
  try {
    const now = await api.call('game:running');
    if (now !== S.running) {
      S.running = now;
      if (now) S.launching = false;
      if (S.page === 'home' && $('#modal').hidden) render();
      else renderNav();
    }
  } catch {}
}

/* ---------- start ---------- */

(async function start() {
  try {
    const init = await api.call('app:init');
    Object.assign(S, { settings: init.settings, game: init.game, version: init.version, portable: init.portable, dataDir: init.dataDir });
  } catch (err) {
    main.innerHTML = `<div class="empty"><b>BoneLaunch could not start</b>${esc(err.message)}</div>`;
    return;
  }
  applyTheme();
  await reloadInstalled();
  render();
  pollRunning();
  setInterval(pollRunning, 5000);
  await loadPackages(false);
  const ups = updates().length;
  if (ups && S.settings.checkUpdatesOnStart) toast(`${ups} mod update${ups === 1 ? '' : 's'} available.`);
})();

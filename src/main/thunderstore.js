// Talks to Thunderstore's BONELAB community.
const fs = require('fs');
const store = require('./store');

const LIST_URL = 'https://thunderstore.io/c/bonelab/api/v1/package/';
const CACHE = 'packages.json';
const MAX_AGE = 30 * 60 * 1000;
const LOADER_ID = 'LavaGang-MelonLoader';

let memory = null;

function slim(p) {
  const v = p.versions[0];
  return {
    id: p.full_name,
    name: p.name,
    owner: p.owner,
    desc: v.description || '',
    icon: v.icon || '',
    version: v.version_number,
    deps: v.dependencies || [],
    downloads: p.versions.reduce((n, x) => n + (x.downloads || 0), 0),
    rating: p.rating_score || 0,
    cats: p.categories || [],
    updated: p.date_updated,
    created: p.date_created,
    nsfw: !!p.has_nsfw_content,
    deprecated: !!p.is_deprecated,
    pinned: !!p.is_pinned,
    size: v.file_size || 0,
    url: p.package_url,
    site: v.website_url || '',
    versions: p.versions.slice(0, 20).map((x) => ({
      v: x.version_number,
      url: x.download_url,
      size: x.file_size || 0,
      date: x.date_created,
      deps: x.dependencies || [],
    })),
  };
}

async function getPackages(force) {
  if (!force && memory && Date.now() - memory.fetchedAt < MAX_AGE) return memory;
  const cached = memory || store.read(CACHE, null);
  if (!force && cached && Date.now() - cached.fetchedAt < MAX_AGE) {
    memory = cached;
    return memory;
  }
  try {
    const res = await fetch(LIST_URL, { headers: { 'User-Agent': 'BoneLaunch' } });
    if (!res.ok) throw new Error('Thunderstore answered ' + res.status);
    const raw = await res.json();
    memory = { fetchedAt: Date.now(), offline: false, list: raw.filter((p) => p.versions && p.versions.length).map(slim) };
    store.write(CACHE, memory);
    return memory;
  } catch (err) {
    if (cached) {
      memory = { ...cached, offline: true };
      return memory;
    }
    throw new Error('Could not reach Thunderstore. Check your internet connection. (' + err.message + ')');
  }
}

async function getReadme(owner, name, version) {
  const url = `https://thunderstore.io/api/experimental/package/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/readme/`;
  const res = await fetch(url, { headers: { 'User-Agent': 'BoneLaunch' } });
  if (!res.ok) return '';
  const data = await res.json();
  return String(data.markdown || '').slice(0, 20000);
}

async function download(url, dest, onProgress) {
  if (!/^https:\/\/thunderstore\.io\//.test(url)) throw new Error('Refusing to download from an unknown address.');
  const res = await fetch(url, { headers: { 'User-Agent': 'BoneLaunch' } });
  if (!res.ok || !res.body) throw new Error('Download failed (' + res.status + ')');
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(dest);
  let done = 0;
  try {
    for await (const chunk of res.body) {
      done += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (onProgress) onProgress(done, total);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
}

function clearCache() {
  memory = null;
  try {
    fs.unlinkSync(store.file(CACHE));
  } catch {}
}

module.exports = { getPackages, getReadme, download, clearCache, LOADER_ID };

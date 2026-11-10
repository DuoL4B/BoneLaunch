// Draws the default home background (assets/bg.jpg) and the app icon.
// Both are original artwork generated here, so the repo ships no game art.
// Usage: node scripts/prep-assets.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');

const ICON = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#141b26"/>
      <stop offset="1" stop-color="#06080c"/>
    </linearGradient>
    <linearGradient id="go" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6dff9a"/>
      <stop offset="1" stop-color="#1fb857"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="104" fill="url(#tile)"/>
  <rect x="16" y="16" width="480" height="480" rx="104" fill="none" stroke="#5fe0ea" stroke-opacity=".35" stroke-width="6"/>
  <g transform="rotate(-45 256 256)" fill="#dfeff2" opacity=".9">
    <rect x="96" y="232" width="320" height="48" rx="12"/>
    <circle cx="96" cy="226" r="38"/><circle cx="96" cy="286" r="38"/>
    <circle cx="416" cy="226" r="38"/><circle cx="416" cy="286" r="38"/>
  </g>
  <path d="M206 150 L390 256 L206 362 Z" fill="url(#go)" stroke="#06080c" stroke-width="18" stroke-linejoin="round"/>
</svg>`;

// A dark test hall: pillars, a gantry, a glowing orb and a tiled floor.
function background() {
  const W = 1920;
  const H = 760;
  const horizon = 500;
  const vx = 1180; // vanishing point, under the orb

  // Deterministic pseudo-random so the picture is the same every build.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  let far = '';
  let windows = '';
  for (let x = -40; x < W; ) {
    const w = 70 + rnd() * 150;
    const h = 120 + rnd() * 260;
    far += `<rect x="${x.toFixed(0)}" y="${(horizon - h).toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}"/>`;
    if (rnd() > 0.45) {
      const wx = x + 14 + rnd() * (w - 40);
      const wy = horizon - h + 30 + rnd() * (h - 70);
      windows += `<rect x="${wx.toFixed(0)}" y="${wy.toFixed(0)}" width="12" height="20"/>`;
    }
    x += w + 18 + rnd() * 60;
  }

  let near = '';
  for (const [x, w, h] of [[60, 210, 300], [420, 150, 210], [1430, 180, 250], [1700, 260, 340]]) {
    near += `<path d="M${x} ${horizon + 20} V${horizon - h + 40} L${x + w / 2} ${horizon - h} L${x + w} ${horizon - h + 40} V${horizon + 20} Z"/>`;
  }

  let floor = '';
  for (let i = -24; i <= 24; i++) {
    floor += `<line x1="${vx + i * 26}" y1="${horizon}" x2="${vx + i * 260}" y2="${H}"/>`;
  }
  for (let i = 0, y = horizon; y < H; i++) {
    y = horizon + 6 * Math.pow(1.42, i);
    floor += `<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}"/>`;
  }

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0c1c2b"/><stop offset=".65" stop-color="#0b131d"/><stop offset="1" stop-color="#07090d"/>
    </linearGradient>
    <radialGradient id="halo"><stop offset="0" stop-color="#5fe0ea" stop-opacity=".55"/><stop offset="1" stop-color="#5fe0ea" stop-opacity="0"/></radialGradient>
    <radialGradient id="ember"><stop offset="0" stop-color="#ff8a3c" stop-opacity=".6"/><stop offset="1" stop-color="#ff8a3c" stop-opacity="0"/></radialGradient>
    <radialGradient id="core"><stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#9ff3f9"/><stop offset="1" stop-color="#5fe0ea"/></radialGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="3"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  <circle cx="${vx}" cy="400" r="460" fill="url(#halo)"/>
  <g fill="#13273a">${far}</g>
  <g stroke="#1b3348" stroke-width="12" fill="none">
    <path d="M0 150 H${W}"/><path d="M0 186 H${W}" stroke-width="4"/>
    <path d="M300 150 V${horizon} M860 150 V${horizon} M1500 150 V${horizon}" stroke-width="16"/>
    <path d="M300 150 l90 36 M860 150 l-90 36 M860 150 l90 36 M1500 150 l-90 36"/>
  </g>
  <g fill="#ffb066" filter="url(#blur)">${windows}</g>
  <rect y="${horizon}" width="${W}" height="${H - horizon}" fill="#0a1019"/>
  <g stroke="#5fe0ea" stroke-opacity=".22" stroke-width="1.5">${floor}</g>
  <ellipse cx="${vx}" cy="${horizon + 60}" rx="330" ry="46" fill="url(#halo)"/>
  <g fill="#0a141e">${near}</g>
  <circle cx="1660" cy="${horizon + 70}" r="260" fill="url(#ember)"/>
  <circle cx="${vx}" cy="400" r="70" fill="none" stroke="#5fe0ea" stroke-opacity=".5" stroke-width="3"/>
  <circle cx="${vx}" cy="400" r="46" fill="url(#core)"/>
</svg>`;
}

(async () => {
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });

  await sharp(Buffer.from(background())).jpeg({ quality: 90 }).toFile(path.join(root, 'assets', 'bg.jpg'));
  console.log('bg.jpg written');

  const png = await sharp(Buffer.from(ICON)).png().toBuffer();
  fs.writeFileSync(path.join(root, 'assets', 'icon.png'), png);
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), png);
  console.log('icon.png written');
})();

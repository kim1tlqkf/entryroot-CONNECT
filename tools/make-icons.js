// 확장 아이콘(16·32·48·128 PNG)을 SVG 그림에서 만든다. 시험용 크롬으로 그려서 찍는다.
//   node tools/make-icons.js
const fs = require('fs'), path = require('path');
const { launch, sleep } = require('../tests/e2e/chrome');

// 파란 바탕에 엔트리 블록 두 개가 맞물린 모양(같이 만든다는 뜻)
const SVG = size => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <rect x="4" y="4" width="120" height="120" rx="28" fill="#2e6ff2"/>
  <path d="M24 30h18l5 6h12l5-6h30a8 8 0 0 1 8 8v16a8 8 0 0 1-8 8H64l-5 6H47l-5-6H24a8 8 0 0 1-8-8V38a8 8 0 0 1 8-8z" fill="#ffd34e"/>
  <path d="M36 66h18l5 6h12l5-6h28a8 8 0 0 1 8 8v16a8 8 0 0 1-8 8H76l-5 6H59l-5-6H36a8 8 0 0 1-8-8V74a8 8 0 0 1 8-8z" fill="#5ed37c"/>
</svg>`;

(async () => {
  const out = path.join(__dirname, '..', 'icons');
  fs.mkdirSync(out, { recursive: true });
  const c = await launch({ name: 'icons', viewport: { width: 256, height: 256 } });
  try {
    await c.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    for (const size of [16, 32, 48, 128]) {
      const html = `<html><body style="margin:0;background:transparent">${SVG(size)}</body></html>`;
      await c.send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) });
      await sleep(300);
      const r = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
      fs.writeFileSync(path.join(out, `${size}.png`), Buffer.from(r.result.data, 'base64'));
      console.log('icons/' + size + '.png');
    }
  } finally { await c.close(); }
})();

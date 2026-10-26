// 큰 작품에서 블록 하나를 더할 때 어느 함수가 시간을 쓰는지(크롬 프로파일러) — 방장(A)·참가자(B)
//   node tests/e2e/profile.js
const path = require('path');
const { launch, openEntry, sleep } = require('./chrome');
const ext = path.resolve(__dirname, '..', '..');
const uiFind = (sel, text, nth = 0) => `(() => { const r = document.getElementById('entry-hapjak-root').shadowRoot; const els = [...r.querySelectorAll(${JSON.stringify(sel)})].filter(e => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'} && e.getBoundingClientRect().width > 0); const e = els[${nth}]; if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`;
async function uiClick(c, sel, text, nth = 0) { const p = await c.waitFor(uiFind(sel, text, nth), 15000); await c.click(p.x, p.y); await sleep(150); }
const BUILD = require('./bigproject')(30, 10, 20, 8);

function summarize(profile, top = 14) {
  const self = new Map();
  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  const dt = profile.timeDeltas; const samples = profile.samples;
  for (let i = 0; i < samples.length; i++) {
    const n = byId.get(samples[i]); const f = n.callFrame;
    if (f.functionName === '(idle)' || f.functionName === '(program)') continue;
    const key = `${f.functionName || '(anon)'} @ ${(f.url || '').split('/').pop().split('?')[0]}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + (dt[i] || 0) / 1000);
  }
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => `${Math.round(v)}ms  ${k}`);
}

(async () => {
  const [A, B] = await Promise.all([launch({ ext, name: 'A' }), launch({ ext, name: 'B' })]);
  try {
    await Promise.all([openEntry(A), openEntry(B)]);
    await A.evalJs(BUILD); await sleep(3000);
    await uiClick(A, '.fab'); await uiClick(A, 'input', null, 0); await A.type('A'); await uiClick(A, 'button.main', '새 방 만들기');
    const code = await A.waitFor(`(s => s.mode === 'room' && s.code)(__entryHapjak.status())`, 120000);
    await uiClick(B, '.fab'); await uiClick(B, 'input', null, 0); await B.type('B'); await uiClick(B, 'input', null, 1); await B.type(code); await uiClick(B, 'button.sub', '참여하기');
    await B.waitFor(`__entryHapjak.status().mode === 'room'`, 300000);
    await sleep(4000);
    for (const c of [A, B]) { await c.send('Profiler.enable'); await c.send('Profiler.setSamplingInterval', { interval: 200 }); await c.send('Profiler.start'); }
    await A.evalJs(`Entry.do('addThread', [{ id: 'profAdd', type: 'when_run_button_click', x: 900, y: 900, params: [null] }]); true`);
    await B.waitFor(`JSON.stringify(Entry.exportProject().objects).includes('profAdd')`, 60000);
    await sleep(1500);
    for (const c of [A, B]) {
      const r = await c.send('Profiler.stop');
      console.log(`\n== ${c.name} 블록 하나 추가 동안 가장 오래 쓴 함수(자기 시간)`);
      console.log(summarize(r.result.profile).join('\n'));
    }
  } finally { await Promise.all([A.close(), B.close()]); }
})();

// 실제 작품에서 방장 쪽 편집 비용: 방 없이 vs 방 연 뒤, 그리고 방 연 뒤 어느 함수가 시간을 쓰는지
//   node tests/e2e/host-edit-cost.js <작품.json> [오브젝트 id]
const fs = require('fs'), path = require('path');
const { launch, openEntry, sleep } = require('./chrome');
const file = process.argv[2];
const objId = process.argv[3] || '7y0y';
const ext = path.resolve(__dirname, '..', '..');
const uiFind = (sel, text, nth = 0) => `(() => { const r = document.getElementById('entry-hapjak-root').shadowRoot; const els = [...r.querySelectorAll(${JSON.stringify(sel)})].filter(e => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'} && e.getBoundingClientRect().width > 0); const e = els[${nth}]; if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`;
async function uiClick(c, sel, text, nth = 0) { const p = await c.waitFor(uiFind(sel, text, nth), 20000); await c.click(p.x, p.y); await sleep(150); }
const LONGTASK = `(() => { window.__lt = []; try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ type: 'longtask' }); } catch (e) { window.__ltErr = String(e); } return true; })()`;
const takeLT = c => c.evalJs(`(() => { const a = window.__lt || []; window.__lt = []; return { n: a.length, total: a.reduce((s, x) => s + x, 0), max: Math.max(0, ...a) }; })()`);

function summarize(prof) {
  const byId = new Map(prof.nodes.map(n => [n.id, n])); const parent = new Map();
  for (const n of prof.nodes) for (const ch of n.children || []) parent.set(ch, n.id);
  const self = new Map(), ours = new Map();
  for (let i = 0; i < prof.samples.length; i++) {
    const dt = (prof.timeDeltas[i] || 0) / 1000; let id = prof.samples[i]; const f0 = byId.get(id).callFrame;
    if (/^\((idle|program)\)$/.test(f0.functionName)) continue;
    const k0 = `${f0.functionName || '(anon)'} @ ${(f0.url || '').split('/').pop().split('?')[0]}:${f0.lineNumber + 1}`; self.set(k0, (self.get(k0) || 0) + dt);
    const seen = new Set();
    while (id != null) { const f = byId.get(id).callFrame; if (/chrome-extension:/.test(f.url)) { const k = `${f.functionName || '(anon)'} @ ${f.url.split('/').pop()}:${f.lineNumber + 1}`; if (!seen.has(k)) { seen.add(k); ours.set(k, (ours.get(k) || 0) + dt); } } id = parent.get(id); }
  }
  const top = m => [...m].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => Math.round(v) + 'ms ' + k);
  return { self: top(self), oursInclusive: top(ours) };
}

(async () => {
  const project = JSON.parse(fs.readFileSync(file, 'utf8'));
  const A = await launch({ ext, name: 'A' });
  const out = {};
  try {
    await openEntry(A);
    await A.send('Runtime.evaluate', { expression: `window.__fixture = ${JSON.stringify(JSON.stringify(project))}; true` });
    await A.evalJs(`(() => { const p = JSON.parse(window.__fixture); delete window.__fixture; Entry.clearProject(); Entry.loadProject(p); Entry.container.selectObject(${JSON.stringify(objId)}); return true; })()`);
    await sleep(8000);
    await A.evalJs(LONGTASK);
    const add = n => A.evalJs(`Entry.do('addThread', [{ id: '${n}', type: 'when_run_button_click', x: 1400, y: 1400, params: [null] }]); true`);
    await add('base1'); await sleep(4000); out.noRoom1 = await takeLT(A);
    await add('base2'); await sleep(4000); out.noRoom2 = await takeLT(A);
    await uiClick(A, '.fab'); await uiClick(A, 'input', null, 0); await A.type('A'); await uiClick(A, 'button.main', '새 방 만들기');
    await A.waitFor(`__entryHapjak.status().mode === 'room'`, 180000);
    await sleep(6000); await takeLT(A);
    await add('room1'); await sleep(4000); out.room1 = await takeLT(A);
    await A.send('Profiler.enable'); await A.send('Profiler.setSamplingInterval', { interval: 500 }); await A.send('Profiler.start');
    await add('room2'); await sleep(4000); out.room2 = await takeLT(A);
    out.profileRoom2 = summarize((await A.send('Profiler.stop')).result.profile);
  } catch (e) { out.error = String(e.message || e).slice(0, 300); }
  finally { console.log(JSON.stringify(out, null, 1)); await A.close(); }
})();

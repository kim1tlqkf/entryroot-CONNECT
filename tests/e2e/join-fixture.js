// 실제 작품 파일(JSON)로 방 열기·참여가 되는지, 어디서 얼마나 걸리는지 잰다. 작품 파일은 저장소에 넣지 않는다.
//   node tests/e2e/join-fixture.js <작품.json>
const fs = require('fs'), path = require('path');
const { launch, openEntry, sleep } = require('./chrome');

const file = process.argv[2];
const PROFILE = process.argv.includes('--profile');
if (!file) { console.error('작품 JSON 경로를 주세요'); process.exit(2); }
const ext = path.resolve(__dirname, '..', '..');
const uiFind = (sel, text, nth = 0) => `(() => { const r = document.getElementById('entry-hapjak-root').shadowRoot; const els = [...r.querySelectorAll(${JSON.stringify(sel)})].filter(e => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'} && e.getBoundingClientRect().width > 0); const e = els[${nth}]; if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`;
async function uiClick(c, sel, text, nth = 0) { const p = await c.waitFor(uiFind(sel, text, nth), 20000); await c.click(p.x, p.y); await sleep(150); }
const LONGTASK = `(() => { window.__lt = []; try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ type: 'longtask' }); } catch (e) { window.__ltErr = String(e); } return true; })()`;
const takeLT = c => c.evalJs(`(() => { const a = window.__lt || []; window.__lt = []; return { n: a.length, total: a.reduce((s, x) => s + x, 0), max: Math.max(0, ...a) }; })()`);
const toasts = c => c.evalJs(`[...document.getElementById('entry-hapjak-root').shadowRoot.querySelectorAll('.toast')].map(t => t.textContent)`).catch(() => []);

(async () => {
  const project = JSON.parse(fs.readFileSync(file, 'utf8'));
  const [A, B] = await Promise.all([launch({ ext, name: 'A' }), launch({ ext, name: 'B' })]);
  const out = { sizeMB: Math.round(fs.statSync(file).size / 1e5) / 10 };
  const watch = setInterval(async () => { try { out.lastToastsB = await toasts(B); } catch { /* 무시 */ } }, 2000);
  try {
    await Promise.all([openEntry(A), openEntry(B)]);
    // 방장 쪽에 작품 넣기(사람이 자기 작품을 연 것과 같은 상태)
    await A.send('Runtime.evaluate', { expression: `window.__fixture = ${JSON.stringify(JSON.stringify(project))}; true` });
    let t0 = Date.now();
    await A.evalJs(`(() => { const p = JSON.parse(window.__fixture); delete window.__fixture; Entry.clearProject(); Entry.loadProject(p); return true; })()`);
    out.hostEntryLoadMs = Date.now() - t0;
    await sleep(5000);
    await Promise.all([A, B].map(c => c.evalJs(LONGTASK)));

    t0 = Date.now();
    await uiClick(A, '.fab'); await uiClick(A, 'input', null, 0); await A.type('A'); await uiClick(A, 'button.main', '새 방 만들기');
    const code = await A.waitFor(`(s => s.mode === 'room' && s.code)(__entryHapjak.status())`, 180000, '방 열림');
    out.hostOpen = { ms: Date.now() - t0, lt: await takeLT(A) };
    await sleep(10000);
    out.hostIdle10s = await takeLT(A);

    if (PROFILE) for (const c of [A, B]) { await c.send('Profiler.enable'); await c.send('Profiler.setSamplingInterval', { interval: 1000 }); await c.send('Profiler.start'); }
    t0 = Date.now();
    await uiClick(B, '.fab'); await uiClick(B, 'input', null, 0); await B.type('B'); await uiClick(B, 'input', null, 1); await B.type(code); await uiClick(B, 'button.sub', '참여하기');
    let joined = false;
    for (let i = 0; i < 240; i++) {
      await sleep(1000);
      const st = await B.evalJs(`__entryHapjak.status()`).catch(e => ({ err: String(e.message) }));
      if (st.mode === 'room') { joined = true; break; }
      if (st.mode === 'idle' && i > 3) { out.joinGaveUp = { afterMs: Date.now() - t0, status: st }; break; }
    }
    out.guestJoin = { joined, ms: Date.now() - t0, times: await B.evalJs(`__entryHapjak.status().joinTimes`).catch(() => null), lt: await takeLT(B), hostLT: await takeLT(A) };
    out.toastsB = await toasts(B);
    if (PROFILE) for (const c of [A, B]) {
      const r = await c.send('Profiler.stop');
      const prof = r.result.profile; const byId = new Map(prof.nodes.map(n => [n.id, n])); const self = new Map();
      // 함수별 자기 시간 + 우리 코드 파일에 대해선 부른 쪽까지 묶어서
      for (let i = 0; i < prof.samples.length; i++) { const n = byId.get(prof.samples[i]); const f = n.callFrame; if (/^\((idle|program)\)$/.test(f.functionName)) continue; const k = `${f.functionName || '(anon)'} @ ${(f.url || '').split('/').pop().split('?')[0]}:${f.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + (prof.timeDeltas[i] || 0) / 1000); }
      const parent = new Map(); for (const n of prof.nodes) for (const ch of n.children || []) parent.set(ch, n.id);
      const ours = new Map();
      for (let i = 0; i < prof.samples.length; i++) { let id = prof.samples[i]; const seen = new Set(); while (id != null) { const f = byId.get(id).callFrame; if (/chrome-extension:/.test(f.url)) { const k = `${f.functionName || '(anon)'} @ ${f.url.split('/').pop()}:${f.lineNumber + 1}`; if (!seen.has(k)) { seen.add(k); ours.set(k, (ours.get(k) || 0) + (prof.timeDeltas[i] || 0) / 1000); } } id = parent.get(id); } }
      out['profile' + c.name] = { self: [...self].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([k, v]) => Math.round(v) + 'ms ' + k), oursInclusive: [...ours].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, v]) => Math.round(v) + 'ms ' + k) };
    }
    if (joined) {
      await sleep(10000);
      out.idle10s = { host: await takeLT(A), guest: await takeLT(B) };
      out.guestObjects = await B.evalJs('Entry.container.getAllObjects().length');
      out.guestFunctions = await B.evalJs('Object.keys(Entry.variableContainer.functions_).length');

      // ── 큰 작품에서 편집: 받는 쪽이 작품 전체를 다시 불러오지 않는지(오브젝트에 표시를 해 두고 그대로 남는지) ──
      const markB = () => B.evalJs(`(() => { Entry.container.getAllObjects().forEach(o => { o.__mark = 1; }); window.__fnMark = Object.keys(Entry.variableContainer.functions_).length; return true; })()`);
      const noReloadB = () => B.evalJs(`Entry.container.getAllObjects().every(o => o.__mark === 1)`);
      const step = async (name, doA, waitB) => {
        await markB(); await takeLT(B); await takeLT(A);
        const t = Date.now();
        await A.evalJs(doA);
        try { await B.waitFor(waitB, 120000, name); } catch (e) { out.edits[name] = { error: String(e.message).slice(0, 200) }; return; }
        await sleep(1500);
        out.edits[name] = { ms: Date.now() - t, guestLT: await takeLT(B), hostLT: await takeLT(A), noReload: await noReloadB() };
      };
      out.edits = {};
      const fid = await A.evalJs(`Object.keys(Entry.variableContainer.functions_)[5]`);
      await step('함수 내용 고치기', `(() => { const f = Entry.variableContainer.functions_[${JSON.stringify(fid)}]; f.content.createThread([{ id: 'fxEdit1', type: 'when_run_button_click', x: 900, y: 900, params: [null] }]); return true; })()`,
        `Entry.variableContainer.functions_[${JSON.stringify(fid)}].content.stringify().includes('fxEdit1')`);
      await step('변수 추가', `Entry.do('variableContainerAddVariable', new Entry.Variable({ id: 'fxVar1', name: '시험변수fx', variableType: 'variable', value: 3, visible: false })); true`,
        `!!Entry.variableContainer.getVariable('fxVar1')`);
      await step('신호 추가', `Entry.do('variableContainerAddMessage', { id: 'fxMsg1', name: '시험신호fx' }); true`,
        `!!Entry.variableContainer.messages_.find(m => m.id === 'fxMsg1')`);
      await step('모양 추가', `(() => { const o = Entry.container.getObject('opx9'); const pic = { ...JSON.parse(JSON.stringify(Entry.getPicturesJSON([o.pictures[0]])[0])), id: 'fxPic1', name: '시험모양' }; Entry.do('objectAddPicture', 'opx9', pic); return true; })()`,
        `!!Entry.container.getObject('opx9').pictures.find(p => p.id === 'fxPic1')`);
      await step('큰 오브젝트에 블록 추가', `(() => { Entry.container.selectObject('7y0y'); Entry.do('addThread', [{ id: 'fxBlk1', type: 'when_run_button_click', x: 1500, y: 1500, params: [null] }]); return true; })()`,
        `Entry.container.getObject('7y0y').script.stringify().includes('fxBlk1')`);
      // 마지막에 두 사람 작품이 같은지(오브젝트·함수·변수·신호 조각)
      await sleep(4000);
      const strip = `(u => { const o = {}; for (const [k, v] of Object.entries(u || {})) { if (v == null || /Order$/.test(k)) continue; if (k.startsWith('obj:')) { const x = JSON.parse(v); if (x.objectType === 'textBox' && x.entity) { delete x.entity.width; delete x.entity.height; } o[k] = JSON.stringify(x); } else o[k] = v; } return o; })`;
      const [ua, ub] = await Promise.all([A.evalJs(`${strip}(__entryHapjak.exportUnits())`), B.evalJs(`${strip}(__entryHapjak.exportUnits())`)]);
      out.sameAfterEdits = ua && ub ? Object.keys({ ...ua, ...ub }).filter(k => ua[k] !== ub[k]).slice(0, 10) : 'export 실패';
    }
  } catch (e) {
    out.error = String(e.message || e).slice(0, 500);
  } finally {
    clearInterval(watch);
    out.consoleB = B.consoleLines.slice(-8);
    out.consoleA = A.consoleLines.slice(-8);
    console.log(JSON.stringify(out, null, 1));
    await Promise.all([A.close(), B.close()]);
  }
})();

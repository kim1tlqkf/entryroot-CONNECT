// 큰 작품에서 합작이 화면을 얼마나 멈추게 하는지 잰다(실제 엔트리, 크롬 2개).
//   node tests/e2e/perf.js [오브젝트 수] [오브젝트마다 묶음 수] [묶음마다 블록 수] [오브젝트마다 모양 수]
const path = require('path');
const { launch, openEntry, sleep } = require('./chrome');

const [N = 30, T = 10, B = 20, P = 8] = process.argv.slice(2).map(Number);
const ext = path.resolve(__dirname, '..', '..');

const uiFind = (sel, text, nth = 0) => `(() => { const r = document.getElementById('entry-hapjak-root').shadowRoot; const els = [...r.querySelectorAll(${JSON.stringify(sel)})].filter(e => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'} && e.getBoundingClientRect().width > 0); const e = els[${nth}]; if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`;
async function uiClick(c, sel, text, nth = 0) { const p = await c.waitFor(uiFind(sel, text, nth), 15000); await c.click(p.x, p.y); await sleep(150); }

// 페이지 안: 긴 작업(50ms 넘게 화면이 멈춘 구간) 기록
const LONGTASK = `(() => { window.__lt = []; try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: false }); } catch (e) {} return true; })()`;
const takeLT = c => c.evalJs(`(() => { const a = window.__lt || []; window.__lt = []; const tot = a.reduce((s, x) => s + x[1], 0); const max = a.reduce((m, x) => Math.max(m, x[1]), 0); return { n: a.length, total: tot, max }; })()`);

const BUILD = require('./bigproject')(N, T, B, P);

(async () => {
  const [A, Bc] = await Promise.all([launch({ ext, name: 'A' }), launch({ ext, name: 'B' })]);
  const out = {};
  try {
    await Promise.all([openEntry(A), openEntry(Bc)]);
    out.size = await A.evalJs(BUILD);
    await sleep(3000);
    out.exportProjectMs = await A.evalJs(`(() => { const t = performance.now(); Entry.exportProject(); return Math.round(performance.now() - t); })()`);

    await Promise.all([A, Bc].map(c => c.evalJs(LONGTASK)));
    // 비교 기준: 방 없이(합작 꺼진 상태) 같은 블록 추가에 엔트리 자체가 쓰는 시간
    await A.evalJs(`Entry.do('addThread', [{ id: 'baseAdd', type: 'when_run_button_click', x: 900, y: 700, params: [null] }]); true`);
    await sleep(2000);
    out.baselineAddBlockNoRoom = await takeLT(A);
    let t0 = Date.now();
    await uiClick(A, '.fab'); await uiClick(A, 'input', null, 0); await A.type('A'); await uiClick(A, 'button.main', '새 방 만들기');
    const code = await A.waitFor(`(s => s.mode === 'room' && s.code)(__entryHapjak.status())`, 120000);
    out.hostOpen = { ms: Date.now() - t0, longtasks: await takeLT(A) };
    out.exportUnitsMs = await A.evalJs(`(() => { const t = performance.now(); __entryHapjak.exportUnits(); return Math.round(performance.now() - t); })()`);
    // 바뀐 것만 읽는 결과가 작품 전체를 처음부터 읽은 결과와 같은지
    out.incrementalEqualsFull = await A.evalJs(`(() => { const inc = __entryHapjak.exportUnits(); const full = ErcMerge.projectToUnits(Entry.exportProject(), k => undefined); const ks = new Set([...Object.keys(inc), ...Object.keys(full)]); const diff = [...ks].filter(k => k !== 'meta' && inc[k] !== full[k]); return diff.length ? diff.slice(0, 5) : true; })()`);

    // 가만히 10초: 주기 점검이 화면을 얼마나 막나
    await sleep(10000);
    out.hostIdle10s = await takeLT(A);

    t0 = Date.now();
    await uiClick(Bc, '.fab'); await uiClick(Bc, 'input', null, 0); await Bc.type('B'); await uiClick(Bc, 'input', null, 1); await Bc.type(code); await uiClick(Bc, 'button.sub', '참여하기');
    await Bc.waitFor(`__entryHapjak.status().mode === 'room'`, 300000);
    out.guestJoin = { ms: Date.now() - t0, guestLT: await takeLT(Bc), hostLT: await takeLT(A), phases: await Bc.evalJs(`(t => ({ connect: t.connected - t.start, welcome: t.welcome - t.connected, load: t.loaded - t.welcome }))(__entryHapjak.status().joinTimes)`) };

    await sleep(10000);
    out.idle10s = { host: await takeLT(A), guest: await takeLT(Bc) };

    // 블록 하나 추가 → 참가자에게 보일 때까지
    t0 = Date.now();
    await A.evalJs(`Entry.do('addThread', [{ id: 'perfAdd', type: 'when_run_button_click', x: 900, y: 900, params: [null] }]); true`);
    await Bc.waitFor(`JSON.stringify(Entry.exportProject().objects).includes('perfAdd')`, 120000);
    out.addBlock = { ms: Date.now() - t0, host: await takeLT(A), guest: await takeLT(Bc) };

    // 오브젝트 이동(부분 반영)
    t0 = Date.now();
    await A.evalJs(`Entry.do('objectUpdatePosX', Entry.playground.object.id, 77); true`);
    await Bc.waitFor(`Entry.container.getObject(${JSON.stringify('perf0')}) && Entry.playground && Entry.container.getAllObjects().some(o => o.entity.getX() === 77)`, 120000);
    out.moveObject = { ms: Date.now() - t0, host: await takeLT(A), guest: await takeLT(Bc) };

    // 변수 추가(작품 다시 불러오기)
    t0 = Date.now();
    await A.evalJs(`Entry.do('variableContainerAddVariable', new Entry.Variable({ id: 'perfVar', name: '점수p', variableType: 'variable', value: 1, visible: true })); true`);
    await Bc.waitFor(`!!Entry.variableContainer.getVariable('perfVar')`, 180000);
    out.fullReload = { ms: Date.now() - t0, host: await takeLT(A), guest: await takeLT(Bc) };
  } catch (e) {
    out.error = String(e.message || e).slice(0, 400);
  } finally {
    console.log(JSON.stringify(out, null, 1));
    await Promise.all([A.close(), Bc.close()]);
  }
})();

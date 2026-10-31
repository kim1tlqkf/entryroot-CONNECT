// 엔트리루트를 켠 사람(A)과 안 켠 사람(B)이 같이 고칠 때. 엔트리루트는 순정 블록을 화면에서만 전용 블록으로 바꿔 보여 주고,
// 플러그인 블록을 처음 쓰면 작품에 시스템 오브젝트·함수·리스트를 넣는다. 안 켠 사람의 엔트리가 멈추면 안 된다.
//   node tests/e2e/entryroot.js --entryroot <엔트리루트 확장 폴더> [--ext 합작 확장 폴더] [--swap]   (또는 환경 변수 ENTRYROOT_EXT)
//   --swap: 안 켠 사람이 방장, 켠 사람이 참가자
const fs = require('fs'), path = require('path');
const { launch, openEntry, closeGuide, sleep } = require('./chrome');
const { checker, converged, openRoom, joinRoom } = require('./room');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i < 0 ? def : process.argv[i + 1]; };
const ext = path.resolve(arg('ext', path.resolve(__dirname, '..', '..')));
const er = arg('entryroot', process.env.ENTRYROOT_EXT || null);
const swap = process.argv.includes('--swap');
if (!er || !fs.existsSync(path.join(er, 'manifest.json'))) { console.log('엔트리루트 확장 폴더가 없어 이 시험을 못 돌림(--entryroot 또는 ENTRYROOT_EXT)'); process.exit(2); }
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.join(__dirname, 'out', 'entryroot-' + stamp);
fs.mkdirSync(out, { recursive: true });
const { results, check } = checker();
const J = JSON.stringify;
const liveHasFlow = `JSON.stringify(Entry.playground.object.script.toJSON()).includes('entryroot_flow_')`;
const roomText = `JSON.stringify(__entryHapjak.serverUnits())`;
const count = `({ objs: Entry.container.getAllObjects().length, funcs: Object.keys(Entry.variableContainer.functions_ || {}).length, lists: Entry.variableContainer.lists_.length })`;
const addThread = (id, y) => `(() => { Entry.do('addThread', [{ id: ${J(id)}, type: 'when_run_button_click', x: 900, y: ${y}, params: [null] }, { id: ${J(id + 'm')}, type: 'move_direction', params: [{ id: ${J(id + 'n')}, type: 'number', params: ['5'] }, null] }]); return true; })()`;
const hasBlock = id => `Entry.container.getAllObjects().some(o => !!o.script.findById(${J(id)}))`;
const longest = `(() => { window.__longest = 0; try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__longest = Math.max(window.__longest, e.duration); }).observe({ entryTypes: ['longtask'] }); } catch {} return true; })()`;

async function dropPluginBlock(A, category, x, y) {
  const id = await A.evalJs(`(() => { const t = [...document.querySelectorAll('[id^="entryCategoryerplugin_"]')].find(e => e.textContent.includes(${J(category)})); if (!t) return null; t.click(); return t.id.slice('entryCategory'.length); })()`);
  if (!id) throw Error('플러그인 카테고리 없음: ' + category);
  await sleep(2200);
  const r = await A.evalJs(`(() => { const m = Entry.getMainWS().getBlockMenu(); for (const t of m.code.getThreadsByCategory(${J(id)})) { const b = t.getFirstBlock(); const g = b && b.view && b.view.svgGroup; const n = g && (g.node || g[0] || g); const r = n && n.getBoundingClientRect && n.getBoundingClientRect(); if (r && r.width > 0 && r.y > 60 && r.y < innerHeight - 40) return { x: r.x, y: r.y, w: r.width, h: r.height, type: b.type }; } return null; })()`);
  if (!r) throw Error('플러그인 블록이 안 보임: ' + category);
  await A.drag(r.x + Math.min(35, r.w / 2), r.y + r.h / 2, x, y, 18);
}
// 새 프로필이면 엔트리 첫 사용 안내창이 끌기를 가로챌 수 있어, 닫고 놓일 때까지 다시 끈다
async function usePlugin(A, category, x, y) {
  const n0 = await A.evalJs('Object.keys(Entry.variableContainer.functions_).length');
  for (let i = 0; i < 3; i++) {
    await closeGuide(A);
    await dropPluginBlock(A, category, x, y);
    const done = await A.waitFor(`Object.keys(Entry.variableContainer.functions_).length > ${n0}`, 12000, category + ' 첫 사용').then(() => true, () => false);
    if (done) return;
  }
  throw Error('플러그인 블록을 놓지 못함: ' + category);
}

(async () => {
  let A, B, C;
  try {
    [A, B, C] = await Promise.all([launch({ ext: [ext, er], name: 'A(엔트리루트)' }), launch({ ext, name: 'B(합작만)' }), launch({ ext, name: 'C(합작만·나중 참가)' })]);
    await Promise.all([openEntry(A), openEntry(B), openEntry(C)]);
    // 엔트리루트가 블록을 전용 블록으로 바꾼 뒤에 방을 연다(고치기 전에는 이때 참가자가 들어오지 못함)
    const flowReady = await A.waitFor(liveHasFlow, 60000, '엔트리루트 전용 블록').then(() => true, () => false);
    check('엔트리루트가 순정 블록을 전용 블록으로 바꾼 뒤임(시험 조건)', flowReady);
    if (!flowReady) return;
    const [H, G] = swap ? [B, A] : [A, B];
    const code = await openRoom(H, G);
    check(swap ? '안 켠 방장의 방에 엔트리루트를 켠 사람이 들어옴' : '엔트리루트를 켠 방장의 방에 안 켠 사람이 들어옴', true);
    if (swap) await A.waitFor(liveHasFlow, 60000, '들어온 뒤 다시 전용 블록').catch(() => {});
    check('방 작품에 전용 블록이 없음', !(await H.evalJs(`${roomText}.includes('entryroot_flow_')`)));
    const same = (label, ms) => converged(H, G, label, check, ms);
    await same('들어온 뒤 같은 작품', 30000);

    await B.evalJs(longest);
    await usePlugin(A, '물리', 900, 240);
    const bGot = await B.waitFor(`Object.keys(Entry.variableContainer.functions_).length > 0`, 60000, 'B가 플러그인 내용 받음').then(() => true, () => false);
    const [ca, cb] = [await A.evalJs(count), await B.evalJs(count)];
    check('플러그인 블록을 처음 쓰면 안 켠 사람에게도 같은 내용이 들어감', bGot && J(ca) === J(cb), `A ${J(ca)} · B ${J(cb)}`);
    await same('플러그인 첫 사용 뒤 같은 작품', 60000);
    const st = await B.evalJs('__entryHapjak.status().client');
    check('안 켠 사람의 맞추기가 멈추지 않음', st && !st.paused && !st.waiting, J(st));
    check('안 켠 사람 엔트리가 작품을 내보낼 수 있음(깨지지 않음)', await B.evalJs(`(() => { try { return !!Entry.exportProject(); } catch { return false; } })()`));
    console.log(`  (참고) 받는 쪽 가장 긴 멈춤 ${Math.round(await B.evalJs('window.__longest'))}ms`);

    await B.evalJs(addThread('erB1', 320));
    await A.waitFor(hasBlock('erB1m'), 20000, 'A가 B 블록 받음');
    await same('안 켠 사람이 고친 뒤 같은 작품', 30000);
    check('켠 사람 화면의 전용 블록은 그대로', await A.evalJs(liveHasFlow));

    await A.evalJs(`(() => { const b = Entry.playground.object.script.getBlockList().find(x => /^entryroot_flow_/.test(x.type)); const nb = b.params.find(p => p instanceof Entry.Block && p.type === 'number'); const f = nb.view._contents.find(c => c && typeof c.pointer === 'function'); Entry.do('setFieldValue', f.pointer(), '77'); window.__changed = nb.id; return true; })()`);
    const nid = await A.evalJs('window.__changed');
    await B.waitFor(`(() => { for (const o of Entry.container.getAllObjects()) { const b = o.script.findById(${J(nid)}); if (b) return String(b.params[0]) === '77'; } return false; })()`, 20000, 'B가 전용 블록의 값 변경 받음');
    check('켠 사람이 전용 블록 값을 고치면 안 켠 사람에게 순정 블록으로 들어감', true);
    await same('값을 고친 뒤 같은 작품', 30000);

    // "시간 속도" 같은 기본 아닌 값은 시간 플러그인을 쓴 뒤에 생긴다
    await usePlugin(A, '시간', 900, 480);
    await sleep(3000);
    await same('시간 플러그인 블록을 쓴 뒤 같은 작품', 60000);
    const picked = await A.evalJs(`(() => { for (const b of Entry.playground.object.script.getBlockList()) { if (!/^entryroot_flow_/.test(b.type) || !b.view) continue; const f = (b.view._contents || []).find(c => c && typeof c.getValue === 'function' && c.getValue() === 'default'); if (!f) continue; const opts = typeof f._menuGenerator === 'function' ? f._menuGenerator() : (f._contents && f._contents.options) || f.options || []; const other = (opts || []).map(o => o[1]).find(v => v !== 'default'); if (!other) continue; Entry.do('setFieldValue', f.pointer(), other); return other; } return null; })()`);
    check('기본이 아닌 값을 고를 수 있는 블록이 있음(시험 조건)', !!picked, String(picked));
    await sleep(2500);
    check('기본이 아닌 값을 골라도 방 작품에 전용 블록이 없음', !(await H.evalJs(`${roomText}.includes('entryroot_flow_')`)));
    const st2 = await B.evalJs('__entryHapjak.status().client');
    check('기본이 아닌 값을 골라도 안 켠 사람이 멈추지 않음', st2 && !st2.paused, J(st2));
    await same('기본이 아닌 값을 고른 뒤 같은 작품', 30000);

    const e0 = B.exceptions.length;
    await B.evalJs('Entry.engine.toggleRun(), true'); await sleep(2000);
    await B.evalJs("(Entry.engine.isState('stop') || Entry.engine.toggleStop(), true)"); await sleep(800);
    check('안 켠 사람이 실행해도 오류 없음', B.exceptions.length === e0, B.exceptions.slice(e0, e0 + 2).map(e => e.text.slice(0, 160)).join(' / '));
    await same('안 켠 사람이 실행·멈춘 뒤 같은 작품', 30000);

    await joinRoom(C, code, '나중');
    const cc = await C.evalJs(count);
    check('플러그인을 쓴 작품에 안 켠 사람이 나중에 들어옴', J(cc) === J(await A.evalJs(count)), J(cc));
  } catch (err) {
    check('시험 진행', false, String(err && err.stack || err).slice(0, 800));
    try { await A?.screenshot(path.join(out, 'fail-A.png')); await B?.screenshot(path.join(out, 'fail-B.png')); } catch { /* 못 찍음 */ }
  } finally {
    for (const c of [A, B, C]) if (c) {
      try { fs.writeFileSync(path.join(out, `diag-${c.name.slice(0, 1)}.txt`), await Promise.race([c.evalJs('__entryHapjak.diagnostics()'), sleep(8000).then(() => '응답 없음')])); } catch { /* 못 읽음 */ }
      const ours = c.exceptions.filter(e => /chrome-extension:|entry-adapter|sync\.js|main\.js|merge\.js/.test(J(e)) && /실시간|hapjak/i.test(J(e)));
      if (ours.length) console.log(`[${c.name}] 확장 예외 ${ours.length}개:`, J(ours.slice(0, 2)).slice(0, 400));
    }
    await Promise.all([A, B, C].filter(Boolean).map(c => c.close()));
    const fails = results.filter(r => !r.ok);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(results, null, 2));
    console.log(`\n${results.length - fails.length}/${results.length} 통과 · 결과: ${out}`);
    process.exit(fails.length ? 1 : 0);
  }
})();

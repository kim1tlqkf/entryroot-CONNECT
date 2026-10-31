// 엔트리가 명령 없이 작품 데이터를 바꾸는 경우(그려진 크기에 따라 적는 값)에, 그 변화를 "내 편집"으로 보내거나
// "방과 다름"으로 보고 작품을 통째로 다시 불러오지 않는지 실제 엔트리 크롬 2개로 확인한다.
//   node tests/e2e/derived.js [--ext 확장폴더]
const fs = require('fs'), path = require('path');
const { launch, openEntry, sleep } = require('./chrome');
const { checker, converged, openRoom, STRIP } = require('./room');

const argExt = process.argv.indexOf('--ext');
const ext = path.resolve(argExt > 0 ? process.argv[argExt + 1] : path.resolve(__dirname, '..', '..'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.join(__dirname, 'out', 'derived-' + stamp);
fs.mkdirSync(out, { recursive: true });
const { results, check } = checker();
const J = JSON.stringify;

const countLoads = `(() => { if (window.__dLoads === undefined) { window.__dLoads = 0; const o = Entry.loadProject; Entry.loadProject = function () { window.__dLoads++; return o.apply(this, arguments); }; } return window.__dLoads; })()`;
const lastWhy = c => c.evalJs('__entryHapjak.diagnostics()').then(d => (d.split('\n').filter(l => /다시 불러오기로/.test(l)).slice(-1)[0] || '').slice(9, 170));
const sentCount = c => c.evalJs('__entryHapjak.status().sent.length');
const commentOf = (blockId) => `(() => { for (const o of Entry.container.getAllObjects()) { const b = o.script.findById(${J(blockId)}); if (b && b._comment) return { x: b._comment.x, y: b._comment.y, gap: b._comment.x - b._comment.parentWidth }; } return null; })()`;
// 글꼴을 늦게 불러와 블록 폭이 바뀐 것과 같은 길: 엔트리 Comment.updateParentPos가 폭 차이만큼 메모를 민다(명령 없음)
const fontDrift = (blockId, dw) => `(() => { for (const o of Entry.container.getAllObjects()) { const b = o.script.findById(${J(blockId)}); if (b && b._comment) { const c = b._comment; c.set({ parentWidth: c.parentWidth - ${dw} }); c.updateParentPos(); return c.x; } } return null; })()`;

(async () => {
  let A, B;
  try {
    [A, B] = await Promise.all([launch({ ext, name: 'A(방장)' }), launch({ ext, name: 'B(참가자)' })]);
    await Promise.all([openEntry(A), openEntry(B)]);
    await openRoom(A, B);
    await B.evalJs(countLoads);
    check('방을 열고 참가자가 들어옴', true);
    const o1 = await A.evalJs('Entry.playground.object.id');

    // ── 처음 실행하면 엔트리가 고른 모양 정보에 크기 기록(dimension.scaleX/Y)을 붙인다 — 실행 중 받은 오브젝트 변경을 멈춘 뒤 넣어도 다시 불러오지 않음 ──
    const dimsBefore = await B.evalJs(`JSON.stringify(Entry.exportProject().objects.find(o => o.id === ${J(o1)}).sprite.pictures.map(p => p.dimension))`);
    let loads0 = await B.evalJs(countLoads);
    await B.evalJs(`Entry.engine.toggleRun(); true`);
    await B.waitFor(`Entry.engine.isState('run')`, 5000, 'B 실행');
    await sleep(300);
    await A.evalJs(`Entry.do('objectNameEdit', ${J(o1)}, '실행중바뀐이름'); true`);
    await sleep(300);
    await B.evalJs(`Entry.engine.toggleStop(); true`);
    await B.waitFor(`Entry.container.getObject(${J(o1)}).name === '실행중바뀐이름'`, 15000, '멈춘 뒤 이름 반영');
    await sleep(1500);
    let reloads = (await B.evalJs(countLoads)) - loads0;
    if (/scaleX/.test(dimsBefore)) check('처음 실행 뒤 받은 오브젝트 변경을 넣어도 작품을 통째로 다시 불러오지 않음', false, `BLOCKED: 실행 전에 이미 크기 기록이 있어 조건이 안 맞음 ${dimsBefore.slice(0, 120)}`);
    else check('처음 실행 뒤 받은 오브젝트 변경을 넣어도 작품을 통째로 다시 불러오지 않음', reloads === 0, `다시 불러오기 ${reloads}번 ${await lastWhy(B)}`);
    await converged(A, B, '실행·멈춘 뒤 같은 작품', check);

    // ── 변수 상자를 x=0에 둠(무대에서 끌어 놓기는 명령이 없다) — 엔트리는 받은 변수를 만들 때 0을 "자리 없음"으로 보고 새 자리를 정한다 ──
    await A.evalJs(`Entry.do('variableContainerAddVariable', new Entry.Variable({ id: 'dv1', name: '자리시험', variableType: 'variable', value: 1, visible: true })); true`);
    await B.waitFor(`!!Entry.variableContainer.getVariable('dv1')`, 15000, 'B가 변수 받음');
    await converged(A, B, '변수를 더한 뒤 같은 작품', check);
    loads0 = await B.evalJs(countLoads);
    await A.evalJs(`(() => { const v = Entry.variableContainer.getVariable('dv1'); v.setX(0); v.setY(40); return true; })()`);
    await B.waitFor(`(v => v && v.getY() === 40)(Entry.variableContainer.getVariable('dv1'))`, 20000, 'B가 옮긴 자리 받음');
    await sleep(1500);
    reloads = (await B.evalJs(countLoads)) - loads0;
    const bPos = await B.evalJs(`(v => [v.getX(), v.getY()])(Entry.variableContainer.getVariable('dv1'))`);
    check('x=0에 둔 변수를 받아도 같은 자리에, 작품을 통째로 다시 불러오지 않고 들어감', reloads === 0 && bPos[0] === 0 && bPos[1] === 40, `B 자리 ${bPos}, 다시 불러오기 ${reloads}번 ${await lastWhy(B)}`);
    await converged(A, B, '변수 자리를 옮긴 뒤 같은 작품', check);

    // ── 블록에 붙은 메모: 블록 폭이 명령 없이 바뀌면 엔트리가 메모 x를 그만큼 민다 ──
    await A.evalJs(`(() => { Entry.container.selectObject(${J(o1)}); Entry.playground.changeViewMode('code'); const board = Entry.getMainWS().board;
      Entry.do('addThread', [{ id: 'dc1', type: 'when_run_button_click', x: 300, y: 200, params: [null] }, { id: 'dc1c', type: 'move_direction', params: [{ id: 'dc1n', type: 'number', params: ['10'] }, null] }]);
      Entry.do('createComment', { x: 220, y: 9, value: '메모' }, board, board.code.findById('dc1c')); return true; })()`);
    await B.waitFor(`!!(${commentOf('dc1c')})`, 15000, 'B가 메모 받음');
    await B.evalJs(`Entry.container.selectObject(${J(o1)}); Entry.playground.changeViewMode('code'); true`);
    await sleep(1500);
    await converged(A, B, '메모를 단 뒤 같은 작품', check);

    const sent0 = await sentCount(B);
    const xBefore = (await B.evalJs(commentOf('dc1c'))).x;
    const xAfter = await B.evalJs(fontDrift('dc1c', 30));
    await sleep(6000);
    const sent1 = await sentCount(B);
    if (Math.abs(xAfter - xBefore - 30) > 0.01) check('글꼴 때문에 메모가 밀려도 내 편집으로 보내지 않음', false, `BLOCKED: 메모가 밀리지 않아 조건이 안 맞음 ${xBefore}→${xAfter}`);
    else check('글꼴 때문에 메모가 밀려도 내 편집으로 보내지 않음', sent1 === sent0, `보낸 수 ${sent0}→${sent1}, 메모 x ${xBefore}→${xAfter}`);

    loads0 = await B.evalJs(countLoads);
    await A.evalJs(`Entry.do('addThread', [{ id: 'dc2', type: 'when_run_button_click', x: 600, y: 400, params: [null] }]); true`);
    await B.waitFor(`!!Entry.container.getObject(${J(o1)}).script.findById('dc2')`, 15000, 'B가 dc2 받음');
    await sleep(1500);
    reloads = (await B.evalJs(countLoads)) - loads0;
    check('메모가 밀린 오브젝트에 남의 변경이 와도 작품을 통째로 다시 불러오지 않음', reloads === 0, `다시 불러오기 ${reloads}번 ${await lastWhy(B)}`);
    await converged(A, B, '메모가 밀린 뒤 같은 작품', check);
    const roomX = await A.evalJs(`JSON.parse(__entryHapjak.serverUnits()[${J('code:' + o1)}]).find(t => t[0].id === 'dc1')[1].comment.x`);
    check('방 작품의 메모 자리는 밀리기 전 그대로', Math.abs(roomX - xBefore) < 0.01, `방 ${roomX}, 밀리기 전 ${xBefore}`);

    // ── 값을 고치면 블록 폭이 바뀌어 메모가 같이 밀린다 — 이건 고친 결과라 모두에게 같은 간격으로 보여야 함 ──
    await A.evalJs(`(() => { const nb = Entry.getMainWS().board.code.findById('dc1n'); const f = nb.view._contents.find(q => q && typeof q.pointer === 'function'); Entry.do('setFieldValue', f.pointer(), '123456789'); return true; })()`);
    await B.waitFor(`JSON.stringify(Entry.container.getObject(${J(o1)}).script.toJSON()).includes('123456789')`, 15000, 'B 값 반영');
    await sleep(1500);
    const ca = await A.evalJs(commentOf('dc1c')), cb = await B.evalJs(commentOf('dc1c'));
    check('값을 고쳐 메모가 밀리면 두 사람 화면의 메모 간격이 같음', ca && cb && Math.abs(ca.gap - cb.gap) < 0.5 && Math.abs(ca.x - cb.x) < 0.01, J({ A: ca, B: cb }));
    await converged(A, B, '값을 고친 뒤 같은 작품', check);

    // ── 사람이 메모를 옮기면(엔트리 moveComment) 그 자리가 그대로 퍼짐 — 앞서 밀린 몫이 있어도 ──
    await B.evalJs(fontDrift('dc1c', 20));
    await sleep(800);
    const moved = await B.evalJs(`(() => { const c = Entry.getMainWS().board.code.findById('dc1c')._comment; c.set({ moveX: c.x + 40, moveY: c.y + 5 }); Entry.do('moveComment', c); return { x: c.x, y: c.y }; })()`);
    await A.waitFor(`(c => c && Math.abs(c.x - ${moved.x}) < 0.01)(${commentOf('dc1c')})`, 15000, 'A가 옮긴 메모 자리 받음').then(() => check('사람이 옮긴 메모 자리가 다른 사람에게 그대로 감', true, J(moved)), e => check('사람이 옮긴 메모 자리가 다른 사람에게 그대로 감', false, String(e.message).slice(0, 200)));
    await converged(A, B, '메모를 옮긴 뒤 같은 작품', check);
  } catch (err) {
    check('시험 진행', false, String(err && err.stack || err).slice(0, 800));
    try { await A?.screenshot(path.join(out, 'fail-A.png')); await B?.screenshot(path.join(out, 'fail-B.png')); } catch { /* 화면 못 찍음 */ }
  } finally {
    for (const c of [A, B]) if (c) {
      const errs = c.consoleLines.filter(l => /EXC|error/i.test(l));
      if (errs.length) console.log(`\n[${c.name}] 콘솔 오류/예외 ${errs.length}개:\n  ` + errs.slice(0, 15).join('\n  '));
    }
    await Promise.all([A, B].filter(Boolean).map(c => c.close()));
    const fails = results.filter(r => !r.ok);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(results, null, 2));
    console.log(`\n${results.length - fails.length}/${results.length} 통과 · 결과: ${out}`);
    process.exit(fails.length ? 1 : 0);
  }
})();

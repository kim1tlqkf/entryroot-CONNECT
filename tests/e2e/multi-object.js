// 두 사람이 서로 다른 오브젝트를 고칠 때 블록이 다른 오브젝트에 섞이지 않는지 실제 엔트리 크롬 2개로 확인한다.
// 받는 쪽 화면에 다른 오브젝트가 열려 있어도: 데이터는 제 오브젝트에만, 그림은 그 오브젝트를 열었을 때만 보여야 한다.
//   node tests/e2e/multi-object.js
const fs = require('fs'), path = require('path');
const { launch, openEntry, sleep } = require('./chrome');
const { checker, converged, openRoom } = require('./room');

// --ext 폴더: 이 폴더 대신 다른 확장 사본으로(돌연변이 측정 등)
const extArg = process.argv.indexOf('--ext');
const ext = path.resolve(extArg > 0 ? process.argv[extArg + 1] : path.resolve(__dirname, '..', '..'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.join(__dirname, 'out', 'multi-' + stamp);
fs.mkdirSync(out, { recursive: true });
const { results, check } = checker();

const J = JSON.stringify;
const show = id => `(() => { Entry.container.selectObject(${J(id)}); Entry.playground.changeViewMode('code'); return true; })()`;
const add = (blockId, x, y) => `(() => { Entry.do('addThread', [{ id: ${J(blockId)}, type: 'when_run_button_click', x: ${x}, y: ${y}, params: [null] }]); return true; })()`;
const inObj = (objId, blockId) => `!!Entry.container.getObject(${J(objId)}).script.findById(${J(blockId)})`;
// 그 블록 그림이 지금 페이지에 붙어 있는지(열린 오브젝트의 블록 화면에 보이는지)
const drawn = blockId => `(() => { for (const o of Entry.container.getAllObjects()) { const b = o.script.findById(${J(blockId)}); if (b) { const g = b.view && b.view.svgGroup; return !!(g && g.isConnected); } } return null; })()`;
// 지금 블록 화면에 붙어 있는 묶음 그림 가운데 열린 오브젝트 것이 아닌 것의 수
const strays = `(() => {
  const board = Entry.getMainWS().board, mine = new Set();
  for (const t of board.code.getThreads()) if (t.view && t.view.svgGroup) mine.add(t.view.svgGroup);
  let n = 0;
  for (const o of Entry.container.getAllObjects()) if (o.script !== board.code) for (const t of o.script.getThreads()) { const g = t.view && t.view.svgGroup; if (g && g.isConnected && !mine.has(g)) n++; }
  return n;
})()`;

(async () => {
  let A, B;
  try {
    [A, B] = await Promise.all([launch({ ext, name: 'A(방장)' }), launch({ ext, name: 'B(참가자)' })]);
    await Promise.all([openEntry(A), openEntry(B)]);
    await openRoom(A, B);
    check('방을 열고 참가자가 들어옴', true);

    const o1 = await A.evalJs('Entry.playground.object.id');
    const o2 = 'moObj2';
    await A.evalJs(`(() => { const o = Entry.exportProject().objects.find(o => o.id === ${J(o1)}); Entry.container.addObject({ ...o, id: ${J(o2)}, name: '두번째', script: '[]' }, 0); return true; })()`);
    await B.waitFor(`!!Entry.container.getObject(${J(o2)})`, 15000, 'B에 두 번째 오브젝트');
    await converged(A, B, '두 번째 오브젝트를 더한 뒤 같은 작품', check);

    // 두 오브젝트 모두 한 번씩 블록 화면에 열어 둔다(엔트리는 한 번 연 코드의 그림을 계속 들고 있다)
    await A.evalJs(show(o2)); await sleep(400); await A.evalJs(show(o1)); await sleep(400);
    await B.evalJs(show(o1)); await sleep(400); await B.evalJs(show(o2)); await sleep(400);

    // ── B(두 번째를 보는 중)가 두 번째에 더함 → A(첫 번째를 보는 중) ──
    await B.evalJs(add('moB1', 300, 80));
    await A.waitFor(inObj(o2, 'moB1'), 15000, 'A가 moB1 받음');
    await sleep(500);
    await A.screenshot(path.join(out, '1-A-o1-after-moB1.png'));
    check('남이 다른 오브젝트에 더한 블록이 내 오브젝트 데이터에 안 들어감', !(await A.evalJs(inObj(o1, 'moB1'))));
    check('남이 다른 오브젝트에 더한 블록이 내 블록 화면에 안 그려짐', (await A.evalJs(drawn('moB1'))) === false && (await A.evalJs(strays)) === 0,
      `moB1 그림 붙음=${await A.evalJs(drawn('moB1'))}, 섞인 묶음=${await A.evalJs(strays)}`);

    await A.evalJs(show(o2)); await sleep(600);
    check('그 오브젝트를 열면 받은 블록이 그려짐', (await A.evalJs(drawn('moB1'))) === true);
    await A.evalJs(show(o1)); await sleep(600);
    check('다시 내 오브젝트로 오면 남의 오브젝트 블록이 안 보임', (await A.evalJs(strays)) === 0 && (await A.evalJs(drawn('moB1'))) === false);

    // ── 동시에: A는 첫 번째, B는 두 번째에 여러 번 더함 ──
    for (let i = 0; i < 3; i++) {
      await Promise.all([A.evalJs(add('moA' + i, 500, 80 + i * 90)), B.evalJs(add('moB' + (i + 2), 500, 80 + i * 90))]);
      await sleep(300);
    }
    await Promise.all([A.waitFor(inObj(o2, 'moB4'), 15000, 'A가 moB4 받음'), B.waitFor(inObj(o1, 'moA2'), 15000, 'B가 moA2 받음')]);
    await converged(A, B, '동시 편집 뒤 같은 작품', check);
    const placement = async c => c.evalJs(`(() => {
      const ids = o => JSON.stringify(Entry.container.getObject(o).script.toJSON());
      const a = ids(${J(o1)}), b = ids(${J(o2)});
      return { o1HasB: /moB\\d/.test(a), o2HasA: /moA\\d/.test(b), o1A: (a.match(/moA\\d/g) || []).length, o2B: (b.match(/moB\\d/g) || []).length };
    })()`);
    const pa = await placement(A), pb = await placement(B);
    check('동시 편집 뒤 두 사람 모두 블록이 제 오브젝트에만 있음', [pa, pb].every(p => !p.o1HasB && !p.o2HasA && p.o1A === 3 && p.o2B === 4), JSON.stringify({ A: pa, B: pb }));
    check('동시 편집 뒤 두 사람 모두 열린 오브젝트 화면에 남의 블록이 없음', (await A.evalJs(strays)) === 0 && (await B.evalJs(strays)) === 0);

    // ── 반대 방향: A가 두 번째를 열고 고침 → B는 첫 번째를 보는 중 ──
    await B.evalJs(show(o1)); await A.evalJs(show(o2)); await sleep(400);
    await A.evalJs(add('moA9', 700, 300));
    await B.waitFor(inObj(o2, 'moA9'), 15000, 'B가 moA9 받음');
    await sleep(500);
    check('방장이 다른 오브젝트에 더한 블록이 참가자 화면에 안 섞임', !(await B.evalJs(inObj(o1, 'moA9'))) && (await B.evalJs(strays)) === 0 && (await B.evalJs(drawn('moA9'))) === false);

    // ── 다른 오브젝트에서 묶음 지우기 ──
    await A.evalJs(`(() => { const t = Entry.container.getObject(${J(o2)}).script.findById('moB1').getThread(); Entry.do('destroyThread', t); return true; })()`);
    await B.waitFor(`!(${inObj(o2, 'moB1')})`, 15000, 'B에서 moB1 지워짐');
    await sleep(500);
    await B.evalJs(show(o2)); await sleep(600);
    const bView = await B.evalJs(`(() => { const ids = Entry.getMainWS().board.code.getThreads().map(t => t.getFirstBlock() && t.getFirstBlock().id); return { ids, moA9: ${drawn('moA9')} }; })()`);
    check('지운 묶음은 사라지고 나머지는 열었을 때 그려짐', !bView.ids.includes('moB1') && bView.moA9 === true, JSON.stringify(bView));
    await converged(A, B, '지운 뒤 같은 작품', check);
    await B.screenshot(path.join(out, '2-B-o2.png'));

    // ── 블록 화면을 스크롤하자마자 다른 오브젝트로 옮겨도 좌표가 바뀐 것으로 보내지 않음(엔트리는 좌표를 200ms 늦게 맞춘다) ──
    await A.evalJs(show(o1)); await sleep(800);
    const codeOf = id => `(__entryHapjak.exportUnits() || {})[${J('code:' + id)}]`;
    const seqS0 = await A.evalJs('__entryHapjak.status().client.seq');
    const codeS0 = await A.evalJs(codeOf(o1));
    await A.evalJs(`(() => { Entry.getMainWS().board.scroller.scroll(-150, -90); Entry.container.selectObject(${J(o2)}); return true; })()`);
    const codeS1 = await A.evalJs(codeOf(o1));
    await sleep(2500);
    const codeS2 = await A.evalJs(codeOf(o1));
    const seqS1 = await A.evalJs('__entryHapjak.status().client.seq');
    check('스크롤하자마자 다른 오브젝트로 옮겨도 좌표를 바뀐 것으로 보내지 않음', seqS0 === seqS1 && codeS0 === codeS1 && codeS0 === codeS2, `seq ${seqS0}→${seqS1}, 바로 읽기 같음=${codeS0 === codeS1}, 2.5초 뒤 같음=${codeS0 === codeS2}`);

    // ── 동시에 변수를 더해도 변수 순서까지 같음 ──
    const addVar = id => `(() => { Entry.do('variableContainerAddVariable', new Entry.Variable({ id: ${J(id)}, name: ${J('변수' + id)}, variableType: 'variable', value: 1, visible: false })); return true; })()`;
    await Promise.all([A.evalJs(addVar('moVarA')), B.evalJs(addVar('moVarB'))]);
    await Promise.all([A.waitFor(`!!Entry.variableContainer.getVariable('moVarB')`, 15000, 'A가 moVarB 받음'), B.waitFor(`!!Entry.variableContainer.getVariable('moVarA')`, 15000, 'B가 moVarA 받음')]);
    await converged(A, B, '동시에 변수를 더해도 같은 작품(변수 순서 포함)', check);
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

// 엔트리 명령을 거치지 않은 변경(다른 확장·도구)을 넣은 직후 상대 때문에 작품을 통째로 다시 불러와도,
// 그 변경이 사라지지 않고 상대에게 가는지 실제 엔트리 크롬 2개로 확인한다.
//   node tests/e2e/reload-keeps-edits.js [--ext 확장폴더]
const fs = require('fs'), path = require('path');
const { launch, openEntry, sleep } = require('./chrome');
const { checker, converged, openRoom, STRIP } = require('./room');

const argExt = process.argv.indexOf('--ext');
const ext = path.resolve(argExt > 0 ? process.argv[argExt + 1] : path.resolve(__dirname, '..', '..'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.join(__dirname, 'out', 'reload-' + stamp);
fs.mkdirSync(out, { recursive: true });
const { results, check } = checker();
const J = JSON.stringify;

// personal_entry_mcp가 쓰는 것과 같은 호출로 고친다. 키 입력을 먼저 흘려 3초 동안 돌아가며 다시 보기가 쉬게 한다 — 찾아내는 길은 다시 불러오기뿐
const tool = code => `(() => {
  window.dispatchEvent(new KeyboardEvent('keydown'));
  const vc = Entry.variableContainer, sm = Entry.stateManager;
  sm.startIgnore();
  try { ${code} } finally { sm.endIgnore(); }
  Entry.container.setCurrentObjects(); Entry.container.updateListView(); vc.updateList(); Entry.Utils.doCodeChange(); Entry.requestUpdate = true;
  return true;
})()`;
const loadThread = (ref, threadId) => `const c = ${ref}; const t = c.toJSON(); t.push([{ id: ${J(threadId)}, type: 'when_run_button_click', x: 300, y: 300, params: [null] }]); c.destroyView(); c.load(t);`;
const objRef = id => `Entry.container.getObject(${J(id)})`;
const fnBody = id => J(J([[{ id: id + 'd', type: 'function_create', x: 40, y: 40, params: [{ id: id + 'l', type: 'function_field_label', params: ['함수' + id, null] }, null], statements: [[]] }]]));
const newFunc = id => `const f = new Entry.Func({ id: ${J(id)}, type: 'normal', localVariables: [], useLocalVariables: false, content: ${fnBody(id)} }); f.generateBlock(true); vc.saveFunction(f);`;
const addObject = (id, from) => `(() => { const o = Entry.exportProject().objects.find(o => o.id === ${J(from)}); Entry.do('addObject', { ...o, id: ${J(id)}, name: ${J('더함' + id)}, script: '[]' }, 0); return true; })()`;

// off: 그 차례에 고칠, 지금 안 고른 오브젝트 — 차례마다 다른 오브젝트를 써서 앞 차례 결과에 기대지 않는다
const KINDS = [
  { name: '변수 추가', edit: id => `vc.addVariable({ id: ${J(id)}, name: ${J('변수' + id)}, variableType: 'variable', value: 7, visible: false, x: 10, y: 10 });`, has: id => `!!Entry.variableContainer.getVariable(${J(id)})` },
  { name: '리스트 추가', edit: id => `vc.addList({ id: ${J(id)}, name: ${J('리스트' + id)}, variableType: 'list', array: [{ data: '1' }], visible: false, x: 20, y: 20 });`, has: id => `!!Entry.variableContainer.getList(${J(id)})` },
  { name: '신호 추가', edit: id => `vc.addMessage({ id: ${J(id)}, name: ${J('신호' + id)} });`, has: id => `!!Entry.variableContainer.getMessage(${J(id)})` },
  { name: '안 고른 오브젝트 블록', edit: (id, off) => loadThread(`${objRef(off)}.script`, id), has: (id, off) => `!!${objRef(off)}.script.findById(${J(id)})` },
  { name: '안 고른 오브젝트 이름·위치', edit: (id, off) => `const o = ${objRef(off)}; o.setName(${J('새이름' + id)}); o.entity.setX(66); o.updateCoordinateView();`, has: (id, off) => `(o => o.name === ${J('새이름' + id)} && o.entity.getX() === 66)(${objRef(off)})` },
  { name: '고른 오브젝트 블록', edit: (id, off, sel) => loadThread(`${objRef(sel)}.script`, id), has: (id, off, sel) => `!!${objRef(sel)}.script.findById(${J(id)})` },
  { name: '함수 내용', edit: id => `const f = vc.getFunction('rkFn'); const t = f.content.toJSON(); t.push([{ id: ${J(id)}, type: 'when_run_button_click', x: 300, y: 300, params: [null] }]); f.content.destroyView(); f.content.load(t); f.generateBlock(true); vc.saveFunction(f);`, has: id => `!!Entry.variableContainer.getFunction('rkFn').content.findById(${J(id)})` },
  { name: '새 함수', edit: id => newFunc(id), has: id => `!!Entry.variableContainer.getFunction(${J(id)})` },
  { name: '변수 지우기', prepare: id => `(Entry.do('variableContainerAddVariable', new Entry.Variable({ id: ${J(id)}, name: ${J('지울변수' + id)}, variableType: 'variable', value: 1, visible: false })), true)`, edit: id => `vc.removeVariable(vc.getVariable(${J(id)}));`, has: id => `!Entry.variableContainer.getVariable(${J(id)})` },
  { name: '오브젝트 지우기', edit: (id, off) => `Entry.container.removeObject(${J(off)});`, has: (id, off) => `!${objRef(off)}` },
  { name: '오브젝트 더하기', edit: (id, off) => `const o = Entry.exportProject().objects.find(o => o.id === ${J(off)}); Entry.container.addObjectFunc({ ...o, id: ${J(id)}, name: ${J('도구' + id)}, script: '[]' }, 0);`, has: id => `!!${objRef(id)}` },
];

// 묶음 좌표에는 사람마다 다른 스크롤 몫이 들어 있어 뺀다(좌표가 같은지는 converged가 몫을 뺀 조각으로 본다)
const full = async c => {
  const u = await c.evalJs(`${STRIP}(ErcMerge.projectToUnits(Entry.exportProject()))`);
  for (const k of Object.keys(u)) if (k.startsWith('code:')) u[k] = J(JSON.parse(u[k]).map(th => { const { x, y, ...first } = th[0]; return [first, ...th.slice(1)]; }));
  return u;
};
// 조각 읽기는 캐시를 쓴다 — 마지막에는 두 사람 작품을 처음부터 읽어 비교한다
async function sameProject(A, B, label) {
  const [ua, ub] = await Promise.all([full(A), full(B)]);
  const diff = [...new Set([...Object.keys(ua), ...Object.keys(ub)])].filter(k => k !== 'meta' && ua[k] !== ub[k]);
  const where = k => { const a = ua[k] || '', b = ub[k] || ''; let i = 0; while (i < a.length && a[i] === b[i]) i++; return `${k} @${i}: ${a.slice(Math.max(0, i - 40), i + 40)} ↔ ${b.slice(Math.max(0, i - 40), i + 40)}`; };
  check(label, !diff.length, diff.slice(0, 3).map(where).join(' | '));
}

(async () => {
  let A, B;
  let n = 0;
  const later = (c, expr, ms, what) => c.waitFor(expr, ms, what).then(() => true, () => false);
  try {
    [A, B] = await Promise.all([launch({ ext, name: 'A(방장)' }), launch({ ext, name: 'B(참가자)' })]);
    await Promise.all([openEntry(A), openEntry(B)]);
    await A.evalJs(require('./bigproject')(30, 1, 2, 1));
    await A.evalJs(tool(newFunc('rkFn')));
    await sleep(1500);
    await openRoom(A, B);
    check('방을 열고 참가자가 들어옴', true);
    await converged(A, B, '들어온 직후 같은 작품', check, 30000);

    // 고친 쪽(E), 오브젝트를 더해 다시 불러오게 만드는 쪽(O)
    const round = async (E, O, tag, kind) => {
      const id = 'rk' + (++n), off = 'perf' + n, added = 'rkObj' + n;
      if (kind.prepare) {
        await E.evalJs(kind.prepare(id));
        await O.waitFor(`!(${kind.has(id, off)})`, 8000, '준비한 변경 전달');
      }
      const sel = await E.evalJs('Entry.playground.object.id');
      const pure = kind.has(id, off, sel);
      await E.evalJs(tool(kind.edit(id, off, sel)));
      await O.evalJs(addObject(added, 'perf0'));
      if (!(await later(E, `!!${objRef(added)}`, 15000, '더한 오브젝트 받기'))) { check(`[${tag}] ${kind.name}: 더한 오브젝트 받음`, false); return; }
      await sleep(200);
      const kept = await E.evalJs(pure);
      const sent = await later(O, pure, 8000, '상대에게 전달');
      check(`[${tag}] ${kind.name}: 고친 쪽에 남음`, kept);
      check(`[${tag}] ${kind.name}: 상대에게 감`, sent);
    };

    console.log('\n── 참가자가 고치고 방장이 오브젝트를 더함 ──');
    for (const kind of KINDS) await round(B, A, '참가자', kind);
    await converged(A, B, '[참가자] 끝난 뒤 같은 작품', check);
    await sameProject(A, B, '[참가자] 처음부터 읽어도 같은 작품');

    console.log('\n── 방장이 고치고 참가자가 오브젝트를 더함 ──');
    for (const kind of KINDS) await round(A, B, '방장', kind);
    await converged(A, B, '[방장] 끝난 뒤 같은 작품', check);
    await sameProject(A, B, '[방장] 처음부터 읽어도 같은 작품');

    // ── 다시 불러오게 만드는 원인이 오브젝트 더하기가 아니어도 ──
    console.log('\n── 다른 원인으로 다시 불러옴 ──');
    const other = async (name, trigger, wait) => {
      const id = 'rkT' + (++n), kind = KINDS[0];
      await B.evalJs(tool(kind.edit(id)));
      await A.evalJs(trigger);
      await later(B, wait, 15000, name);
      await sleep(200);
      check(`${name}: 고친 쪽에 남음`, await B.evalJs(kind.has(id)));
      check(`${name}: 상대에게 감`, await later(A, kind.has(id), 8000, '상대에게 전달'));
    };
    await other('상대가 오브젝트를 지움', `(Entry.do('removeObject', 'perf29'), true)`, `!${objRef('perf29')}`);
    await other('상대가 장면을 더함', `(Entry.do('sceneAdd', 'rkScene'), true)`, `!!Entry.scene.getSceneById('rkScene')`);
    await converged(A, B, '[다른 원인] 끝난 뒤 같은 작품', check);

    // ── 같은 조각을 상대도 고친 경우 ──
    console.log('\n── 같은 조각을 상대도 고침 ──');
    {
      const off = 'perf27';
      await B.evalJs(tool(`${objRef(off)}.entity.setX(55); ${objRef(off)}.updateCoordinateView();`));
      await A.evalJs(`(Entry.do('objectNameEdit', ${J(off)}, '방장이름'), true)`);
      await A.evalJs(addObject('rkObjF', 'perf0'));
      await later(B, `!!${objRef('rkObjF')}`, 15000, '더한 오브젝트 받기');
      const both = `(o => o.name === '방장이름' && o.entity.getX() === 55)(${objRef(off)})`;
      check('같은 오브젝트의 다른 칸: 둘 다 남음', (await later(B, both, 8000, 'B 양쪽')) && (await later(A, both, 8000, 'A 양쪽')));
      await B.evalJs(tool(`${objRef(off)}.setName('도구이름');`));
      await A.evalJs(`(Entry.do('objectNameEdit', ${J(off)}, '방장새이름'), true)`);
      await A.evalJs(addObject('rkObjG', 'perf0'));
      await later(B, `!!${objRef('rkObjG')}`, 15000, '더한 오브젝트 받기');
      await sleep(1000);
      await converged(A, B, '같은 칸을 둘 다 고쳐도 같은 작품', check);
      check('같은 칸: 방에 먼저 닿은 값이 남고 늦은 쪽에 알림', (await B.evalJs(`${objRef(off)}.name`)) === '방장새이름'
        && /반영되지 않았어요/.test(await B.evalJs('__entryHapjak.diagnostics()')));
    }

    // ── 다시 불러오지 않고 그 부분만 넣는 경우에도, 덮어쓸 조각을 내가 고쳤으면 덮지 않는다 ──
    console.log('\n── 그 부분만 넣는 길 ──');
    {
      const off = 'perf25', noReload = 'Entry.container.getAllObjects().every(o => o.__rk === 1)';
      const mark = () => B.evalJs(`(Entry.container.getAllObjects().forEach(o => { o.__rk = 1; }), true)`);

      await mark();
      await B.evalJs(tool(`${objRef(off)}.entity.setX(44); ${objRef(off)}.updateCoordinateView();`));
      await A.evalJs(`(Entry.do('objectNameEdit', ${J(off)}, '부분이름'), true)`);
      const both = `(o => o.name === '부분이름' && o.entity.getX() === 44)(${objRef(off)})`;
      check('같은 오브젝트의 다른 칸: 둘 다 남음', (await later(B, both, 8000, 'B 양쪽')) && (await later(A, both, 8000, 'A 양쪽')));
      check('같은 오브젝트의 다른 칸: 다시 불러오지 않음', await B.evalJs(noReload));

      await B.evalJs(tool(loadThread(`${objRef(off)}.script`, 'rkPartB')));
      await A.evalJs(`(() => { Entry.container.selectObject(${J(off)}); Entry.do('addThread', [{ id: 'rkPartA', type: 'when_run_button_click', x: 500, y: 300, params: [null] }]); return true; })()`);
      const threads = `(o => !!o.script.findById('rkPartA') && !!o.script.findById('rkPartB'))(${objRef(off)})`;
      check('같은 오브젝트의 다른 묶음: 둘 다 남음', (await later(B, threads, 10000, 'B 두 묶음')) && (await later(A, threads, 10000, 'A 두 묶음')));

      await B.evalJs(tool(`vc.addMessage({ id: 'rkMsgT', name: '도구신호' });`));
      await A.evalJs(`(Entry.do('variableContainerAddMessage', { id: 'rkMsgR', name: '방장신호' }), true)`);
      const msgs = `!!Entry.variableContainer.getMessage('rkMsgT') && !!Entry.variableContainer.getMessage('rkMsgR')`;
      check('신호를 서로 더해도 둘 다 남음', (await later(B, msgs, 10000, 'B 두 신호')) && (await later(A, msgs, 10000, 'A 두 신호')));

      await converged(A, B, '[부분 반영] 끝난 뒤 같은 작품', check);
      await sameProject(A, B, '[부분 반영] 처음부터 읽어도 같은 작품');
    }

    // ── 글상자 폭처럼 컴퓨터마다 달리 계산되는 값은 다시 읽어도 내 편집이 아니다 ──
    console.log('\n── 화면 사정으로만 달라진 값 ──');
    {
      const widen = `(() => { window.dispatchEvent(new KeyboardEvent('keydown')); const e = ${objRef('rkTb')}.entity; e.setWidth(e.getWidth() + 3); return true; })()`;
      const sentSince = async at => (await B.evalJs('__entryHapjak.status().sent')).filter(s => s.at >= at).flatMap(s => s.keys);
      const notices = async () => ((await B.evalJs('__entryHapjak.diagnostics()')).match(/반영되지 않았어요/g) || []).length;
      const sceneId = await A.evalJs('Entry.scene.selectedScene.id');
      const tb = { id: 'rkTb', name: '글상자', text: '안녕', script: '[]', objectType: 'textBox', rotateMethod: 'none', scene: sceneId, sprite: { pictures: [], sounds: [] }, selectedPictureId: null, lock: false,
        entity: { rotation: 0, direction: 90, x: 0, y: 0, regX: 0, regY: 0, scaleX: 1, scaleY: 1, width: 64, height: 24, font: '20px Nanum Gothic', visible: true, colour: '#000000', text: '안녕', textAlign: 0, lineBreak: false, bgColor: 'transparent', underLine: false, strike: false, fontSize: 20 } };
      await A.evalJs(`(Entry.do('addObject', ${J(tb)}, 0), true)`);
      await B.waitFor(`!!${objRef('rkTb')}`, 15000, 'B 글상자');
      await sleep(800);

      const n0 = await notices();
      let at = await B.evalJs('Date.now()');
      await B.evalJs(widen);
      await A.evalJs(addObject('rkObjW', 'perf0'));
      await B.waitFor(`!!${objRef('rkObjW')}`, 15000, 'B 더한 오브젝트');
      await sleep(800);
      const sent1 = await sentSince(at);
      check('글상자 폭만 다르면 다시 불러올 때 내 편집으로 보내지 않음', !sent1.includes('obj:rkTb'), sent1.join(','));

      at = await B.evalJs('Date.now()');
      await B.evalJs(widen);
      await A.evalJs(`(Entry.do('removeObject', 'rkTb'), true)`);
      await B.waitFor(`!${objRef('rkTb')}`, 15000, 'B 글상자 지워짐');
      await sleep(1500);
      const sent2 = await sentSince(at);
      check('폭만 다른 글상자를 상대가 지워도 되살아나지 않고 충돌 알림도 없음', !(await B.evalJs(`!!${objRef('rkTb')}`)) && !sent2.includes('obj:rkTb') && (await notices()) === n0, sent2.join(','));
      await converged(A, B, '[글상자] 끝난 뒤 같은 작품', check);
    }

    // ── 그 부분만 넣다 실패해 통째로 다시 불러오는 길 ──
    console.log('\n── 부분 반영 실패 뒤 다시 불러옴 ──');
    {
      const id = 'rkPart', off = 'perf26', kind = KINDS[0];
      await B.evalJs(`(() => { const o = ${objRef(off)}, orig = o.setName; o.setName = function () { o.setName = orig; throw new Error('시험용 부분 반영 실패'); }; return true; })()`);
      await B.evalJs(tool(kind.edit(id)));
      await A.evalJs(`(Entry.do('objectNameEdit', ${J(off)}, '부분실패이름'), true)`);
      check('받은 변경이 들어감', await later(B, `${objRef(off)}.name === '부분실패이름'`, 15000, 'B 이름 반영'));
      check('고친 쪽에 남음', await B.evalJs(kind.has(id)));
      check('상대에게 감', await later(A, kind.has(id), 8000, '상대에게 전달'));
      await converged(A, B, '[부분 반영 실패] 끝난 뒤 같은 작품', check);
      await sameProject(A, B, '[부분 반영 실패] 처음부터 읽어도 같은 작품');
    }

    // ── 다시 불러오기가 실패해 되돌릴 때도 ──
    console.log('\n── 다시 불러오기 실패 ──');
    {
      const id = 'rkFail', kind = KINDS[0];
      await B.evalJs(`(() => { const orig = Entry.loadProject; let once = true; Entry.loadProject = function (p) { if (once && p && Array.isArray(p.objects) && p.objects.some(o => o.id === 'rkObjH')) { once = false; throw new Error('시험용 불러오기 실패'); } return orig.apply(this, arguments); }; return true; })()`);
      await B.evalJs(tool(kind.edit(id)));
      await A.evalJs(addObject('rkObjH', 'perf0'));
      await B.waitFor(`__entryHapjak.status().client.paused`, 15000, 'B 반영 실패 안내');
      check('되돌린 화면에도 변경이 남음', await B.evalJs(kind.has(id)));
    }
  } catch (err) {
    check('시험 진행', false, String(err && err.stack || err).slice(0, 800));
    try { await A?.screenshot(path.join(out, 'fail-A.png')); await B?.screenshot(path.join(out, 'fail-B.png')); } catch { /* 화면 못 찍음 */ }
  } finally {
    for (const c of [A, B]) if (c) {
      try { fs.writeFileSync(path.join(out, `diag-${c.name.slice(0, 1)}.txt`), await c.evalJs('__entryHapjak.diagnostics()')); } catch { /* 못 읽음 */ }
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

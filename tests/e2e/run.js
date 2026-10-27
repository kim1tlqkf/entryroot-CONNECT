// 실제 엔트리(playentry.org/ws/new)를 크롬 2개로 열고, 확장을 설치한 채 실제 P2P로 합작 흐름을 확인한다.
//   node tests/e2e/run.js
// 엔트리 서버에 저장하지 않는다(로그인 없음, 저장 버튼을 누르지 않음).
const fs = require('fs'), path = require('path');
const { launch, openEntry, sleep } = require('./chrome');
const { checker, uiClick, openPanel, converged, hasBlock } = require('./room');

const ext = path.resolve(__dirname, '..', '..');
const VERSION = require(path.join(ext, 'manifest.json')).version;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.join(__dirname, 'out', stamp);
fs.mkdirSync(out, { recursive: true });

const { results, check } = checker();

(async () => {
  let A, B;
  try {
    [A, B] = await Promise.all([launch({ ext, name: 'A(방장)' }), launch({ ext, name: 'B(참가자)' })]);
    await Promise.all([openEntry(A), openEntry(B)]);
    check('두 크롬 모두 엔트리와 확장이 뜸', true);

    // ── 방 열기 ──
    await uiClick(A, '.fab');
    await uiClick(A, 'input', null, 0); await A.type('방장');
    await uiClick(A, 'button.main', '새 방 만들기');
    const code = await A.waitFor(`(s => s.mode === 'room' && s.code)(__entryHapjak.status())`, 30000, '방 열림');
    check('방장이 방을 열고 초대 코드를 받음', /^[a-z0-9]{4}-[a-z0-9]{4}$/.test(code), code);

    // ── 키 입력이 엔트리로 새지 않는지(참가자 창에서) ──
    await uiClick(B, '.fab');
    await B.evalJs(`window.__keyLeak = 0; document.addEventListener('keydown', () => window.__keyLeak++); true`);
    await uiClick(B, 'input', null, 0); await B.type('참가자');
    await B.key('Delete', 'Delete', 46); await B.key('Backspace', 'Backspace', 8); await B.type('참가자');
    check('합작 창에서 누른 키가 엔트리 단축키로 새지 않음', (await B.evalJs('window.__keyLeak')) === 0);

    // ── 참여 ──
    await uiClick(B, 'input', null, 1); await B.type(code);
    await uiClick(B, 'button.sub', '참여하기');
    await B.waitFor(`__entryHapjak.status().mode === 'room'`, 45000, '참가자 방 입장');
    await A.waitFor(`__entryHapjak.status().members.length === 2`, 10000, '방장이 참가자를 봄');
    check('참가자가 실제 P2P로 방에 들어옴', true);
    await converged(A, B, '들어온 직후 두 사람 작품이 같음', check);
    await A.screenshot(path.join(out, '1-A-room.png'));
    await B.screenshot(path.join(out, '1-B-room.png'));

    const objId = await A.evalJs('Entry.playground.object.id');

    // ── A가 블록 묶음 추가 → B에 보임 ──
    await A.evalJs(`Entry.do('addThread', [{ id: 'e2eA1', type: 'when_run_button_click', x: 420, y: 60, params: [null] }]); true`);
    await B.waitFor(hasBlock('e2eA1'), 10000, 'B가 A의 블록을 받음');
    check('방장이 더한 블록이 참가자에게 보임', true);

    // ── B가 더한 블록 → A에 보임(B 화면에 그 오브젝트가 열려 있으면 바로 그려짐) ──
    await B.evalJs(`Entry.container.selectObject(${JSON.stringify(objId)}); Entry.do('addThread', [{ id: 'e2eB1', type: 'when_some_key_pressed', x: 420, y: 200, params: [null, '81'] }]); true`);
    await A.waitFor(hasBlock('e2eB1'), 10000, 'A가 B의 블록을 받음');
    const drawn = await A.evalJs(`!!(Entry.getMainWS().board.code.findById('e2eB1') && Entry.getMainWS().board.code.findById('e2eB1').view)`);
    check('참가자가 더한 블록이 방장 블록 화면에 바로 그려짐', drawn);

    // ── 같은 오브젝트에서 동시에 다른 묶음 추가 → 둘 다 남음 ──
    await Promise.all([
      A.evalJs(`Entry.do('addThread', [{ id: 'e2eConA', type: 'when_run_button_click', x: 600, y: 60, params: [null] }]); true`),
      B.evalJs(`Entry.do('addThread', [{ id: 'e2eConB', type: 'when_run_button_click', x: 600, y: 300, params: [null] }]); true`),
    ]);
    await Promise.all([A.waitFor(hasBlock('e2eConB'), 15000, 'A에 B 동시 블록'), B.waitFor(hasBlock('e2eConA'), 15000, 'B에 A 동시 블록')]);
    check('동시에 같은 오브젝트에 다른 묶음을 더해도 둘 다 남음', (await A.evalJs(hasBlock('e2eConA'))) && (await B.evalJs(hasBlock('e2eConB'))));
    await converged(A, B, '동시 편집 뒤 같은 작품', check);

    // ── 큰 묶음(여러 조각으로 나눠 보내짐) ──
    const bigLen = await A.evalJs(`(() => {
      const blocks = [{ id: 'e2eBig', type: 'when_run_button_click', x: 1200, y: 60, params: [null] }];
      for (let i = 0; i < 250; i++) blocks.push({ id: 'big' + i, type: 'move_x', params: [{ id: 'bn' + i, type: 'number', params: ['한글😀' + i] }, null] });
      Entry.do('addThread', blocks);
      return JSON.stringify(Entry.playground.object.script.toJSON()).length;
    })()`);
    await B.waitFor(hasBlock('big249'), 20000, 'B가 큰 묶음을 받음');
    check('큰 묶음(나눠 보내기)이 참가자에게 그대로 감', true, `코드 ${bigLen}자`);
    await converged(A, B, '큰 묶음 뒤 같은 작품', check);

    // ── 스크롤만 하면 보내지 않음 ──
    const seq0 = await A.evalJs('__entryHapjak.status().client.seq');
    // 엔트리는 스크롤한 좌표를 200ms 늦게 작품 데이터에 넣는다 — 그 사이 어느 때 읽어도 조각이 같아야 한다
    const scrollBad = await A.evalJs(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const key = 'code:' + Entry.playground.object.id;
      const pick = () => (__entryHapjak.exportUnits() || {})[key];
      const base = pick(); const bad = [];
      for (const [dx, dy] of [[-120, -60], [37.3, 11.1], [80, 300]]) {
        Entry.getMainWS().board.scroller.scroll(dx, dy);
        for (const w of [0, 50, 150, 300]) { await sleep(w); if (pick() !== base) bad.push([dx, dy, w]); }
      }
      return bad;
    })()`);
    check('스크롤 직후 어느 순간에 읽어도 블록 좌표 조각이 그대로', scrollBad.length === 0, JSON.stringify(scrollBad));
    await sleep(2000);
    const seq1 = await A.evalJs('__entryHapjak.status().client.seq');
    const sentWhy = seq0 === seq1 ? '' : JSON.stringify({ A: (await A.evalJs('__entryHapjak.status().sent')).slice(-3), B: (await B.evalJs('__entryHapjak.status().sent')).slice(-3) });
    check('블록 화면을 스크롤만 하면 아무것도 보내지 않음', seq0 === seq1, `seq ${seq0}→${seq1} ${sentWhy}`);

    // ── 스크롤한 뒤에 B가 블록을 더해도 A 화면의 묶음이 튀지 않음 ──
    const posBefore = await A.evalJs(`(() => { const b = Entry.getMainWS().board.code.findById('e2eA1'); return [b.view.x, b.view.y]; })()`);
    await B.evalJs(`Entry.do('addThread', [{ id: 'e2eB2', type: 'when_run_button_click', x: 700, y: 400, params: [null] }]); true`);
    await A.waitFor(hasBlock('e2eB2'), 10000, 'A가 B2 받음');
    await sleep(300);
    const posAfter = await A.evalJs(`(() => { const b = Entry.getMainWS().board.code.findById('e2eA1'); return [b.view.x, b.view.y]; })()`);
    check('남의 변경이 들어와도 내 블록 화면 위치가 그대로', Math.abs(posBefore[0] - posAfter[0]) < 1 && Math.abs(posBefore[1] - posAfter[1]) < 1, `${posBefore} → ${posAfter}`);

    // ── 오브젝트 위치: 부분 반영(작품 다시 불러오기 없이) ──
    await A.evalJs(`Entry.container.getObject(${JSON.stringify(objId)}).__e2eMark = 1; true`);
    await B.evalJs(`Entry.do('objectUpdatePosX', ${JSON.stringify(objId)}, 123); true`);
    await A.waitFor(`Entry.container.getObject(${JSON.stringify(objId)}).entity.getX() === 123`, 10000, 'A 오브젝트 x=123');
    check('오브젝트 위치가 다시 불러오기 없이 반영', (await A.evalJs(`Entry.container.getObject(${JSON.stringify(objId)}).__e2eMark === 1`)));

    // ── 새 오브젝트: 다시 불러오기 + 보던 화면 유지 ──
    const bSel0 = await B.evalJs('Entry.playground.object.id');
    await B.evalJs(`Entry.projectId = 'e2eFakeProject'; true`);
    await A.evalJs(`(() => { const o = Entry.exportProject().objects.find(o => o.id === ${JSON.stringify(objId)}); Entry.container.addObject({ ...o, id: 'e2eObj2', name: '두번째', script: '[]' }, 0); return true; })()`);
    await B.waitFor(`!!Entry.container.getObject('e2eObj2')`, 15000, 'B에 새 오브젝트');
    await sleep(500);
    const bSel1 = await B.evalJs('Entry.playground.object && Entry.playground.object.id');
    check('새 오브젝트가 참가자에게 생기고, 참가자가 보던 오브젝트는 그대로', bSel0 === bSel1, `${bSel0} → ${bSel1}`);
    check('작품을 다시 불러와도 내 작품 번호(저장 위치)는 그대로', (await B.evalJs('Entry.projectId')) === 'e2eFakeProject');
    await converged(A, B, '오브젝트 추가 뒤 같은 작품', check);

    // ── 오브젝트 이름 바꾸기: 부분 반영 ──
    await B.evalJs(`Entry.do('objectNameEdit', ${JSON.stringify(objId)}, '바뀐이름'); true`);
    await A.waitFor(`Entry.container.getObject(${JSON.stringify(objId)}).name === '바뀐이름'`, 10000, 'A 이름 반영');
    check('오브젝트 이름이 다시 불러오기 없이 반영', await A.evalJs(`Entry.container.getObject(${JSON.stringify(objId)}).__e2eMark === 1`));

    // ── 모양 추가(명령), 지금 고른 모양의 내용 바꾸기: 다시 불러오기 없이 반영되고 받는 쪽 내보내기가 깨지지 않음 ──
    await B.evalJs(`Entry.container.getObject(${JSON.stringify(objId)}).__e2eMark = 2; true`);
    await A.evalJs(`(() => { const o = Entry.container.getObject(${JSON.stringify(objId)}); const pic = { ...Entry.getPicturesJSON([o.pictures[0]])[0], id: 'e2ePic1', name: '시험모양' }; Entry.do('objectAddPicture', ${JSON.stringify(objId)}, pic); return true; })()`);
    await B.waitFor(`!!Entry.container.getObject(${JSON.stringify(objId)}).getPicture('e2ePic1')`, 15000, 'B에 모양');
    await A.evalJs(`(() => { const o = Entry.container.getObject(${JSON.stringify(objId)}); const sel = o.selectedPicture; Entry.container.setPicture({ ...Entry.getPicturesJSON([sel])[0], objectId: o.id, name: '바뀐모양이름' }); o.selectPicture(sel.id); Entry.do('objectUpdatePosY', o.id, 33); return true; })()`);
    await B.waitFor(`Entry.container.getObject(${JSON.stringify(objId)}).pictures.some(p => p.name === '바뀐모양이름')`, 20000, 'B 모양 이름');
    check('모양 추가·고른 모양 바꾸기가 다시 불러오기 없이 반영', (await B.evalJs(`Entry.container.getObject(${JSON.stringify(objId)}).__e2eMark === 2`)) && (await B.evalJs(`!!__entryHapjak.exportUnits()`)));
    await converged(A, B, '모양 바꾼 뒤 같은 작품', check);

    // ── 변수 추가(엔트리 화면의 변수 추가와 같은 명령) ──
    await A.evalJs(`Entry.do('variableContainerAddVariable', new Entry.Variable({ id: 'e2eVar', name: '점수e2e', variableType: 'variable', value: 5, visible: true })); true`);
    await B.waitFor(`!!Entry.variableContainer.getVariable('e2eVar')`, 15000, 'B에 변수');
    check('방장이 만든 변수가 참가자에게 생김', true);
    await converged(A, B, '변수 추가 뒤 같은 작품', check);

    // ── 실행 중엔 미뤘다가 멈추면 반영 ──
    await B.evalJs(`Entry.engine.toggleRun(); true`);
    await B.waitFor(`Entry.engine.isState('run')`, 5000, 'B 실행');
    await A.evalJs(`Entry.container.selectObject(${JSON.stringify(objId)}); Entry.do('addThread', [{ id: 'e2eRun', type: 'when_run_button_click', x: 300, y: 500, params: [null] }]); true`);
    await sleep(2500);
    const duringRun = await B.evalJs(`!!Entry.container.getObject(${JSON.stringify(objId)}).script.findById('e2eRun')`);
    const waiting = await B.evalJs('__entryHapjak.status().client.waiting');
    check('참가자가 실행 중이면 받은 변경을 미룸', !duringRun && waiting > 0, `waiting=${waiting}`);
    await B.evalJs(`Entry.engine.toggleStop(); true`);
    await B.waitFor(hasBlock('e2eRun'), 10000, '멈춘 뒤 반영');
    check('실행을 멈추면 미룬 변경이 반영됨', true);

    // ── 실제 마우스로 블록 꾸러미에서 끌어다 놓기(방장) → 참가자에 보임 ──
    await A.evalJs(`Entry.container.selectObject(${JSON.stringify(objId)}); Entry.playground.changeViewMode('code'); true`);
    await sleep(500);
    if (!(await A.evalJs(`document.getElementById('entry-hapjak-root').shadowRoot.querySelector('.panel').hidden`))) await uiClick(A, 'button.x');
    const before = await A.evalJs(`Entry.playground.object.script.getThreads().length`);
    const geo = await A.evalJs(`(() => {
      const ws = Entry.getMainWS();
      const th = ws.blockMenu.code.getThreads().find(t => { const b = t.getFirstBlock(); if (!b || b.type !== 'when_run_button_click' || !b.view || !b.view.svgGroup) return false; const r = b.view.svgGroup.getBoundingClientRect(); return r.width > 0 && r.top > 0 && r.bottom < innerHeight; });
      const r = th.getFirstBlock().view.svgGroup.getBoundingClientRect();
      const g = ws.board.svgBlockGroup; const svgEl = (g && (g.ownerSVGElement || (g.node && g.node.ownerSVGElement)));
      const board = svgEl.getBoundingClientRect();
      return { from: { x: r.left + 15, y: r.top + r.height / 2 }, to: { x: board.left + board.width * 0.6, y: board.top + board.height * 0.65 }, type: th.getFirstBlock().type };
    })()`);
    await A.drag(geo.from.x, geo.from.y, geo.to.x, geo.to.y, 20);
    await sleep(800);
    const after = await A.evalJs(`Entry.playground.object.script.getThreads().length`);
    check('방장이 실제 마우스로 블록을 끌어다 놓음', after === before + 1, `${before}→${after} (${geo.type})`);
    await converged(A, B, '마우스로 놓은 블록이 참가자에게도 같음', check);

    // ── 남의 변경이 내 화면 오브젝트에 들어온 뒤 Ctrl+Z가 남의 블록을 지우지 않음 ──
    await A.evalJs(`Entry.do('addThread', [{ id: 'e2eUndoA', type: 'when_run_button_click', x: 900, y: 300, params: [null] }]); true`);
    await B.waitFor(hasBlock('e2eUndoA'), 10000, 'B가 e2eUndoA 받음');
    const undoBefore = await A.evalJs('Entry.stateManager.undoStack_.length');
    await B.evalJs(`Entry.container.selectObject(${JSON.stringify(objId)}); Entry.do('addThread', [{ id: 'e2eUndoB', type: 'when_run_button_click', x: 900, y: 100, params: [null] }]); true`);
    await A.waitFor(hasBlock('e2eUndoB'), 10000, 'A가 e2eUndoB 받음');
    const undoAfter = await A.evalJs('Entry.stateManager.undoStack_.length');
    await A.key('z', 'KeyZ', 90, 2);
    await sleep(1500);
    check('되돌리기(Ctrl+Z)가 남이 더한 블록을 지우지 않음', await A.evalJs(hasBlock('e2eUndoB')), `되돌리기 기록 ${undoBefore}→${undoAfter}`);
    await converged(A, B, '되돌리기 뒤에도 같은 작품', check);

    // ── 참가자가 다른 작품을 불러오면 멈추고, 되돌리기를 고르면 방 작품으로 돌아옴 ──
    await B.evalJs(`Entry.clearProject(); Entry.loadProject(); true`);
    await B.waitFor(`__entryHapjak.status().client.paused && !document.getElementById('entry-hapjak-root').shadowRoot.querySelector('.modal-back').hidden`, 10000, 'B 멈춤 안내');
    const seqPaused = await A.evalJs('__entryHapjak.status().client.seq');
    await sleep(2500);
    check('다른 작품을 불러오면 방으로 보내지 않고 멈춤', (await A.evalJs('__entryHapjak.status().client.seq')) === seqPaused && (await A.evalJs(hasBlock('e2eUndoB'))));
    await uiClick(B, '.modal button.main', '방 작품으로 되돌리기');
    await converged(A, B, '"방 작품으로 되돌리기" 뒤 같은 작품', check);

    // ── 엔트리가 같은 작품을 비웠다가 조금 뒤 다시 불러와도(저장 뒤 다시 열기 같은 경우) 아무것도 보내지 않고 이어 감 ──
    const seqReload = await A.evalJs('__entryHapjak.status().client.seq');
    await B.evalJs(`(() => { const p = Entry.exportProject(); Entry.clearProject(); setTimeout(() => Entry.loadProject(p), 300); return true; })()`);
    await sleep(3000);
    const reloadState = await B.evalJs(`({ paused: __entryHapjak.status().client.paused, modal: !document.getElementById('entry-hapjak-root').shadowRoot.querySelector('.modal-back').hidden })`);
    check('같은 작품을 비웠다 다시 불러오면 멈추지도 보내지도 않음', !reloadState.paused && !reloadState.modal && (await A.evalJs('__entryHapjak.status().client.seq')) === seqReload, JSON.stringify(reloadState));

    // ── 참가자 화면에서 작품 다시 불러오기가 실패해도 방 작품은 지워지지 않고, 참가자 화면은 바로 전으로 돌아옴 ──
    const bObjsBefore = await B.evalJs('Entry.container.getAllObjects().length');
    await B.evalJs(`(() => { const orig = Entry.loadProject; let once = true; Entry.loadProject = function (p) { if (once && p && Array.isArray(p.objects) && p.objects.some(o => o.id === 'e2eObj3')) { once = false; throw new Error('시험용 불러오기 실패'); } return orig.apply(this, arguments); }; return true; })()`);
    await A.evalJs(`(() => { const o = Entry.exportProject().objects.find(o => o.id === ${JSON.stringify(objId)}); Entry.container.addObject({ ...o, id: 'e2eObj3', name: '세번째', script: '[]' }, 0); return true; })()`);
    await B.waitFor(`__entryHapjak.status().client.paused && !document.getElementById('entry-hapjak-root').shadowRoot.querySelector('.modal-back').hidden`, 15000, 'B 반영 실패 안내');
    await sleep(2500);
    const afterFail = { serverObjs: await A.evalJs('JSON.parse(__entryHapjak.serverUnits().objOrder).length'), aObjs: await A.evalJs('Entry.container.getAllObjects().length'), bObjs: await B.evalJs('Entry.container.getAllObjects().length') };
    check('참가자 불러오기가 실패해도 방 작품은 그대로이고 참가자 화면은 바로 전 상태', afterFail.serverObjs === afterFail.aObjs && afterFail.aObjs === bObjsBefore + 1 && afterFail.bObjs === bObjsBefore, JSON.stringify(afterFail));
    await uiClick(B, '.modal button.main', '방 작품 다시 받기');
    await B.waitFor(`!!Entry.container.getObject('e2eObj3')`, 10000, 'B 다시 받기');
    await converged(A, B, '"방 작품 다시 받기" 뒤 같은 작품', check);

    // ── 블록 값 고르기 목록이 열려 있는 동안은 그 화면 블록을 바꾸지 않음 ──
    await A.evalJs(`Entry.container.selectObject(${JSON.stringify(objId)}); Entry.playground.changeViewMode('code'); true`);
    await sleep(500);
    let opened = false;
    const kb = await A.evalJs(`(() => { const b = Entry.getMainWS().board.code.findById('e2eB1'); if (!b || !b.view) return null; const r = b.view.svgGroup.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
    if (kb) {
      for (const dx of [44, 50, 56, 38, 62]) {
        await A.click(kb.l + dx, kb.t + kb.h / 2);
        await sleep(300);
        // 목록 틀은 높이 0이고 실제 목록은 안쪽에 뜬다
        if (await A.evalJs(`[...document.querySelectorAll('.entry-widget-dropdown *')].some(e => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; })`)) { opened = true; break; }
      }
    }
    if (!opened) check('블록 값 목록이 열린 동안 반영 미룸', false, 'BLOCKED: 시험에서 값 목록을 열지 못함');
    else {
      await B.evalJs(`Entry.container.selectObject(${JSON.stringify(objId)}); Entry.do('addThread', [{ id: 'e2eWidget', type: 'when_run_button_click', x: 1100, y: 500, params: [null] }]); true`);
      await sleep(2500);
      const whileOpen = await A.evalJs(`!!Entry.getMainWS().board.code.findById('e2eWidget')`);
      await A.key('Escape', 'Escape', 27);
      await A.click(kb.l + kb.w + 300, kb.t + 250);
      await A.waitFor(`!!Entry.getMainWS().board.code.findById('e2eWidget')`, 10000, '목록 닫은 뒤 반영');
      check('블록 값 목록이 열린 동안 반영을 미루고, 닫으면 반영', !whileOpen);
      await converged(A, B, '값 목록 닫은 뒤 같은 작품', check);
    }

    // ── 오른쪽 클릭 메뉴가 열려 있는 동안도 같음 ──
    const rc = await A.evalJs(`(() => { const r = Entry.getMainWS().board.code.findById('e2eA1').view.svgGroup.getBoundingClientRect(); return { x: r.left + 30, y: r.top + r.height / 2 }; })()`);
    await A.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rc.x, y: rc.y, buttons: 0 });
    await A.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rc.x, y: rc.y, button: 'right', buttons: 2, clickCount: 1 });
    await A.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rc.x, y: rc.y, button: 'right', buttons: 0, clickCount: 1 });
    await sleep(400);
    if (!(await A.evalJs('!!(Entry.ContextMenu && Entry.ContextMenu.visible)'))) check('오른쪽 클릭 메뉴가 열린 동안 반영 미룸', false, 'BLOCKED: 시험에서 메뉴를 열지 못함');
    else {
      await B.evalJs(`Entry.container.selectObject(${JSON.stringify(objId)}); Entry.do('addThread', [{ id: 'e2eCtx', type: 'when_run_button_click', x: 1100, y: 650, params: [null] }]); true`);
      await sleep(2500);
      const whileMenu = await A.evalJs(`!!Entry.getMainWS().board.code.findById('e2eCtx')`);
      await A.click(rc.x + 500, rc.y + 400);
      await A.waitFor(`!!Entry.getMainWS().board.code.findById('e2eCtx')`, 10000, '메뉴 닫은 뒤 반영');
      check('오른쪽 클릭 메뉴가 열린 동안 반영을 미루고, 닫으면 반영', !whileMenu);
      await converged(A, B, '메뉴 닫은 뒤 같은 작품', check);
    }

    // ── 방장 쪽이 1분 넘게 멈춤(인터넷 끊김 흉내) → 참가자가 다시 붙고, 그동안 고친 게 살아남음 ──
    await A.send('Debugger.enable');
    await A.send('Debugger.pause');
    await sleep(1000);
    await B.evalJs(`Entry.container.selectObject(${JSON.stringify(objId)}); Entry.do('addThread', [{ id: 'e2eOffline', type: 'when_run_button_click', x: 100, y: 700, params: [null] }]); true`);
    // 큰 작품을 불러오는 동안의 멈춤을 끊김으로 오판하지 않도록 60초까지는 기다린다 — 그보다 오래 멈춰야 끊김으로 본다
    await B.waitFor(`__entryHapjak.status().link === 'down'`, 90000, 'B가 끊김을 알아챔');
    const offlineUi = await B.evalJs(`document.getElementById('entry-hapjak-root').shadowRoot.querySelector('.fab .dot').className`);
    await sleep(3000);
    await A.send('Debugger.resume');
    await A.send('Debugger.disable');
    await B.waitFor(`__entryHapjak.status().link === 'up' && __entryHapjak.status().mode === 'room'`, 90000, 'B 다시 연결');
    await A.waitFor(hasBlock('e2eOffline'), 20000, 'A가 끊긴 동안의 편집을 받음');
    check('끊겼다 다시 붙으면 끊긴 동안 고친 것이 방장에게 감', true, `끊김 표시: ${offlineUi}`);
    await converged(A, B, '다시 연결 뒤 같은 작품', check, 30000);

    await A.screenshot(path.join(out, '2-A-after.png'));
    await B.screenshot(path.join(out, '2-B-after.png'));

    // ── 문제 기록 복사: 버튼이 보이고, 누르면 알림이 뜨고, 기록에 판 번호·상태·최근 기록이 들어 있음 ──
    await openPanel(B);
    await uiClick(B, '.foot button', '문제 기록 복사');
    const diag = await B.evalJs('__entryHapjak.diagnostics()');
    const diagToast = await B.evalJs(`[...document.getElementById('entry-hapjak-root').shadowRoot.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')`);
    check('문제 기록 복사가 판 번호·상태·최근 기록을 담고 알림을 띄움', diag.includes('v' + VERSION) &&/상태 room\/guest/.test(diag) && /최근 기록/.test(diag) && /복사/.test(diagToast), diagToast.slice(0, 80));
    await uiClick(B, 'button.x');

    // ── 방장이 방 닫기 → 참가자 화면에 작품은 남고 방에서 나옴 ──
    await openPanel(A);
    await uiClick(A, 'button.danger', '방 닫기');
    await uiClick(A, '.modal button.danger', '방 닫기');
    await B.waitFor(`__entryHapjak.status().mode === 'idle'`, 15000, '참가자 방 종료 알림');
    check('방장이 방을 닫으면 참가자는 작품을 가진 채 방에서 나옴', await B.evalJs(hasBlock('e2eUndoB')));
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

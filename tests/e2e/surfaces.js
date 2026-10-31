// 무작위 편집 시험이 안 건드리는 편집 종류(함수·장면·리스트·소리·글상자·오브젝트 순서·초시계/대답·같은 묶음 동시 편집·
// 지우는 중에 고치기·연결 끊김)를 실제 엔트리 크롬 2개로 하나씩 해 보고, 매번 같은 성질을 본다:
// 모두 방 작품과 같음 · 엔트리 원본도 같음 · 예상 밖 통째로 다시 불러오기 없음 · 확장 예외 없음 · 멈춤 없음
//   node tests/e2e/surfaces.js [--ext 확장폴더] [--only 이름,이름]
const fs = require('fs'), path = require('path');
const { launch, openEntry, closeGuide, sleep } = require('./chrome');
const { checker, openRoom, openPanel, uiClick, STRIP } = require('./room');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i < 0 ? def : process.argv[i + 1]; };
const ext = path.resolve(arg('ext', path.resolve(__dirname, '..', '..')));
const only = arg('only', '') ? new Set(arg('only', '').split(',')) : null;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.join(__dirname, 'out', 'surfaces-' + stamp);
fs.mkdirSync(out, { recursive: true });
const { results, check } = checker();
const J = JSON.stringify;

function pageHelper() {
  if (window.__sf) return true;
  const M = window.ErcMerge;
  let loads = 0;
  const origLoad = Entry.loadProject;
  Entry.loadProject = function () { loads++; return origLoad.apply(this, arguments); };
  // 연결 끊김 흉내: 이 탭이 만든 데이터 통로를 닫으면 PeerJS가 끊김으로 알린다
  const dcs = [];
  const P = RTCPeerConnection.prototype, origDc = P.createDataChannel;
  P.createDataChannel = function () { const dc = origDc.apply(this, arguments); dcs.push(dc); return dc; };
  const vm = () => (Entry.playground.getViewMode ? Entry.playground.getViewMode() : Entry.playground.viewMode_);
  window.__sf = {
    loads: () => loads,
    drop() { let n = 0; for (const dc of dcs.splice(0)) if (dc.readyState === 'open') { dc.close(); n++; } return n; },
    raw() { return M.projectToUnits(Entry.exportProject(), () => null); },
    show(id) { Entry.container.selectObject(id); Entry.playground.changeViewMode('code'); return String(Entry.playground.object.id); },
    view() {
      const b = Entry.getMainWS().board, c = Entry.playground.object;
      let strays = 0, missing = 0;
      if (b && b.code) {
        const mine = new Set();
        for (const t of b.code.getThreads()) { const g = t.view && t.view.svgGroup; if (g && g.isConnected) mine.add(g); else missing++; }
        for (const o of Entry.container.getAllObjects()) if (o.script !== b.code) for (const t of o.script.getThreads()) { const g = t.view && t.view.svgGroup; if (g && g.isConnected && !mine.has(g)) strays++; }
      }
      const s = __entryHapjak.status();
      return { sel: c ? String(c.id) : null, scene: Entry.scene.selectedScene && Entry.scene.selectedScene.id, mode: vm(), boardIsCur: !!(c && b && b.code === c.script), strays, missing,
        paused: !!(s.client && s.client.paused), link: s.link, room: s.mode, loads, running: !Entry.engine.isState('stop') };
    },
    dialog() {
      for (const el of document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="popup" i]')) {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        if (r.width > 40 && r.height > 40 && cs.visibility !== 'hidden' && cs.display !== 'none') return (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120) || el.className;
      }
      return null;
    },
  };
  return true;
}

function headless(k, v) {
  if (v == null) return v;
  try {
    if (k.startsWith('code:')) return J(JSON.parse(v).map(th => (Array.isArray(th) && th[0] ? [{ ...th[0], x: 0, y: 0 }, ...th.slice(1)] : th)));
    if (k.startsWith('func:')) { const f = JSON.parse(v); if (Array.isArray(f.content)) f.content = f.content.map(th => (Array.isArray(th) && th[0] ? [{ ...th[0], x: 0, y: 0 }, ...th.slice(1)] : th)); return J(f); }
    if (k.startsWith('obj:')) { const o = JSON.parse(v); if (o.objectType === 'textBox' && o.entity) { delete o.entity.width; delete o.entity.height; } return J(o); }
  } catch { /* 그대로 비교 */ }
  return v;
}
const COMPARE = /^(code|obj|var|msg|func|scene):|^(objOrder|varOrder|msgOrder|funcOrder|sceneOrder)$/;

(async () => {
  let A, B;
  const peers = [];
  try {
    [A, B] = await Promise.all([launch({ ext, name: 'A(방장)' }), launch({ ext, name: 'B(참가자)' })]);
    await Promise.all([openEntry(A), openEntry(B)]);
    const HELPER = `(${pageHelper.toString()})()`;
    await Promise.all([A.evalJs(HELPER), B.evalJs(HELPER)]);
    await openRoom(A, B);
    check('방을 열고 참가자가 들어옴', true);
    for (const [c, name] of [[A, 'A'], [B, 'B']]) peers.push({ c, name, loads0: await c.evalJs('__sf.loads()'), excAt: c.exceptions.length, seenNotes: new Set() });
    const [pA, pB] = peers;
    const o1 = await A.evalJs('String(Entry.playground.object.id)');
    const sceneId = await A.evalJs('Entry.scene.selectedScene.id');

    const readUnits = async (c, server = false) => {
      for (let i = 0; i < 40; i++) { const u = await c.evalJs(`${STRIP}(__entryHapjak.${server ? 'serverUnits' : 'exportUnits'}())`); if (u && Object.keys(u).length) return u; await sleep(100); }
      return null;
    };
    // 지난 확인 뒤 "내 변경이 반영되지 않았어요" 알림(남이 먼저 고침·남이 지움)을 받았는지
    const notified = async p => {
      const lines = (await p.c.evalJs('__entryHapjak.diagnostics()')).split('\n').filter(l => /반영되지 않았어요/.test(l));
      const fresh = lines.filter(l => !p.seenNotes.has(l));
      fresh.forEach(l => p.seenNotes.add(l));
      return fresh.length > 0;
    };
    // expect: { A: 다시 불러오기 수, B: … } — 정해 둔 수와 다르면 실패. 'any'면 세지 않는다
    // 엔트리 원본과 방 작품이 다른 조각(엔트리가 명령 없이 바꾼 값은 확장이 몇 초 안에 돌아보며 찾으므로 기다린다)
    const rawBad = (raw, us) => [...new Set([...Object.keys(raw || {}), ...Object.keys(us || {})])]
      .filter(k => COMPARE.test(k) && headless(k, raw && raw[k] != null ? raw[k] : null) !== headless(k, us && us[k] != null ? us[k] : null));
    async function settle(label, expect = {}) {
      await sleep(600);
      const t0 = Date.now();
      let us, mine, raws, diff = [], bads = [];
      while (Date.now() - t0 < 30000) {
        [us, ...mine] = await Promise.all([readUnits(A, true), ...peers.map(p => readUnits(p.c))]);
        raws = await Promise.all(peers.map(p => p.c.evalJs('__sf.raw()')));
        const st = await Promise.all(peers.map(p => p.c.evalJs('__entryHapjak.status().client')));
        diff = [];
        if (us && mine.every(Boolean)) for (const k of new Set([us, ...mine].flatMap(Object.keys))) if (mine.some(u => u[k] !== us[k])) diff.push(k);
        bads = raws.map(raw => rawBad(raw, us));
        if (us && mine.every(Boolean) && !diff.length && bads.every(b => !b.length) && st.every(s => s && !s.sending && !s.waiting)) break;
        await sleep(300);
      }
      check(`[${label}] 두 사람 작품이 방 작품과 같아짐`, us && mine.every(Boolean) && !diff.length, diff.length ? '다른 조각: ' + diff.slice(0, 8).join(', ') + ' · ' + J(await Promise.all(peers.map(p => p.c.evalJs('__entryHapjak.status().client')))) : '');
      for (const [i, p] of peers.entries()) {
        const raw = raws[i], bad = bads[i];
        check(`[${label}] ${p.name}의 실제 엔트리 작품도 방 작품과 같음`, !bad.length, bad.length ? bad.slice(0, 6).join(', ') + ' · 엔트리 ' + String(raw[bad[0]]).slice(0, 220) + ' · 방 ' + String(us && us[bad[0]]).slice(0, 220) : '');
        const v = await p.c.evalJs('__sf.view()');
        const reloads = v.loads - p.loads0;
        p.loads0 = v.loads;
        const want = expect[p.name] === undefined ? 0 : expect[p.name];
        if (want !== 'any') {
          const why = reloads !== want ? (await p.c.evalJs('__entryHapjak.diagnostics()')).split('\n').filter(l => /다시 불러오기|실패/.test(l)).slice(-3).join(' / ') : '';
          check(`[${label}] ${p.name} 통째로 다시 불러오기 ${want}번`, reloads === want, `실제 ${reloads}번 ${why}`);
        }
        const probs = [];
        if (v.paused) probs.push('방과 맞추기 멈춤');
        if (v.link !== 'up' || v.room !== 'room') probs.push(`연결 ${v.link}/${v.room}`);
        if (v.mode === 'code' && v.sel && !v.boardIsCur) probs.push('블록 화면이 고른 오브젝트 코드가 아님');
        if (v.strays) probs.push(`남의 오브젝트 블록 ${v.strays}개가 화면에 섞임`);
        if (v.missing) probs.push(`그려지지 않은 묶음 ${v.missing}개`);
        const exc = p.c.exceptions.slice(p.excAt);
        p.excAt = p.c.exceptions.length;
        const ours = exc.filter(e => /chrome-extension:|entry-adapter|sync\.js|main\.js|merge\.js/.test(J(e)));
        if (ours.length) probs.push('확장 예외 ' + J(ours.slice(0, 2)).slice(0, 400));
        else if (exc.length) console.log(`  (참고) ${p.name} 엔트리 쪽 예외 ${exc.length}개: ${exc.slice(0, 2).map(e => e.text.slice(0, 120)).join(' / ')}`);
        check(`[${label}] ${p.name} 화면·연결 정상`, !probs.length, probs.join(' · '));
      }
      return us;
    }
    const waitAll = (expr, what, ms = 20000) => Promise.all(peers.map(p => p.c.waitFor(expr, ms, what)));
    const addThread = (tid, blocks, x = 120, y = 120) => `(() => { Entry.do('addThread', [{ id: ${J(tid)}, type: 'when_run_button_click', x: ${x}, y: ${y}, params: [null] }, ...${J(blocks)}]); return true; })()`;
    const num = (id, n) => ({ id, type: 'number', params: [String(n)] });
    const hasBlock = id => `(Entry.container.getAllObjects().some(o => !!o.script.findById(${J(id)})) || Object.values(Entry.variableContainer.functions_ || {}).some(f => !!(f.content && f.content.findById(${J(id)}))))`;
    // 조각 안에서 그 id의 블록 수(코드·함수)
    const countId = (units, id) => {
      let n = 0;
      const walk = x => { if (Array.isArray(x)) { x.forEach(walk); return; } if (!x || typeof x !== 'object') return; if (x.id === id && typeof x.type === 'string') n++; for (const v of Object.values(x)) if (v && typeof v === 'object') walk(v); };
      for (const [k, v] of Object.entries(units || {})) if (/^(code|func):/.test(k) && v) walk(JSON.parse(v));
      return n;
    };
    const runFor = async (c, ms) => { await c.evalJs('Entry.engine.toggleRun(), true'); await sleep(ms); await c.evalJs("(Entry.engine.isState('stop') || Entry.engine.toggleStop(), true)"); await sleep(400); };

    const scenarios = {
      // 블록이 쓰는 변수를 남이 이름 바꾸거나 지울 때
      async varUsed() {
        await A.evalJs(`(Entry.do('variableContainerAddVariable', new Entry.Variable({ id: 'sv1', name: '점수', variableType: 'variable', value: 0 })), true)`);
        await waitAll(`!!Entry.variableContainer.getVariable('sv1')`, '변수 sv1');
        await B.evalJs(`__sf.show(${J(o1)})`);
        await B.evalJs(addThread('tsv1', [{ id: 'tsv1s', type: 'set_variable', params: ['sv1', { id: 'tsv1n', type: 'text', params: ['5'] }, null] }]));
        await A.waitFor(hasBlock('tsv1s'), 15000, 'A가 변수 블록 받음');
        await settle('변수 블록');
        await A.evalJs(`(Entry.do('variableSetName', 'sv1', '점수2'), true)`);
        await B.waitFor(`Entry.variableContainer.getVariable('sv1').name_ === '점수2'`, 15000, 'B가 새 이름 받음');
        await settle('블록이 쓰는 변수 이름 바꾸기');
        check('블록이 쓰는 변수 이름을 남이 바꿔도 그 블록이 남음', await B.evalJs(hasBlock('tsv1s')) && await A.evalJs(hasBlock('tsv1s')));
        // 엔트리는 변수를 지워도 그 변수를 쓰는 블록을 남겨 두고, 실행하면 오류가 난다 — 다음 시나리오가 실행하므로 블록부터 지운다
        await B.evalJs(`(Entry.do('destroyThread', Entry.playground.object.script.findById('tsv1').getThread()), true)`);
        await A.waitFor(`!${hasBlock('tsv1s')}`, 15000, 'A에서 변수 블록 지워짐');
        await A.evalJs(`(Entry.do('variableContainerRemoveVariable', Entry.variableContainer.getVariable('sv1')), true)`);
        await B.waitFor(`!Entry.variableContainer.getVariable('sv1')`, 15000, 'B에서 변수 지워짐');
        await settle('블록이 쓰는 변수 지우기');
      },
      async list() {
        // 엔트리 화면의 리스트 추가처럼 데이터로 넘긴다(Entry.Variable로 만들면 리스트 모양이 아닌 보통 변수가 됨)
        await A.evalJs(`(Entry.do('variableContainerAddList', { id: 'sl1', name: '목록', variableType: 'list' }), true)`);
        await waitAll(`!!Entry.variableContainer.getList('sl1')`, '리스트 sl1');
        await settle('리스트 더하기');
        await B.evalJs(`__sf.show(${J(o1)})`);
        await B.evalJs(addThread('tls1', [{ id: 'tls1a', type: 'add_value_to_list', params: [{ id: 'tls1t', type: 'text', params: ['사과'] }, 'sl1', null] }], 120, 320));
        await settle('리스트 블록');
        await runFor(B, 1200);
        await settle('리스트에 넣는 블록 실행·멈춤');
      },
      async sound() {
        await A.evalJs(`(() => { __sf.show(${J(o1)}); Entry.playground.changeViewMode('sound'); const s = Entry.exportProject().objects.find(o => o.id === ${J(o1)}).sprite.sounds[0]; Entry.do('objectAddSound', ${J(o1)}, { ...s, id: 'ss1', name: '소리둘' }); return true; })()`);
        await B.waitFor(`!!Entry.container.getObject(${J(o1)}).getSound('ss1')`, 15000, 'B가 소리 받음');
        await A.evalJs(`(Entry.playground.changeViewMode('code'), true)`);
        await settle('소리 더하기');
        // B가 소리 탭에서 그 오브젝트를 보는 중이면 미뤘다가, 블록 탭으로 오면 넣는다
        await B.evalJs(`(() => { __sf.show(${J(o1)}); Entry.playground.changeViewMode('sound'); return true; })()`);
        await A.evalJs(`(Entry.do('objectRemoveSound', ${J(o1)}, { id: 'ss1' }), true)`);
        await sleep(1500);
        check('소리 탭을 보는 사람에게는 소리 목록 바꾸기를 미룸', await B.evalJs(`!!Entry.container.getObject(${J(o1)}).getSound('ss1')`));
        await B.evalJs(`(Entry.playground.changeViewMode('code'), true)`);
        await settle('소리 빼기(소리 탭에서 나온 뒤)');
      },
      async textbox() {
        const tb = { id: 'tb1', name: '글상자', text: '안녕', script: '[]', objectType: 'textBox', rotateMethod: 'none', scene: sceneId, sprite: { pictures: [], sounds: [] }, selectedPictureId: null, lock: false,
          entity: { rotation: 0, direction: 90, x: 0, y: 0, regX: 0, regY: 0, scaleX: 1, scaleY: 1, width: 64, height: 24, font: '20px Nanum Gothic', visible: true, colour: '#000000', text: '안녕', textAlign: 0, lineBreak: false, bgColor: 'transparent', underLine: false, strike: false, fontSize: 20 } };
        await A.evalJs(`(Entry.do('addObject', ${J(tb)}, 0), true)`);
        await B.waitFor(`!!Entry.container.getObject('tb1')`, 20000, 'B가 글상자 받음');
        await settle('글상자 더하기', { B: 1 });
        await A.evalJs(`(() => { __sf.show('tb1'); Entry.do('editText', '바뀐 글'); return true; })()`);
        await B.waitFor(`Entry.container.getObject('tb1').text === '바뀐 글'`, 15000, 'B가 바뀐 글 받음');
        await settle('글상자 글 바꾸기');
        check('글상자 글이 받는 쪽 무대 글에도 들어감', await B.evalJs(`Entry.container.getObject('tb1').entity.getText() === '바뀐 글'`));
        await B.evalJs(`__sf.show('tb1')`);
        await A.evalJs(`(Entry.do('editText', '또 바뀜'), true)`);
        await B.waitFor(`Entry.container.getObject('tb1').text === '또 바뀜'`, 15000, 'B가 또 바뀐 글 받음');
        await settle('글상자를 보는 사람에게 글 바꾸기');
        await A.evalJs(`__sf.show(${J(o1)})`); await B.evalJs(`__sf.show(${J(o1)})`);
      },
      // 엔트리는 초시계·대답 블록이 화면에 그려질 때 그 변수를 "보이기"로 바꾼다(명령 없이) — 그 블록을 화면에서 안 본 사람은 받아서 넣어야 한다
      async timerAnswer() {
        await A.evalJs(`__sf.show('tb1')`);
        await B.evalJs(`__sf.show(${J(o1)})`);
        await B.evalJs(addThread('ttm1', [{ id: 'ttm1a', type: 'choose_project_timer_action', params: [null, 'START', null, null] }, { id: 'ttm1w', type: 'wait_second', params: [num('ttm1n', 2), null] }], 420, 120));
        await settle('초시계 블록(받는 사람은 다른 오브젝트를 보는 중)');
        check('초시계가 받는 사람 무대에도 보임', await A.evalJs('Entry.engine.projectTimer.isVisible()'));
        await runFor(B, 1500);
        await settle('초시계 실행·멈춤');
        await B.evalJs(addThread('tas1', [{ id: 'tas1a', type: 'ask_and_wait', params: [{ id: 'tas1t', type: 'text', params: ['이름?'] }, null] }], 420, 320));
        await settle('묻고 기다리기 블록(받는 사람은 다른 오브젝트를 보는 중)');
        await B.evalJs('Entry.engine.toggleRun(), true'); await sleep(800);
        await B.evalJs(`(Entry.container.setInputValue('정답'), true)`); await sleep(300);
        await B.evalJs("(Entry.engine.isState('stop') || Entry.engine.toggleStop(), true)"); await sleep(400);
        await settle('대답 받고 멈춤');
        await A.evalJs(`__sf.show(${J(o1)})`);
      },
      async reorder() {
        const before = await B.evalJs(`Entry.container.getCurrentObjects().map(o => String(o.id)).join(',')`);
        if (before.split(',').length < 2) { check('오브젝트 순서 시험 준비(오브젝트 2개 이상)', false, before); return; }
        await A.evalJs(`(Entry.do('objectReorder', 1, 0), true)`);
        const want = await A.evalJs(`Entry.container.getCurrentObjects().map(o => String(o.id)).join(',')`);
        await B.waitFor(`Entry.container.getCurrentObjects().map(o => String(o.id)).join(',') === ${J(want)}`, 15000, 'B가 새 순서 받음');
        await settle('오브젝트 순서 바꾸기');
        // 오브젝트 목록 순서가 곧 무대에서 앞뒤 순서다
        const zorder = `Entry.container.getCurrentObjects().map(o => Entry.stage.selectedObjectContainer.getChildIndex(o.entity.object)).join(',')`;
        const [za, zb] = [await A.evalJs(zorder), await B.evalJs(zorder)];
        check('받는 사람 무대의 앞뒤 순서도 같음', za === zb, `A ${za} · B ${zb}`);
      },
      // 엔트리파이선(글 코딩)에서 블록으로 돌아오면 엔트리가 그 오브젝트 코드를 글 내용으로 통째로 다시 만든다
      async python() {
        await A.evalJs(`__sf.show(${J(o1)})`); await B.evalJs(`__sf.show(${J(o1)})`);
        await B.evalJs(`(Entry.getMainWS().setMode({ boardType: Entry.Workspace.MODE_VIMBOARD, textType: Entry.Vim.TEXT_TYPE_PY, runType: Entry.Vim.WORKSPACE_MODE }), true)`);
        await B.waitFor('Entry.isTextMode === true', 10000, 'B 파이선 화면');
        await sleep(800);
        await A.evalJs(`(() => { __sf.show('tb1'); return true; })()`);
        await A.evalJs(addThread('tpy3', [{ id: 'tpy3m', type: 'move_direction', params: [num('tpy3n', 5), null] }], 300, 300));
        await B.waitFor(hasBlock('tpy3m'), 15000, 'B가 파이선 화면에서도 다른 오브젝트 블록 받음');
        await A.evalJs(`__sf.show(${J(o1)})`);
        await A.evalJs(addThread('tpy2', [{ id: 'tpy2m', type: 'move_direction', params: [num('tpy2n', 4), null] }], 300, 500));
        await sleep(2500);
        await B.evalJs(`(Entry.getMainWS().setMode({ boardType: Entry.Workspace.MODE_BOARD, textType: -1 }), true)`);
        await B.waitFor('Entry.isTextMode === false', 10000, 'B 블록 화면');
        const us = await settle('파이선에서 블록으로 돌아옴');
        check('파이선 화면에 있던 동안 남이 그 오브젝트에 더한 블록이 남음', countId(us, 'tpy2m') === 1 && await A.evalJs(hasBlock('tpy2m')), `방에 ${countId(us, 'tpy2m')}개`);

        // 파이선 글에는 그 오브젝트가 쓰는 함수 정의도 들어 있어, 블록으로 돌아올 때 엔트리가 함수도 글 내용으로 다시 만든다
        const toPy = `(Entry.getMainWS().setMode({ boardType: Entry.Workspace.MODE_VIMBOARD, textType: Entry.Vim.TEXT_TYPE_PY, runType: Entry.Vim.WORKSPACE_MODE }), true)`;
        const toBlock = `(Entry.getMainWS().setMode({ boardType: Entry.Workspace.MODE_BOARD, textType: -1 }), true)`;
        const moves = (units, k) => ((units[k] || '').match(/move_direction/g) || []).length;
        await A.evalJs(`(() => { Entry.do('funcEditStart', 'spf'); Entry.do('addThread', [{ id: 'spfb1', type: 'move_direction', x: 200, y: 200, params: [{ id: 'spfb1n', type: 'number', params: ['7'] }, null] }]); const c = Entry.Func.targetFunc.content; Entry.do('insertBlock', c.findById('spfb1'), c.getThreads()[0].getFirstBlock().statements[0]); Entry.do('funcEditEnd', 'save'); return true; })()`);
        await A.evalJs(addThread('tpyf', [{ id: 'tpyff', type: 'func_spf', params: [] }], 600, 500));
        await B.waitFor(hasBlock('tpyff'), 15000, 'B가 함수 쓰는 블록 받음');
        await settle('파이선 시험용 함수');
        await B.evalJs(toPy); await B.waitFor('Entry.isTextMode === true', 10000, 'B 파이선 화면');
        await sleep(800);
        await A.evalJs(`(() => { Entry.do('funcEditStart', 'spf'); Entry.do('addThread', [{ id: 'spfb2', type: 'move_direction', x: 200, y: 260, params: [{ id: 'spfb2n', type: 'number', params: ['9'] }, null] }]); const c = Entry.Func.targetFunc.content; Entry.do('insertBlock', c.findById('spfb2'), c.findById('spfb1')); Entry.do('funcEditEnd', 'save'); return true; })()`);
        await sleep(2500);
        await B.evalJs(toBlock); await B.waitFor('Entry.isTextMode === false', 10000, 'B 블록 화면');
        const us2 = await settle('파이선 화면 동안 남이 함수를 고침');
        check('파이선 화면에 있던 동안 남이 고친 함수가 옛 정의로 덮이지 않음', moves(us2, 'func:spf') === 2, `방 함수 블록 ${moves(us2, 'func:spf')}개`);

        // 블록으로 못 바꾸는 글로 돌아가면 엔트리가 그 오브젝트 블록을 비운다 — 방에 퍼지기 전에 멈추고 물어야 한다
        const threadsIn = (units, id) => JSON.parse(units['code:' + id] || '[]').length;
        const n0 = threadsIn(us2, o1);
        await B.evalJs(toPy); await B.waitFor('Entry.isTextMode === true', 10000, 'B 파이선 화면');
        await B.evalJs(`(() => { const v = Entry.getMainWS().vimBoard; (v.codeMirror || v._codeMirror).setValue('def 틀림 ((( :'); return true; })()`);
        await B.evalJs(toBlock);
        const paused = await B.waitFor(`__entryHapjak.status().client.paused`, 10000, 'B 멈춤').then(() => true, () => false);
        await sleep(1500);
        const usW = await readUnits(A, true);
        check('블록이 한꺼번에 비워지면 방에 보내기 전에 멈춤', paused && threadsIn(usW, o1) === n0, `멈춤 ${paused}, 방 묶음 ${n0}→${threadsIn(usW, o1)}, B 묶음 ${await B.evalJs('Entry.playground.object.script.getThreads().length')}`);
        if (paused) await uiClick(B, 'button.main', '방 작품으로 되돌리기');
        await settle('방 작품으로 되돌림', { B: paused ? 1 : 'any' });
        check('되돌리면 비워진 블록이 돌아옴', await B.evalJs('Entry.playground.object.script.getThreads().length') === n0);
      },
      async scene() {
        await B.evalJs(`__sf.show(${J(o1)})`);
        await A.evalJs(`(Entry.do('sceneAdd', 'sc2'), true)`);
        await B.waitFor(`!!Entry.scene.getSceneById('sc2')`, 20000, 'B가 새 장면 받음');
        const us = await settle('장면 더하기', { B: 'any' });
        const vb = await B.evalJs('__sf.view()');
        check('장면이 더해져도 B는 보던 장면·오브젝트 그대로', vb.scene === sceneId && vb.sel === o1, J({ scene: vb.scene, sel: vb.sel }));
        const base = JSON.parse(us['obj:' + o1]);
        await A.evalJs(`(Entry.do('addObject', ${J({ ...base, id: 'sco1', name: '둘째장면것', scene: 'sc2', script: '[]', sprite: { ...base.sprite, pictures: base.sprite.pictures.map((p, i) => ({ ...p, id: 'sco1p' + i })), sounds: [] }, selectedPictureId: 'sco1p0' })}, 0), true)`);
        await B.waitFor(`!!Entry.container.getObject('sco1')`, 20000, 'B가 둘째 장면 오브젝트 받음');
        await settle('다른 장면에 오브젝트 더하기', { B: 1 });
        await A.evalJs(`(() => { Entry.do('sceneSelect', 'sc2'); __sf.show('sco1'); return true; })()`);
        await A.evalJs(addThread('tsc1', [{ id: 'tsc1m', type: 'move_direction', params: [num('tsc1n', 3), null] }]));
        await B.waitFor(hasBlock('tsc1m'), 15000, 'B가 다른 장면 블록 받음');
        await settle('다른 장면 오브젝트 블록 고치기');
        await B.evalJs(`(() => { Entry.do('sceneSelect', 'sc2'); __sf.show('sco1'); return true; })()`); await sleep(600);
        check('그 장면을 열면 받은 블록이 그려짐', await B.evalJs(`(() => { const b = Entry.getMainWS().board.code.findById('tsc1m'); return !!(b && b.view && b.view.svgGroup && b.view.svgGroup.isConnected); })()`));
        await A.evalJs(`(Entry.do('sceneRename', 'sc2', '둘째'), true)`);
        await B.waitFor(`Entry.scene.getSceneById('sc2').name === '둘째'`, 20000, 'B가 장면 이름 받음');
        await settle('장면 이름 바꾸기');
        const vb2 = await B.evalJs('__sf.view()');
        check('장면 이름이 바뀌어도 B는 보던 장면·오브젝트 그대로', vb2.scene === 'sc2' && vb2.sel === 'sco1', J({ scene: vb2.scene, sel: vb2.sel }));
        await A.evalJs(`(() => { Entry.do('sceneSelect', ${J(sceneId)}); __sf.show(${J(o1)}); Entry.do('sceneRemove', 'sc2'); return true; })()`);
        await B.waitFor(`!Entry.scene.getSceneById('sc2')`, 20000, 'B에서 장면 지워짐');
        await settle('보는 중인 장면을 남이 지움', { A: 'any', B: 'any' });
        await B.evalJs(`__sf.show(${J(o1)})`);
      },
      async func() {
        await A.evalJs(`(() => { __sf.show(${J(o1)}); Entry.do('funcEditStart', 'sf1'); Entry.do('addThread', [{ id: 'sfb1', type: 'move_direction', x: 200, y: 200, params: [{ id: 'sfb1n', type: 'number', params: ['7'] }, null] }]); const c = Entry.Func.targetFunc.content; Entry.do('insertBlock', c.findById('sfb1'), c.getThreads()[0].getFirstBlock().statements[0]); Entry.do('funcEditEnd', 'save'); return true; })()`);
        await B.waitFor(`!!Entry.variableContainer.functions_.sf1`, 15000, 'B가 함수 받음');
        await settle('함수 만들기');
        check('받은 함수가 B 블록 꾸러미에 보임', await B.evalJs(`Entry.getMainWS().getBlockMenu().code.getThreads().some(t => t.getFirstBlock() && t.getFirstBlock().type === 'func_sf1')`));
        await B.evalJs(`__sf.show(${J(o1)})`);
        await B.evalJs(addThread('tfu1', [{ id: 'tfu1f', type: 'func_sf1', params: [] }], 620, 120));
        await A.waitFor(hasBlock('tfu1f'), 15000, 'A가 함수 블록 받음');
        await settle('함수 블록 쓰기');
        await A.evalJs(`(() => { Entry.do('funcEditStart', 'sf1'); Entry.do('addThread', [{ id: 'sfb2', type: 'move_direction', x: 200, y: 260, params: [{ id: 'sfb2n', type: 'number', params: ['9'] }, null] }]); const c = Entry.Func.targetFunc.content; Entry.do('insertBlock', c.findById('sfb2'), c.findById('sfb1')); Entry.do('funcEditEnd', 'save'); return true; })()`);
        await B.waitFor(`JSON.stringify(Entry.variableContainer.functions_.sf1.content.toJSON()).includes('sfb2')`, 15000, 'B가 고친 함수 받음');
        await settle('함수 고치기');
        check('함수를 고쳐도 B 화면의 함수 블록이 그려진 채', await B.evalJs(`(() => { const b = Entry.getMainWS().board.code.findById('tfu1f'); return !!(b && b.view && b.view.svgGroup && b.view.svgGroup.isConnected); })()`));
        await A.evalJs(`(Entry.do('funcRemove', Entry.variableContainer.getFunction('sf1')), true)`);
        await B.waitFor(`!Entry.variableContainer.functions_.sf1`, 15000, 'B에서 함수 지워짐');
        await settle('함수 지우기');
        check('지운 함수가 B 블록 꾸러미에서도 빠짐', await B.evalJs(`!Entry.getMainWS().getBlockMenu().code.getThreads().some(t => t.getFirstBlock() && t.getFirstBlock().type === 'func_sf1')`));
      },
      // 같은 묶음을 둘이 동시에: 먼저 온 쪽이 남고, 사라진 쪽은 알림을 받아야 한다
      async contention() {
        await A.evalJs(`__sf.show(${J(o1)})`); await B.evalJs(`__sf.show(${J(o1)})`);
        await A.evalJs(addThread('tct1', [{ id: 'tct1m', type: 'move_direction', params: [num('tct1n', 1), null] }], 120, 500));
        await B.waitFor(hasBlock('tct1n'), 15000, 'B가 묶음 받음');
        await settle('같이 고칠 묶음');
        for (const p of peers) await notified(p);
        const setNum = n => `(() => { const nb = Entry.getMainWS().board.code.findById('tct1n'); const f = nb.view._contents.find(c => c && typeof c.pointer === 'function'); Entry.do('setFieldValue', f.pointer(), ${J(String(n))}); return true; })()`;
        await Promise.all([A.evalJs(setNum(11)), B.evalJs(setNum(22))]);
        const us = await settle('같은 값 칸을 동시에 고침');
        const got = JSON.stringify(JSON.parse(us['code:' + o1])).match(/"tct1n"[^}]*"params":\["(\d+)"/);
        const val = got && got[1];
        const loser = val === '11' ? pB : val === '22' ? pA : null;
        check('동시에 고친 값 칸에 둘 중 한 값이 남음', !!loser, String(val));
        if (loser) check('값이 사라진 사람에게 알림', await notified(loser), loser.name);
        await Promise.all([
          A.evalJs(`(() => { Entry.do('moveBlock', Entry.getMainWS().board.code.findById('tct1'), 300, 520); return true; })()`),
          B.evalJs(`(() => { const head = Entry.getMainWS().board.code.findById('tct1'); Entry.do('addThread', [{ id: 'tct1b', type: 'move_direction', x: 600, y: 600, params: [{ id: 'tct1bn', type: 'number', params: ['5'] }, null] }]); Entry.do('insertBlock', Entry.getMainWS().board.code.findById('tct1b'), head.getThread().getLastBlock()); return true; })()`),
        ]);
        const us2 = await settle('한 사람은 옮기고 한 사람은 붙임');
        const ids = (JSON.stringify(JSON.parse(us2['code:' + o1])).match(/"id":"tct1b?"/g) || []);
        check('옮기기·붙이기를 동시에 해도 블록이 겹치지 않음', ids.filter(x => x === '"id":"tct1"').length === 1 && ids.filter(x => x === '"id":"tct1b"').length <= 1, ids.join(' '));
      },
      // 한 사람이 오브젝트를 지우는 동안 다른 사람이 그 오브젝트 블록을 고침
      async deleteWhileEdit() {
        const us0 = await readUnits(A, true);
        const base = JSON.parse(us0['obj:' + o1]);
        await A.evalJs(`(Entry.do('addObject', ${J({ ...base, id: 'dvo1', name: '지울것', script: '[]', sprite: { ...base.sprite, pictures: base.sprite.pictures.map((p, i) => ({ ...p, id: 'dvo1p' + i })), sounds: [] }, selectedPictureId: 'dvo1p0' })}, 0), true)`);
        await B.waitFor(`!!Entry.container.getObject('dvo1')`, 20000, 'B가 오브젝트 받음');
        await A.evalJs(`__sf.show(${J(o1)})`);
        await B.evalJs(`__sf.show('dvo1')`);
        await B.evalJs(addThread('tdv1', [{ id: 'tdv1m', type: 'move_direction', params: [num('tdv1n', 4), null] }]));
        await A.waitFor(hasBlock('tdv1m'), 15000, 'A가 블록 받음');
        await settle('지울 오브젝트 준비', { B: 1 });
        for (const p of peers) await notified(p);
        await Promise.all([
          A.evalJs(`(Entry.do('removeObject', 'dvo1'), true)`),
          B.evalJs(addThread('tdv2', [{ id: 'tdv2m', type: 'move_direction', params: [num('tdv2n', 6), null] }], 300, 300)),
        ]);
        const us = await settle('지우는 동안 고침', { A: 'any', B: 'any' });
        const hasObj = us['obj:dvo1'] != null, hasCode = us['code:dvo1'] != null;
        check('오브젝트와 그 코드가 함께 남거나 함께 지워짐', hasObj === hasCode, J({ hasObj, hasCode }));
        const lost = hasObj ? pA : pB;
        check(`편집이 사라진 쪽(${lost.name})에 알림`, await notified(lost));
        if (hasObj) { await A.evalJs(`(Entry.do('removeObject', 'dvo1'), true)`); await settle('남은 오브젝트 지우기', { B: 1 }); }
        await B.evalJs(`__sf.show(${J(o1)})`);
      },
      // 참가자 연결이 끊겼다 다시 붙음: 끊긴 동안 양쪽에서 고친 것이 모두 남아야 한다
      async reconnect() {
        await A.evalJs(`__sf.show(${J(o1)})`); await B.evalJs(`__sf.show(${J(o1)})`);
        const cases = [['끊긴 뒤 고침', 'trc1', 'trc2', -1], ['고치자마자 끊김', 'trc3', 'trc4', 0], ['보낸 직후 끊김', 'trc5', 'trc6', 450]];
        let y = 120;
        for (const [label, tb, ta, gap] of cases) {
          y += 60;
          if (gap < 0) { check(`[${label}] 데이터 통로를 닫음`, (await B.evalJs('__sf.drop()')) > 0); await B.waitFor(`__entryHapjak.status().link === 'down'`, 10000, '끊김 알아챔'); }
          await B.evalJs(addThread(tb, [{ id: tb + 'm', type: 'move_direction', params: [num(tb + 'n', 2), null] }], 820, y));
          if (gap >= 0) { if (gap) await sleep(gap); check(`[${label}] 데이터 통로를 닫음`, (await B.evalJs('__sf.drop()')) > 0); }
          await A.evalJs(addThread(ta, [{ id: ta + 'm', type: 'move_direction', params: [num(ta + 'n', 3), null] }], 1000, y));
          await B.waitFor(`__entryHapjak.status().link === 'up' && __entryHapjak.status().mode === 'room'`, 30000, '다시 연결');
          await A.waitFor(`__entryHapjak.status().members.length === 2`, 15000, '방장이 다시 붙은 참가자를 봄');
          const us = await settle(label);
          check(`[${label}] 끊긴 동안 양쪽에서 고친 것이 모두 한 번씩 남음`, countId(us, tb + 'm') === 1 && countId(us, ta + 'm') === 1, `${tb} ${countId(us, tb + 'm')}개 · ${ta} ${countId(us, ta + 'm')}개`);
        }
      },
      // 참가자 페이지가 새로 열림(엔트리는 참가자가 처음 저장하면 저장한 작품 주소로 페이지를 새로 연다 — 로그인이 필요해 여기선 새로고침으로 같은 길을 탄다)
      async rejoin() {
        const reopen = async () => {
          await B.evalJs('window.__beforeReopen = true');
          await B.send('Page.reload', {});
          // 엔트리가 "저장하지 않은 변경" 떠나기 확인 창을 띄우면 사람처럼 나가기를 누른다(저장 뒤 옮길 때는 엔트리가 이 확인을 끄고 옮긴다)
          for (let i = 0; i < 15; i++) { const r = await B.send('Page.handleJavaScriptDialog', { accept: true }); if (!r.error) break; await sleep(200); }
          // 새로고침이면 엔트리가 "작품 복구"(저장하지 않은 작품을 먼저 열까요?)를 묻는다 — 사람처럼 "예"
          const yes = `(() => { const b = [...document.querySelectorAll('button, a, div, span')].find(el => el.children.length === 0 && el.textContent.trim() === '예' && el.getBoundingClientRect().width > 0); if (!b) return false; b.click(); return true; })()`;
          await B.waitFor(`!window.__beforeReopen && ((window.Entry && Entry.playground && Entry.getMainWS && Entry.getMainWS()) || ${yes})`, 60000, 'B 엔트리 다시 열림 또는 작품 복구 창');
          await B.waitFor('!!(window.Entry && Entry.playground && Entry.getMainWS && Entry.getMainWS() && window.__entryHapjak)', 60000, 'B 엔트리 다시 열림');
          await sleep(1500); await closeGuide(B);
        };
        await B.evalJs(`__sf.show(${J(o1)})`);
        await B.evalJs(addThread('trj1', [{ id: 'trj1m', type: 'move_direction', params: [num('trj1n', 6), null] }], 1100, 120));
        await settle('새로 열기 전');
        await reopen();
        const back = await B.waitFor(`__entryHapjak.status().mode === 'room'`, 45000, 'B 같은 방에 다시 들어감').then(() => true, () => false);
        check('참가자 페이지가 새로 열리면 같은 방에 다시 들어감', back && (await B.evalJs('__entryHapjak.diagnostics()')).includes('다시 들어왔어요'));
        if (!back) return;
        await B.evalJs(HELPER);
        pB.loads0 = await B.evalJs('__sf.loads()'); pB.excAt = B.exceptions.length;
        await A.waitFor(`__entryHapjak.status().members.length === 2`, 15000, '방장이 다시 들어온 참가자를 봄');
        await A.evalJs(addThread('trj2', [{ id: 'trj2m', type: 'move_direction', params: [num('trj2n', 7), null] }], 1100, 220));
        await B.evalJs(addThread('trj3', [{ id: 'trj3m', type: 'move_direction', params: [num('trj3n', 8), null] }], 1100, 320));
        const us = await settle('다시 들어온 뒤 양쪽에서 고침');
        check('다시 들어온 뒤에도 새로 열기 전 블록과 양쪽 새 블록이 한 번씩 있음', ['trj1m', 'trj2m', 'trj3m'].every(id => countId(us, id) === 1));
        // 스스로 나간 뒤 새로 열면 다시 들어가지 않는다
        await openPanel(B); await uiClick(B, 'button.danger', '방 나가기');
        await B.waitFor(`__entryHapjak.status().mode === 'idle'`, 10000, 'B 나감');
        await reopen();
        await sleep(6000);
        check('스스로 나간 뒤 새로 열면 다시 들어가지 않음', (await B.evalJs('__entryHapjak.status().mode')) === 'idle');
        peers.splice(peers.indexOf(pB), 1);
      },
    };

    for (const [name, fn] of Object.entries(scenarios)) {
      if (only && !only.has(name)) continue;
      console.log(`\n── ${name} ──`);
      try { await fn(); } catch (err) {
        check(`[${name}] 진행`, false, String(err && err.stack || err).slice(0, 600));
        try { await A.screenshot(path.join(out, `fail-${name}-A.png`)); await B.screenshot(path.join(out, `fail-${name}-B.png`)); } catch { /* 못 찍음 */ }
        // 다음 시나리오가 이어서 돌 수 있게 맞춘다
        try { await settle(`${name} 뒤 정리`, { A: 'any', B: 'any' }); } catch { /* 계속 */ }
      }
    }
  } catch (err) {
    check('시험 진행', false, String(err && err.stack || err).slice(0, 800));
  } finally {
    for (const c of [A, B]) if (c) { try { fs.writeFileSync(path.join(out, `diag-${c.name.slice(0, 1)}.txt`), await c.evalJs('__entryHapjak.diagnostics()')); } catch { /* 못 읽음 */ } }
    await Promise.all([A, B].filter(Boolean).map(c => c.close()));
    const fails = results.filter(r => !r.ok);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(results, null, 2));
    console.log(`\n${results.length - fails.length}/${results.length} 통과 · 결과: ${out}`);
    if (fails.length) console.log('실패:\n  ' + fails.map(f => f.name + (f.detail ? '  — ' + String(f.detail).slice(0, 300) : '')).join('\n  '));
    process.exit(fails.length ? 1 : 0);
  }
})();

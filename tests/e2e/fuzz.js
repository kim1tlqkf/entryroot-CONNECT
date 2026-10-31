// 두 사람이 사람처럼 동시에 무작위로 고치고, 몇 차례마다 멈춰서 작품과 화면이 맞는지 본다(실제 엔트리 크롬 2개).
// 시험을 짠 사람이 떠올린 상황만 보면 쓰는 사람이 먼저 결함을 만난다 — 고르는 건 난수에 맡기고, 확인할 성질만 정해 둔다.
// 같은 seed면 같은 순서로 고친다. 실패하면 출력된 seed로 다시 돌린다.
//   node tests/e2e/fuzz.js [--seed N] [--rounds N] [--ext 확장폴더] [--keep-going]
//   node tests/e2e/fuzz.js --replay <result.json>   지난 시험의 편집 기록을 같은 차례·순서로 다시 한다(시간 간격은 다를 수 있음)
//   --join-mid: 두 사람이 고치는 도중에 세 번째 사람이 들어와 같이 고친다(들어오는 동안 온 변경을 모아 넣는 길)
const fs = require('fs'), path = require('path');
const { launch, openEntry, sleep } = require('./chrome');
const { openRoom, joinRoom, STRIP } = require('./room');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i < 0 ? def : process.argv[i + 1]; };
const REPLAY = arg('replay', null);
const replayOps = REPLAY ? JSON.parse(fs.readFileSync(REPLAY, 'utf8')).ops.filter(o => typeof o.round === 'number') : null;
const SEED = REPLAY ? JSON.parse(fs.readFileSync(REPLAY, 'utf8')).seed : Number(arg('seed', String(Date.now() % 1e9)));
const ROUNDS = replayOps ? Math.max(...replayOps.map(o => o.round)) : Number(arg('rounds', '60'));
const JOIN_MID = REPLAY ? !!JSON.parse(fs.readFileSync(REPLAY, 'utf8')).joinMid : process.argv.includes('--join-mid');
const JOIN_AT = Math.max(4, Math.floor(ROUNDS / 3));
const ext = path.resolve(arg('ext', path.resolve(__dirname, '..', '..')));
const keepGoing = process.argv.includes('--keep-going');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.join(__dirname, 'out', `fuzz-${stamp}-s${SEED}`);
fs.mkdirSync(out, { recursive: true });

function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const rnd = mulberry32(SEED);
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = arr => arr[Math.floor(rnd() * arr.length)];
function weighted(table) {
  const live = table.filter(([, w]) => w > 0);
  let x = rnd() * live.reduce((n, [, w]) => n + w, 0);
  for (const [v, w] of live) { if ((x -= w) < 0) return v; }
  return live[live.length - 1][0];
}

// ── 페이지 안에서 도는 부분(문자열로 넣는다) ──
function pageHelper() {
  if (window.__fz) return true;
  const M = window.ErcMerge;
  let loads = 0;
  const origLoad = Entry.loadProject;
  Entry.loadProject = function () { loads++; return origLoad.apply(this, arguments); };
  const board = () => Entry.getMainWS().board;
  const cur = () => Entry.playground.object;
  const viewMode = () => (Entry.playground.getViewMode ? Entry.playground.getViewMode() : Entry.playground.viewMode_);
  const onBoard = id => { const b = board(); return b && b.code ? b.code.findById(id) : null; };
  const show = id => { Entry.container.selectObject(id); Entry.playground.changeViewMode('code'); };
  const num = (id, n) => ({ id, type: 'number', params: [String(n)] });
  const codeReady = () => viewMode() === 'code' && cur() && board().code === cur().script;
  const ops = {
    add(tid, x, y, n) {
      if (!codeReady()) return { skip: '블록 화면 아님' };
      Entry.do('addThread', [{ id: tid, type: 'when_run_button_click', x, y, params: [null] }, { id: tid + 'c', type: 'move_direction', params: [num(tid + 'n', n), null] }]);
      return { obj: String(cur().id) };
    },
    move(tid, x, y) { const b = onBoard(tid); if (!b) return { skip: '없음' }; Entry.do('moveBlock', b, x, y); return {}; },
    setNum(tid, n) {
      const nb = onBoard(tid + 'n');
      const f = nb && nb.view && (nb.view._contents || []).find(c => c && typeof c.pointer === 'function');
      if (!f) return { skip: '값 칸 없음' };
      Entry.do('setFieldValue', f.pointer(), String(n));
      return {};
    },
    append(tid, k) {
      const head = onBoard(tid);
      if (!head) return { skip: '없음' };
      const bid = tid + 'a' + k;
      Entry.do('addThread', [{ id: bid, type: 'move_direction', x: head.x + 300, y: head.y + 200, params: [num(bid + 'n', k), null] }]);
      Entry.do('insertBlock', board().code.findById(bid), head.getThread().getLastBlock());
      return {};
    },
    del(tid) { const b = onBoard(tid); if (!b) return { skip: '없음' }; Entry.do('destroyThread', b.getThread()); return {}; },
    select(id) { if (!Entry.container.getObject(id)) return { skip: '없음' }; show(id); return {}; },
    mode(m) { Entry.playground.changeViewMode(m); return {}; },
    scroll(dx, dy) { if (viewMode() !== 'code') return { skip: '블록 화면 아님' }; board().scroller.scroll(dx, dy); return {}; },
    // 스크롤하자마자(엔트리가 좌표를 맞추는 200ms 안) 다른 오브젝트를 고른다
    scrollSwitch(dx, dy, id) { if (viewMode() !== 'code' || !Entry.container.getObject(id)) return { skip: '조건 안 맞음' }; board().scroller.scroll(dx, dy); show(id); return {}; },
    objX(id, x) { if (!Entry.container.getObject(id)) return { skip: '없음' }; Entry.do('objectUpdatePosX', id, x); return {}; },
    objName(id, name) { if (!Entry.container.getObject(id)) return { skip: '없음' }; Entry.do('objectNameEdit', id, name); return {}; },
    addVar(id, name) { Entry.do('variableContainerAddVariable', new Entry.Variable({ id, name, variableType: 'variable', value: 0, visible: false })); return {}; },
    renameVar(id, name) { if (!Entry.variableContainer.getVariable(id)) return { skip: '없음' }; Entry.do('variableSetName', id, name); return {}; },
    delVar(id) { const v = Entry.variableContainer.getVariable(id); if (!v) return { skip: '없음' }; Entry.do('variableContainerRemoveVariable', v); return {}; },
    addMsg(id, name) { Entry.do('variableContainerAddMessage', { id, name }); return {}; },
    addPic(pid) {
      const o = cur();
      if (!o || !o.pictures.length) return { skip: '모양 없음' };
      Entry.do('objectAddPicture', o.id, { ...Entry.getPicturesJSON([o.pictures[0]])[0], id: pid, name: '모양' + pid });
      return { obj: String(o.id) };
    },
    selPic(pid) { const o = cur(); const p = o && o.getPicture(pid); if (!p) return { skip: '없음' }; Entry.playground.selectPicture(p); return { obj: String(o.id) }; },
    addObj(id, name) {
      const base = Entry.exportProject().objects[0];
      const pics = base.sprite.pictures.map((p, i) => ({ ...p, id: id + 'p' + i }));
      const snds = (base.sprite.sounds || []).map((s, i) => ({ ...s, id: id + 's' + i }));
      Entry.do('addObject', { ...base, id, name, script: '[]', sprite: { ...base.sprite, pictures: pics, sounds: snds }, selectedPictureId: pics[0].id }, 0);
      return {};
    },
    delObj(id) { if (!Entry.container.getObject(id)) return { skip: '없음' }; Entry.do('removeObject', id); return {}; },
    run() { if (!Entry.engine.isState('stop')) return { skip: '이미 실행 중' }; Entry.engine.toggleRun(); return {}; },
    stop() { if (!Entry.engine.isState('stop')) Entry.engine.toggleStop(); return {}; },
  };
  function view() {
    const b = board(), c = cur();
    const st = { sel: c ? String(c.id) : null, mode: viewMode(), boardIsCur: !!(c && b && b.code === c.script), missing: [], strays: 0, orphans: [], posBad: [],
      loads, undo: Entry.stateManager.undoStack_.length, running: !Entry.engine.isState('stop') };
    if (b && b.code) {
      const mine = new Set();
      for (const t of b.code.getThreads()) {
        const f = t.getFirstBlock();
        const g = t.view && t.view.svgGroup;
        if (!g || !g.isConnected) st.missing.push(f && f.id); else mine.add(g);
        if (f && f.view && (Math.abs(f.view.x - f.x) > 1 || Math.abs(f.view.y - f.y) > 1)) st.posBad.push([f.id, Math.round(f.x), Math.round(f.y), Math.round(f.view.x), Math.round(f.view.y)]);
      }
      for (const o of Entry.container.getAllObjects()) {
        if (o.script === b.code) continue;
        for (const t of o.script.getThreads()) { const g = t.view && t.view.svgGroup; if (g && g.isConnected && !mine.has(g)) st.strays++; }
      }
      // 묶음 그림 자리에 붙어 있는데 이 코드의 어느 묶음 것도 아닌 것(지운 묶음의 그림이 남았는지)
      st.orphans = [...b.svgThreadGroup.childNodes].filter(g => !mine.has(g)).map(g => `${g.tagName}.${(g.getAttribute && g.getAttribute('class')) || ''}/${g.childNodes.length}`);
    }
    const s = __entryHapjak.status();
    st.client = s.client; st.link = s.link; st.room = s.mode;
    return st;
  }
  // 엔트리 확인·안내 창(합작 창은 shadow 안이라 여기 안 잡힘). 열려 있으면 확장은 통째로 바꾸기를 미룬다
  const dialogText = () => {
    for (const el of document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="popup" i]')) {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (r.width > 40 && r.height > 40 && cs.visibility !== 'hidden' && cs.display !== 'none') return (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120) || el.className;
    }
    return null;
  };
  const painterState = () => { const pt = Entry.playground.painter; return pt && pt.file ? (pt.file.modified ? '고쳐짐:' : '') + pt.file.id : null; };
  // 확장의 내보내기(캐시 포함)를 거치지 않고 엔트리 작품 그대로 조각으로 나눈다
  const rawUnits = () => { const p = Entry.exportProject(); return p ? M.projectToUnits(p, () => null) : null; };
  window.__fz = {
    do(name, args) {
      const u0 = Entry.stateManager.undoStack_.length;
      try { const r = ops[name](...args) || {}; r.undoGrew = Entry.stateManager.undoStack_.length > u0; r.sel = cur() ? String(cur().id) : null; r.mode = viewMode(); r.dialog = dialogText(); r.painter = painterState(); return r; } catch (e) { return { error: String((e && e.stack) || e).slice(0, 500), dialog: dialogText() }; }
    },
    view, rawUnits, dialogText,
    focusBody() { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; },
  };
  return true;
}
const HELPER = `(${pageHelper.toString()})()`;

// ── 조각 비교 도구 ──
const J = JSON.stringify;
// 묶음 맨 앞 블록 좌표는 화면마다 스크롤 몫만큼 다르다 — 원본(엔트리 그대로)과 방 조각을 비교할 땐 뺀다
function headless(k, v) {
  if (v == null) return v;
  try {
    if (k.startsWith('code:')) return J(JSON.parse(v).map(th => (Array.isArray(th) && th[0] ? [{ ...th[0], x: 0, y: 0 }, ...th.slice(1)] : th)));
    if (k.startsWith('func:')) { const f = JSON.parse(v); if (Array.isArray(f.content)) f.content = f.content.map(th => (Array.isArray(th) && th[0] ? [{ ...th[0], x: 0, y: 0 }, ...th.slice(1)] : th)); return J(f); }
    if (k.startsWith('obj:')) { const o = JSON.parse(v); if (o.objectType === 'textBox' && o.entity) { delete o.entity.width; delete o.entity.height; } return J(o); }
  } catch { /* 그대로 비교 */ }
  return v;
}
const COMPARE = /^(code|obj|var|msg|func):|^(objOrder|varOrder|msgOrder|funcOrder)$/;
function threadsOf(units) {
  const m = new Map();
  for (const [k, v] of Object.entries(units || {})) {
    if (!k.startsWith('code:') || v == null) continue;
    for (const th of JSON.parse(v)) if (Array.isArray(th) && th[0] && th[0].id != null) {
      const id = String(th[0].id);
      if (!m.has(id)) m.set(id, []);
      m.get(id).push({ obj: k.slice(5), th });
    }
  }
  return m;
}
function blockIds(units) {
  const count = new Map();
  const walk = x => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    if (typeof x.type === 'string' && x.id != null) count.set(String(x.id), (count.get(String(x.id)) || 0) + 1);
    for (const v of Object.values(x)) if (v && typeof v === 'object') walk(v);
  };
  for (const [k, v] of Object.entries(units || {})) if (k.startsWith('code:') && v != null) walk(JSON.parse(v));
  return count;
}
const headOff = th => [{ ...th[0], x: 0, y: 0 }, ...th.slice(1)];

(async () => {
  const findings = [];
  const opsLog = [];
  let A, B, C, failed = false;
  const fail = (what, detail) => { failed = true; findings.push({ kind: 'FAIL', what, detail }); console.log(`FAIL  ${what}  — ${J(detail).slice(0, 600)}`); };
  const warn = (what, detail) => { findings.push({ kind: 'WARN', what, detail }); console.log(`WARN  ${what}  — ${J(detail).slice(0, 400)}`); };
  console.log(`seed ${SEED} · ${ROUNDS}차례 · 확장 ${ext}`);
  try {
    [A, B, C] = await Promise.all([launch({ ext, name: 'A(방장)' }), launch({ ext, name: 'B(참가자)' }), JOIN_MID ? launch({ ext, name: 'C(나중 참가자)' }) : null]);
    await Promise.all([A, B, C].filter(Boolean).map(c => openEntry(c)));
    const code = await openRoom(A, B);
    await Promise.all([A, B, C].filter(Boolean).map(c => c.evalJs(HELPER)));
    const P = { A: { c: A, name: 'A' }, B: { c: B, name: 'B' }, C: C ? { c: C, name: 'C' } : null };
    const peers = [P.A, P.B];
    for (const p of peers) { p.view = await p.c.evalJs('__fz.view()'); p.sel = p.view.sel; p.loads0 = p.view.loads; p.excAt = p.c.exceptions.length; p.expectLoads = 0; }
    // 처음 화면에도 묶음 아닌 그림 자리(엔트리 것)가 있다 — 그 모양이 아닌 것만 남은 그림으로 본다
    const orphanOk = new Set([...P.A.view.orphans, ...P.B.view.orphans]);
    console.log('처음 블록 화면의 묶음 아닌 그림:', [...orphanOk].join(', ') || '없음');

    // 기대하는 결과: 묶음은 만든 사람만 고친다(같은 묶음 동시 편집은 "먼저 온 쪽"이라 결과를 미리 알 수 없음)
    const threads = new Map(); // tid → { owner, obj, content(좌표 뺀 엔트리 원본) | null, canon(방 조각) | null }
    const ownVars = new Map(), ownMsgs = new Map(); // id → { owner, unit | null }
    let fieldsSet = new Map(); // 'obj|필드' → Map(사람 → 값)  (지난 확인 뒤 바꾼 것)
    const fieldHistory = new Map(); // 'obj|필드' → 지금까지 방 작품에 있던 값들(되돌리기가 돌려 놓을 수 있는 값)
    const seenConflictLines = new Set();
    function recordFieldHistory(units) {
      for (const [uk, v] of Object.entries(units || {})) {
        if (!uk.startsWith('obj:') || v == null) continue;
        const o = JSON.parse(v);
        for (const [field, val] of [['x', o.entity && o.entity.x], ['name', o.name], ['selectedPictureId', o.selectedPictureId]]) {
          const k = uk.slice(4) + '|' + field;
          if (!fieldHistory.has(k)) fieldHistory.set(k, new Set());
          fieldHistory.get(k).add(String(val));
        }
      }
    }
    // 지난 확인 뒤 "내 변경이 반영되지 않았어요" 알림(남이 먼저 고침·남이 지움)을 받은 사람
    async function conflictNotified() {
      const out = new Set();
      for (const p of peers) {
        const lines = (await p.c.evalJs('__entryHapjak.diagnostics()')).split('\n').filter(l => /반영되지 않았어요/.test(l));
        for (const l of lines) if (!seenConflictLines.has(p.name + l)) { seenConflictLines.add(p.name + l); out.add(p.name); }
      }
      return out;
    }
    const pics = new Map(); // 모양 id → { obj, owner }
    const fuzzObjs = new Set();
    let objIds = JSON.parse((await A.evalJs('__entryHapjak.serverUnits()')).objOrder);
    recordFieldHistory(await A.evalJs('__entryHapjak.serverUnits()'));
    // 지난 확인 뒤 되돌리기를 누른 사람 → 누를 때 되돌리기 기록에 마지막으로 남아 있던 것
    const undoers = new Map();
    async function pressUndo(p, round) {
      const v = await p.c.evalJs('__fz.view()');
      if (v.mode !== 'code') await doOp(p, 'mode', ['code'], round);
      await p.c.evalJs('__fz.focusBody()');
      await p.c.key('z', 'KeyZ', 90, 2);
      // 되돌리기는 그 사람이 보는 오브젝트도 바꿀 수 있다(지운 오브젝트를 되살리면 그걸 고름) — 그 사람이 한 일이라 새 기준으로
      await sleep(300);
      const after = await p.c.evalJs('__fz.view()');
      opsLog.push({ round, peer: p.name, op: 'undo(Ctrl+Z)', args: [], r: { undoBefore: v.undo, undoAfter: after.undo, sel: after.sel } });
      p.sel = after.sel;
      if (!undoers.has(p)) undoers.set(p, new Set());
      undoers.get(p).add(p.lastItem || null);
      p.lastItem = null;
    }
    let n = 0;

    async function readUnits(c, server = false) {
      for (let i = 0; i < 40; i++) {
        const u = await c.evalJs(`${STRIP}(__entryHapjak.${server ? 'serverUnits' : 'exportUnits'}())`);
        if (u && Object.keys(u).length) return u;
        await sleep(100);
      }
      return null;
    }
    // 고친 사람의 엔트리 원본과 확장 조각에서 그 묶음의 지금 모양을 기록한다
    async function recordThread(p, tid) {
      const [raw, units] = [await p.c.evalJs('__fz.rawUnits()'), await readUnits(p.c)];
      const r = threadsOf(raw).get(tid), u = threadsOf(units).get(tid);
      threads.set(tid, { owner: p.name, obj: r ? r[0].obj : null, content: r ? J(headOff(r[0].th)) : null, canon: u ? J(u[0].th) : null, rawCount: r ? r.length : 0, unitCount: u ? u.length : 0 });
    }
    async function recordGlobal(p, map, key, id) {
      const raw = await p.c.evalJs('__fz.rawUnits()');
      map.set(id, { owner: p.name, unit: raw[key + id] == null ? null : raw[key + id] });
    }
    const noteField = (p, obj, field, value) => {
      const k = obj + '|' + field;
      if (!fieldsSet.has(k)) fieldsSet.set(k, new Map());
      fieldsSet.get(k).set(p.name, value);
    };

    async function doOp(p, name, args, round) {
      const r = await p.c.evalJs(`__fz.do(${J(name)}, ${J(args)})`);
      opsLog.push({ round, peer: p.name, op: name, args, r });
      // 불러오는 중 표시처럼 곧 사라지는 창은 빼고, 2초 뒤에도 남은 창만 센다(사람이 닫아야 하는 창)
      if (r.dialog && !p.dialog) {
        await sleep(2000);
        const still = await p.c.evalJs('__fz.dialogText()');
        if (still) fail(`[차례 ${round}] ${p.name}: ${name} 직후 엔트리 창이 떠서 남아 있음`, { args, dialog: still, recent: opsLog.slice(-6).map(o => `${o.round} ${o.peer} ${o.op}`) });
        r.dialog = still;
      }
      p.dialog = r.dialog || null;
      if (r.mode) p.mode = r.mode;
      if (r.error) { warn(`[${p.name}] 엔트리 명령 실패: ${name}`, { args, error: r.error }); return r; }
      if (r.skip) return r;
      p.sel = r.sel;
      // 되돌리기가 바꿔도 되는 것은 되돌리기 기록에 마지막으로 남은 편집 하나뿐이다(엔트리는 변수 더하기 등을 기록에 안 남긴다)
      if (r.undoGrew) {
        if (['add', 'move', 'setNum', 'append', 'del'].includes(name)) p.lastItem = 'thread:' + args[0];
        else if (['addVar', 'renameVar', 'delVar'].includes(name)) p.lastItem = 'var:' + args[0];
        else if (name === 'addMsg') p.lastItem = 'msg:' + args[0];
        else if (name === 'addPic') p.lastItem = 'pic:' + args[0];
        else p.lastItem = null;
      }
      if (['add', 'move', 'setNum', 'append', 'del'].includes(name)) await recordThread(p, args[0]);
      else if (name === 'objX') { noteField(p, args[0], 'x', args[1]); }
      else if (name === 'objName') noteField(p, args[0], 'name', args[1]);
      else if (name === 'addPic') { pics.set(args[0], { obj: r.obj, owner: p.name }); noteField(p, r.obj, 'selectedPictureId', args[0]); }
      else if (name === 'selPic') noteField(p, r.obj, 'selectedPictureId', args[0]);
      else if (name === 'addVar' || name === 'renameVar' || name === 'delVar') await recordGlobal(p, ownVars, 'var:', args[0]);
      else if (name === 'addMsg') await recordGlobal(p, ownMsgs, 'msg:', args[0]);
      return r;
    }

    function chooseOp(p, round) {
      if (p.running) return ['stop', []];
      const mine = [...threads].filter(([, t]) => t.owner === p.name && t.content && t.obj === p.sel).map(([id]) => id);
      const myVars = [...ownVars].filter(([, v]) => v.owner === p.name && v.unit).map(([id]) => id);
      const curPics = [...pics].filter(([, x]) => x.obj === p.sel).map(([id]) => id);
      // 블록은 블록 탭에서만 고칠 수 있다(사람도 모양·소리 탭에서는 못 고침)
      const coding = (p.mode || 'code') === 'code';
      if (!coding) mine.length = 0;
      const kind = weighted([
        ['add', coding ? 3 : 0], ['move', mine.length ? 2 : 0], ['setNum', mine.length ? 2 : 0], ['append', mine.length ? 1 : 0], ['del', mine.length ? 1 : 0],
        ['select', 2], ['scroll', 1], ['scrollSwitch', coding && objIds.length > 1 ? 0.4 : 0], ['undo', coding ? 0.5 : 0], ['objX', 1], ['objName', 0.5], ['addVar', 0.7], ['renameVar', myVars.length ? 0.4 : 0], ['delVar', myVars.length ? 0.3 : 0],
        // 모양 더하기·고르기는 모양 탭에서만 할 수 있다(블록 탭에서 명령으로 더하면 엔트리 그림판이 혼자 "고쳐짐"이 된다 — 사람은 못 하는 순서)
        ['addMsg', 0.4], ['addPic', p.mode === 'picture' ? 1 : 0], ['selPic', p.mode === 'picture' && curPics.length ? 0.8 : 0], ['mode', 0.5], ['run', coding ? 0.2 : 0],
      ]);
      const id = `f${p.name}${round}_${++n}`;
      switch (kind) {
        case 'add': return ['add', [id, int(0, 900), int(0, 600), int(1, 99)]];
        case 'move': return ['move', [pick(mine), int(0, 900), int(0, 600)]];
        case 'setNum': return ['setNum', [pick(mine), int(1, 99)]];
        case 'append': return ['append', [pick(mine), n]];
        case 'del': return ['del', [pick(mine)]];
        case 'select': return ['select', [pick(objIds)]];
        case 'scroll': return ['scroll', [int(-200, 200), int(-150, 150)]];
        case 'scrollSwitch': return ['scrollSwitch', [int(-200, 200), int(-150, 150), pick(objIds.filter(x => x !== p.sel))]];
        case 'undo': return ['undo(Ctrl+Z)', []];
        case 'objX': return ['objX', [pick(objIds), int(-200, 200)]];
        case 'objName': return ['objName', [pick(objIds), '이름' + id]];
        case 'addVar': return ['addVar', [id + 'v', '변수' + id]];
        case 'renameVar': return ['renameVar', [pick(myVars), '새이름' + id]];
        case 'delVar': return ['delVar', [pick(myVars)]];
        case 'addMsg': return ['addMsg', [id + 'm', '신호' + id]];
        case 'addPic': return ['addPic', [id + 'p']];
        case 'selPic': return ['selPic', [pick(curPics)]];
        case 'mode': return ['mode', [pick(['picture', 'sound', 'code'])]];
        case 'run': return ['run', []];
      }
      return ['scroll', [0, 0]];
    }

    // 모두 멈춘 뒤 확인한다
    async function settleAndCheck(label) {
      for (const p of peers) {
        if (p.running) { await doOp(p, 'stop', [], label); p.running = false; }
        const v = await p.c.evalJs('__fz.view()');
        if (v.mode !== 'code') await doOp(p, 'mode', ['code'], label);
      }
      await sleep(600);
      // 1) 모두의 확장 조각과 방 조각이 같아질 때까지
      const t0 = Date.now();
      let mine = [], us, diff = [];
      while (Date.now() - t0 < 25000) {
        [us, ...mine] = await Promise.all([readUnits(A, true), ...peers.map(p => readUnits(p.c))]);
        const st = await Promise.all(peers.map(p => p.c.evalJs('__entryHapjak.status().client')));
        diff = [];
        const ok = us && mine.every(Boolean);
        if (ok) for (const k of new Set([us, ...mine].flatMap(Object.keys))) if (mine.some(u => u[k] !== us[k])) diff.push(k);
        if (ok && !diff.length && st.every(s => s && !s.sending && !s.waiting)) break;
        await sleep(300);
      }
      if (!us || !mine.every(Boolean) || diff.length) { fail(`[${label}] 두 사람 작품이 방 작품과 같아지지 않음`, { diff: diff.slice(0, 10), status: await Promise.all(peers.map(p => p.c.evalJs('__entryHapjak.status().client'))) }); return; }
      await sleep(400);
      // 2) 각자 엔트리 원본(확장 캐시를 거치지 않음)도 방 작품과 같은지
      for (const p of peers) {
        const raw = await p.c.evalJs('__fz.rawUnits()');
        const bad = [];
        for (const k of new Set([...Object.keys(raw), ...Object.keys(us)])) {
          if (!COMPARE.test(k)) continue;
          if (headless(k, raw[k] == null ? null : raw[k]) !== headless(k, us[k] == null ? null : us[k])) bad.push(k);
        }
        if (bad.length) fail(`[${label}] ${p.name}의 실제 엔트리 작품이 방 작품과 다름(확장은 같다고 봄)`, { keys: bad.slice(0, 10), sample: bad[0] ? { raw: String(raw[bad[0]]).slice(0, 300), room: String(us[bad[0]]).slice(0, 300) } : null });
      }
      // 3) 고친 사람이 남긴 대로 방 작품에 있는지. 방금 되돌리기를 누른 사람 것은 되돌린 결과가 맞으므로 아래에서 새 기준으로 삼고,
      //    남의 것이 그대로인지만 본다(되돌리기가 남의 블록을 지우면 여기서 걸린다)
      const undoerNames = new Set([...undoers.keys()].map(q => q.name));
      const room = threadsOf(us);
      for (const [tid, t] of threads) {
        if (undoerNames.has(t.owner)) continue;
        const got = room.get(tid) || [];
        if (!t.content) {
          if (!got.length) continue;
          // 지운 오브젝트를 누가 되돌리기로 살리면 그 안의 묶음도 같이 돌아온다
          if (t.objDeleted && undoers.size && got.length === 1 && got[0].obj === t.objDeleted) {
            warn(`[${label}] 되돌리기로 오브젝트 ${t.objDeleted}가 돌아와 ${t.owner}의 묶음 ${tid}도 돌아옴`, {});
            threads.set(tid, { ...t, obj: got[0].obj, content: J(headOff(got[0].th)), canon: J(got[0].th), objDeleted: null });
          } else fail(`[${label}] ${t.owner}가 지운 묶음 ${tid}가 남아 있음`, { at: got.map(g => g.obj) });
          continue;
        }
        if (got.length !== 1) { fail(`[${label}] ${t.owner}의 묶음 ${tid}가 ${got.length}군데 있음`, { expect: t.obj, at: got.map(g => g.obj) }); continue; }
        if (got[0].obj !== t.obj) fail(`[${label}] ${t.owner}의 묶음 ${tid}가 다른 오브젝트에 들어감`, { expect: t.obj, got: got[0].obj });
        else if (J(headOff(got[0].th)) !== t.content) fail(`[${label}] ${t.owner}의 묶음 ${tid} 내용이 고친 사람 화면과 다름`, { expect: t.content.slice(0, 300), got: J(headOff(got[0].th)).slice(0, 300) });
        else if (t.canon && J(got[0].th) !== t.canon) fail(`[${label}] ${t.owner}의 묶음 ${tid} 자리가 고친 사람 화면과 다름`, { expect: t.canon.slice(0, 200), got: J(got[0].th).slice(0, 200) });
      }
      const dup = [...blockIds(us)].filter(([, c]) => c > 1).map(([id]) => id);
      if (dup.length) fail(`[${label}] 같은 블록이 두 군데 있음`, dup.slice(0, 10));
      for (const [map, key, what] of [[ownVars, 'var:', '변수'], [ownMsgs, 'msg:', '신호']]) {
        for (const [id, v] of map) {
          if (undoerNames.has(v.owner)) continue;
          const got = us[key + id] == null ? null : us[key + id];
          if (got !== v.unit) fail(`[${label}] ${v.owner}의 ${what} ${id}가 고친 사람 화면과 다름`, { expect: v.unit, got });
        }
      }
      // 같은 칸을 동시에 고치면 먼저 온 쪽이 남고 늦은 사람에게 알린다(설계). 알림 없이 사라진 편집만 결함으로 센다
      const notified = await conflictNotified();
      const fieldOf = (obj, field) => { if (us['obj:' + obj] == null) return undefined; const o = JSON.parse(us['obj:' + obj]); return field === 'x' ? o.entity && o.entity.x : o[field]; };
      for (const [k, setters] of fieldsSet) {
        const [obj, field] = k.split('|');
        const got = fieldOf(obj, field);
        if (got === undefined) continue;
        const ok = [...setters.values()].some(v => String(v) === String(got));
        const lost = [...setters.keys()].filter(n => String(setters.get(n)) !== String(got));
        const byUndo = undoers.size && fieldHistory.has(k) && fieldHistory.get(k).has(String(got));
        if (ok && !lost.length) continue;
        if (lost.every(n => notified.has(n))) warn(`[${label}] 오브젝트 ${obj}의 ${field}: 동시에 고쳐 먼저 온 쪽이 남고 ${lost.join(',')}에게 알림`, { set: Object.fromEntries(setters), got });
        else if (!ok && byUndo) warn(`[${label}] 오브젝트 ${obj}의 ${field}: 되돌리기가 예전 값으로 돌림`, { set: Object.fromEntries(setters), got, undoers: [...undoers.keys()].map(q => q.name) });
        else if (!ok) fail(`[${label}] 오브젝트 ${obj}의 ${field} 편집이 알림 없이 사라짐`, { set: Object.fromEntries(setters), got, notified: [...notified] });
      }
      recordFieldHistory(us);
      for (const [pid, { obj, owner }] of pics) {
        if (undoerNames.has(owner) || us['obj:' + obj] == null) continue;
        const o = JSON.parse(us['obj:' + obj]);
        if (!((o.sprite && o.sprite.pictures) || []).some(x => String(x.id) === pid)) fail(`[${label}] 모양 ${pid}가 오브젝트 ${obj}에서 사라짐`, {});
      }
      fieldsSet = new Map();
      objIds = JSON.parse(us.objOrder);
      // 4) 화면: 보던 오브젝트 그대로, 열린 블록 화면에 그 오브젝트 블록만 다 그려짐, 멈춤 없음
      for (const p of peers) {
        const v = await p.c.evalJs('__fz.view()');
        if (p.sel && objIds.includes(p.sel) && v.sel !== p.sel) fail(`[${label}] ${p.name}가 보던 오브젝트가 바뀜`, { was: p.sel, now: v.sel });
        p.sel = v.sel;
        const probs = {};
        if (!v.boardIsCur) probs.board = '블록 화면이 고른 오브젝트 코드가 아님';
        if (v.missing.length) probs.missing = v.missing;
        if (v.strays) probs.strays = v.strays;
        const orphans = v.orphans.filter(d => !orphanOk.has(d));
        if (orphans.length) probs.orphans = orphans.slice(0, 5);
        if (v.posBad.length) probs.posBad = v.posBad.slice(0, 5);
        if (!v.client || v.client.paused) probs.paused = v.client;
        if (v.link !== 'up' || v.room !== 'room') probs.link = [v.link, v.room];
        if (Object.keys(probs).length) fail(`[${label}] ${p.name} 화면 이상`, probs);
        const reloads = v.loads - p.loads0;
        // 되돌리기는 오브젝트 지우기·더하기도 되돌릴 수 있다(그러면 받는 쪽은 통째로 다시 불러온다)
        if (reloads > p.expectLoads && undoers.size) warn(`[${label}] ${p.name}가 작품을 통째로 다시 불러옴 — 그사이 되돌리기가 있었음(${[...undoers.keys()].map(q => q.name).join(',')})`, { reloads, expected: p.expectLoads });
        else if (reloads > p.expectLoads) {
          const diag = await p.c.evalJs('__entryHapjak.diagnostics()');
          // 큰 작품에서는 받는 쪽이 십수 초 멈추는 일이라 결함으로 센다
          fail(`[${label}] ${p.name}가 작품을 통째로 다시 불러옴(예상 ${p.expectLoads}번, 실제 ${reloads}번)`, { why: diag.split('\n').filter(l => /다시 불러오기|실패/.test(l)).slice(-5) });
        }
        p.loads0 = v.loads; p.expectLoads = 0;
        const exc = p.c.exceptions.slice(p.excAt);
        p.excAt = p.c.exceptions.length;
        const ours = exc.filter(e => /chrome-extension:|entry-adapter|sync\.js|main\.js|merge\.js/.test(J(e)));
        if (ours.length) fail(`[${label}] ${p.name} 확장에서 예외`, ours.slice(0, 3));
        else if (exc.length) warn(`[${label}] ${p.name} 페이지 예외(엔트리 쪽)`, exc.slice(0, 3).map(e => e.text));
      }
      for (const [undoBy, allowed] of undoers) {
        // 되돌린 사람 것은 되돌린 결과를 새 기준으로 삼는다(남의 것은 위 3)에서 그대로인지 이미 봤다)
        const changed = [];
        for (const [tid, t] of threads) if (t.owner === undoBy.name) {
          const g = room.get(tid);
          const nt = { ...t, obj: g ? g[0].obj : null, content: g ? J(headOff(g[0].th)) : null, canon: g ? J(g[0].th) : null };
          if (nt.content !== t.content || nt.obj !== t.obj) changed.push('thread:' + tid);
          threads.set(tid, nt);
        }
        for (const [map, key] of [[ownVars, 'var:'], [ownMsgs, 'msg:']]) for (const [id, v] of map) if (v.owner === undoBy.name) {
          const unit = us[key + id] == null ? null : us[key + id];
          if (unit !== v.unit) changed.push(key + id);
          map.set(id, { ...v, unit });
        }
        // 되돌린 뒤 같은 사람이 또 고쳤으면 그건 기록과 맞으므로 여기 안 잡힌다
        const odd = changed.filter(k => !allowed.has(k));
        if (odd.length) warn(`[${label}] ${undoBy.name}의 되돌리기가 마지막으로 손댄 것(${[...allowed].join(', ')}) 말고 다른 것도 바꿈`, { changed });
        for (const [pid, x] of pics) if (x.owner === undoBy.name) {
          const o = us['obj:' + x.obj] == null ? null : JSON.parse(us['obj:' + x.obj]);
          if (!o || !((o.sprite && o.sprite.pictures) || []).some(q => String(q.id) === pid)) pics.delete(pid);
        }
      }
      undoers.clear();
    }

    let joining = null, joinedC = false;
    async function addLatecomer() {
      const p = P.C;
      p.view = await p.c.evalJs('__fz.view()'); p.sel = p.view.sel; p.loads0 = p.view.loads; p.excAt = p.c.exceptions.length; p.expectLoads = 0;
      p.view.orphans.forEach(d => orphanOk.add(d));
      peers.push(p);
      opsLog.push({ round: 'join', peer: 'C', op: 'joined', args: [], r: {} });
    }
    for (let round = 1; round <= ROUNDS && (!failed || keepGoing); round++) {
      if (JOIN_MID && round === JOIN_AT) {
        opsLog.push({ round, peer: 'C', op: 'join-start', args: [], r: {} });
        joining = joinRoom(C, code, '나중').then(() => { joinedC = true; }, e => fail(`[차례 ${round}] 세 번째 사람이 편집 중에 들어오지 못함`, String(e.message || e).slice(0, 300)));
      }
      if (joinedC && !peers.includes(P.C)) await addLatecomer();
      if (round % 10 === 0) {
        // 작품 구조를 바꾸는 일은 한 사람만(동시에 하면 결과가 정해지지 않음): 오브젝트 더하기·지우기, 되돌리기
        const rec = replayOps && replayOps.find(o => o.round === round && ['addObj', 'delObj', 'undo(Ctrl+Z)'].includes(o.op));
        if (replayOps && !rec) continue;
        const p = rec ? P[rec.peer] : pick(peers);
        const others = peers.filter(q => q !== p);
        const kind = rec ? (rec.op === 'undo(Ctrl+Z)' ? 'undo' : rec.op) : weighted([['addObj', objIds.length < 5 ? 2 : 0], ['delObj', [...fuzzObjs].some(id => objIds.includes(id)) && objIds.length > 2 ? 1 : 0], ['undo', 2]]);
        if (kind === 'addObj') {
          const id = rec ? rec.args[0] : `fzo${round}`;
          const r = await doOp(p, 'addObj', [id, '오브젝트' + round], round);
          if (!r.skip && !r.error) { fuzzObjs.add(id); others.forEach(q => q.expectLoads++); }
        } else if (kind === 'delObj') {
          const id = rec ? rec.args[0] : pick([...fuzzObjs].filter(x => objIds.includes(x)));
          const r = await doOp(p, 'delObj', [id], round);
          if (!r.skip && !r.error) {
            others.forEach(q => q.expectLoads++);
            for (const [tid, t] of threads) if (t.obj === id) threads.set(tid, { ...t, content: null, canon: null, objDeleted: id });
            for (const [pid, x] of pics) if (x.obj === id) pics.delete(pid);
          }
        } else {
          await pressUndo(p, round);
          await sleep(800);
        }
        await settleAndCheck(`차례 ${round} ${p.name} ${kind}`);
        continue;
      }
      await Promise.all(peers.map(async p => {
        const recs = replayOps && replayOps.filter(o => o.round === round && o.peer === p.name);
        const times = recs ? recs.length : rnd() < 0.3 ? 2 : 1;
        for (let i = 0; i < times; i++) {
          await sleep(int(0, 400));
          const [name, args] = recs ? [recs[i].op, recs[i].args] : chooseOp(p, round);
          if (name === 'undo(Ctrl+Z)') { await pressUndo(p, round); continue; }
          const r = await doOp(p, name, args, round);
          if (name === 'run' && !r.skip && !r.error) p.running = true;
          if (name === 'stop') p.running = false;
        }
      }));
      await sleep(int(0, 700));
      if (round % 3 === 0) await settleAndCheck(`차례 ${round}`);
    }
    if (joining) { await joining; if (joinedC && !peers.includes(P.C)) await addLatecomer(); }
    if (!failed || keepGoing) await settleAndCheck('끝');
  } catch (err) {
    fail('시험 진행', String((err && err.stack) || err).slice(0, 800));
  } finally {
    if (failed) {
      for (const c of [A, B, C]) if (c) {
        try { await c.screenshot(path.join(out, `fail-${c.name.slice(0, 1)}.png`)); } catch { /* 못 찍음 */ }
        try { fs.writeFileSync(path.join(out, `diag-${c.name.slice(0, 1)}.txt`), await c.evalJs('__entryHapjak.diagnostics()')); } catch { /* 못 읽음 */ }
      }
    }
    await Promise.all([A, B, C].filter(Boolean).map(c => c.close()));
    fs.writeFileSync(path.join(out, 'result.json'), J({ seed: SEED, rounds: ROUNDS, joinMid: JOIN_MID, ext, findings, ops: opsLog }, null, 1));
    const fails = findings.filter(f => f.kind === 'FAIL').length, warns = findings.filter(f => f.kind === 'WARN').length;
    console.log(`\n${fails ? 'FAIL' : 'PASS'} · seed ${SEED} · 실패 ${fails} · 경고 ${warns} · 편집 ${opsLog.length}번 · 결과: ${out}`);
    if (fails) console.log(`다시 돌리기: node tests/e2e/fuzz.js --seed ${SEED} --rounds ${ROUNDS}${JOIN_MID ? ' --join-mid' : ''}  또는  --replay ${path.join(out, 'result.json')}`);
    process.exit(fails ? 1 : 0);
  }
})();

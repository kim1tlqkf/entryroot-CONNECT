// 엔트리 편집기와 붙는 부분: 작품을 조각으로 읽고, 방에서 온 조각을 편집기에 넣는다.
// 블록 코드·오브젝트 위치처럼 자주 바뀌는 것은 그 부분만 바꾸고, 나머지는 작품을 다시 불러오되 보던 화면을 되살린다.
(function (root) {
  'use strict';
  const M = root.ErcMerge;
  const E = () => root.Entry;

  function create({ onLocalChange, onExternalLoad, isOwnUi, log = () => {} }) {
    const offsets = new Map();
    // 스크롤한(moveBy) 코드 — 블록 화면에서 내려간 뒤에도 좌표 맞추기(_updatePos)가 남아 있을 수 있다
    const lazyCodes = new Set();
    // 사람이 옮긴 메모(엔트리 메모 명령) — 'code:<id>|블록 id'. 이 메모는 x·y만 달라도 내 편집으로 보낸다
    const movedComments = new Set();
    let pointerDown = false;
    let applying = false;
    let hookedSm = null, hookedCce = null, hookedCmd = null, protoHooked = false, loadHooked = false;

    // 큰 작품에서 매번 전체를 읽으면 화면이 멈춘다. 바뀐 오브젝트·함수만 다시 읽고 나머지는 지난 결과를 쓴다.
    const objCache = new Map();
    const funcCache = new Map();
    // 큰 오브젝트에서 한 묶음만 바뀌어도 전체를 다시 정리하지 않도록 묶음별 정리 결과를 둔다
    const threadCache = new Map();
    const threadCacheFor = () => { if (threadCache.size > 50000) threadCache.clear(); return threadCache; };
    let globalsCache = null;
    const dirtyObjs = new Set(), dirtyFuncs = new Set();
    // 함수는 큰 작품에서 수 MB라, 함수 쪽 신호가 있을 때만(또는 처음 한 번) 전부 읽는다
    let allDirty = true, globalsDirty = true, funcsAllDirty = true;
    const watchedCodes = new WeakSet();
    const markAll = () => { allDirty = true; globalsDirty = true; };
    // 명령을 거치지 않은 변경을 놓치지 않게 조금씩 돌아가며 다시 본다
    let scanAt = 0, funcScanAt = 0, lastInputAt = 0;
    function scanSome(count) {
      // 편집하는 동안 멈춤에 보태지 않도록, 3초 넘게 아무 조작이 없을 때만 돈다
      if (Date.now() - lastInputAt < 3000) return;
      try {
        const objs = E().container.getAllObjects();
        if (objs.length) {
          for (let i = 0; i < Math.min(count, objs.length); i++) dirtyObjs.add(String(objs[(scanAt + i) % objs.length].id));
          scanAt = (scanAt + count) % objs.length;
          if (scanAt < count) globalsDirty = true;
        }
        const fids = Object.keys(E().variableContainer.functions_ || {});
        if (fids.length) { dirtyFuncs.add(fids[funcScanAt % fids.length]); funcScanAt = (funcScanAt + 1) % fids.length; }
      } catch (err) { log('scan', err); }
    }

    // 블록 화면 안에서만 바뀌는 명령 — 지금 블록 화면에 열린 코드만 다시 읽으면 된다
    const BLOCK_CMDS = new Set(['addThread', 'destroyThread', 'destroyBlock', 'recoverBlock', 'insertBlock', 'separateBlock', 'moveBlock',
      'cloneBlock', 'uncloneBlock', 'scrollBoard', 'setFieldValue', 'destroyBlockBelow', 'destroyThreads', 'addThreads', 'recoverBlockBelow',
      'addThreadFromBlockMenu', 'insertBlockFromBlockMenu', 'moveBlockFromBlockMenu', 'separateBlockForDestroy', 'moveBlockForDestroy',
      'insertBlockFromBlockMenuFollowSeparate', 'insertBlockFollowSeparate', 'separateBlockByCommand', 'createComment', 'removeComment',
      'moveComment', 'toggleComment', 'cloneComment', 'uncloneComment', 'separateComment', 'connectComment', 'writeComment',
      'showAllComment', 'hideAllComment']);
    // 화면만 바꾸는 명령(작품 내용은 그대로)
    const VIEW_ONLY_CMD = /^(selectBlockMenu|selectObject|containerSelectObject|sceneSelect|playgroundChangeViewMode|toggleRun|toggleStop|dismissModal|variableContainerSelectFilter|objectEditButtonClick|addObjectButtonClick)$|Click|Cancel$/;
    const FUNC_CMD = /^func|Func|LocalVariable/;
    const GLOBAL_CMD = /^(variable|list|message|scene|dataTable|objectReorder|addObject|removeObject|objectAdd(Expansion|AIUtilize|HardwareLite)|objectRemove(Expansion|AIUtilize|HardwareLite))/;
    let cmdNames = null;
    function cmdName(type) {
      if (typeof type === 'string') return type;
      if (!cmdNames) {
        cmdNames = new Map();
        const CT = (E().STATIC && E().STATIC.COMMAND_TYPES) || {};
        for (const k of Object.keys(CT)) if (typeof CT[k] === 'number') cmdNames.set(CT[k], k);
      }
      return cmdNames.get(type) || null;
    }
    function markTargetFunc() {
      try { const f = E().Func && E().Func.targetFunc; if (f && f.id != null) dirtyFuncs.add(String(f.id)); } catch { /* 편집 중인 함수 없음 */ }
    }
    function markBoard() {
      const k = boardKey();
      if (k && k.startsWith('obj:')) dirtyObjs.add(k.slice(4));
      else if (k && k.startsWith('func:')) dirtyFuncs.add(k.slice(5));
      else { markTargetFunc(); globalsDirty = true; }
    }
    function onCommand(type, args) {
      const name = cmdName(type);
      if (!name) { markAll(); return; }
      if (/Comment/.test(name) && Array.isArray(args)) {
        for (const a of args) {
          if (!(E().Comment && a instanceof E().Comment) || !a._block) continue;
          const ck = codeKey(a.code);
          if (ck) movedComments.add((ck.startsWith('obj:') ? 'code:' + ck.slice(4) : ck) + '|' + a._block.id);
        }
      }
      if (BLOCK_CMDS.has(name)) { markBoard(); return; }
      if (VIEW_ONLY_CMD.test(name)) return;
      const list = Array.isArray(args) ? args : [];
      if (FUNC_CMD.test(name)) {
        markTargetFunc();
        const fns = E().variableContainer.functions_ || {};
        for (const a of list) if ((typeof a === 'string' || typeof a === 'number') && fns[a]) dirtyFuncs.add(String(a));
        globalsDirty = true;
        return;
      }
      const a0 = list[0];
      if ((typeof a0 === 'string' || typeof a0 === 'number') && getObj(a0)) { dirtyObjs.add(String(a0)); globalsDirty = true; return; }
      if (GLOBAL_CMD.test(name)) { globalsDirty = true; return; }
      // 모양·소리·글상자 편집처럼 대상 id가 없는 명령은 지금 고른 오브젝트
      if (/Picture|Sound|Text/.test(name)) {
        const o = E().playground && E().playground.object;
        if (o) dirtyObjs.add(String(o.id));
        globalsDirty = true;
        return;
      }
      markAll();
    }
    function watchCode(code, onChange) {
      if (!code || !code.changeEvent || typeof code.changeEvent.attach !== 'function' || watchedCodes.has(code)) return;
      watchedCodes.add(code);
      code.changeEvent.attach(null, onChange);
    }

    function ready() {
      try {
        const e = E();
        return !!(e && e.playground && e.container && e.engine && e.stateManager && e.scene && e.Code &&
          typeof e.exportProject === 'function' && typeof e.loadProject === 'function' && e.getMainWS && e.getMainWS());
      } catch { return false; }
    }

    function codeKey(code) {
      if (!code) return null;
      if (code.object && code.object.id != null) return 'obj:' + code.object.id;
      const fns = E().variableContainer && E().variableContainer.functions_;
      if (fns) for (const id of Object.keys(fns)) if (fns[id] && fns[id].content === code) return 'func:' + id;
      return null;
    }
    function boardKey() {
      const ws = E().getMainWS();
      return ws && ws.board ? codeKey(ws.board.code) : null;
    }

    // 엔트리 쪽 객체가 다시 만들어질 수 있어(작품 다시 열기 등) 주기적으로 다시 건다
    function ensureHooks() {
      if (!ready()) return false;
      const e = E();
      if (!protoHooked) {
        const P = e.Code.prototype;
        const orig = P.moveBy;
        P.moveBy = function (dx, dy) {
          try {
            const k = codeKey(this);
            if (k && isFinite(dx) && isFinite(dy) && (dx || dy)) {
              const o = offsets.get(k) || [0, 0];
              offsets.set(k, [o[0] + (+dx || 0), o[1] + (+dy || 0)]);
              lazyCodes.add(this);
            }
          } catch (err) { log('moveBy', err); }
          return orig.apply(this, arguments);
        };
        protoHooked = true;
      }
      if (!loadHooked) {
        const origLoad = e.loadProject;
        e.loadProject = function () {
          const r = origLoad.apply(this, arguments);
          if (!applying) { try { onExternalLoad(); } catch (err) { log('externalLoad', err); } }
          return r;
        };
        // 비우기만 먼저 오고 불러오기가 늦게 오는 경우, 그 사이의 빈 작품을 보내지 않도록 비우는 순간 멈춘다
        const origClear = e.clearProject;
        e.clearProject = function () {
          if (!applying) { try { onExternalLoad(); } catch (err) { log('externalClear', err); } }
          return origClear.apply(this, arguments);
        };
        loadHooked = true;
      }
      if (hookedSm !== e.stateManager) {
        const sm = e.stateManager;
        const origAdd = sm.addCommand;
        sm.addCommand = function () {
          const st = origAdd.apply(this, arguments);
          try { if (st && typeof st === 'object') st.__ercKey = boardKey(); } catch { /* 표시만 못 함 */ }
          return st;
        };
        hookedSm = sm;
      }
      if (hookedCce !== e.creationChangedEvent && e.creationChangedEvent) {
        e.creationChangedEvent.attach(null, () => { if (!applying) { markBoard(); onLocalChange(); } });
        hookedCce = e.creationChangedEvent;
      }
      // 명령(되돌리기 포함)마다 무엇이 바뀌었는지 기록한다
      if (hookedCmd !== e.commander && e.commander && e.commander.doEvent && typeof e.commander.doEvent.attach === 'function') {
        e.commander.doEvent.attach(null, (type, args) => { try { onCommand(type, args); } catch (err) { markAll(); log('command', err); } });
        hookedCmd = e.commander;
        markAll();
      }
      return true;
    }

    const down = ev => { lastInputAt = Date.now(); if (ev.button === 0 && !isOwnUi(ev.target)) pointerDown = true; };
    window.addEventListener('keydown', () => { lastInputAt = Date.now(); }, true);
    const up = () => { if (pointerDown) { pointerDown = false; onLocalChange(); } };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('mousedown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('mouseup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', up);

    function isRunning() {
      const en = E().engine;
      return !!(en && typeof en.isState === 'function' && !en.isState('stop'));
    }
    function canRead() { return ready() && !applying && !pointerDown && !isRunning(); }

    // 블록 화면은 그림을 먼저 옮기고 작품 데이터 좌표는 200ms 뒤에 맞춘다(BlockView의 debounce된 _updatePos).
    // 스크롤 몫은 바로 더해지므로, 읽기 전에 그 맞추기를 미리 해 두지 않으면 스크롤만 해도 좌표가 바뀐 것으로 보인다.
    // 스크롤하자마자 다른 오브젝트로 옮기면 그 코드는 블록 화면에 없으므로, 스크롤한 코드도 같이 맞춘다.
    function flushLazyPositions() {
      const ws = E().getMainWS();
      const codes = new Set(lazyCodes);
      lazyCodes.clear();
      if (ws && ws.board && ws.board.code) codes.add(ws.board.code);
      for (const code of codes) {
        if (!code || typeof code.getThreads !== 'function') continue;
        for (const th of code.getThreads()) {
          const b = th && typeof th.getFirstBlock === 'function' ? th.getFirstBlock() : null;
          if (b && b.view && typeof b._updatePos === 'function') b._updatePos();
        }
      }
    }

    // 오브젝트를 뺀 나머지(장면·변수·함수·표·설정)는 엔트리의 같은 내보내기로 읽되, 오브젝트 직렬화만 건너뛴다
    // 오브젝트·함수를 뺀 나머지(장면·변수·신호·표·설정)는 엔트리의 같은 내보내기로 읽되, 큰 두 부분의 직렬화만 건너뛴다
    function globalsViaExport() {
      const e = E();
      const stubs = [[e.container, 'toJSON', () => [{}]], [e.variableContainer, 'getFunctionJSON', () => []]];
      const saved = stubs.map(([o, k]) => [Object.prototype.hasOwnProperty.call(o, k), o[k]]);
      for (const [o, k, f] of stubs) o[k] = f;
      try { return e.exportProject(); } finally {
        stubs.forEach(([o, k], i) => { if (saved[i][0]) o[k] = saved[i][1]; else delete o[k]; });
      }
    }
    // 엔트리 getFunctionJSON이 함수 하나에 대해 만드는 것과 같은 모양
    const funcJSON = f => ({ id: f.id, type: f.type === undefined ? 'normal' : f.type, localVariables: f.localVariables, useLocalVariables: f.useLocalVariables, content: f.content.stringify() });
    const offKeyOf = k => { const off = offsets.get(k); return off ? off[0] + ',' + off[1] : '0,0'; };
    // 블록에 붙은 메모의 x·y는 엔트리가 블록의 그려진 폭에 맞춰 명령 없이 바꾼다(Comment.updateParentPos — 글꼴을 언제 다 불러왔는지에 따라 다름).
    // 메모 x·y만 다른 묶음은 방에서 받은 모양 그대로 보낸다. 사람이 옮긴 메모(movedComments)는 그대로 보낸다.
    const commentFree = th => JSON.stringify(th, (key, val) => (key === 'comment' && val && typeof val === 'object' ? { ...val, x: 0, y: 0 } : val));
    function hasMovedComment(k, th) {
      let hit = false;
      const walk = x => {
        if (hit || !x || typeof x !== 'object') return;
        if (Array.isArray(x)) { x.forEach(walk); return; }
        if (x.comment && movedComments.has(k + '|' + x.id)) hit = true;
        if (x.params) walk(x.params);
        if (x.statements) walk(x.statements);
      };
      walk(th);
      return hit;
    }
    function cleanLocal(k, base, mine) {
      const isCode = k.startsWith('code:'), isFunc = k.startsWith('func:');
      if ((!isCode && !isFunc) || mine.indexOf('"comment"') < 0) return mine;
      try {
        const bv = JSON.parse(base), mv = JSON.parse(mine);
        const bt = isFunc ? bv.content : bv, mt = isFunc ? mv.content : mv;
        if (!Array.isArray(bt) || !Array.isArray(mt)) return mine;
        const byKey = new Map(bt.map((th, i) => [M.threadKey(th, i), th]));
        let changed = false;
        const out = mt.map((th, i) => {
          const b = byKey.get(M.threadKey(th, i));
          if (!b || JSON.stringify(b) === JSON.stringify(th) || commentFree(b) !== commentFree(th) || hasMovedComment(k, th)) return th;
          changed = true;
          return b;
        });
        if (!changed) return mine;
        return isFunc ? JSON.stringify({ ...mv, content: out }) : M.stable(out);
      } catch (err) { log('clean', err); return mine; }
      finally { for (const x of [...movedComments]) if (x.startsWith(k + '|')) movedComments.delete(x); }
    }

    function exportUnits() {
      if (!canRead()) return null;
      try { flushLazyPositions(); } catch (err) { log('flush positions', err); }
      const e = E();
      const units = {};
      const ids = [], fids = [];
      const seen = new Set();
      try {
        const objs = e.container.getAllObjects();
        // 엔트리 내보내기도 오브젝트가 하나도 없으면 실패로 돌려준다(비워진 화면을 "모두 지움"으로 보내지 않게)
        if (!objs || !objs.length) return null;
        const full = allDirty;
        for (const o of objs) {
          const id = String(o.id);
          if (seen.has(id)) continue;
          seen.add(id); ids.push(id);
          watchCode(o.script, () => dirtyObjs.add(id));
          const offKey = offKeyOf('obj:' + id);
          let c = objCache.get(id);
          // 다른 확장이 코드를 통째로 바꿔 끼운 경우도 잡는다(scriptRef)
          if (full || !c || dirtyObjs.has(id) || c.offKey !== offKey || c.scriptRef !== o.script) {
            const j = o.toJSON();
            const raw = JSON.stringify(j);
            if (!c || c.raw !== raw || c.offKey !== offKey) {
              const u = M.objectUnits(j, offsets.get('obj:' + id), threadCacheFor());
              c = { raw, offKey, scriptRef: o.script, obj: u.obj, code: u.code };
              objCache.set(id, c);
            } else c.scriptRef = o.script;
          }
          units['obj:' + id] = c.obj;
          units['code:' + id] = c.code;
        }
        for (const id of [...objCache.keys()]) if (!seen.has(id)) objCache.delete(id);

        const fns = e.variableContainer.functions_ || {};
        for (const fid of Object.keys(fns)) {
          const f = fns[fid];
          if (!f || !f.content) continue;
          fids.push(fid);
          watchCode(f.content, () => dirtyFuncs.add(fid));
          const offKey = offKeyOf('func:' + fid);
          let c = funcCache.get(fid);
          if (funcsAllDirty || !c || dirtyFuncs.has(fid) || c.offKey !== offKey || c.contentRef !== f.content) {
            c = { offKey, contentRef: f.content, unit: M.funcUnit(funcJSON(f), offsets.get('func:' + fid)) };
            funcCache.set(fid, c);
          }
          units['func:' + fid] = c.unit;
        }
        const fset = new Set(fids);
        for (const fid of [...funcCache.keys()]) if (!fset.has(fid)) funcCache.delete(fid);

        if (full || globalsDirty || !globalsCache) {
          const g = globalsViaExport();
          if (!g) return null;
          delete g.objects; delete g.interface; delete g.functions;
          const raw = JSON.stringify(g);
          if (!globalsCache || globalsCache.raw !== raw) globalsCache = { raw, units: M.globalUnits(g, k => offsets.get(k)) };
        }
      } catch (err) { log('export', err); return null; }
      Object.assign(units, globalsCache.units);
      units.objOrder = M.stable(ids);
      units.funcOrder = M.stable(fids);
      dirtyObjs.clear(); dirtyFuncs.clear();
      allDirty = false; globalsDirty = false; funcsAllDirty = false;
      return units;
    }

    // 막 불러온 작품은 곧 이 조각들이다 — 큰 작품에서 불러온 직후 수 MB를 다시 읽지 않도록 캐시에 바로 넣는다
    function primeFrom(units) {
      const e = E();
      objCache.clear(); funcCache.clear();
      for (const o of e.container.getAllObjects()) {
        const id = String(o.id);
        if (units['obj:' + id] == null) continue;
        objCache.set(id, { raw: null, offKey: offKeyOf('obj:' + id), scriptRef: o.script, obj: units['obj:' + id], code: units['code:' + id] == null ? '[]' : units['code:' + id] });
      }
      const fns = e.variableContainer.functions_ || {};
      for (const fid of Object.keys(fns)) {
        if (units['func:' + fid] == null || !fns[fid] || !fns[fid].content) continue;
        funcCache.set(fid, { offKey: offKeyOf('func:' + fid), contentRef: fns[fid].content, unit: units['func:' + fid] });
      }
      dirtyObjs.clear(); dirtyFuncs.clear();
      allDirty = false; funcsAllDirty = false; globalsDirty = true;
    }

    const getObj = id => { try { return E().container.getObject(id) || null; } catch { return null; } };
    const viewMode = () => { const pg = E().playground; return pg.getViewMode ? pg.getViewMode() : pg.viewMode_; };

    function focusedEditable() {
      const a = document.activeElement;
      if (!a || a === document.body || isOwnUi(a)) return null;
      if (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return a;
      return null;
    }
    function dialogOpen() {
      for (const el of document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="popup" i]')) {
        if (isOwnUi(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 40 && r.height > 40 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none') return true;
      }
      return false;
    }

    // 블록 값 고르기 목록·오른쪽 클릭 메뉴가 열린 채 블록을 바꾸면 고른 값이 사라진 옛 블록에 들어간다
    // 엔트리 목록 틀(.entry-widget-dropdown)은 높이 0이고 실제 목록은 그 안쪽에 떠 있다
    function widgetOpen() {
      const cm = E().ContextMenu;
      if (cm && cm.visible === true) return true;
      const box = el => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
      for (const el of document.querySelectorAll('[class*="entry-widget-"], .entry-contextmenu')) {
        if (isOwnUi(el)) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (box(el) || [...el.querySelectorAll('*')].some(box)) return true;
      }
      return false;
    }

    // 이 필드들은 작품을 다시 불러오지 않고 그 오브젝트에만 넣는다(모양·소리는 하나씩 더하고 빼기)
    const OBJ_TARGET_FIELDS = new Set(['entity', 'name', 'lock', 'rotateMethod', 'selectedPictureId', 'sprite', 'text']);
    const SYSTEM_VAR_TYPES = new Set(['timer', 'answer', 'stt']);
    function changedFields(a, b) {
      const out = [];
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (M.stable(a[k]) !== M.stable(b[k])) out.push(k);
      return out;
    }
    const varType = s => { try { return s == null ? null : JSON.parse(s).variableType; } catch { return null; } };

    // 큰 작품은 다시 불러오기에 수십 초가 걸려, 자주 바뀌는 것(블록·오브젝트 속성·모양·함수·변수·신호)은 그 부분만 넣는다
    function plan(toApply, current) {
      const p = { full: false, code: [], obj: [], func: [], vars: [], sys: [], scenes: [], msgs: false, varOrder: false, funcOrder: false, objOrder: false };
      const idSet = s => { try { return JSON.parse(s || '[]').map(String).sort().join('\n'); } catch { return null; } };
      for (const k of Object.keys(toApply)) {
        const v = toApply[k];
        if (k.startsWith('code:')) {
          if (v == null || !getObj(k.slice(5))) { p.full = true; continue; }
          p.code.push(k);
        } else if (k.startsWith('obj:')) {
          const old = current && current[k];
          if (v == null || old == null || !getObj(k.slice(4))) { p.full = true; continue; }
          const ov = JSON.parse(old), nv = JSON.parse(v);
          const diff = changedFields(ov, nv);
          if (diff.some(f => !OBJ_TARGET_FIELDS.has(f))) { p.full = true; continue; }
          if (diff.includes('sprite') && changedFields(ov.sprite || {}, nv.sprite || {}).some(f => f !== 'pictures' && f !== 'sounds')) { p.full = true; continue; }
          p.obj.push(k);
        } else if (k.startsWith('func:')) {
          p.func.push(k);
        } else if (k.startsWith('var:')) {
          const nt = varType(v), ot = varType(current && current[k]);
          if (SYSTEM_VAR_TYPES.has(nt) || SYSTEM_VAR_TYPES.has(ot)) {
            if (v != null && nt === ot) p.sys.push(k); else p.full = true;
            continue;
          }
          p.vars.push(k);
        } else if (k.startsWith('scene:')) {
          const old = current && current[k];
          if (v == null || old == null || changedFields(JSON.parse(old), JSON.parse(v)).some(f => f !== 'name')) { p.full = true; continue; }
          p.scenes.push(k);
        } else if (k === 'objOrder') {
          // 오브젝트가 더해지거나 빠진 게 아니라 순서만 바뀐 경우
          if (idSet(v) === null || idSet(v) !== idSet(current && current.objOrder)) { p.full = true; continue; }
          p.objOrder = true;
        } else if (k.startsWith('msg:') || k === 'msgOrder') {
          p.msgs = true;
        } else if (k === 'varOrder') {
          p.varOrder = true;
        } else if (k === 'funcOrder') {
          p.funcOrder = true;
        } else p.full = true;
      }
      return p;
    }

    function isSafe(toApply, current) {
      if (!canRead()) return false;
      const e = E();
      if (e.Func && e.Func.isEdit) return false;
      const p = plan(toApply, current);
      const bk = boardKey();
      // 엔트리파이선(글 코딩)에서 블록으로 돌아오면 엔트리가 열린 오브젝트 코드와 그 글에 든 함수 정의를 글 내용으로 다시 만든다 —
      // 그사이 넣은 남의 블록·함수 변경이 지워지므로, 그것들과 작품 통째로 다시 불러오기는 블록 화면으로 돌아온 뒤에 넣는다
      if (e.isTextMode && (p.full || p.func.length || p.funcOrder || (bk && bk.startsWith('obj:') && p.code.includes('code:' + bk.slice(4))))) return false;
      const focus = focusedEditable();
      if (p.full) {
        if (focus || dialogOpen() || widgetOpen()) return false;
        const mode = viewMode();
        const painter = e.playground.painter;
        if (mode === 'picture' && painter && painter.file && painter.file.modified) return false;
        if (mode === 'sound') return false;
        return true;
      }
      if ((p.obj.length || p.vars.length || p.sys.length || p.scenes.length || p.msgs || p.func.length || p.varOrder || p.funcOrder || p.objOrder) && focus) return false;
      // 그림판에 저장 안 한 그림이 있거나 소리 화면을 보는 중이면, 그 오브젝트의 모양·소리 목록은 바꾸지 않고 미룬다
      const pg = e.playground, cur = pg && pg.object;
      if (cur && p.obj.includes('obj:' + cur.id)) {
        const mode = viewMode();
        const painterDirty = mode === 'picture' && pg.painter && pg.painter.file && pg.painter.file.modified;
        if (painterDirty || mode === 'sound') {
          const ov = JSON.parse(current['obj:' + cur.id]), nv = JSON.parse(toApply['obj:' + cur.id]);
          const same = f => M.stable((ov.sprite || {})[f]) === M.stable((nv.sprite || {})[f]);
          if (painterDirty && (!same('pictures') || ov.selectedPictureId !== nv.selectedPictureId)) return false;
          if (mode === 'sound' && !same('sounds')) return false;
        }
      }
      if (bk && p.code.includes('code:' + bk.slice(4)) && bk.startsWith('obj:')) {
        if (viewMode() !== 'code') return false;
        if (focus || widgetOpen()) return false;
      }
      return true;
    }

    function dropUndoIfTouches(key, force) {
      const sm = E().stateManager;
      const touches = st => st && (st.__ercKey === key || st.__ercKey === undefined);
      const hit = force || [sm.undoStack_, sm.redoStack_].some(s => Array.isArray(s) && s.some(touches));
      if (hit && typeof sm.clear === 'function') sm.clear();
    }

    // 블록 화면에 열린 큰 오브젝트도 바뀐 묶음만 지우고 새로 넣는다(전체를 다시 그리면 수 초 멈춤).
    // 내 화면 코드가 직전 조각과 묶음 단위로 맞지 않거나 순서가 바뀌었으면 false(통째로 바꾸기로).
    function patchThreads(code, oldT, newT, off, board, prevStr) {
      const oldKeys = oldT.map((th, i) => M.threadKey(th, i));
      const newKeys = newT.map((th, i) => M.threadKey(th, i));
      if ([...oldKeys, ...newKeys].some(k => k.startsWith('i:'))) return false;
      if (new Set(oldKeys).size !== oldKeys.length || new Set(newKeys).size !== newKeys.length) return false;
      const live = code.getThreads();
      if (live.length !== oldT.length) return false;
      for (let i = 0; i < live.length; i++) {
        const fb = live[i].getFirstBlock();
        if (!fb || 't:' + fb.id !== oldKeys[i]) return false;
      }
      const oldStr = new Map(oldT.map((th, i) => [oldKeys[i], M.stable(th)]));
      // 메모 x·y만 다른 묶음: 방 작품의 직전 값과 받은 값이 같으면 내 화면에서 그려진 폭 때문이라 다시 만들지 않는다(큰 묶음을 다시 그리면 멈춤).
      // 방 작품에서 바뀌었으면(누가 메모를 옮김) 넣는다
      let prevByKey = null;
      const prevOf = k => {
        if (prevByKey === null) { prevByKey = new Map(); try { (prevStr ? JSON.parse(prevStr) : []).forEach((th, i) => prevByKey.set(M.threadKey(th, i), M.stable(th))); } catch { /* 직전 값 없음 */ } }
        return prevByKey.get(k);
      };
      const sameThread = (k, a, th) => {
        const b = M.stable(th);
        if (a === b) return true;
        return a !== undefined && a.indexOf('"comment"') >= 0 && prevOf(k) === b && commentFree(JSON.parse(a)) === commentFree(th);
      };
      const changed = new Set(newKeys.filter((k, i) => !sameThread(k, oldStr.get(k), newT[i])));
      const newSet = new Set(newKeys);
      const kept = newKeys.filter(k => oldStr.has(k) && !changed.has(k));
      const keptOld = oldKeys.filter(k => newSet.has(k) && !changed.has(k));
      if (kept.join('\n') !== keptOld.join('\n')) return false;
      for (let i = live.length - 1; i >= 0; i--) if (!newSet.has(oldKeys[i]) || changed.has(oldKeys[i])) live[i].destroy(false);
      newT.forEach((th, i) => {
        const k = newKeys[i];
        if (oldStr.has(k) && !changed.has(k)) return;
        const t = code.createThread(JSON.parse(JSON.stringify(M.decanonThreads([th], off)[0])), i);
        if (board && t && !t.view) t.createView(board);
      });
      return true;
    }

    // 엔트리는 한 번 열었던 코드(view가 남은 코드)에 묶음을 더하면 그 그림을 블록 화면에 지금 붙은 그림 묶음, 곧 지금 열린 오브젝트 것에 붙인다.
    // 화면에 없는 그런 코드를 고치는 동안은 그 자리를 그 코드 자신의 그림 묶음으로 바꿔 둔다(엔트리 bindCodeView가 바꿔 끼우는 자리).
    const VIEW_GROUPS = ['svgThreadGroup', 'svgBlockGroup', 'svgCommentGroup'];
    function withOwnGroups(code, fn) {
      const cv = code.view;
      if (!cv) return fn();
      const board = cv.board || code.board;
      if (!board || VIEW_GROUPS.some(k => !cv[k])) return false;
      const saved = VIEW_GROUPS.map(k => board[k]);
      VIEW_GROUPS.forEach(k => { board[k] = cv[k]; });
      try { return fn(); } finally { VIEW_GROUPS.forEach((k, i) => { board[k] = saved[i]; }); }
    }

    function applyCode(k, v, oldStr, prevStr) {
      const id = k.slice(5);
      const obj = getObj(id);
      const off = offsets.get('obj:' + id);
      const ws = E().getMainWS();
      const onBoard = !!(ws && ws.board && ws.board.code === obj.script);
      let patched = false;
      if (oldStr) {
        const run = () => patchThreads(obj.script, JSON.parse(oldStr), JSON.parse(v), off, onBoard ? ws.board : null, prevStr);
        try { patched = onBoard ? run() : withOwnGroups(obj.script, run); } catch (err) { log('patch threads', err); patched = false; }
      }
      if (!patched) {
        const threads = M.decanonThreads(JSON.parse(v), off);
        const old = obj.script;
        const nc = new (E().Code)(threads, obj);
        obj.script = nc;
        if (onBoard) ws.changeBoardCode(nc);
        try { if (old && old.clearExecutors) old.clearExecutors(); } catch { /* 옛 코드 정리는 실패해도 됨 */ }
      }
      // 실행 취소가 옛 블록 자리(순서 번호)를 가리켜 남의 블록을 지울 수 있어, 이 오브젝트를 건드린 기록이 있으면 비운다
      dropUndoIfTouches('obj:' + id, onBoard);
      dirtyObjs.add(id);
    }

    const clone = x => JSON.parse(JSON.stringify(x));
    // 목록(모양·소리)을 받은 목록과 같게: 새것은 그 자리에 더하고, 바뀐 것은 바꾸고, 없는 것은 뺀다(마지막 하나는 엔트리가 못 빼므로 더하기부터)
    // asJSON: 살아 있는 항목을 엔트리 내보내기와 같은 모양으로(살아 있는 객체엔 내보내기에 없는 값이 붙어 있다)
    function syncList(now, want, asJSON, { add, remove, replace }) {
      const byId = new Map(now.map(x => [String(x.id), x]));
      want.forEach((w, i) => {
        const cur = byId.get(String(w.id));
        if (!cur) add(clone(w), i);
        else if (M.stable(asJSON(cur)) !== M.stable(w)) replace(clone(w), i);
      });
      const keep = new Set(want.map(w => String(w.id)));
      for (const x of [...now]) if (!keep.has(String(x.id))) remove(x.id);
    }

    function applyObj(k, v, oldStr) {
      const id = k.slice(4);
      const o = getObj(id);
      const nv = JSON.parse(v), ov = JSON.parse(oldStr);
      const pg = E().playground;
      if (nv.sprite && M.stable(nv.sprite.pictures) !== M.stable(ov.sprite && ov.sprite.pictures)) {
        const picJSON = x => M.canonPicture(E().getPicturesJSON ? E().getPicturesJSON([x])[0] : x);
        syncList(o.pictures, nv.sprite.pictures || [], picJSON, {
          add: (pic, i) => o.addPicture(pic, i),
          remove: pid => o.removePicture(pid),
          replace: pic => {
            const wasSelected = o.selectedPicture && String(o.selectedPicture.id) === String(pic.id);
            E().container.setPicture({ ...pic, objectId: o.id });
            // setPicture는 모양 객체를 새로 만든다 — 고른 모양이 옛 객체를 가리키면 엔트리 내보내기가 깨진다
            if (wasSelected) o.selectPicture(pic.id);
          },
        });
        const order = (nv.sprite.pictures || []).map(x => String(x.id));
        o.pictures.sort((a, b) => order.indexOf(String(a.id)) - order.indexOf(String(b.id)));
        if (o.pictures.length && o.pictures.indexOf(o.selectedPicture) < 0) o.selectPicture((nv.selectedPictureId && o.getPicture(nv.selectedPictureId)) ? nv.selectedPictureId : o.pictures[0].id);
        if (pg.object === o) pg.injectPicture(o);
      }
      if (nv.sprite && M.stable(nv.sprite.sounds) !== M.stable(ov.sprite && ov.sprite.sounds)) {
        const sndJSON = x => (E().getSoundsJSON ? E().getSoundsJSON([x])[0] : x);
        syncList(o.sounds, nv.sprite.sounds || [], sndJSON, {
          add: (snd, i) => o.addSound(snd, i),
          remove: sid => o.removeSound(sid),
          replace: (snd, i) => { o.removeSound(snd.id); o.addSound(snd, i); },
        });
        const order = (nv.sprite.sounds || []).map(x => String(x.id));
        o.sounds.sort((a, b) => order.indexOf(String(a.id)) - order.indexOf(String(b.id)));
        if (o.selectedSound && o.sounds.indexOf(o.selectedSound) < 0) o.selectedSound = o.sounds[0];
        if (pg.object === o) pg.injectSound(o);
      }
      if (nv.selectedPictureId && (nv.selectedPictureId !== ov.selectedPictureId || !o.selectedPicture || String(o.selectedPicture.id) !== String(nv.selectedPictureId))) o.selectPicture(nv.selectedPictureId);
      if (typeof nv.text === 'string' && nv.text !== ov.text) o.setText(nv.text);
      if (M.stable(nv.entity) !== M.stable(ov.entity) && nv.entity) o.entity.setModel(nv.entity);
      if (nv.name !== ov.name && typeof nv.name === 'string') { o.setName(nv.name); pg.updateObjectTitle(o); }
      if (nv.lock !== ov.lock) o.setLock(!!nv.lock);
      if (nv.rotateMethod !== ov.rotateMethod && nv.rotateMethod) o.setRotateMethod(nv.rotateMethod);
      if (o.updateCoordinateView) o.updateCoordinateView();
      if (o.updateRotationView) o.updateRotationView();
      if (o.updateThumbnailView) o.updateThumbnailView();
      if (E().stage && E().stage.updateObject) E().stage.updateObject();
      dirtyObjs.add(id);
    }

    // 함수: 정의만 바꿔 끼운다. 엔트리 removeFunction은 그 함수를 쓰는 블록까지 모두 지우므로 쓰지 않는다.
    function applyFuncs(keys, toApply) {
      const vc = E().variableContainer;
      const fns = vc.functions_;
      for (const k of keys) {
        const id = k.slice(5);
        const v = toApply[k];
        const old = fns[id];
        if (v == null) {
          if (old) { try { old.destroy(); } catch (err) { log('func destroy', err); } delete fns[id]; }
        } else {
          const json = M.decanonFunc(JSON.parse(v), offsets.get('func:' + id));
          const nf = new (E().Func)(json);
          nf.generateBlock();
          fns[id] = nf;
          if (old && old !== nf) { try { old.destroy(); } catch (err) { log('func destroy', err); } }
        }
        // 이 함수 안에서 한 되돌리기 기록은 바뀌기 전 함수 블록을 가리킨다
        dropUndoIfTouches('func:' + id);
        dirtyFuncs.add(id);
      }
      globalsDirty = true;
      if (vc.updateList) vc.updateList();
    }

    // 함수 목록 순서: 엔트리는 functions_에 넣은 순서대로 보여 주고 내보낸다
    function orderFuncs(orderStr) {
      if (!orderStr) return;
      const vc = E().variableContainer, fns = vc.functions_;
      const order = JSON.parse(orderStr).map(String);
      const pos = id => { const i = order.indexOf(id); return i < 0 ? 1e9 : i; };
      const ids = Object.keys(fns);
      const sorted = [...ids].sort((a, b) => pos(a) - pos(b));
      if (sorted.join('\n') === ids.join('\n')) return;
      for (const id of sorted) { const f = fns[id]; delete fns[id]; fns[id] = f; }
      if (vc.updateList) vc.updateList();
    }

    // 변수·리스트: 바뀐 것은 빼고 다시 넣는다(블록은 id로 가리키므로 그대로), 그다음 받은 순서로 줄 세운다
    // 엔트리는 변수를 만들 때 x·y 가운데 하나라도 0이면 없는 것으로 보고(t.x ? … : null) 다른 변수 상자를 피해 새 자리를 정한다
    // (상자 크기는 글자 폭에 따라 다름). 받은 변수는 받은 자리에 다시 둔다
    function pinVarPositions(list) {
      const vc = E().variableContainer;
      for (const j of list) {
        if (!j || j.id == null) continue;
        const v = [...(vc.variables_ || []), ...(vc.lists_ || [])].find(x => String(x.id_) === String(j.id));
        if (!v || typeof v.setX !== 'function') continue;
        if (typeof j.x === 'number' && v.getX() !== j.x) v.setX(j.x);
        if (typeof j.y === 'number' && v.getY() !== j.y) v.setY(j.y);
      }
    }

    function applyVars(keys, toApply, current) {
      const vc = E().variableContainer;
      for (const k of keys) {
        const id = k.slice(4);
        const v = toApply[k];
        const curVar = (vc.variables_ || []).find(x => String(x.id_) === id);
        const curList = (vc.lists_ || []).find(x => String(x.id_) === id);
        if (curVar) vc.removeVariable(curVar);
        if (curList) vc.removeList(curList);
        if (v != null) { const j = JSON.parse(v); vc.appendVariables([j]); pinVarPositions([j]); }
      }
      const orderStr = toApply.varOrder != null ? toApply.varOrder : current && current.varOrder;
      if (orderStr) {
        const order = JSON.parse(orderStr).map(String);
        const pos = x => { const i = order.indexOf(String(x.id_)); return i < 0 ? 1e9 : i; };
        vc.variables_.sort((a, b) => pos(a) - pos(b));
        vc.lists_.sort((a, b) => pos(a) - pos(b));
      }
      if (vc.updateViews) vc.updateViews();
      if (vc.updateList) vc.updateList();
      globalsDirty = true;
    }

    // 초시계·대답·음성 인식 변수는 엔진·오브젝트 목록이 그 객체를 직접 쥐고 있어 빼고 다시 넣으면 실행이 깨진다 — 있는 객체에 값만 넣는다
    // (엔트리는 이 블록이 화면에 그려질 때 그 변수를 명령 없이 "보이기"로 바꾸므로, 블록을 화면에서 안 본 사람은 받아서 맞춰야 한다)
    function systemVar(type) {
      const e = E();
      if (type === 'timer') return e.engine && e.engine.projectTimer;
      if (type === 'answer') return e.container && e.container.inputValue;
      if (type === 'stt') return e.container && e.container.sttValue;
      return null;
    }
    function applySystemVars(keys, toApply) {
      for (const k of keys) {
        const j = JSON.parse(toApply[k]);
        const v = systemVar(j.variableType);
        if (!v || String(v.id_) !== String(j.id)) throw new Error('시스템 변수를 못 찾음 ' + k);
        if (typeof j.name === 'string' && v.getName() !== j.name) v.setName(j.name);
        if (typeof j.visible === 'boolean' && v.isVisible() !== j.visible) v.setVisible(j.visible);
        if (typeof j.x === 'number' && v.getX() !== j.x) v.setX(j.x);
        if (typeof j.y === 'number' && v.getY() !== j.y) v.setY(j.y);
        if (j.value !== undefined && String(v.getValue()) !== String(j.value)) v.setValue(j.value);
      }
      globalsDirty = true;
    }

    // 오브젝트 순서(목록·무대 앞뒤): 엔트리 순서 바꾸기(container.moveElement)와 같은 단계로 맞춘다
    function orderObjects(orderStr) {
      const c = E().container;
      const order = JSON.parse(orderStr).map(String);
      const pos = o => { const i = order.indexOf(String(o.id)); return i < 0 ? 1e9 : i; };
      const sorted = [...c.objects_].sort((a, b) => pos(a) - pos(b));
      if (sorted.every((o, i) => o === c.objects_[i])) return;
      c.objects_.splice(0, c.objects_.length, ...sorted);
      c.setCurrentObjects();
      c.updateListView();
      E().requestUpdate = true;
    }

    // 장면 이름: 엔트리 sceneRename 명령과 같게
    function applyScenes(keys, toApply) {
      for (const k of keys) {
        const sc = E().scene.getSceneById(k.slice(6));
        if (!sc) throw new Error('장면을 못 찾음 ' + k);
        const name = JSON.parse(toApply[k]).name;
        sc.name = name;
        if (sc.view && sc.view.nameField) sc.view.nameField.value = name;
      }
      setTimeout(() => { try { E().scene.resize(); } catch (err) { log('scene resize', err); } }, 0);
      globalsDirty = true;
    }

    // 신호: 받은 순서 그대로 목록을 바꾼다
    function applyMsgs(toApply, current) {
      const vc = E().variableContainer;
      const get = k => (k in toApply ? toApply[k] : current && current[k]);
      const order = JSON.parse(get('msgOrder') || '[]').map(String);
      const list = order.map(id => get('msg:' + id)).filter(x => x != null).map(x => JSON.parse(x));
      vc.setMessages(list);
      if (vc.updateList) vc.updateList();
      globalsDirty = true;
    }

    // 글상자 크기처럼 컴퓨터마다 다르게 계산되는 값은 비교에서 뺀다
    function sameish(k, a, b) {
      if (a === b) return true;
      if (a == null || b == null) return false;
      if (k.startsWith('code:') || k.startsWith('func:')) { try { return commentFree(JSON.parse(a)) === commentFree(JSON.parse(b)); } catch { return false; } }
      if (!k.startsWith('obj:')) return false;
      const strip = s => { const o = JSON.parse(s); if (o.objectType === 'textBox' && o.entity) { delete o.entity.width; delete o.entity.height; } return M.stable(o); };
      try { return strip(a) === strip(b); } catch { return false; }
    }
    // 어느 칸이 다른지 칸 이름만(값은 빼고) — 문제 기록에 남겨 다시 불러온 까닭을 알 수 있게
    function diffPaths(a, b, pre = '', depth = 0, out = []) {
      if (out.length >= 6 || M.stable(a) === M.stable(b)) return out;
      if (depth >= 5 || !a || !b || typeof a !== 'object' || typeof b !== 'object') { out.push(pre || '(전체)'); return out; }
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], pre ? pre + '.' + k : String(k), depth + 1, out);
      return out;
    }
    const whereDiffers = (k, a, b) => { try { return k + ' ' + diffPaths(a == null ? null : JSON.parse(a), b == null ? null : JSON.parse(b)).join(','); } catch { return k; } };

    function captureView() {
      const e = E();
      return {
        scene: e.scene.selectedScene && e.scene.selectedScene.id,
        object: e.playground.object && e.playground.object.id,
        mode: viewMode(),
      };
    }
    function restoreView(v) {
      const e = E();
      try {
        const sc = v.scene && e.scene.getSceneById && e.scene.getSceneById(v.scene);
        if (sc && e.scene.selectedScene !== sc) e.scene.selectScene(sc);
        if (v.object && getObj(v.object)) e.container.selectObject(v.object);
        if (v.mode && v.mode !== viewMode() && v.mode !== 'default') e.playground.changeViewMode(v.mode);
      } catch (err) { log('restoreView', err); }
    }

    // 엔트리가 장면별로 오브젝트 순서를 다시 맞출 수 있어 순서가 아니라 빠진 것이 있는지만 본다
    const idLists = p => M.stable(['scenes', 'objects'].map(f => (Array.isArray(p && p[f]) ? p[f] : []).map(x => x && String(x.id)).sort()));
    // 큰 작품에서 전체 내보내기는 느려서, 불러온 뒤 확인은 장면·오브젝트 id만 엔트리에서 바로 읽는다
    const loadedIds = () => { const e = E(); return M.stable([e.scene.getScenes().map(s => String(s.id)).sort(), e.container.getAllObjects().map(o => String(o.id)).sort()]); };

    // 다시 불러오기가 실패하거나 일부만 들어오면 원래 작품으로 되돌리고 예외를 던진다.
    // 비워진·반쯤 찬 화면이 남으면 다음 확인 때 "내가 지운 것"으로 방 전체에 퍼지기 때문이다.
    // current: 지금 화면 조각(있으면 되돌릴 작품을 다시 내보내지 않고 이걸로 만든다)
    // opts.fresh: 처음 참여 — 보던 화면이 내 기본 작품 것이라 되살리지 않는다(큰 오브젝트를 괜히 다시 그리게 됨)
    function loadUnits(units, current, opts = {}) {
      const e = E();
      const view = captureView();
      const pid = e.projectId;
      let prev = null;
      try { prev = current ? M.unitsToProject(current, k => offsets.get(k)) : e.exportProject(); } catch (err) { log('되돌릴 작품을 못 읽음', err); }
      const project = M.unitsToProject(units, k => offsets.get(k));
      if (pid) project._id = pid;
      const want = idLists(project);
      const load = p => { e.clearProject(); e.loadProject(p); };
      let failure = null;
      markAll();
      applying = true;
      try {
        try {
          load(project);
          if (loadedIds() !== want) failure = new Error('작품이 일부만 불러와짐');
        } catch (err) { failure = err; }
        if (failure && prev) {
          if (pid) prev._id = pid;
          try { load(prev); } catch (err2) { log('원래 작품으로 되돌리기 실패', err2); }
        }
      } finally { applying = false; }
      if (pid !== undefined) e.projectId = pid;
      if (failure) { markAll(); funcsAllDirty = true; } else {
        primeFrom(units);
        try { pinVarPositions(Object.keys(units).filter(k => k.startsWith('var:') && units[k] != null).map(k => JSON.parse(units[k]))); } catch (err) { log('pin vars', err); }
      }
      if (!opts.fresh) restoreView(view);
      ensureHooks();
      if (failure) throw failure;
    }

    // 반환값: 작품을 통째로 다시 불러왔으면 true. prevOf(key): 그 조각의 방 작품 직전 값(있으면)
    function apply(toApply, current, prevOf) {
      const p = plan(toApply, current);
      if (!p.full) {
        applying = true;
        try {
          // 함수·변수·신호를 먼저(블록이 가리킬 대상), 그다음 오브젝트·블록
          if (p.func.length) applyFuncs(p.func, toApply);
          if (p.func.length || p.funcOrder) orderFuncs(toApply.funcOrder != null ? toApply.funcOrder : current && current.funcOrder);
          if (p.vars.length || p.varOrder) applyVars(p.vars, toApply, current);
          if (p.sys.length) applySystemVars(p.sys, toApply);
          if (p.msgs) applyMsgs(toApply, current);
          if (p.scenes.length) applyScenes(p.scenes, toApply);
          for (const k of p.obj) applyObj(k, toApply[k], current[k]);
          if (p.objOrder) orderObjects(toApply.objOrder);
          for (const k of p.code) applyCode(k, toApply[k], current[k], prevOf ? prevOf(k) : null);
        } catch (err) {
          log('부분 반영 실패, 다시 불러오기로', err);
          p.full = true;
        } finally { applying = false; }
        if (!p.full) {
          const after = exportUnits();
          // 순서 목록은 넣고 빼는 동안 엔트리가 정하는 자리가 있어 비교에서 뺀다(내용 조각은 모두 같아야 함). 오브젝트 순서만 바꾼 경우는 순서가 곧 내용이다
          const bad = after ? Object.keys(toApply).filter(k => (!/Order$/.test(k) || (k === 'objOrder' && p.objOrder)) && !sameish(k, after[k] == null ? null : after[k], toApply[k])) : ['(읽기 실패)'];
          if (!bad.length) return false;
          log('부분 반영 결과가 방과 달라 다시 불러오기로', after ? bad.map(k => whereDiffers(k, after[k], toApply[k])) : bad);
        }
      }
      const units = {};
      for (const [k, v] of Object.entries(current)) if (v != null) units[k] = v;
      for (const [k, v] of Object.entries(toApply)) { if (v == null) delete units[k]; else units[k] = v; }
      loadUnits(units, current);
      return true;
    }

    function where() {
      try {
        const e = E();
        const o = e.playground.object;
        return { scene: e.scene.selectedScene ? e.scene.selectedScene.id : null, object: o ? o.id : null, objectName: o ? String(o.name || '') : '', mode: viewMode() || null };
      } catch { return null; }
    }

    function objectName(id) { const o = getObj(id); return o ? String(o.name || '') : null; }
    function objectIds() { try { return E().container.getAllObjects().map(o => String(o.id)); } catch { return []; } }
    function isDefaultProject() {
      try { const e = E(); return typeof e.isDefaultProject === 'function' ? !!e.isDefaultProject(e.exportProject()) : false; } catch { return false; }
    }
    function stopRunning() { try { if (isRunning()) E().engine.toggleStop(); } catch (err) { log('stop', err); } }

    return {
      ready, ensureHooks, exportUnits, cleanLocal, isSafe, apply, loadAll: (units, opts) => loadUnits(units, null, opts), where, objectName, objectIds, isDefaultProject,
      isRunning, stopRunning, isBusy: () => pointerDown || applying, markAllDirty: markAll, scanSome,
      _offsets: offsets,
    };
  }

  root.ErcEntry = { create };
})(typeof self !== 'undefined' ? self : this);

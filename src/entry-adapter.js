// 엔트리 편집기와 붙는 부분: 작품을 조각으로 읽고, 방에서 온 조각을 편집기에 넣는다.
// 블록 코드·오브젝트 위치처럼 자주 바뀌는 것은 그 부분만 바꾸고, 나머지는 작품을 다시 불러오되 보던 화면을 되살린다.
(function (root) {
  'use strict';
  const M = root.ErcMerge;
  const E = () => root.Entry;

  function create({ onLocalChange, onExternalLoad, isOwnUi, log = () => {} }) {
    const offsets = new Map();
    let pointerDown = false;
    let applying = false;
    let hookedSm = null, hookedCce = null, hookedCmd = null, protoHooked = false, loadHooked = false;

    // 큰 작품에서 매번 전체를 읽으면 화면이 멈춘다. 바뀐 오브젝트만 다시 읽고 나머지는 지난 결과를 쓴다.
    const objCache = new Map();
    let globalsCache = null;
    const dirtyObjs = new Set();
    let allDirty = true, globalsDirty = true;
    const watchedCodes = new WeakSet();
    const markAll = () => { allDirty = true; globalsDirty = true; };
    // 명령을 거치지 않은 변경을 놓치지 않게 조금씩 다시 본다(한꺼번에 전체를 읽으면 큰 작품에서 화면이 멈춘다)
    let scanAt = 0;
    function scanSome(count) {
      try {
        const objs = E().container.getAllObjects();
        if (!objs.length) return;
        for (let i = 0; i < Math.min(count, objs.length); i++) dirtyObjs.add(String(objs[(scanAt + i) % objs.length].id));
        scanAt = (scanAt + count) % objs.length;
        if (scanAt < count) globalsDirty = true;
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
    function markBoard() {
      const k = boardKey();
      if (k && k.startsWith('obj:')) dirtyObjs.add(k.slice(4));
      else { globalsDirty = true; if (!k) allDirty = true; }
    }
    function onCommand(type, args) {
      const name = cmdName(type);
      if (!name) { markAll(); return; }
      if (BLOCK_CMDS.has(name)) { markBoard(); return; }
      if (VIEW_ONLY_CMD.test(name)) return;
      const a0 = Array.isArray(args) ? args[0] : undefined;
      if ((typeof a0 === 'string' || typeof a0 === 'number') && getObj(a0)) { dirtyObjs.add(String(a0)); globalsDirty = true; return; }
      markAll();
    }
    function watchCode(o) {
      const c = o.script;
      if (!c || !c.changeEvent || typeof c.changeEvent.attach !== 'function' || watchedCodes.has(c)) return;
      watchedCodes.add(c);
      const id = String(o.id);
      c.changeEvent.attach(null, () => { dirtyObjs.add(id); });
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

    const down = ev => { if (ev.button === 0 && !isOwnUi(ev.target)) pointerDown = true; };
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
    function flushLazyPositions() {
      const ws = E().getMainWS();
      const code = ws && ws.board && ws.board.code;
      if (!code || typeof code.getThreads !== 'function') return;
      for (const th of code.getThreads()) {
        const b = th && typeof th.getFirstBlock === 'function' ? th.getFirstBlock() : null;
        if (b && b.view && typeof b._updatePos === 'function') b._updatePos();
      }
    }

    // 오브젝트를 뺀 나머지(장면·변수·함수·표·설정)는 엔트리의 같은 내보내기로 읽되, 오브젝트 직렬화만 건너뛴다
    function globalsViaExport() {
      const c = E().container;
      const own = Object.prototype.hasOwnProperty.call(c, 'toJSON');
      const prev = c.toJSON;
      c.toJSON = () => [{}];
      try { return E().exportProject(); } finally { if (own) c.toJSON = prev; else delete c.toJSON; }
    }

    function exportUnits() {
      if (!canRead()) return null;
      try { flushLazyPositions(); } catch (err) { log('flush positions', err); }
      const e = E();
      const units = {};
      const ids = [];
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
          watchCode(o);
          const off = offsets.get('obj:' + id);
          const offKey = off ? off[0] + ',' + off[1] : '0,0';
          let c = objCache.get(id);
          if (full || !c || dirtyObjs.has(id) || c.offKey !== offKey) {
            const j = o.toJSON();
            const raw = JSON.stringify(j);
            if (!c || c.raw !== raw || c.offKey !== offKey) {
              const u = M.objectUnits(j, off);
              c = { raw, offKey, obj: u.obj, code: u.code };
              objCache.set(id, c);
            }
          }
          units['obj:' + id] = c.obj;
          units['code:' + id] = c.code;
        }
        for (const id of [...objCache.keys()]) if (!seen.has(id)) objCache.delete(id);
        if (full || globalsDirty || !globalsCache) {
          const g = globalsViaExport();
          if (!g) return null;
          delete g.objects; delete g.interface;
          const funcOff = [...offsets].filter(([k]) => k.startsWith('func:')).map(([k, v]) => k + '=' + v).join(';');
          const raw = JSON.stringify(g) + '|' + funcOff;
          if (!globalsCache || globalsCache.raw !== raw) globalsCache = { raw, units: M.globalUnits(g, k => offsets.get(k)) };
        }
      } catch (err) { log('export', err); return null; }
      Object.assign(units, globalsCache.units);
      units.objOrder = M.stable(ids);
      dirtyObjs.clear();
      allDirty = false; globalsDirty = false;
      return units;
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

    const OBJ_TARGET_FIELDS = new Set(['entity', 'name', 'lock', 'rotateMethod', 'selectedPictureId']);
    function changedFields(a, b) {
      const out = [];
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (M.stable(a[k]) !== M.stable(b[k])) out.push(k);
      return out;
    }

    function plan(toApply, current) {
      let full = false;
      const code = [], obj = [];
      for (const k of Object.keys(toApply)) {
        const v = toApply[k];
        if (k.startsWith('code:')) {
          if (v == null || !getObj(k.slice(5))) { full = true; continue; }
          code.push(k);
        } else if (k.startsWith('obj:')) {
          const old = current && current[k];
          if (v == null || old == null || !getObj(k.slice(4))) { full = true; continue; }
          const diff = changedFields(JSON.parse(old), JSON.parse(v));
          if (diff.some(f => !OBJ_TARGET_FIELDS.has(f))) { full = true; continue; }
          obj.push(k);
        } else full = true;
      }
      return { full, code, obj };
    }

    function isSafe(toApply, current) {
      if (!canRead()) return false;
      const e = E();
      if (e.Func && e.Func.isEdit) return false;
      const p = plan(toApply, current);
      const focus = focusedEditable();
      if (p.full) {
        if (focus || dialogOpen() || widgetOpen()) return false;
        const mode = viewMode();
        const painter = e.playground.painter;
        if (mode === 'picture' && painter && painter.file && painter.file.modified) return false;
        if (mode === 'sound') return false;
        return true;
      }
      if (p.obj.length && focus) return false;
      const bk = boardKey();
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

    function applyCode(k, v) {
      const id = k.slice(5);
      const obj = getObj(id);
      const threads = M.decanonThreads(JSON.parse(v), offsets.get('obj:' + id));
      const ws = E().getMainWS();
      const onBoard = !!(ws && ws.board && ws.board.code === obj.script);
      const old = obj.script;
      const nc = new (E().Code)(threads, obj);
      obj.script = nc;
      if (onBoard) ws.changeBoardCode(nc);
      try { if (old && old.clearExecutors) old.clearExecutors(); } catch { /* 옛 코드 정리는 실패해도 됨 */ }
      // 실행 취소가 옛 블록 자리(순서 번호)를 가리켜 남의 블록을 지울 수 있어, 이 오브젝트를 건드린 기록이 있으면 비운다
      dropUndoIfTouches('obj:' + id, onBoard);
      dirtyObjs.add(id);
    }

    function applyObj(k, v, oldStr) {
      const id = k.slice(4);
      const o = getObj(id);
      const nv = JSON.parse(v), ov = JSON.parse(oldStr);
      if (M.stable(nv.entity) !== M.stable(ov.entity) && nv.entity) o.entity.setModel(nv.entity);
      if (nv.name !== ov.name && typeof nv.name === 'string') { o.setName(nv.name); E().playground.updateObjectTitle(o); }
      if (nv.lock !== ov.lock) o.setLock(!!nv.lock);
      if (nv.rotateMethod !== ov.rotateMethod && nv.rotateMethod) o.setRotateMethod(nv.rotateMethod);
      if (nv.selectedPictureId !== ov.selectedPictureId && nv.selectedPictureId) o.selectPicture(nv.selectedPictureId);
      if (o.updateCoordinateView) o.updateCoordinateView();
      if (o.updateRotationView) o.updateRotationView();
      if (E().stage && E().stage.updateObject) E().stage.updateObject();
      dirtyObjs.add(id);
    }

    // 글상자 크기처럼 컴퓨터마다 다르게 계산되는 값은 비교에서 뺀다
    function sameish(k, a, b) {
      if (a === b) return true;
      if (a == null || b == null || !k.startsWith('obj:')) return false;
      const strip = s => { const o = JSON.parse(s); if (o.objectType === 'textBox' && o.entity) { delete o.entity.width; delete o.entity.height; } return M.stable(o); };
      try { return strip(a) === strip(b); } catch { return false; }
    }

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
    function loadUnits(units, current) {
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
      restoreView(view);
      ensureHooks();
      if (failure) throw failure;
    }

    // 반환값: 작품을 통째로 다시 불러왔으면 true
    function apply(toApply, current) {
      const p = plan(toApply, current);
      if (!p.full) {
        applying = true;
        try {
          for (const k of p.code) applyCode(k, toApply[k]);
          for (const k of p.obj) applyObj(k, toApply[k], current[k]);
        } catch (err) {
          log('targeted apply 실패, 다시 불러오기로', err);
          p.full = true;
        } finally { applying = false; }
        if (!p.full) {
          const after = exportUnits();
          if (after && Object.keys(toApply).every(k => sameish(k, after[k] == null ? null : after[k], toApply[k]))) return false;
          log('부분 반영 결과가 방과 달라 다시 불러오기로', Object.keys(toApply));
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
    function isDefaultProject() {
      try { const e = E(); return typeof e.isDefaultProject === 'function' ? !!e.isDefaultProject(e.exportProject()) : false; } catch { return false; }
    }
    function stopRunning() { try { if (isRunning()) E().engine.toggleStop(); } catch (err) { log('stop', err); } }

    return {
      ready, ensureHooks, exportUnits, isSafe, apply, loadAll: loadUnits, where, objectName, isDefaultProject,
      isRunning, stopRunning, isBusy: () => pointerDown || applying, markAllDirty: markAll, scanSome,
      _offsets: offsets,
    };
  }

  root.ErcEntry = { create };
})(typeof self !== 'undefined' ? self : this);

// 엔트리 작품 JSON을 키별 조각(unit)으로 나누고, 같은 조각을 두 사람이 동시에 고쳤을 때 3방향으로 합친다.
// 엔트리·브라우저에 기대지 않아 node 시험에서 그대로 불러 쓴다.
(function (root, factory) {
  const api = factory();
  // 페이지에 다른 스크립트가 module 전역을 만들어 둘 수 있어 브라우저(window)가 아닐 때만 node로 본다
  if (typeof window === 'undefined' && typeof module === 'object' && module.exports) module.exports = api;
  else root.ErcMerge = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // [작품 JSON 필드, 조각 키 앞부분, 순서 조각 키]
  const LISTS = [
    ['scenes', 'scene', 'sceneOrder'],
    ['objects', 'obj', 'objOrder'],
    ['variables', 'var', 'varOrder'],
    ['messages', 'msg', 'msgOrder'],
    ['functions', 'func', 'funcOrder'],
    ['tables', 'table', 'tableOrder'],
  ];
  const LIST_FIELDS = new Set(LISTS.map(l => l[0]));
  // interface는 사람마다 다른 화면 배치라 나누지 않는다
  const LOCAL_FIELDS = new Set(['interface', '_id']);

  function stable(v) {
    if (v === undefined || typeof v === 'function') return undefined;
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(x => { const s = stable(x); return s === undefined ? 'null' : s; }).join(',') + ']';
    const keys = Object.keys(v).filter(k => v[k] !== undefined && typeof v[k] !== 'function').sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }

  const round2 = n => Math.round(n * 100) / 100;

  function parseScript(s) {
    if (Array.isArray(s)) return s;
    if (typeof s !== 'string' || !s) return [];
    try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
  }

  // 블록 화면을 스크롤하면 엔트리는 모든 묶음의 x·y를 함께 옮긴다. 사람마다 다른 스크롤 몫(off)을 빼서 같은 좌표로 맞춘다.
  function canonThreads(threads, off) {
    const [ox, oy] = off || [0, 0];
    return threads.map(th => {
      if (!Array.isArray(th) || !th.length || !th[0] || typeof th[0] !== 'object') return th;
      const f = th[0];
      if (typeof f.x !== 'number' || typeof f.y !== 'number') return th;
      return [{ ...f, x: round2(f.x - ox), y: round2(f.y - oy) }, ...th.slice(1)];
    });
  }
  function decanonThreads(threads, off) {
    const [ox, oy] = off || [0, 0];
    if (!ox && !oy) return threads;
    return threads.map(th => {
      if (!Array.isArray(th) || !th.length || !th[0] || typeof th[0] !== 'object') return th;
      const f = th[0];
      if (typeof f.x !== 'number' || typeof f.y !== 'number') return th;
      return [{ ...f, x: f.x + ox, y: f.y + oy }, ...th.slice(1)];
    });
  }

  // 실행했다 멈추면 엔트리가 일부 변수 값을 "0"↔0처럼 형만 바꿔 되돌린다. 같은 값으로 본다.
  function canonVar(v) {
    if (v && v.value !== undefined && v.value !== null && typeof v.value !== 'object') return { ...v, value: String(v.value) };
    return v;
  }

  function canonFunc(f, off) {
    if (!f || typeof f.content !== 'string') return f;
    return { ...f, content: canonThreads(parseScript(f.content), off) };
  }
  // 함수는 통째로만 합쳐서(부분 합치기 없음) 키 정렬이 필요 없다. 큰 작품은 함수가 수 MB라 빠른 JSON.stringify를 쓴다.
  function funcUnit(f, off) {
    return JSON.stringify(canonFunc(f, off));
  }
  function decanonFunc(f, off) {
    if (!f || !Array.isArray(f.content)) return f;
    return { ...f, content: JSON.stringify(decanonThreads(f.content, off)) };
  }

  function itemId(item, i) {
    const id = item && (item.id != null ? item.id : item._id);
    return id != null ? String(id) : '#' + i;
  }

  // 블록 묶음 배열 → code 조각. stable(배열)과 같은 글이지만, cache(Map: 묶음 원문 → 정리된 글)가 있으면 안 바뀐 묶음은 다시 정리하지 않는다.
  function codeUnit(threads, off, cache) {
    const canon = canonThreads(threads, off);
    if (!cache) return stable(canon);
    const parts = canon.map(th => {
      const raw = JSON.stringify(th);
      let st = cache.get(raw);
      if (st === undefined) { st = stable(th); cache.set(raw, st); }
      return st === undefined ? 'null' : st;
    });
    return '[' + parts.join(',') + ']';
  }

  // 오브젝트 하나 → obj·code 조각. 큰 작품에서 바뀐 오브젝트만 다시 만들 수 있게 따로 둔다.
  function objectUnits(item, off, cache) {
    const rest = { ...item };
    delete rest.script;
    return { obj: stable(rest), code: codeUnit(parseScript(item.script), off, cache) };
  }

  // offsetOf('obj:<id>' | 'func:<id>') → [dx, dy] 이 화면의 스크롤 몫
  function projectToUnits(p, offsetOf) {
    return globalUnits(p, offsetOf, true);
  }

  // withObjects=false면 오브젝트(obj·code·objOrder)를 빼고 나머지만 만든다
  function globalUnits(p, offsetOf, withObjects = false) {
    const u = {};
    const meta = {};
    for (const k of Object.keys(p || {})) {
      if (LIST_FIELDS.has(k) || LOCAL_FIELDS.has(k) || p[k] === undefined) continue;
      meta[k] = p[k];
    }
    u.meta = stable(meta);
    for (const [field, pre, orderKey] of LISTS) {
      if (pre === 'obj' && !withObjects) continue;
      const arr = Array.isArray(p && p[field]) ? p[field] : [];
      const ids = [];
      arr.forEach((item, i) => {
        if (!item || typeof item !== 'object') return;
        const id = itemId(item, i);
        if (u[pre + ':' + id] !== undefined) return;
        ids.push(id);
        if (pre === 'obj') {
          const ou = objectUnits(item, offsetOf && offsetOf('obj:' + id));
          u['obj:' + id] = ou.obj;
          u['code:' + id] = ou.code;
        } else if (pre === 'func') {
          u['func:' + id] = funcUnit(item, offsetOf && offsetOf('func:' + id));
        } else if (pre === 'var') {
          u['var:' + id] = stable(canonVar(item));
        } else {
          u[pre + ':' + id] = stable(item);
        }
      });
      u[orderKey] = stable(ids);
    }
    return u;
  }

  function unitsToProject(u, offsetOf) {
    const get = k => (u[k] == null ? null : JSON.parse(u[k]));
    const p = get('meta') || {};
    for (const [field, pre, orderKey] of LISTS) {
      // 순서 목록에 아직 없는 것(순서 조각만 늦게 온 경우)도 빠뜨리면 다음 내보내기에서 "지움"으로 퍼지므로 뒤에 붙인다
      const listed = (get(orderKey) || []).map(String);
      const listedSet = new Set(listed);
      const extra = Object.keys(u).filter(k => u[k] != null && k.startsWith(pre + ':')).map(k => k.slice(pre.length + 1))
        .filter(id => !listedSet.has(id)).sort();
      const ids = [...listed, ...extra];
      const out = [];
      for (const id of ids) {
        const item = get(pre + ':' + id);
        if (!item) continue;
        if (pre === 'obj') {
          item.script = JSON.stringify(decanonThreads(get('code:' + id) || [], offsetOf && offsetOf('obj:' + id)));
          out.push(item);
        } else if (pre === 'func') {
          out.push(decanonFunc(item, offsetOf && offsetOf('func:' + id)));
        } else {
          out.push(item);
        }
      }
      p[field] = out;
    }
    return p;
  }

  // ── 3방향 합치기 ──
  // b: 내가 고치기 전(기준), t: 지금 방에 있는 것(먼저 들어온 쪽), m: 내가 고친 것.
  // 같은 자리를 둘 다 다르게 고쳤으면 먼저 들어온 쪽(t)을 남기고 conflict로 알린다.

  const same = (a, c) => a.length === c.length && a.every((x, i) => x === c[i]);

  function mergeOrderKeys(bk, tk, mk, finalSet) {
    const bs = new Set(bk), ts = new Set(tk), ms = new Set(mk);
    const inAll = x => bs.has(x) && ts.has(x) && ms.has(x);
    const cb = bk.filter(inAll), ct = tk.filter(inAll), cm = mk.filter(inAll);
    const primary = (!same(cm, cb) && same(ct, cb)) ? mk : tk;
    const res = [];
    const resSet = new Set();
    for (const x of primary) if (finalSet.has(x) && !resSet.has(x)) { res.push(x); resSet.add(x); }
    // 새로 들어온 항목: 그쪽 목록에서 뒤에 아무것도 없으면 맨 뒤, 아니면 바로 앞 항목 뒤(같은 자리에 상대가 먼저 넣은 것은 앞에 둠)
    const place = src => {
      const srcSet = new Set(src);
      src.forEach((x, i) => {
        if (!finalSet.has(x) || resSet.has(x)) return;
        let k = i + 1;
        while (k < src.length && !resSet.has(src[k])) k++;
        let pos;
        if (k >= src.length) pos = res.length;
        else {
          let j = i - 1;
          while (j >= 0 && !resSet.has(src[j])) j--;
          if (j < 0) pos = res.indexOf(src[k]);
          else {
            pos = res.indexOf(src[j]) + 1;
            while (pos < res.length && !bs.has(res[pos]) && !srcSet.has(res[pos])) pos++;
          }
        }
        res.splice(pos, 0, x);
        resSet.add(x);
      });
    };
    place(primary === mk ? tk : mk);
    place(bk);
    for (const x of finalSet) if (!resSet.has(x)) { res.push(x); resSet.add(x); }
    return res;
  }

  function mergeOrder(B, T, M) {
    const bs = new Set(B), ts = new Set(T), ms = new Set(M);
    const fin = new Set();
    for (const x of [...T, ...M]) {
      if (bs.has(x) && (!ts.has(x) || !ms.has(x))) continue;
      fin.add(x);
    }
    return { value: mergeOrderKeys(B, T, M, fin), conflict: false };
  }

  function indexBy(arr, keyOf) {
    const map = new Map();
    const seen = new Map();
    (arr || []).forEach((v, i) => {
      let k = keyOf(v, i);
      const n = seen.get(k) || 0;
      seen.set(k, n + 1);
      if (n) k += '#' + n;
      map.set(k, { v, s: stable(v) });
    });
    return map;
  }

  function mergeKeyed(B, T, M, keyOf, itemMerge) {
    const ib = indexBy(B, keyOf), it = indexBy(T, keyOf), im = indexBy(M, keyOf);
    const out = new Map();
    let conflict = false;
    for (const k of new Set([...ib.keys(), ...it.keys(), ...im.keys()])) {
      const b = ib.get(k), t = it.get(k), m = im.get(k);
      const bs = b && b.s, ts = t && t.s, ms = m && m.s;
      let r;
      if (ts === bs) r = m;
      else if (ms === bs || ms === ts) r = t;
      else if (itemMerge && b && t && m) {
        const x = itemMerge(b.v, t.v, m.v);
        if (x.conflict) conflict = true;
        r = { v: x.value };
      } else { r = t; conflict = true; }
      if (r) out.set(k, r.v);
    }
    const order = mergeOrderKeys([...ib.keys()], [...it.keys()], [...im.keys()], new Set(out.keys()));
    return { value: order.map(k => out.get(k)), conflict };
  }

  const threadKey = (th, i) => {
    const f = Array.isArray(th) ? th[0] : null;
    return f && typeof f === 'object' && f.id != null ? 't:' + f.id : 'i:' + i;
  };
  const idKey = (x, i) => (x && x.id != null ? 'id:' + x.id : 'i:' + i);

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

  function mergeFields(B, T, M, sub) {
    if (!isObj(B) || !isObj(T) || !isObj(M)) return { value: T, conflict: true };
    const out = {};
    let conflict = false;
    for (const k of new Set([...Object.keys(B), ...Object.keys(T), ...Object.keys(M)])) {
      const bs = stable(B[k]), ts = stable(T[k]), ms = stable(M[k]);
      let v;
      if (ts === bs) v = M[k];
      else if (ms === bs || ms === ts) v = T[k];
      else if (sub && sub[k] && B[k] !== undefined && T[k] !== undefined && M[k] !== undefined) {
        const r = sub[k](B[k], T[k], M[k]);
        v = r.value;
        if (r.conflict) conflict = true;
      } else { v = T[k]; conflict = true; }
      if (v !== undefined) out[k] = v;
    }
    return { value: out, conflict };
  }

  const listMerge = (b, t, m) => mergeKeyed(Array.isArray(b) ? b : [], Array.isArray(t) ? t : [], Array.isArray(m) ? m : [], idKey);

  function mergeObject(B, T, M) {
    const r = mergeFields(B, T, M, {
      entity: (b, t, m) => mergeFields(b, t, m),
      sprite: (b, t, m) => mergeFields(b, t, m, { pictures: listMerge, sounds: listMerge }),
    });
    const o = r.value;
    if (o && o.sprite && Array.isArray(o.sprite.pictures)) {
      // 남은 모양이 모두 지워졌으면(둘이 서로 다른 마지막 모양을 지움) 먼저 들어온 쪽 모양을 남긴다 — 모양 없는 오브젝트는 엔트리가 내보내지 못한다
      if (o.objectType !== 'textBox' && !o.sprite.pictures.length && T.sprite && Array.isArray(T.sprite.pictures) && T.sprite.pictures.length) {
        o.sprite = { ...o.sprite, pictures: T.sprite.pictures };
        r.conflict = true;
      }
      const pics = o.sprite.pictures;
      if (o.selectedPictureId != null && pics.length && !pics.some(p => p && p.id === o.selectedPictureId)) o.selectedPictureId = pics[0].id;
    }
    return r;
  }

  function blockIdCounts(threads) {
    const counts = new Map();
    const walk = v => {
      if (Array.isArray(v)) { for (const x of v) walk(x); return; }
      if (!v || typeof v !== 'object') return;
      if (v.id != null && v.type != null) counts.set(v.id, (counts.get(v.id) || 0) + 1);
      for (const k of Object.keys(v)) { const x = v[k]; if (x && typeof x === 'object') walk(x); }
    };
    walk(threads);
    return counts;
  }
  // 원래부터 겹치던 id(엔트리가 드물게 만듦)는 따지지 않고, 합치면서 새로 겹친 것만 본다
  function makesDuplicateBlocks(result, T, M) {
    const cr = blockIdCounts(result), ct = blockIdCounts(T), cm = blockIdCounts(M);
    for (const [id, n] of cr) if (n > 1 && n > Math.max(ct.get(id) || 0, cm.get(id) || 0)) return true;
    return false;
  }

  function mergeUnit(key, b, t, m) {
    b = b == null ? null : b; t = t == null ? null : t; m = m == null ? null : m;
    if (t === b) return { value: m, conflict: false };
    if (m === b || m === t) return { value: t, conflict: false };
    if (b !== null && t !== null && m !== null) {
      try {
        const B = JSON.parse(b), T = JSON.parse(t), M = JSON.parse(m);
        let r = null;
        if (key.startsWith('code:')) {
          r = mergeKeyed(B, T, M, threadKey);
          // 묶음을 나누거나 붙이는 동안 상대가 같은 묶음을 고치면 블록이 두 묶음에 다 남는다 — 그러면 이 오브젝트는 먼저 들어온 쪽으로
          if (makesDuplicateBlocks(r.value, T, M)) return { value: t, conflict: true };
        } else if (key.startsWith('obj:')) r = mergeObject(B, T, M);
        else if (key === 'meta') r = mergeFields(B, T, M);
        else if (key.endsWith('Order')) r = mergeOrder(B, T, M);
        if (r) return { value: stable(r.value), conflict: r.conflict };
      } catch (e) { /* 아래: 먼저 들어온 쪽을 남김 */ }
    }
    return { value: t, conflict: true };
  }

  // ── 합친 뒤 작품이 엔트리에서 열리도록 맞추기(방 상태 전체 기준) ──
  // state: Map(key → string|null). 바꾼 키와 값을 돌려준다.
  function normalize(state) {
    const changed = new Map();
    const get = k => { const v = state.get(k); return v == null ? null : v; };
    const set = (k, v) => { if (get(k) !== v) { state.set(k, v); changed.set(k, v); } };
    const idsOf = pre => {
      const out = [];
      for (const [k, v] of state) if (v != null && k.startsWith(pre + ':')) out.push(k.slice(pre.length + 1));
      return out.sort();
    };
    const fixOrder = (orderKey, pre) => {
      const exist = new Set(idsOf(pre));
      let list = [];
      try { list = JSON.parse(get(orderKey) || '[]'); } catch { list = []; }
      const seen = new Set();
      const res = [];
      for (const id of Array.isArray(list) ? list : []) if (exist.has(id) && !seen.has(id)) { res.push(id); seen.add(id); }
      for (const id of exist) if (!seen.has(id)) res.push(id);
      set(orderKey, stable(res));
      return res;
    };

    const scenes = fixOrder('sceneOrder', 'scene');
    const sceneSet = new Set(scenes);
    const objIds = new Set(idsOf('obj'));
    for (const id of objIds) {
      const s = get('obj:' + id);
      let o;
      try { o = JSON.parse(s); } catch { continue; }
      if (scenes.length && !sceneSet.has(o.scene)) set('obj:' + id, stable({ ...o, scene: scenes[0] }));
      if (get('code:' + id) === null) set('code:' + id, '[]');
    }
    for (const id of idsOf('code')) if (!objIds.has(id)) set('code:' + id, null);
    for (const id of idsOf('var')) {
      let v;
      try { v = JSON.parse(get('var:' + id)); } catch { continue; }
      if (v && v.object && !objIds.has(String(v.object))) set('var:' + id, null);
    }
    for (const [, pre, orderKey] of LISTS) if (pre !== 'scene') fixOrder(orderKey, pre);
    return changed;
  }

  return {
    LISTS, stable, projectToUnits, unitsToProject, mergeUnit, mergeKeyed, mergeOrder, mergeFields, mergeObject,
    normalize, canonThreads, decanonThreads, threadKey, objectUnits, globalUnits, funcUnit, decanonFunc, codeUnit,
  };
});

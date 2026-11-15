// 방장(Server)이 모든 변경에 차례를 매기고, 참가자(Client)는 자기 편집기와 방 상태를 맞춘다.
// 통신·엔트리와 떨어져 있어(보내기 함수와 adapter만 받음) node 시험에서 여러 명을 흉내 낼 수 있다.
(function (root, factory) {
  const isNode = typeof window === 'undefined' && typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./merge.js') : root.ErcMerge);
  if (isNode) module.exports = api;
  else root.ErcSync = api;
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';

  // 조각 모양이 바뀌면 올린다(서로 다른 판끼리 섞이면 계속 다르게 보임). 켠 사람의 옛 판이 저장 모양 방에 들어오면 작품을 끊으므로 그때도 올린다
  const PROTOCOL = 4;
  // 받아 줄 수 있는 가장 옛 규칙. 3과 4의 차이는 엔트리루트 블록·저장 모양이 든 작품에서만 생기므로 그런 작품이 아니면 3도 함께 고친다
  const MIN_PROTOCOL = 3;
  const EDIT_FORM_PIECE = /^(func|obj|var|msg):ers0/;
  const ENTRYROOT_PIECE = /^[a-z]+:ers0|^var:erinfo$/i;
  const hasEntryRoot = units => [...(units instanceof Map ? units.keys() : Object.keys(units || {}))].some(k => ENTRYROOT_PIECE.test(k));
  // 들어오려는 사람의 규칙으로 이 방 작품을 함께 고쳐도 되는지. 안 되면 까닭을 돌려준다
  function joinBlock(v, units) {
    if (v === PROTOCOL) return null;
    if (typeof v !== 'number' || v < MIN_PROTOCOL || v > PROTOCOL) return 'version';
    return hasEntryRoot(units) ? 'version-entryroot' : null;
  }
  const COLORS =['#e5484d', '#2e6ff2', '#30a46c', '#f5a524', '#8e4ec6', '#0091ff', '#e93d82', '#12a594', '#d6409f', '#3e63dd'];
  const nn = v => (v === undefined ? null : v);

  class Server {
    // send(clientId, msg) — 한 사람에게, broadcast(msg) — 모두에게
    constructor(units, { send, broadcast, maxMembers = 8, app = null, onRefused = null }) {
      this.app = app;
      this.onRefused = onRefused;
      this.state = new Map(Object.entries(units));
      M.normalize(this.state);
      this.seq = 0;
      this.send = send;
      this.broadcast = broadcast;
      this.maxMembers = maxMembers;
      this.members = new Map();
      this.colorIdx = 0;
      // 다시 연결한 참가자가 "답을 못 받은 편집"을 또 보내지 않도록 마지막으로 처리한 편집 번호를 기억한다
      this.lastPid = new Map();
    }

    snapshot() {
      const o = {};
      for (const [k, v] of this.state) if (v != null) o[k] = v;
      return o;
    }

    memberList() {
      return [...this.members.values()].map(m => ({ id: m.id, name: m.name, color: m.color, host: !!m.host, where: m.where || null }));
    }

    onMessage(cid, msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'hello') return this.onHello(cid, msg);
      if (!this.members.has(cid)) return;
      if (msg.t === 'put') return this.onPut(cid, msg);
      if (msg.t === 'where') {
        const m = this.members.get(cid);
        m.where = msg.where && typeof msg.where === 'object' ? msg.where : null;
        this.broadcast({ t: 'mem', members: this.memberList() });
      }
    }

    onHello(cid, msg) {
      const block = joinBlock(msg.v, this.state);
      if (block) {
        this.send(cid, { t: 'refuse', why: block, v: PROTOCOL, min: MIN_PROTOCOL, app: this.app });
        if (this.onRefused) this.onRefused({ name: String(msg.name || '참가자').slice(0, 20), v: msg.v, app: msg.app || null, why: block });
        return;
      }
      if (!this.members.has(cid) && this.members.size >= this.maxMembers) { this.send(cid, { t: 'refuse', why: 'full' }); return; }
      const prev = this.members.get(cid);
      const name = String(msg.name || '참가자').slice(0, 20);
      this.members.set(cid, { id: cid, name, color: prev ? prev.color : COLORS[this.colorIdx++ % COLORS.length], host: !!msg.host, where: prev ? prev.where : null });
      this.send(cid, { t: 'welcome', v: PROTOCOL, you: cid, seq: this.seq, units: this.snapshot(), lastPid: this.lastPid.has(cid) ? this.lastPid.get(cid) : null });
      this.broadcast({ t: 'mem', members: this.memberList() });
    }

    // 오브젝트 지우기는 속성·코드·지역 변수를 한 덩어리로 다룬다. 그 사이 누가 그중 하나라도 고쳤으면(또는 지역 변수를 더했으면)
    // 지우기를 통째로 거절한다 — 조각마다 따로 합치면 오브젝트는 남고 코드만 지워지는 식의 반쪽 결과가 난다.
    rejectedDeletions(ch) {
      const rejected = new Map();
      const varObject = s => { try { const v = JSON.parse(s); return v && v.object != null ? String(v.object) : null; } catch { return null; } };
      // 엔트리는 오브젝트를 지워도 지역 리스트는 남겨서 지운 사람의 변경에 없다 — "그사이 더해진 것"으로 세면 지우기가 늘 거절된다
      const localVarOf = s => { try { const v = JSON.parse(s); return v && v.object != null && v.variableType !== 'list' ? String(v.object) : null; } catch { return null; } };
      for (const k of Object.keys(ch)) {
        if (!k.startsWith('obj:')) continue;
        const c = ch[k] || {};
        if (nn(c.m) !== null || nn(c.b) === null) continue;
        const id = k.slice(4);
        const group = new Set(['obj:' + id, 'code:' + id]);
        for (const [vk, v] of this.state) if (vk.startsWith('var:') && v != null && localVarOf(v) === id) group.add(vk);
        for (const vk of Object.keys(ch)) if (vk.startsWith('var:') && ch[vk] && ch[vk].b != null && varObject(ch[vk].b) === id) group.add(vk);
        const touched = [...group].some(g => (g in ch ? nn(this.state.get(g)) !== nn((ch[g] || {}).b) : this.state.get(g) != null));
        if (touched) rejected.set(id, [...group].filter(g => g in ch));
      }
      return rejected;
    }

    onPut(cid, msg) {
      const ch = msg.ch && typeof msg.ch === 'object' ? msg.ch : {};
      const out = {};
      const conflicts = [];
      const before = new Map(this.state);
      const rejected = this.rejectedDeletions(ch);
      const keep = new Set();
      for (const [id, keys] of rejected) { keys.forEach(k => keep.add(k)); conflicts.push('obj:' + id); }
      for (const k of Object.keys(ch)) {
        if (keep.has(k)) { out[k] = nn(this.state.get(k)); continue; }
        const c = ch[k] || {};
        const r = M.mergeUnit(k, nn(c.b), nn(this.state.get(k)), nn(c.m));
        if (r.conflict && !conflicts.includes(k)) conflicts.push(k);
        this.state.set(k, r.value);
        out[k] = r.value;
      }
      // 거절한 오브젝트·지역 변수가 순서 목록에서 빠졌으면 원래 자리에 되돌린다(정리 단계는 맨 뒤에 붙이므로)
      if (rejected.size) {
        const ids = { objOrder: [...rejected.keys()], varOrder: [...keep].filter(k => k.startsWith('var:')).map(k => k.slice(4)) };
        for (const [orderKey, list] of Object.entries(ids)) {
          if (!list.length) continue;
          const now = JSON.parse(nn(this.state.get(orderKey)) || '[]');
          const old = JSON.parse(nn(before.get(orderKey)) || '[]');
          let changed = false;
          for (const id of list) {
            if (now.includes(id)) continue;
            let j = old.indexOf(id) - 1;
            while (j >= 0 && !now.includes(old[j])) j--;
            now.splice(j < 0 ? 0 : now.indexOf(old[j]) + 1, 0, id);
            changed = true;
          }
          if (changed) { const v = M.stable(now); this.state.set(orderKey, v); out[orderKey] = v; }
        }
      }
      const added = Object.keys(ch).filter(k => nn((ch[k] || {}).b) === null);
      for (const [k, v] of M.normalize(this.state, added)) out[k] = v;
      for (const [k, v] of this.state) if (v == null) this.state.delete(k);
      if (msg.pid != null) this.lastPid.set(cid, msg.pid);
      this.seq++;
      this.broadcast({ t: 'upd', seq: this.seq, by: cid, pid: msg.pid, v: out, cf: conflicts });
    }

    leave(cid) {
      if (!this.members.delete(cid)) return;
      this.broadcast({ t: 'mem', members: this.memberList() });
    }
  }

  const LOST = '\u0000lost';

  class Client {
    // adapter: exportUnits() → {key: string} | null(지금은 읽으면 안 됨)
    //          isSafe(toApply, current) → bool, loadAll(units)
    //          apply(toApply, current, prevOf, rebase) → 통째로 다시 불러왔으면 true(동기). prevOf(key)는 그 조각의 방 직전 값,
    //            rebase(fresh, partly)는 덮어쓰기 직전에 다시 읽은 조각을 받는다(못 읽었으면 null, partly: toApply 일부가 이미 들어간 뒤)
    //          cleanLocal(key, base, mine) → 보낼 값(있으면; 화면 사정으로만 생긴 차이를 base 쪽으로 되돌림)
    //          isHoldingSaved() → 켠 사람 화면이 방 작품을 변환 없이 받은 모양 그대로 들고 있는지(없어도 됨)
    // hooks: onConflict(keys), onChange(), onGap(), onApplyError(err), onSuspicious(info), onMixedForm(keys)
    // 브라우저의 setTimeout은 window 말고 다른 this로 부르면 Illegal invocation이라 감싸서 쓴다
    constructor({ adapter, send, hooks = {}, timers = { set: (f, ms) => setTimeout(f, ms), clear: t => clearTimeout(t) }, id = 'c' }) {
      this.adapter = adapter;
      this.sendMsg = send;
      this.hooks = hooks;
      this.timers = timers;
      this.idPrefix = id;
      this.base = new Map();
      this.seen = new Map();
      this.server = new Map();
      this.inflight = null;
      this.seq = 0;
      this.pidN = 0;
      this.ready = false;
      this.paused = false;
      this.retryT = null;
      this.reconciling = false;
    }

    // 방장 자신: 지금 편집기 내용이 곧 방 상태
    startAsHost(units) {
      for (const [k, v] of Object.entries(units)) { this.base.set(k, v); this.seen.set(k, v); this.server.set(k, v); }
      this.ready = true;
    }

    // welcome: fresh면 내 편집기를 방 작품으로 통째로 바꾼다. 아니면(다시 연결) 못 보낸 편집을 살려서 합친다.
    onWelcome(msg, { fresh }) {
      this.seq = msg.seq;
      const units = msg.units || {};
      if (fresh) {
        this.base.clear(); this.seen.clear(); this.server.clear(); this.inflight = null;
        this.adapter.loadAll(units, { fresh: true });
        const E = this.adapter.exportUnits() || {};
        for (const [k, v] of Object.entries(units)) { this.base.set(k, v); this.server.set(k, v); }
        for (const k of new Set([...Object.keys(units), ...Object.keys(E)])) this.seen.set(k, nn(E[k]));
        // 내 화면에서 다르게 보이는 부분(글꼴 폭 등)은 내가 고친 것이 아니므로 그대로 둔다
      } else {
        // 답을 못 받은 편집: 방장이 이미 처리했으면 다시 보내지 않는다(그 사이 남이 지운 것을 되살리지 않게)
        if (this.inflight && msg.lastPid !== this.inflight.pid) {
          for (const [k, b] of this.inflight.bases) { this.base.set(k, b); this.seen.set(k, LOST); }
        }
        this.inflight = null;
        const keys = new Set([...this.server.keys(), ...Object.keys(units)]);
        for (const k of keys) this.server.set(k, nn(units[k]));
      }
      this.ready = true;
      this.resyncing = false;
      this.reconcile();
    }

    dirtyKeys(E) {
      const out = [];
      for (const k of new Set([...this.seen.keys(), ...Object.keys(E)])) if (nn(E[k]) !== nn(this.seen.get(k))) out.push(k);
      return out;
    }

    // 내 편집을 찾아 방장에게 보낸다(한 번에 하나만 보내고 답을 기다림)
    flush() {
      if (!this.ready || this.paused || this.inflight || this.reconciling) return false;
      const E = this.adapter.exportUnits();
      if (!E) return false;
      const keys = this.dirtyKeys(E);
      if (!keys.length) return false;
      // 켠 사람 화면이 받은 모양 그대로인데 플러그인 조각이 새로 생기면(플러그인 블록을 처음 씀) 한 작품에 두 모양이 생긴다 — 보내기 전에 멈춘다
      if (this.adapter.isHoldingSaved && this.adapter.isHoldingSaved()) {
        const added = keys.filter(k => EDIT_FORM_PIECE.test(k) && E[k] != null && nn(this.server.get(k)) === null);
        if (added.length) {
          this.paused = true;
          if (this.hooks.onMixedForm) this.hooks.onMixedForm(added);
          return false;
        }
      }
      // 오브젝트가 모두, 또는 한 번에 3개 이상·절반 넘게 사라졌으면 편집기 오류일 수 있어 묻기 전엔 보내지 않는다
      if (!this.allowMassDeleteOnce) {
        const count = s => { try { const a = JSON.parse(s); return Array.isArray(a) ? a.length : 0; } catch { return 0; } };
        const total = count(nn(this.server.get('objOrder')));
        const gone = keys.filter(k => k.startsWith('obj:') && E[k] == null && this.base.get(k) != null).length;
        if (total > 0 && (count(nn(E.objOrder)) === 0 || (gone >= 3 && gone * 2 >= total))) {
          this.paused = true;
          if (this.hooks.onSuspicious) this.hooks.onSuspicious({ gone, total });
          return false;
        }
        // 한 오브젝트의 블록 묶음(2개 이상)이 한 번에 모두 사라져도 묻는다 — 엔트리파이선 글을 블록으로 못 바꾸면 엔트리가 그 오브젝트 블록을 비운다
        const wiped = keys.filter(k => k.startsWith('code:') && E[k] != null && count(nn(this.base.get(k))) >= 2 && count(E[k]) === 0);
        if (wiped.length) {
          this.paused = true;
          if (this.hooks.onSuspicious) this.hooks.onSuspicious({ wiped });
          return false;
        }
      }
      this.allowMassDeleteOnce = false;
      const ch = {};
      const bases = new Map();
      for (const k of keys) {
        const b = nn(this.base.get(k));
        // 내 화면에서만 다르게 그려진 몫(편집기가 명령 없이 적는 값)은 방에서 받은 값으로 되돌려 보낸다. 그것만 달랐으면 보내지 않는다
        const m = this.adapter.cleanLocal && b != null && E[k] != null ? this.adapter.cleanLocal(k, b, E[k]) : nn(E[k]);
        this.seen.set(k, nn(E[k]));
        if (m === b) continue;
        ch[k] = { b, m };
        bases.set(k, b);
        this.base.set(k, m);
      }
      if (!bases.size) return false;
      const pid = this.idPrefix + ':' + (++this.pidN);
      this.inflight = { pid, keys: new Set(bases.keys()), bases };
      this.sendMsg({ t: 'put', pid, ch });
      if (this.hooks.onChange) this.hooks.onChange();
      return true;
    }

    onUpd(msg) {
      if (this.resyncing) return;
      if (msg.seq !== this.seq + 1) {
        this.resyncing = true;
        if (this.hooks.onGap) this.hooks.onGap();
        return;
      }
      this.seq = msg.seq;
      for (const [k, v] of Object.entries(msg.v || {})) this.server.set(k, nn(v));
      if (this.inflight && msg.pid === this.inflight.pid) {
        this.inflight = null;
        if (msg.cf && msg.cf.length && this.hooks.onConflict) this.hooks.onConflict(msg.cf);
      }
      this.reconcile();
    }

    behindKeys() {
      const out = [];
      for (const k of new Set([...this.server.keys(), ...this.base.keys()])) {
        if (nn(this.server.get(k)) !== nn(this.base.get(k))) out.push(k);
      }
      return out;
    }

    // 방에 새로 들어온 내용 중, 내가 손대지 않은 부분만 내 편집기에 넣는다
    reconcile() {
      if (!this.ready || this.paused || this.reconciling) return;
      if (this.retryT) { this.timers.clear(this.retryT); this.retryT = null; }
      const behind = this.behindKeys().filter(k => !(this.inflight && this.inflight.keys.has(k)));
      if (behind.length) {
        let E = this.adapter.exportUnits();
        if (!E) return this.retryLater();
        const toApply = {};
        let n = 0;
        for (const k of behind) {
          if (nn(E[k]) !== nn(this.seen.get(k))) continue;
          toApply[k] = nn(this.server.get(k));
          n++;
        }
        if (n) {
          if (!this.adapter.isSafe(toApply, E)) {
            this.retryLater();
            this.flush();
            if (this.hooks.onChange) this.hooks.onChange();
            return;
          }
          this.reconciling = true;
          let full = false;
          // 지금까지 몰랐던 변경도 내 편집으로 다뤄야 덮이지 않고 아래 flush가 방으로 보낸다 — 같은 조각에 온 값은 방장이 합친 뒤 다시 받는다
          const rebase = (fresh, partly) => {
            if (fresh) E = fresh; else this.retryLater();
            if (!partly) for (const k of Object.keys(toApply)) if (!fresh || nn(fresh[k]) !== nn(this.seen.get(k))) delete toApply[k];
          };
          try {
            full = !!this.adapter.apply(toApply, E, k => nn(this.base.get(k)), rebase);
          } catch (err) {
            // 내 화면이 반쯤 불러온 상태일 수 있다 — 그걸 "내 편집"으로 보내면 방 작품이 지워지므로 멈추고 알린다
            this.paused = true;
            if (this.hooks.onApplyError) this.hooks.onApplyError(err);
            return;
          } finally { this.reconciling = false; }
          const E2 = this.adapter.exportUnits() || E;
          for (const k of Object.keys(toApply)) { this.base.set(k, toApply[k]); this.seen.set(k, nn(E2[k])); }
          if (full) {
            // 아직 안 보낸 내 편집이 통째로 다시 불러오는 동안 없어졌으면(남이 그 오브젝트를 지움) 알린다 — 다음에 보내는 값은 방과 같아져 방장도 충돌로 못 본다
            const dropped = [];
            for (const k of new Set([...this.seen.keys(), ...Object.keys(E), ...Object.keys(E2)])) {
              if (k in toApply) continue;
              if (nn(E[k]) === nn(this.seen.get(k))) this.seen.set(k, nn(E2[k]));
              else if (nn(E[k]) !== null && nn(E2[k]) === null) dropped.push(k);
            }
            if (dropped.length && this.hooks.onConflict) this.hooks.onConflict(dropped);
          }
        }
      }
      this.flush();
      if (this.hooks.onChange) this.hooks.onChange();
    }

    // 멈춘 뒤 사용자가 "이대로 보내기"를 고른 경우
    resume({ allowMassDelete = false } = {}) {
      this.paused = false;
      this.allowMassDeleteOnce = !!allowMassDelete;
      this.reconcile();
    }

    retryLater(ms = 250) {
      if (this.retryT) return;
      this.retryT = this.timers.set(() => { this.retryT = null; this.reconcile(); }, ms);
    }

    // 화면에 보이는 상태 요약(대기 중인 변경 수 등)
    status() {
      const behind = this.behindKeys().filter(k => !(this.inflight && this.inflight.keys.has(k)));
      return { ready: this.ready, sending: !!this.inflight, waiting: behind.length, seq: this.seq, paused: this.paused };
    }

    // 방장 상태로 내 편집기를 통째로 되돌린다(다른 작품을 불러왔을 때)
    resetToServer() {
      const units = {};
      for (const [k, v] of this.server) if (v != null) units[k] = v;
      this.adapter.loadAll(units);
      const E = this.adapter.exportUnits() || {};
      this.base = new Map(this.server);
      this.seen.clear();
      for (const k of new Set([...this.server.keys(), ...Object.keys(E)])) this.seen.set(k, nn(E[k]));
      this.inflight = null;
      this.paused = false;
    }
  }

  // 참가자 페이지가 새로 열렸을 때(엔트리가 저장한 작품 주소로 옮김, 새로고침) 같은 방에 다시 들어갈지.
  // 방금 저장한 그 작품(오브젝트가 방 작품과 같음)이나 빈 새 작품일 때만 — 다른 작품을 열었으면 그 작품을 방 작품으로 바꾸지 않는다
  const REJOIN_MS = 90000;
  // 엔트리루트 시스템 오브젝트는 같은 작품이라도 켠 화면에서 되살릴 때 바뀌므로 사람이 만든 오브젝트만 비교한다
  const SYSTEM_OBJ = /^ers0o/;
  function rejoinTarget(mark, { path, objIds, isDefault, now }) {
    if (!mark || typeof mark !== 'object' || typeof mark.code !== 'string' || typeof mark.cid !== 'string') return null;
    if (!(now >= mark.at && now - mark.at < REJOIN_MS)) return null;
    if (!/^\/ws\/[^/]+$/.test(path || '')) return null;
    const people = a => (Array.isArray(a) ? a.map(String).filter(id => !SYSTEM_OBJ.test(id)).sort().join('\n') : '');
    const roomObjs = people(mark.objs);
    const same = roomObjs !== '' && roomObjs === people(objIds);
    if (!same && !(path === '/ws/new' && isDefault)) return null;
    return { code: mark.code, name: String(mark.name || ''), cid: mark.cid };
  }

  return { PROTOCOL, MIN_PROTOCOL, joinBlock, hasEntryRoot, Server, Client, COLORS, rejoinTarget, REJOIN_MS };
});

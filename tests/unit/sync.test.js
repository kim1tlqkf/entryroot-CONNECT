// 방장 + 여러 참가자를 엔트리 없이 흉내 내서, 메시지가 늦게·뒤섞여 와도(링크마다 순서는 유지) 모두 같은 작품에 도착하는지 본다.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../src/merge.js');
const { Server, Client, PROTOCOL, rejoinTarget } = require('../../src/sync.js');

const S = M.stable;
function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clone = v => JSON.parse(JSON.stringify(v));

// 글꼴 폭처럼 사람마다 다르게 계산되는 값을 흉내 낸다(내보낼 때 entity.width가 사람마다 다름)
function noisy(i, k, v) {
  if (v == null || !k.startsWith('obj:')) return v;
  const o = JSON.parse(v);
  if (o.entity) o.entity.width = 37 + i / 10;
  return S(o);
}
const stripNoise = units => {
  const o = {};
  for (const [k, v] of Object.entries(units)) {
    if (v == null) continue;
    if (k.startsWith('obj:')) { const x = JSON.parse(v); if (x.entity) delete x.entity.width; o[k] = S(x); } else o[k] = v;
  }
  return o;
};

// 엔트리처럼 편집기는 "작품" 하나를 들고 있고, 내보내기는 그 작품에서 조각을 새로 만든다(순서 목록과 오브젝트가 늘 맞음)
const project = units => M.projectToUnits(M.unitsToProject(units));
class FakeEditor {
  constructor(i, r) { this.i = i; this.r = r; this._u = {}; this.busy = false; this.unsafe = false; this.applied = 0; }
  get units() { return this._u; }
  set units(u) { this._u = project(u); }
  exportUnits() {
    if (this.busy) return null;
    this._u = project(this._u);
    const o = {};
    for (const [k, v] of Object.entries(this._u)) o[k] = noisy(this.i, k, v);
    return o;
  }
  isSafe() { return !this.unsafe; }
  apply(toApply) {
    this.applied++;
    const u = { ...this._u };
    for (const [k, v] of Object.entries(toApply)) { if (v == null) delete u[k]; else u[k] = v; }
    this.units = u;
    return Object.keys(toApply).some(k => !k.startsWith('code:') && !k.startsWith('obj:'));
  }
  loadAll(units) { this.units = { ...units }; }
}

function initialUnits() {
  const p = {
    objects: [
      { id: 'o1', name: '고양이', script: JSON.stringify([[{ id: 'a', type: 'when_run_button_click', x: 0, y: 0 }, { id: 'a1', type: 'move_x' }]]), objectType: 'sprite', scene: 's1', sprite: { pictures: [{ id: 'p1' }], sounds: [] }, selectedPictureId: 'p1', entity: { x: 0, y: 0, width: 10 } },
      { id: 'o2', name: '배경', script: '[]', objectType: 'sprite', scene: 's1', sprite: { pictures: [{ id: 'p2' }], sounds: [] }, selectedPictureId: 'p2', entity: { x: 0, y: 0, width: 10 } },
    ],
    scenes: [{ id: 's1', name: '장면 1' }], variables: [], messages: [], functions: [], tables: [], speed: 60,
  };
  return M.projectToUnits(p);
}

function makeRoom(n, seed, { timers } = {}) {
  const r = rng(seed);
  const toServer = new Map(), toClient = new Map();
  const editors = [], clients = [], joined = [], connected = [];
  let msgCount = 0, massAsks = 0;
  const fakeTimers = { set: () => 0, clear: () => {} };
  const server = new Server(initialUnits(), {
    send: (cid, msg) => { if (connected[cid]) { toClient.get(cid).push(clone(msg)); msgCount++; } },
    broadcast: msg => { for (const cid of server.members.keys()) if (connected[cid]) { toClient.get(cid).push(clone(msg)); msgCount++; } },
  });
  const conflicts = [];
  for (let i = 0; i < n; i++) {
    toServer.set(i, []); toClient.set(i, []);
    const ed = new FakeEditor(i, r);
    editors.push(ed);
    connected[i] = true;
    clients.push(new Client({
      adapter: ed, id: 'c' + i, timers: timers || fakeTimers,
      send: msg => { if (connected[i]) { toServer.get(i).push(clone(msg)); msgCount++; } },
      // 여러 오브젝트를 한꺼번에 지워 멈춘 경우는 아래 resumePaused에서 사람이 "방에도 지우기"를 고른 것으로 친다
      hooks: { onConflict: keys => conflicts.push([i, keys]), onGap: () => hello(i), onSuspicious: () => { massAsks++; } },
    }));
  }
  // 방장(0)은 자기 편집기가 곧 방 상태
  editors[0].units = { ...server.snapshot() };
  clients[0].startAsHost(editors[0].exportUnits());
  function hello(i) { toServer.get(i).push({ t: 'hello', v: PROTOCOL, name: 'p' + i, host: i === 0 }); }
  for (let i = 0; i < n; i++) hello(i);

  function deliverOne() {
    const queues = [];
    for (const [i, q] of toServer) if (q.length) queues.push(['s', i, q]);
    for (const [i, q] of toClient) if (q.length) queues.push(['c', i, q]);
    if (!queues.length) return false;
    const [dir, i, q] = queues[Math.floor(r() * queues.length)];
    const msg = q.shift();
    if (dir === 's') server.onMessage(i, msg);
    else if (msg.t === 'welcome') { clients[i].onWelcome(msg, { fresh: !joined[i] && i !== 0 }); joined[i] = true; }
    else if (msg.t === 'upd') clients[i].onUpd(msg);
    return true;
  }
  function disconnect(i) {
    connected[i] = false;
    toServer.get(i).length = 0; toClient.get(i).length = 0;
    server.leave(i);
  }
  function reconnect(i) { connected[i] = true; hello(i); }
  const resumePaused = () => { for (const c of clients) if (c.paused) c.resume({ allowMassDelete: true }); };
  return { r, server, editors, clients, deliverOne, disconnect, reconnect, connected, conflicts, resumePaused, msgs: () => msgCount, massAsks: () => massAsks };
}

function randomEdit(room, i, nextId) {
  const { r, editors, clients } = room;
  const u = { ...editors[i].units };
  editRandomly(u, r, nextId);
  editors[i].units = u;
  clients[i].reconcile();
}

function editRandomly(u, r, nextId) {
  const objIds = JSON.parse(u.objOrder || '[]');
  const pick = arr => arr[Math.floor(r() * arr.length)];
  const roll = r();
  if (!objIds.length || roll < 0.08) {
    const id = 'n' + nextId();
    u['obj:' + id] = S({ id, name: id, objectType: 'sprite', scene: 's1', sprite: { pictures: [{ id: 'pp' + id }], sounds: [] }, selectedPictureId: 'pp' + id, entity: { x: 0, y: 0, width: 10 } });
    u['code:' + id] = '[]';
    u.objOrder = S([...objIds, id]);
  } else if (roll < 0.12 && objIds.length > 1) {
    const id = pick(objIds);
    delete u['obj:' + id]; delete u['code:' + id];
    u.objOrder = S(objIds.filter(x => x !== id));
  } else if (roll < 0.3) {
    const id = pick(objIds);
    const o = JSON.parse(u['obj:' + id]);
    if (r() < 0.5) o.entity.x = Math.round(r() * 400); else o.name = 'nm' + nextId();
    u['obj:' + id] = S(o);
  } else {
    const id = pick(objIds);
    const code = JSON.parse(u['code:' + id] || '[]');
    const op = r();
    const long = code.filter(th => th.length >= 3);
    if (!code.length || op < 0.25) code.push([{ id: 'th' + nextId(), type: 'when_run_button_click', x: Math.round(r() * 300), y: 0 }]);
    else if (op < 0.55) pick(code).push({ id: 'b' + nextId(), type: 'move_x' });
    else if (op < 0.65) code.splice(Math.floor(r() * code.length), 1);
    else if (op < 0.75 && long.length) {
      // 묶음 나누기: 가운데 블록을 끌어내 새 묶음으로(그 블록이 새 묶음의 첫 블록)
      const th = pick(long);
      const k = 1 + Math.floor(r() * (th.length - 1));
      const tail = th.splice(k);
      code.push([{ ...tail[0], x: Math.round(r() * 300), y: 200 }, ...tail.slice(1)]);
    } else if (op < 0.85 && code.length >= 2) {
      // 묶음 붙이기: 한 묶음을 다른 묶음 끝에 붙임
      const from = Math.floor(r() * code.length);
      const [moved] = code.splice(from, 1);
      pick(code).push(...moved.map(({ x, y, ...rest }) => rest));
    } else { const th = pick(code); th[0] = { ...th[0], x: Math.round(r() * 300) }; }
    u['code:' + id] = S(code);
  }
}

function settle(room) {
  const { editors, clients, deliverOne } = room;
  for (const e of editors) { e.busy = false; e.unsafe = false; }
  for (let round = 0; round < 200; round++) {
    let moved = false;
    while (deliverOne()) moved = true;
    room.resumePaused();
    for (const c of clients) c.reconcile();
    if (deliverOne()) moved = true;
    if (!moved) return round;
  }
  throw new Error('멈추지 않음(서로 계속 보냄)');
}

function assertConverged(room) {
  const snap = stripNoise(room.server.snapshot());
  room.editors.forEach((e, i) => {
    assert.deepEqual(stripNoise(e.units), snap, `참가자 ${i} 편집기가 방 상태와 다름`);
    const st = room.clients[i].status();
    assert.equal(st.waiting, 0, `참가자 ${i}에 반영 안 된 변경이 남음`);
    assert.equal(st.sending, false);
  });
}

test('동시에 다른 묶음을 고치면 모두에게 둘 다 반영', () => {
  const room = makeRoom(3, 1);
  settle(room);
  const [, A, B] = [0, 1, 2];
  const ua = room.editors[A].units, ub = room.editors[B].units;
  const ca = JSON.parse(ua['code:o1']); ca.push([{ id: 'fromA', type: 'when_run_button_click', x: 100, y: 0 }]); ua['code:o1'] = S(ca);
  const cb = JSON.parse(ub['code:o1']); cb[0].push({ id: 'fromB', type: 'move_y' }); ub['code:o1'] = S(cb);
  room.clients[A].reconcile(); room.clients[B].reconcile();
  settle(room);
  assertConverged(room);
  const code = room.server.snapshot()['code:o1'];
  assert.ok(code.includes('fromA') && code.includes('fromB'));
  assert.equal(room.conflicts.length, 0);
});

test('같은 묶음을 동시에 고치면 늦은 쪽에만 충돌을 알리고 모두 같은 결과', () => {
  const room = makeRoom(2, 2);
  settle(room);
  for (const [i, tag] of [[0, 'X'], [1, 'Y']]) {
    const u = room.editors[i].units; const c = JSON.parse(u['code:o1']); c[0].push({ id: 'blk' + tag, type: 'move_x' }); u['code:o1'] = S(c);
    room.clients[i].reconcile();
  }
  settle(room);
  assertConverged(room);
  assert.equal(room.conflicts.length, 1);
});

test('글꼴 폭 같은 사람마다 다른 값 때문에 서로 계속 보내지 않는다', () => {
  const room = makeRoom(3, 3);
  settle(room);
  const u = room.editors[1].units; const o = JSON.parse(u['obj:o2']); o.entity.x = 77; u['obj:o2'] = S(o);
  room.clients[1].reconcile();
  settle(room);
  const before = room.msgs();
  for (let k = 0; k < 5; k++) { for (const c of room.clients) c.reconcile(); settle(room); }
  assert.equal(room.msgs(), before, '편집이 없는데 메시지가 오감');
  assertConverged(room);
});

test('반영을 미루는 동안(끌기 중) 고친 것도 잃지 않는다', () => {
  const room = makeRoom(2, 4);
  settle(room);
  room.editors[1].unsafe = true;
  const u0 = room.editors[0].units; const c0 = JSON.parse(u0['code:o2']); c0.push([{ id: 'host1', type: 'when_run_button_click', x: 0, y: 0 }]); u0['code:o2'] = S(c0);
  room.clients[0].reconcile();
  while (room.deliverOne());
  const u1 = room.editors[1].units; const c1 = JSON.parse(u1['code:o2']); c1.push([{ id: 'guest1', type: 'when_run_button_click', x: 50, y: 0 }]); u1['code:o2'] = S(c1);
  room.clients[1].reconcile();
  settle(room);
  assertConverged(room);
  const code = room.server.snapshot()['code:o2'];
  assert.ok(code.includes('host1') && code.includes('guest1'));
});

test('안 보낸 편집이 있는 오브젝트를 남이 먼저 지우면, 편집이 사라졌다고 알린다', () => {
  const room = makeRoom(2, 8);
  settle(room);
  const u1 = room.editors[1].units; const c1 = JSON.parse(u1['code:o2']); c1.push([{ id: 'unsent', type: 'when_run_button_click', x: 0, y: 0 }]);
  room.editors[1].units = { ...u1, 'code:o2': S(c1) };
  const u0 = { ...room.editors[0].units }; delete u0['obj:o2']; delete u0['code:o2'];
  room.editors[0].units = u0;
  room.clients[0].reconcile();
  settle(room);
  assertConverged(room);
  assert.equal(room.server.snapshot()['obj:o2'], undefined);
  assert.deepEqual(room.conflicts.filter(([i]) => i === 1).flatMap(([, keys]) => keys), ['code:o2']);
});

// 실제 어댑터처럼 평소엔 캐시를 돌려주고, 통째로 다시 불러오기 직전에만 전부 다시 읽어 rebase로 넘긴다
function cacheEditor(ed) {
  const read = ed.exportUnits.bind(ed);
  let cache = read();
  ed.exportUnits = () => cache;
  ed.apply = (toApply, current, prevOf, rebase) => {
    cache = read();
    rebase(cache, false);
    if (!Object.keys(toApply).length) return false;
    const u = { ...ed.units };
    for (const [k, v] of Object.entries(toApply)) { if (v == null) delete u[k]; else u[k] = v; }
    ed.units = u;
    cache = read();
    return true;
  };
}
const addObjectOn = (room, i, id) => {
  const u = room.editors[i].units;
  room.editors[i].units = { ...u, ['obj:' + id]: S({ id, name: id, objectType: 'sprite', scene: 's1', sprite: { pictures: [{ id: 'p' + id }], sounds: [] }, selectedPictureId: 'p' + id, entity: { x: 0, y: 0, width: 10 } }), ['code:' + id]: '[]' };
  room.clients[i].reconcile();
};

test('명령 없이 바꾼 조각은 통째로 다시 불러와도 남고 방으로 간다', () => {
  const room = makeRoom(2, 21);
  settle(room);
  cacheEditor(room.editors[1]);
  room.editors[1].units = { ...room.editors[1].units, 'var:vTool': S({ id: 'vTool', name: '도구변수', value: '1' }) };
  addObjectOn(room, 0, 'o9');
  settle(room);
  assertConverged(room);
  const snap = room.server.snapshot();
  assert.ok(snap['var:vTool'] && snap['obj:o9']);
  assert.ok(room.editors[1].units['var:vTool']);
});

test('들어온 조각을 나도 명령 없이 고쳤으면 덮지 않고 방장이 합친다', () => {
  const room = makeRoom(2, 22);
  settle(room);
  cacheEditor(room.editors[1]);
  const edit = (i, f) => { const u = room.editors[i].units; const o = JSON.parse(u['obj:o2']); f(o); room.editors[i].units = { ...u, 'obj:o2': S(o) }; };
  edit(1, o => { o.name = '도구이름'; });
  edit(0, o => { o.entity.x = 77; });
  addObjectOn(room, 0, 'o9');
  settle(room);
  assertConverged(room);
  const o = JSON.parse(room.server.snapshot()['obj:o2']);
  assert.equal(o.name, '도구이름');
  assert.equal(o.entity.x, 77);
});

test('들어온 조각이 모두 내가 명령 없이 고친 것이면 불러오지 않고 내 편집만 보낸다', () => {
  const room = makeRoom(2, 23);
  settle(room);
  cacheEditor(room.editors[1]);
  const edit = (i, name) => { const u = room.editors[i].units; const o = JSON.parse(u['obj:o2']); o.name = name; room.editors[i].units = { ...u, 'obj:o2': S(o) }; };
  edit(1, '도구이름');
  edit(0, '방장이름');
  room.clients[0].reconcile();
  settle(room);
  assertConverged(room);
  assert.equal(JSON.parse(room.server.snapshot()['obj:o2']).name, '방장이름');
  assert.deepEqual(room.conflicts.filter(([i]) => i === 1).flatMap(([, keys]) => keys), ['obj:o2']);
});

test('한 오브젝트의 블록 묶음이 한 번에 모두 사라지면 보내기 전에 멈추고, 사람이 고르면 그때 보낸다', () => {
  const room = makeRoom(2, 9);
  settle(room);
  const u0 = room.editors[0].units; const c0 = JSON.parse(u0['code:o1']); c0.push([{ id: 'second', type: 'when_run_button_click', x: 0, y: 0 }]);
  room.editors[0].units = { ...u0, 'code:o1': S(c0) };
  room.clients[0].reconcile();
  settle(room);
  const threads = () => JSON.parse(room.server.snapshot()['code:o1']).length;
  assert.equal(threads(), 2);
  // 엔트리파이선 글을 블록으로 못 바꾸면 엔트리가 그 오브젝트 블록을 비우는 것과 같은 모양
  room.editors[1].units = { ...room.editors[1].units, 'code:o1': '[]' };
  room.clients[1].reconcile();
  while (room.deliverOne());
  assert.equal(room.clients[1].paused, true);
  assert.equal(room.massAsks(), 1);
  assert.equal(threads(), 2, '묻기 전에는 방 작품이 그대로');
  room.clients[1].resume({ allowMassDelete: true });
  while (room.deliverOne());
  assert.equal(threads(), 0, '방에도 지우기를 고르면 보냄');
});

test('보낸 직후 연결이 끊겨도 다시 붙으면 그 편집이 살아남는다', () => {
  const room = makeRoom(2, 5);
  settle(room);
  const u1 = room.editors[1].units; const c1 = JSON.parse(u1['code:o1']); c1.push([{ id: 'offline', type: 'when_run_button_click', x: 0, y: 0 }]); u1['code:o1'] = S(c1);
  room.clients[1].reconcile();
  room.disconnect(1);
  const u0 = room.editors[0].units; const c0 = JSON.parse(u0['code:o2']); c0.push([{ id: 'meanwhile', type: 'when_run_button_click', x: 0, y: 0 }]); u0['code:o2'] = S(c0);
  room.clients[0].reconcile();
  settle(room);
  room.reconnect(1);
  settle(room);
  assertConverged(room);
  const snap = room.server.snapshot();
  assert.ok(snap['code:o1'].includes('offline'));
  assert.ok(snap['code:o2'].includes('meanwhile'));
});

for (const seed of [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]) {
  test(`무작위 편집·지연·끊김 뒤에도 모두 같은 작품 (seed ${seed})`, () => {
    const room = makeRoom(4, seed);
    let n = 0;
    const nextId = () => `${seed}_${++n}`;
    const down = new Set();
    for (let step = 0; step < 1500; step++) {
      const x = room.r();
      const i = Math.floor(room.r() * 4);
      if (x < 0.35) randomEdit(room, i, nextId);
      else if (x < 0.4) room.editors[i].busy = !room.editors[i].busy;
      else if (x < 0.45) room.editors[i].unsafe = !room.editors[i].unsafe;
      else if (x < 0.455 && i !== 0 && !down.has(i)) { room.disconnect(i); down.add(i); }
      else if (x < 0.47 && down.has(i)) { room.reconnect(i); down.delete(i); }
      else if (x < 0.5) { if (x < 0.48) room.resumePaused(); room.clients[i].reconcile(); }
      else room.deliverOne();
    }
    for (const i of down) room.reconnect(i);
    settle(room);
    assertConverged(room);
    // 오브젝트마다 코드가 있고, 순서 목록과 실제 오브젝트가 맞는다
    const snap = room.server.snapshot();
    const order = JSON.parse(snap.objOrder);
    const objs = Object.keys(snap).filter(k => k.startsWith('obj:')).map(k => k.slice(4)).sort();
    assert.deepEqual([...order].sort(), objs);
    for (const id of objs) assert.ok(snap['code:' + id] != null);
    // 블록 하나가 두 군데에 있으면 안 된다(묶음 나누기·붙이기가 동시 수정과 겹쳐도)
    for (const id of objs) {
      const ids = [];
      for (const th of JSON.parse(snap['code:' + id])) for (const b of th) ids.push(b.id);
      assert.deepEqual(ids.filter((x, i2) => ids.indexOf(x) !== i2), [], `오브젝트 ${id}에 겹친 블록`);
    }
  });
}

test('편집기가 화면 사정으로만 바꾼 값(cleanLocal이 되돌리는 것)은 보내지 않고, 진짜 편집에는 방 값으로 실어 보낸다', () => {
  const room = makeRoom(2, 7);
  const settle = () => { for (let i = 0; i < 10000 && room.deliverOne(); i++); };
  settle();
  // 블록에 붙은 메모 x만 다른 묶음은 방 값으로(엔트리 메모가 블록 폭에 맞춰 명령 없이 밀리는 것과 같은 모양)
  const commentFree = th => JSON.stringify(th, (k, v) => (k === 'comment' && v && typeof v === 'object' ? { ...v, x: 0 } : v));
  const cleanLocal = (k, base, mine) => {
    if (!k.startsWith('code:')) return mine;
    const bt = JSON.parse(base), mt = JSON.parse(mine);
    const byKey = new Map(bt.map((th, i) => [M.threadKey(th, i), th]));
    let changed = false;
    const out = mt.map((th, i) => { const b = byKey.get(M.threadKey(th, i)); if (b && JSON.stringify(b) !== JSON.stringify(th) && commentFree(b) === commentFree(th)) { changed = true; return b; } return th; });
    return changed ? S(out) : mine;
  };
  for (const ed of room.editors) ed.cleanLocal = cleanLocal;
  const withComment = (u, x, extra = []) => {
    const th = JSON.parse(u['code:o1']);
    th[0][0].comment = { x, y: 9, width: 160, height: 160, value: '메모', type: 'comment' };
    return { ...u, 'code:o1': S([...th, ...extra]) };
  };
  room.editors[0].units = withComment(room.editors[0].units, 100);
  room.clients[0].reconcile(); settle();
  const roomComment = () => JSON.parse(room.server.snapshot()['code:o1'])[0][0].comment.x;
  assert.equal(roomComment(), 100);
  assert.equal(JSON.parse(room.editors[1].units['code:o1'])[0][0].comment.x, 100);

  const putsBefore = room.msgs();
  room.editors[1].units = withComment(room.editors[1].units, 130);
  room.clients[1].reconcile(); settle();
  assert.equal(room.msgs(), putsBefore, '화면 사정으로 밀린 메모는 보내지 않음');
  assert.equal(roomComment(), 100);

  const u = room.editors[1].units;
  room.editors[1].units = { ...u, 'code:o1': S([...JSON.parse(u['code:o1']), [{ id: 'g1', type: 'when_run_button_click', x: 400, y: 0 }]]) };
  room.clients[1].reconcile(); settle();
  const snap = JSON.parse(room.server.snapshot()['code:o1']);
  assert.ok(snap.some(th => th[0].id === 'g1'), '진짜 편집은 감');
  assert.equal(snap[0][0].comment.x, 100, '같이 실린 메모 자리는 방 값 그대로');
  assert.equal(JSON.parse(room.editors[0].units['code:o1'])[0][0].comment.x, 100);
  assert.ok(JSON.parse(room.editors[0].units['code:o1']).some(th => th[0].id === 'g1'));
});

test('참가자 페이지가 새로 열렸을 때: 방금 저장한 그 작품이나 빈 새 작품일 때만 같은 방에 다시 들어간다', () => {
  const mark = { code: 'abcd-ef23', name: '참가자', cid: 'c1', at: 1000, objs: ['o1', 'o2'] };
  const at = (extra) => rejoinTarget(mark, { path: '/ws/p123', objIds: ['o2', 'o1'], isDefault: false, now: 5000, ...extra });
  assert.deepEqual(at(), { code: 'abcd-ef23', name: '참가자', cid: 'c1' }, '저장한 작품(오브젝트가 방 작품과 같음)');
  assert.equal(at({ objIds: ['o1', 'x9'] }), null, '다른 작품을 열었으면 그 작품을 방 작품으로 바꾸지 않는다');
  assert.equal(at({ objIds: [] }), null, '아직 작품을 다 안 불러옴');
  assert.ok(at({ path: '/ws/new', objIds: ['o9'], isDefault: true }), '새로고침한 빈 새 작품');
  assert.equal(at({ path: '/ws/new', objIds: ['o9'], isDefault: false }), null, '새 작품 화면에 다른 작품이 들어 있음');
  assert.equal(at({ path: '/project/p123' }), null, '작품 만들기 화면이 아님');
  assert.equal(at({ now: 1000 + 90000 }), null, '너무 오래 지남');
  assert.equal(at({ now: 500 }), null, '시계가 거꾸로');
  assert.equal(rejoinTarget(null, { path: '/ws/p123', objIds: ['o1'], now: 5000 }), null);
  assert.equal(rejoinTarget({ ...mark, cid: undefined }, { path: '/ws/p123', objIds: ['o1', 'o2'], now: 5000 }), null);
});

test('같은 작품인지는 사람이 만든 오브젝트로 본다: 엔트리루트 시스템 오브젝트는 켠 화면에서만 바뀌어도 같은 작품이다', () => {
  const mark = { code: 'abcd-ef23', name: '참가자', cid: 'c1', at: 1000, objs: ['o1', 'o2', 'ers0oaaaa0000', 'ers0obbbb0000'] };
  const at = (extra, m = mark) => rejoinTarget(m, { path: '/ws/new', objIds: ['o2', 'o1', 'ers0oaaaa0000', 'ers0occcc0000', 'ers0odddd0000'], isDefault: false, now: 5000, ...extra });
  assert.deepEqual(at(), { code: 'abcd-ef23', name: '참가자', cid: 'c1' }, '되살리며 시스템 오브젝트가 늘고 바뀜');
  assert.ok(at({ path: '/ws/p123', objIds: ['o1', 'o2'] }), '시스템 오브젝트가 없어짐');
  assert.equal(at({ objIds: ['o1', 'x9', 'ers0oaaaa0000', 'ers0obbbb0000'] }), null, '시스템 오브젝트가 같아도 사람이 만든 오브젝트가 다르면 다른 작품');
  assert.equal(at({ objIds: ['o1', 'ers0oaaaa0000', 'ers0obbbb0000'] }), null, '사람이 만든 오브젝트가 빠짐');
  assert.equal(at({ objIds: ['ers0oaaaa0000', 'ers0obbbb0000'] }), null, '사람이 만든 오브젝트가 아직 안 들어옴');
  assert.equal(at({ objIds: ['ers0oaaaa0000'] }, { ...mark, objs: ['ers0oaaaa0000'] }), null, '시스템 오브젝트뿐이면 같은 작품인지 알 수 없다');
});

test('판이 다른 참가자: 맞는 옛 규칙은 받고, 엔트리루트 작품·너무 옛 판·새 판은 까닭과 함께 거절', () => {
  const { joinBlock, MIN_PROTOCOL } = require('../../src/sync.js');
  const plain = { objOrder: '["o1"]', 'obj:o1': '{}', 'code:o1': '[]' };
  const er = { ...plain, 'func:ers0abc': '{}' };
  assert.equal(joinBlock(PROTOCOL, er), null);
  assert.equal(joinBlock(MIN_PROTOCOL, plain), null);
  assert.equal(joinBlock(MIN_PROTOCOL, er), 'version-entryroot');
  assert.equal(joinBlock(MIN_PROTOCOL, { ...plain, 'var:erinfo': '{}' }), 'version-entryroot');
  assert.equal(joinBlock(MIN_PROTOCOL - 1, plain), 'version');
  assert.equal(joinBlock(PROTOCOL + 1, plain), 'version');
  const sent = [];
  const srv = new Server(er, { send: (c, m) => sent.push(m), broadcast: () => {}, app: '9.9.9' });
  srv.onMessage('g', { t: 'hello', v: MIN_PROTOCOL, name: 'x' });
  assert.deepEqual([sent[0].t, sent[0].why, sent[0].v, sent[0].app], ['refuse', 'version-entryroot', PROTOCOL, '9.9.9']);
  const srv2 = new Server(plain, { send: (c, m) => sent.push(m), broadcast: () => {} });
  srv2.onMessage('g', { t: 'hello', v: MIN_PROTOCOL, name: 'x' });
  assert.equal(sent[1].t, 'welcome');
});

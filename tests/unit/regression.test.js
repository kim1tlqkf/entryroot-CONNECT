// 검토에서 나온 결함들의 재현 시험. 고치기 전에는 실패해야 한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../src/merge.js');
const { Server, Client, PROTOCOL } = require('../../src/sync.js');

const S = M.stable;
const blk = (id, type = 'move_x', extra = {}) => ({ id, type, x: 0, y: 0, params: [], statements: [], ...extra });
const top = (id, x = 0, y = 0) => ({ ...blk(id, 'when_run_button_click'), x, y });
const norm = u => M.projectToUnits(M.unitsToProject(u));
const T = { set: () => 0, clear: () => {} };

function blockIds(code) {
  const ids = [];
  const walk = v => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') { if (v.id != null && v.type != null) ids.push(v.id); Object.values(v).forEach(walk); }
  };
  walk(JSON.parse(code));
  return ids;
}
const dupes = ids => ids.filter((x, i) => ids.indexOf(x) !== i);

const project = () => M.projectToUnits({
  objects: [
    { id: 'o1', name: '고양이', script: JSON.stringify([[top('a'), blk('a1')]]), objectType: 'sprite', scene: 's1', sprite: { pictures: [{ id: 'p1' }], sounds: [] }, selectedPictureId: 'p1', entity: { x: 0, y: 0 } },
    { id: 'o2', name: '배경', script: '[]', objectType: 'sprite', scene: 's1', sprite: { pictures: [{ id: 'p2' }], sounds: [] }, selectedPictureId: 'p2', entity: { x: 0, y: 0 } },
    { id: 'o3', name: '개', script: '[]', objectType: 'sprite', scene: 's1', sprite: { pictures: [{ id: 'p3' }], sounds: [] }, selectedPictureId: 'p3', entity: { x: 0, y: 0 } },
  ],
  scenes: [{ id: 's1', name: '장면 1' }],
  variables: [{ id: 'lv', name: '지역', value: 3, object: 'o1' }],
  messages: [], functions: [{ id: 'f1', content: '[]' }], tables: [], speed: 60,
});

// ── 묶음을 나누거나 붙이는 동안 상대가 같은 묶음을 고침: 같은 블록이 두 번 생기면 안 된다 ──
for (const [name, b, t, m] of [
  ['나누기', [[top('A'), blk('B'), blk('C')]], [[top('A'), blk('B'), blk('C', 'move_x', { params: [10] })]], [[top('A')], [{ ...blk('B'), x: 300 }, blk('C')]]],
  ['붙이기', [[top('A'), blk('A1')], [top('X', 200), blk('X1')]], [[top('A'), blk('A1')], [top('X', 200), blk('X1', 'move_x', { params: [5] })]], [[top('A'), blk('A1'), blk('X', 'move_y'), blk('X1')]]],
  ['맨 위에 끼우기', [[top('A'), blk('A1')]], [[top('A'), blk('A1', 'move_x', { params: [1] })]], [[top('N'), { ...blk('A'), type: 'when_run_button_click' }, blk('A1')]]],
]) {
  test(`블록 묶음 ${name} 중 동시 수정: 같은 블록 id가 두 번 생기지 않는다`, () => {
    const r = M.mergeUnit('code:o', S(b), S(t), S(m));
    assert.deepEqual(dupes(blockIds(r.value)), []);
    assert.equal(r.conflict, true);
  });
}

// ── 오브젝트 지우기와 고치기가 겹침: 반쪽만 반영되면 안 된다 ──
function serverWith(units) {
  let last = null;
  const srv = new Server(units, { send: () => {}, broadcast: m => { last = m; } });
  srv.members.set('A', {}); srv.members.set('B', {});
  return { srv, last: () => last };
}
function deletionPut(base, objId) {
  const p = M.unitsToProject(base);
  p.objects = p.objects.filter(o => o.id !== objId);
  p.variables = p.variables.filter(v => v.object !== objId);
  const u = M.projectToUnits(p);
  const ch = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(u)])) if (base[k] !== u[k]) ch[k] = { b: base[k] ?? null, m: u[k] ?? null };
  return ch;
}

test('먼저 위치를 옮긴 오브젝트를 나중에 지우면: 지우기를 통째로 거절(코드·지역 변수·자리 유지)하고 지운 사람에게 알린다', () => {
  const base = project();
  const { srv, last } = serverWith(base);
  const moved = JSON.parse(base['obj:o1']); moved.entity.x = 50;
  srv.onMessage('A', { t: 'put', pid: 'A:1', ch: { 'obj:o1': { b: base['obj:o1'], m: S(moved) } } });
  srv.onMessage('B', { t: 'put', pid: 'B:1', ch: deletionPut(base, 'o1') });
  const s = srv.snapshot();
  assert.equal(JSON.parse(s['obj:o1']).entity.x, 50);
  assert.equal(s['code:o1'], base['code:o1'], '코드가 지워지면 안 됨');
  assert.ok(s['var:lv'], '지역 변수가 지워지면 안 됨');
  assert.deepEqual(JSON.parse(s.objOrder), ['o1', 'o2', 'o3'], '자리도 그대로');
  assert.ok(last().cf.includes('obj:o1'));
});

test('먼저 코드를 고친 오브젝트를 나중에 지우면: 고친 코드가 남는다', () => {
  const base = project();
  const { srv, last } = serverWith(base);
  const code = S([[top('a'), blk('a1'), blk('NEW', 'move_y')]]);
  srv.onMessage('A', { t: 'put', pid: 'A:1', ch: { 'code:o1': { b: base['code:o1'], m: code } } });
  srv.onMessage('B', { t: 'put', pid: 'B:1', ch: deletionPut(base, 'o1') });
  const s = srv.snapshot();
  assert.ok(s['obj:o1']);
  assert.equal(s['code:o1'], code);
  assert.ok(last().cf.includes('obj:o1'));
});

test('먼저 지운 오브젝트를 나중에 고치면: 지운 것이 남고 고친 사람에게 알린다', () => {
  const base = project();
  const { srv, last } = serverWith(base);
  srv.onMessage('B', { t: 'put', pid: 'B:1', ch: deletionPut(base, 'o1') });
  const code = S([[top('a'), blk('a1'), blk('NEW', 'move_y')]]);
  srv.onMessage('A', { t: 'put', pid: 'A:1', ch: { 'code:o1': { b: base['code:o1'], m: code } } });
  const s = srv.snapshot();
  assert.equal(s['obj:o1'], undefined);
  assert.equal(s['code:o1'], undefined);
  assert.ok(last().cf.length > 0);
});

test('아무도 안 건드린 오브젝트를 지우면 그대로 지워진다', () => {
  const base = project();
  const { srv, last } = serverWith(base);
  srv.onMessage('B', { t: 'put', pid: 'B:1', ch: deletionPut(base, 'o1') });
  const s = srv.snapshot();
  assert.equal(s['obj:o1'], undefined);
  assert.equal(s['var:lv'], undefined);
  assert.deepEqual(JSON.parse(s.objOrder), ['o2', 'o3']);
  assert.deepEqual(last().cf, []);
});

// ── 방 작품 반영(다시 불러오기)이 실패해도 방 작품이 지워져 퍼지면 안 된다 ──
class Ed {
  constructor(u) { this.u = norm(u); this.failNext = false; this.busy = false; }
  exportUnits() { return this.busy ? null : norm(this.u); }
  isSafe() { return true; }
  apply(toApply, cur) {
    const units = { ...cur };
    for (const [k, v] of Object.entries(toApply)) { if (v == null) delete units[k]; else units[k] = v; }
    // 엔트리처럼: 먼저 비우고(clearProject) 다시 불러오는데(loadProject) 그게 실패
    this.u = norm({ sceneOrder: cur.sceneOrder, 'scene:s1': cur['scene:s1'], meta: cur.meta });
    if (this.failNext) { this.failNext = false; throw new Error('loadProject failed'); }
    this.u = norm(units);
    return true;
  }
  loadAll(u) { this.u = norm(u); }
}
function room() {
  const q = [];
  const host = new Ed(project()), guest = new Ed({});
  const flags = { gUp: true, applyErrors: 0, suspicious: 0 };
  const srv = new Server(host.exportUnits(), { send: (c, m) => q.push([c, m]), broadcast: m => { for (const c of srv.members.keys()) q.push([c, JSON.parse(JSON.stringify(m))]); } });
  const hooks = { onApplyError: () => flags.applyErrors++, onSuspicious: () => flags.suspicious++ };
  const cl = {
    host: new Client({ adapter: host, id: 'h', send: m => q.push(['S', 'host', m]), timers: T, hooks }),
    g: new Client({ adapter: guest, id: 'g', send: m => { if (flags.gUp) q.push(['S', 'g', m]); }, timers: T, hooks }),
  };
  cl.host.startAsHost(host.exportUnits());
  let joined = false;
  const pump = () => {
    let x;
    while ((x = q.shift())) {
      if (x[0] === 'S') { srv.onMessage(x[1], x[2]); continue; }
      if (x[0] === 'g' && !flags.gUp) continue;
      const c = cl[x[0]], m = x[1];
      try {
        if (m.t === 'welcome') { c.onWelcome(m, { fresh: x[0] === 'g' && !joined }); if (x[0] === 'g') joined = true; } else if (m.t === 'upd') c.onUpd(m);
      } catch (e) { flags.threw = (flags.threw || 0) + 1; }
    }
  };
  q.push(['S', 'host', { t: 'hello', v: PROTOCOL, host: true }], ['S', 'g', { t: 'hello', v: PROTOCOL }]);
  pump();
  return { q, srv, host, guest, cl, pump, flags };
}

test('참가자 화면에서 작품 다시 불러오기가 실패해도 방 작품은 그대로이고, 그 참가자는 멈춘다', () => {
  const r = room();
  const hu = r.host.exportUnits();
  hu['func:f1'] = S({ id: 'f1', content: [[top('fb')]] });
  r.host.u = norm(hu);
  r.guest.failNext = true;
  r.cl.host.reconcile(); r.pump();
  r.cl.g.reconcile(); r.pump();
  r.cl.host.reconcile(); r.pump();
  assert.deepEqual(JSON.parse(r.srv.snapshot().objOrder), ['o1', 'o2', 'o3'], '방 오브젝트가 지워짐');
  assert.equal(r.flags.threw || 0, 0, '예외가 밖으로 새면 안 됨');
  assert.equal(r.cl.g.paused, true);
  assert.ok(r.flags.applyErrors >= 1);
});

test('오브젝트가 하나도 없는 상태를 자동으로 보내지 않는다(실수·오류로 비었을 때)', () => {
  const r = room();
  r.guest.u = norm({ sceneOrder: r.guest.u.sceneOrder, 'scene:s1': r.guest.u['scene:s1'], meta: r.guest.u.meta });
  r.cl.g.reconcile(); r.pump();
  assert.deepEqual(JSON.parse(r.srv.snapshot().objOrder), ['o1', 'o2', 'o3']);
  assert.ok(r.flags.suspicious >= 1);
});

// ── 다시 연결할 때 이미 처리된 편집을 또 보내서 남의 삭제를 되살리면 안 된다 ──
test('처리된 편집의 답만 못 받고 끊겼다 다시 붙어도, 그 사이 남이 지운 것을 되살리지 않는다', () => {
  const r = room();
  const gu = r.guest.exportUnits();
  const c = JSON.parse(gu['code:o1']); c.push([top('X', 100)]); gu['code:o1'] = S(c); r.guest.u = norm(gu);
  r.cl.g.reconcile();
  r.flags.gUp = false; r.pump(); r.srv.leave('g');
  assert.ok(r.srv.snapshot()['code:o1'].includes('"X"'));
  const hu = r.host.exportUnits(); hu['code:o1'] = S(JSON.parse(hu['code:o1']).filter(th => th[0].id !== 'X')); r.host.u = norm(hu);
  r.cl.host.reconcile(); r.pump();
  assert.ok(!r.srv.snapshot()['code:o1'].includes('"X"'));
  r.flags.gUp = true; r.q.push(['S', 'g', { t: 'hello', v: PROTOCOL, lastPid: r.cl.g.inflight && r.cl.g.inflight.pid }]); r.pump();
  r.cl.g.reconcile(); r.pump(); r.cl.host.reconcile(); r.pump();
  assert.ok(!r.srv.snapshot()['code:o1'].includes('"X"'), '지운 묶음이 되살아남');
  assert.ok(!r.guest.exportUnits()['code:o1'].includes('"X"'), '참가자 화면도 지운 상태여야 함');
});

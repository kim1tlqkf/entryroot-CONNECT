const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../src/merge.js');

const S = M.stable;
const blk = (id, type = 'move_x', extra = {}) => ({ id, type, x: 0, y: 0, params: [], statements: [], ...extra });
const thread = (id, x, y, ...rest) => [{ ...blk(id, 'when_run_button_click'), x, y }, ...rest];

test('다른 블록 묶음을 동시에 고치면 둘 다 남는다', () => {
  const b = [thread('a', 10, 10, blk('a1')), thread('b', 200, 10, blk('b1'))];
  const t = [thread('a', 10, 10, blk('a1'), blk('a2')), thread('b', 200, 10, blk('b1'))];
  const m = [thread('a', 10, 10, blk('a1')), thread('b', 200, 10, blk('b1'), blk('b2'))];
  const r = M.mergeUnit('code:o', S(b), S(t), S(m));
  assert.equal(r.conflict, false);
  assert.equal(r.value, S([t[0], m[1]]));
});

test('같은 묶음을 둘 다 고치면 먼저 들어온 쪽이 남고 충돌로 알린다', () => {
  const b = [thread('a', 10, 10, blk('a1'))];
  const t = [thread('a', 10, 10, blk('a1'), blk('x'))];
  const m = [thread('a', 10, 10, blk('a1'), blk('y'))];
  const r = M.mergeUnit('code:o', S(b), S(t), S(m));
  assert.equal(r.conflict, true);
  assert.equal(r.value, S(t));
});

test('둘이 각각 새 묶음을 더하면 둘 다, 각자 쓴 자리 근처에 들어간다', () => {
  const b = [thread('a', 0, 0), thread('b', 0, 100)];
  const t = [thread('a', 0, 0), thread('t1', 50, 50), thread('b', 0, 100)];
  const m = [thread('a', 0, 0), thread('b', 0, 100), thread('m1', 90, 90)];
  const r = M.mergeUnit('code:o', S(b), S(t), S(m));
  assert.equal(r.conflict, false);
  assert.deepEqual(JSON.parse(r.value).map(th => th[0].id), ['a', 't1', 'b', 'm1']);
});

test('지운 묶음을 상대가 고쳤으면 고친 쪽(먼저 들어온 쪽)이 제자리에 남는다', () => {
  const b = [thread('a', 0, 0), thread('b', 0, 100), thread('c', 0, 200)];
  const t = [thread('a', 0, 0), thread('b', 0, 100, blk('new')), thread('c', 0, 200)];
  const m = [thread('a', 0, 0), thread('c', 0, 200)];
  const r = M.mergeUnit('code:o', S(b), S(t), S(m));
  assert.equal(r.conflict, true);
  assert.deepEqual(JSON.parse(r.value).map(th => th[0].id), ['a', 'b', 'c']);
});

test('한쪽만 지우면 지워진다', () => {
  const b = [thread('a', 0, 0), thread('b', 0, 100)];
  const t = [thread('a', 0, 0, blk('z')), thread('b', 0, 100)];
  const m = [thread('a', 0, 0)];
  const r = M.mergeUnit('code:o', S(b), S(t), S(m));
  assert.equal(r.conflict, false);
  assert.equal(r.value, S([t[0]]));
});

test('오브젝트: 한 사람은 위치, 다른 사람은 이름을 바꾸면 둘 다 남는다', () => {
  const b = { id: 'o', name: '고양이', entity: { x: 0, y: 0, rotation: 0 }, sprite: { pictures: [{ id: 'p1' }], sounds: [] }, selectedPictureId: 'p1' };
  const t = { ...b, name: '호랑이' };
  const m = { ...b, entity: { ...b.entity, x: 50 } };
  const r = M.mergeUnit('obj:o', S(b), S(t), S(m));
  assert.equal(r.conflict, false);
  const v = JSON.parse(r.value);
  assert.equal(v.name, '호랑이');
  assert.equal(v.entity.x, 50);
});

test('오브젝트: 둘이 각자 모양을 추가하면 둘 다 남는다', () => {
  const b = { id: 'o', sprite: { pictures: [{ id: 'p1' }], sounds: [] }, selectedPictureId: 'p1', entity: {} };
  const t = { ...b, sprite: { pictures: [{ id: 'p1' }, { id: 'p2' }], sounds: [] } };
  const m = { ...b, sprite: { pictures: [{ id: 'p1' }, { id: 'p3' }], sounds: [] } };
  const r = M.mergeUnit('obj:o', S(b), S(t), S(m));
  assert.equal(r.conflict, false);
  assert.deepEqual(JSON.parse(r.value).sprite.pictures.map(p => p.id), ['p1', 'p2', 'p3']);
});

test('오브젝트: 둘이 서로 다른 마지막 모양을 지워도 모양 하나는 남고, 고른 모양은 있는 모양을 가리킨다', () => {
  const b = { id: 'o', objectType: 'sprite', sprite: { pictures: [{ id: 'p1' }, { id: 'p2' }], sounds: [] }, selectedPictureId: 'p1', entity: {} };
  const t = { ...b, sprite: { pictures: [{ id: 'p2' }], sounds: [] }, selectedPictureId: 'p2' };
  const m = { ...b, sprite: { pictures: [{ id: 'p1' }], sounds: [] } };
  const r = M.mergeUnit('obj:o', S(b), S(t), S(m));
  const v = JSON.parse(r.value);
  assert.ok(v.sprite.pictures.length >= 1);
  assert.ok(v.sprite.pictures.some(p => p.id === v.selectedPictureId));
});

test('순서: 한쪽만 순서를 바꾸고 다른 쪽은 추가하면 둘 다 반영', () => {
  const r = M.mergeUnit('objOrder', S(['a', 'b', 'c']), S(['a', 'b', 'c', 'd']), S(['c', 'a', 'b']));
  assert.deepEqual(JSON.parse(r.value), ['c', 'a', 'b', 'd']);
});

test('스크롤 몫을 빼고 더하면 원래 좌표로 돌아오고, 스크롤은 조각을 바꾸지 않는다', () => {
  const p = { objects: [{ id: 'o', name: 'n', script: JSON.stringify([thread('a', 21.5, 30), thread('b', 300.25, 80)]), entity: {}, sprite: { pictures: [], sounds: [] } }], scenes: [{ id: 's', name: '장면 1' }], variables: [], messages: [], functions: [], tables: [], speed: 60, interface: { menuWidth: 280 } };
  const u0 = M.projectToUnits(p, () => [0, 0]);
  const scrolled = JSON.parse(JSON.stringify(p));
  scrolled.objects[0].script = JSON.stringify([thread('a', 21.5 - 33.3, 30 + 12.7), thread('b', 300.25 - 33.3, 80 + 12.7)]);
  const u1 = M.projectToUnits(scrolled, () => [-33.3, 12.7]);
  assert.equal(u1['code:o'], u0['code:o']);
  assert.equal(u0.meta.includes('menuWidth'), false, 'interface는 나누지 않음');
  const back = M.unitsToProject(u1, () => [-33.3, 12.7]);
  const th = JSON.parse(back.objects[0].script);
  assert.ok(Math.abs(th[0][0].x - (21.5 - 33.3)) < 0.01);
  assert.equal(back.speed, 60);
});

test('작품 → 조각 → 작품 왕복이 같은 조각을 만든다', () => {
  const p = {
    objects: [
      { id: 'o1', name: '엔트리봇', script: JSON.stringify([thread('a', 1, 2, blk('a1'))]), objectType: 'sprite', rotateMethod: 'free', scene: 's1', sprite: { pictures: [{ id: 'p', fileurl: '/x.svg' }], sounds: [] }, selectedPictureId: 'p', lock: false, entity: { x: 1, y: 2 } },
      { id: 'o2', name: '글', script: '[]', objectType: 'textBox', scene: 's1', sprite: { pictures: [], sounds: [] }, text: '안녕', lock: false, entity: { x: 0, y: 0, text: '안녕' } },
    ],
    scenes: [{ id: 's1', name: '장면 1' }],
    variables: [{ id: 'v', name: '점수', value: 0, object: null }, { id: 'lv', name: '지역', value: '3', object: 'o1' }],
    messages: [{ id: 'm', name: '신호' }],
    functions: [{ id: 'f', type: 'normal', content: JSON.stringify([thread('fa', 5, 5)]) }],
    tables: [], speed: 60, expansionBlocks: [], interface: {},
  };
  const u = M.projectToUnits(p);
  const u2 = M.projectToUnits(M.unitsToProject(u));
  assert.deepEqual(u2, u);
  assert.equal(JSON.parse(u['var:v']).value, '0');
});

test('정리: 지운 오브젝트의 코드·지역 변수는 지우고, 없는 장면의 오브젝트는 첫 장면으로', () => {
  const st = new Map(Object.entries({
    sceneOrder: S(['s1']), 'scene:s1': S({ id: 's1' }),
    objOrder: S(['o1', 'gone']), 'obj:o1': S({ id: 'o1', scene: 's-deleted' }), 'code:o1': S([]),
    'code:gone': S([]), 'var:lv': S({ id: 'lv', object: 'gone' }), varOrder: S(['lv']),
    'obj:o2': S({ id: 'o2', scene: 's1' }),
  }));
  const ch = M.normalize(st);
  assert.equal(st.get('code:gone'), null);
  assert.equal(st.get('var:lv'), null);
  assert.equal(JSON.parse(st.get('obj:o1')).scene, 's1');
  assert.deepEqual(JSON.parse(st.get('objOrder')), ['o1', 'o2']);
  assert.equal(st.get('code:o2'), '[]');
  assert.deepEqual(JSON.parse(st.get('varOrder')), []);
  assert.ok(ch.size > 0);
});

test('묶음별 정리 결과를 재사용해도 전체를 정리한 것과 글이 같다', () => {
  const threads = [thread('a', 10.5, 20, blk('a1', 'move_x', { params: [{ id: 'n1', type: 'number', params: ['3'] }, null] })), thread('b', 300, 40, blk('b1')), [{ id: 'cm', type: 'comment', x: 5, y: 6, value: '메모' }]];
  const cache = new Map();
  for (const off of [[0, 0], [-33.3, 12.7], [-33.3, 12.7]]) {
    assert.equal(M.codeUnit(threads, off, cache), M.stable(M.canonThreads(threads, off)));
  }
  assert.ok(cache.size > 0);
  const o = { id: 'o', name: 'n', script: JSON.stringify(threads), entity: { x: 1 } };
  assert.deepEqual(M.objectUnits(o, [2, 3], cache), M.objectUnits(o, [2, 3]));
});

test('엔트리가 나중에 붙이는 모양 크기 기록(dimension.scaleX/Y)은 조각에 없다 — 있든 없든 같은 조각', () => {
  const pic = (scale) => ({ id: 'p1', name: '모양', fileurl: '/a.svg', imageType: 'svg', dimension: { width: 144, height: 246, ...(scale ? { scaleX: 0.51, scaleY: 0.51 } : {}) } });
  const obj = scale => ({ id: 'o', name: 'n', script: '[]', sprite: { pictures: [pic(scale), { ...pic(false), id: 'p2' }], sounds: [] }, selectedPictureId: 'p1' });
  const withScale = M.objectUnits(obj(true)), without = M.objectUnits(obj(false));
  assert.equal(withScale.obj, without.obj);
  assert.ok(!/scaleX|scaleY/.test(withScale.obj));
  assert.deepEqual(JSON.parse(withScale.obj).sprite.pictures[0].dimension, { width: 144, height: 246 });
  const item = obj(true);
  M.objectUnits(item);
  assert.equal(item.sprite.pictures[0].dimension.scaleX, 0.51, '엔트리에서 읽은 원본은 건드리지 않음');
  assert.equal(M.projectToUnits({ objects: [obj(true)] })['obj:o'], without.obj);
});

test('엔트리루트가 화면에서만 쓰는 흐름 블록은 조각에 저장본과 같은 순정 블록으로 들어간다', () => {
  const hex = 'ab'.repeat(12);
  const flow = (native, params, extra = {}) => ({ id: native + '1', type: `entryroot_flow_${hex}_${native}`, params: [...params, 'default'], statements: [], ...extra });
  const nat = (native, params, extra = {}) => ({ id: native + '1', type: native, params, statements: [], ...extra });
  const num = id => ({ id, type: 'number', params: [10], statements: [] });
  const head = { id: 'h', type: 'when_run_button_click', x: 5, y: 6, params: [null], statements: [] };
  const live = [[head, flow('repeat_basic', [num('n1'), null], { statements: [[flow('move_direction', [num('n2'), null])]] })]];
  const saved = [[head, nat('repeat_basic', [num('n1'), null], { statements: [[nat('move_direction', [num('n2'), null])]] })]];
  const code = s => M.objectUnits({ id: 'o', name: 'n', script: JSON.stringify(s) }).code;
  const func = s => M.funcUnit({ id: 'f', type: 'normal', localVariables: [], useLocalVariables: false, content: JSON.stringify(s) });
  assert.equal(code(live), code(saved));
  assert.equal(func(live), func(saved));
  assert.ok(!code(live).includes('entryroot_flow_'));
  // 값 칸 안에 든 흐름 블록과, 이름만 비슷한 사용자 글자는 구분한다
  const inParam = [[head, nat('move_direction', [flow('calc_basic', [num('n3')]), null])]];
  assert.ok(!code(inParam).includes('entryroot_flow_'));
  // 기본이 아닌 값(시간 속도 등)을 고른 블록도 순정으로 보낸다 — 그대로 보내면 받는 쪽 엔트리가 모르는 블록에서 멈춘다
  const scaled = [[head, { ...flow('repeat_basic', [num('n1'), null]), params: [num('n1'), null, 'scaled'] }]];
  assert.equal(code(scaled), code([[head, nat('repeat_basic', [num('n1'), null])]]));
  const text = [[head, nat('dialog', [{ id: 't', type: 'text', params: ['entryroot_flow_글자'], statements: [] }, null])]];
  assert.equal(code(text), M.stable(JSON.parse(JSON.stringify(text))));
});

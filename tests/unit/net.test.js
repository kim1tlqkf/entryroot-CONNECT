// 큰 메시지를 나눠 보내고 다시 합치는 부분(한글·이모지 포함)을 가짜 연결로 확인한다
const test = require('node:test');
const assert = require('node:assert/strict');
const { ErcNet: Net } = require('../../src/net.js');

function fakePair() {
  const handlers = {};
  const sent = [];
  const conn = {
    open: true,
    send: s => sent.push(s),
    close() { this.open = false; },
    on: (ev, fn) => { handlers[ev] = fn; },
  };
  return { conn, sent, emit: (ev, v) => handlers[ev] && handlers[ev](v) };
}

test('UTF-16 짝(이모지)을 가르지 않고 자른다', () => {
  const s = 'a'.repeat(9) + '😀' + '가나다😀'.repeat(50);
  for (const size of [3, 5, 10, 11, 17]) {
    const parts = Net.splitText(s, size);
    assert.equal(parts.join(''), s);
    for (const p of parts) {
      const last = p.charCodeAt(p.length - 1);
      assert.ok(!(last >= 0xd800 && last <= 0xdbff), '짝 앞쪽으로 끝나면 안 됨');
    }
  }
});

const until = async (cond, ms = 5000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('시간 초과'); await new Promise(r => setTimeout(r, 10)); } };

test('큰 메시지는 줄이고 나눠 보내며, 받는 쪽에서 원래대로·보낸 순서대로 합쳐진다', async () => {
  const a = fakePair(), b = fakePair();
  const got = [];
  const progress = [];
  const wa = Net.wrapConn(a.conn, { onMessage: () => {}, onClose: () => {}, log: () => {} });
  const wb = Net.wrapConn(b.conn, { onMessage: m => got.push(m), onClose: () => {}, onProgress: (g, n) => progress.push([g, n]), log: () => {} });
  const big = { t: 'welcome', units: {} };
  // 압축이 덜 되도록 조각마다 다른 값(실제 작품보다 불리한 경우)
  for (let i = 0; i < 4000; i++) big.units['code:' + i] = JSON.stringify([[{ id: 'b' + i, type: 'text', params: ['안녕😀 블록 ' + Math.random().toString(36).repeat(3)] }]]);
  wa.send({ t: 'mem', members: [] });
  wa.send(big);
  wa.send({ t: 'upd', seq: 1 });
  await until(() => a.sent.some(s => s.startsWith('M{"t":"upd"')));
  const zipped = a.sent.filter(s => s[0] === 'G');
  assert.ok(zipped.length > 1, '큰 메시지는 압축 조각(G)으로');
  assert.ok(zipped.join('').length < JSON.stringify(big).length, '압축해서 더 작아야 함');
  for (const raw of a.sent) b.emit('data', raw);
  await until(() => got.length === 3);
  assert.deepEqual(got, [{ t: 'mem', members: [] }, big, { t: 'upd', seq: 1 }]);
  assert.ok(progress.length > 1 && progress[progress.length - 1][0] === progress[progress.length - 1][1]);
  wa.close(); wb.close();
});

test('초대 코드는 대소문자·띄어쓰기·하이픈 빠짐을 맞춰 준다', () => {
  assert.equal(Net.normCode(' ABCD ef23 '), 'abcd-ef23');
  assert.equal(Net.normCode('abcdef23'), 'abcd-ef23');
  assert.match(Net.newCode(), /^[a-z0-9]{4}-[a-z0-9]{4}$/);
});

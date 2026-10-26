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

test('큰 메시지는 나눠 보내고 받는 쪽에서 원래대로 합쳐진다', () => {
  const a = fakePair(), b = fakePair();
  const got = [];
  const wa = Net.wrapConn(a.conn, { onMessage: () => {}, onClose: () => {}, log: () => {} });
  const wb = Net.wrapConn(b.conn, { onMessage: m => got.push(m), onClose: () => {}, log: () => {} });
  const big = { t: 'welcome', units: {} };
  for (let i = 0; i < 4000; i++) big.units['code:' + i] = JSON.stringify([[{ id: 'b' + i, type: 'text', params: ['안녕😀 블록 ' + i.toString().repeat(20)] }]]);
  wa.send(big);
  wa.send({ t: 'upd', seq: 1 });
  assert.ok(a.sent.length > 3, '여러 조각으로 나뉘어야 함');
  for (const raw of a.sent) b.emit('data', raw);
  assert.deepEqual(got, [big, { t: 'upd', seq: 1 }]);
  wa.close(); wb.close();
});

test('초대 코드는 대소문자·띄어쓰기·하이픈 빠짐을 맞춰 준다', () => {
  assert.equal(Net.normCode(' ABCD ef23 '), 'abcd-ef23');
  assert.equal(Net.normCode('abcdef23'), 'abcd-ef23');
  assert.match(Net.newCode(), /^[a-z0-9]{4}-[a-z0-9]{4}$/);
});

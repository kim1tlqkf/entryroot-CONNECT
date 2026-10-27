// e2e 시험 공통: 합작 창 누르기, 방 열고 들어가기, 두 사람 작품이 방 작품과 같아질 때까지 기다리기
const { sleep } = require('./chrome');

function checker() {
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
  return { results, check };
}

const uiFind = (sel, text, nth = 0) => `(() => {
  const r = document.getElementById('entry-hapjak-root').shadowRoot;
  const els = [...r.querySelectorAll(${JSON.stringify(sel)})].filter(e => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'} && e.getBoundingClientRect().width > 0);
  const e = els[${nth}]; if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
})()`;
async function uiClick(c, sel, text, nth = 0) {
  const p = await c.waitFor(uiFind(sel, text, nth), 10000, `화면 요소 ${sel} ${text || ''}`);
  await c.click(p.x, p.y);
  await sleep(150);
}
async function openPanel(c) {
  const hidden = await c.evalJs(`document.getElementById('entry-hapjak-root').shadowRoot.querySelector('.panel').hidden`);
  if (hidden) await uiClick(c, '.fab');
}

// 글상자 폭처럼 컴퓨터마다 다를 수 있는 값을 빼고 비교
const STRIP = `(u => { const o = {}; for (const [k, v] of Object.entries(u || {})) { if (v == null) continue; if (k.startsWith('obj:')) { const x = JSON.parse(v); if (x.objectType === 'textBox' && x.entity) { delete x.entity.width; delete x.entity.height; } o[k] = JSON.stringify(x); } else o[k] = v; } return o; })`;
async function units(c, server = false) { return c.evalJs(`${STRIP}(__entryHapjak.${server ? 'serverUnits' : 'exportUnits'}())`); }
async function converged(A, B, label, check, ms = 20000) {
  const t0 = Date.now();
  let diff = [];
  while (Date.now() - t0 < ms) {
    const [ua, ub, us] = await Promise.all([units(A), units(B), units(A, true)]);
    diff = [];
    if (ua && ub && us) {
      for (const k of new Set([...Object.keys(ua), ...Object.keys(ub), ...Object.keys(us)])) {
        if (ua[k] !== us[k] || ub[k] !== us[k]) diff.push(k);
      }
      if (!diff.length) { check(label, true, `${Math.round((Date.now() - t0) / 100) / 10}초`); return true; }
    }
    await sleep(300);
  }
  check(label, false, '다른 조각: ' + diff.slice(0, 8).join(', '));
  return false;
}
const hasBlock = (id) => `JSON.stringify(Entry.exportProject().objects).includes(${JSON.stringify(id)})`;

// A가 방을 열고 B가 초대 코드로 들어온다
async function openRoom(A, B) {
  await uiClick(A, '.fab');
  await uiClick(A, 'input', null, 0); await A.type('방장');
  await uiClick(A, 'button.main', '새 방 만들기');
  const code = await A.waitFor(`(s => s.mode === 'room' && s.code)(__entryHapjak.status())`, 30000, '방 열림');
  await uiClick(B, '.fab');
  await uiClick(B, 'input', null, 0); await B.type('참가자');
  await uiClick(B, 'input', null, 1); await B.type(code);
  await uiClick(B, 'button.sub', '참여하기');
  await B.waitFor(`__entryHapjak.status().mode === 'room'`, 45000, '참가자 방 입장');
  await A.waitFor(`__entryHapjak.status().members.length === 2`, 10000, '방장이 참가자를 봄');
  return code;
}

module.exports = { checker, uiFind, uiClick, openPanel, STRIP, units, converged, hasBlock, openRoom };

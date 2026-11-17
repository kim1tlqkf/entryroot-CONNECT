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

// 글상자 폭, 블록에 붙은 메모 x·y처럼 각자 그려진 크기에 따라 다를 수 있는 값을 빼고 비교
const STRIP = `(u => { const o = {}; for (const [k, v] of Object.entries(u || {})) { if (v == null) continue; if (k.startsWith('obj:')) { const x = JSON.parse(v); if (x.objectType === 'textBox' && x.entity) { delete x.entity.width; delete x.entity.height; } o[k] = JSON.stringify(x); } else if (/^(code|func):/.test(k) && v.indexOf('"comment"') >= 0) o[k] = JSON.stringify(JSON.parse(v), (kk, vv) => (kk === 'comment' && vv && typeof vv === 'object' ? { ...vv, x: 0, y: 0 } : vv)); else o[k] = v; } return o; })`;
async function units(c, server = false) { return c.evalJs(`${STRIP}(__entryHapjak.${server ? 'serverUnits' : 'exportUnits'}())`); }
async function converged(A, B, label, check, ms = 20000) {
  const t0 = Date.now();
  let diff = [], metaDiff = '';
  while (Date.now() - t0 < ms) {
    const [ua, ub, us] = await Promise.all([units(A), units(B), units(A, true)]);
    diff = [];
    if (ua && ub && us) {
      for (const k of new Set([...Object.keys(ua), ...Object.keys(ub), ...Object.keys(us)])) {
        if (ua[k] !== us[k] || ub[k] !== us[k]) diff.push(k);
      }
      if (!diff.length) { check(label, true, `${Math.round((Date.now() - t0) / 100) / 10}초`); return true; }
      if (diff.includes('meta')) {
        const [ma, mb, ms2] = [ua, ub, us].map(u => JSON.parse(u.meta || '{}'));
        const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
        metaDiff = ' · meta 칸: ' + [...new Set([...Object.keys(ma), ...Object.keys(mb), ...Object.keys(ms2)])].filter(k => !same(ma[k], ms2[k]) || !same(mb[k], ms2[k])).join(', ');
      }
    }
    await sleep(300);
  }
  check(label, false, '다른 조각: ' + diff.slice(0, 8).join(', ') + metaDiff);
  return false;
}
const hasBlock = (id) => `JSON.stringify(Entry.exportProject().objects).includes(${JSON.stringify(id)})`;

async function hostRoom(A) {
  await uiClick(A, '.fab');
  await uiClick(A, 'input', null, 0); await A.type('방장');
  await uiClick(A, 'button.main', '새 방 만들기');
  return A.waitFor(`(s => s.mode === 'room' && s.code)(__entryHapjak.status())`, 30000, '방 열림');
}
// A가 방을 열고 B가 초대 코드로 들어온다
async function openRoom(A, B) {
  const code = await hostRoom(A);
  await joinRoom(B, code);
  await A.waitFor(`__entryHapjak.status().members.length === 2`, 10000, '방장이 참가자를 봄');
  return code;
}
async function joinRoom(c, code, name = '참가자', ms = 45000) {
  await uiClick(c, '.fab');
  await uiClick(c, 'input', null, 0); await c.type(name);
  await uiClick(c, 'input', null, 1); await c.type(code);
  await uiClick(c, 'button.sub', '참여하기');
  await c.waitFor(`__entryHapjak.status().mode === 'room'`, ms, '참가자 방 입장');
}

// 엔트리루트 플러그인 블록을 사람처럼 끌어 놓는다
async function dropPluginBlock(A, category, x, y) {
  const J = JSON.stringify;
  const id = await A.evalJs(`(() => { const t = [...document.querySelectorAll('[id^="entryCategoryerplugin_"]')].find(e => e.textContent.includes(${J(category)})); if (!t) return null; t.click(); return t.id.slice('entryCategory'.length); })()`);
  if (!id) throw Error('플러그인 카테고리 없음: ' + category);
  await sleep(2200);
  const r = await A.evalJs(`(() => { const m = Entry.getMainWS().getBlockMenu(); for (const t of m.code.getThreadsByCategory(${J(id)})) { const b = t.getFirstBlock(); const g = b && b.view && b.view.svgGroup; const n = g && (g.node || g[0] || g); const r = n && n.getBoundingClientRect && n.getBoundingClientRect(); if (r && r.width > 0 && r.y > 60 && r.y < innerHeight - 40) return { x: r.x, y: r.y, w: r.width, h: r.height, type: b.type }; } return null; })()`);
  if (!r) throw Error('플러그인 블록이 안 보임: ' + category);
  await A.drag(r.x + Math.min(35, r.w / 2), r.y + r.h / 2, x, y, 18);
  return r.type;
}

module.exports = { checker, uiFind, uiClick, openPanel, STRIP, units, converged, hasBlock, hostRoom, openRoom, joinRoom, dropPluginBlock };

// 참가자가 저장하면 엔트리는 저장한 작품 주소(/ws/<작품 번호>)로 페이지를 새로 연다. 그 페이지에서 같은 방에 다시 들어가는지 본다.
// 로그인 저장은 시험에서 할 수 없어서, 방장이 공개 작품을 /ws/<번호>로 열어 방을 만들고 참가자를 같은 주소로 옮긴다
// (저장한 작품이 방 작품과 같은 오브젝트로 열리는 것과 같은 모양). 작품 번호는 돌릴 때마다 인기 작품 목록에서 고른다.
//   node tests/e2e/rejoin-saved.js [--ext 확장폴더]
const fs = require('fs'), path = require('path');
const { launch, openEntry, closeGuide, sleep } = require('./chrome');
const { checker, converged, openRoom } = require('./room');

const extArg = process.argv.indexOf('--ext');
const ext = path.resolve(extArg > 0 ? process.argv[extArg + 1] : path.resolve(__dirname, '..', '..'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.join(__dirname, 'out', 'rejoin-saved-' + stamp);
fs.mkdirSync(out, { recursive: true });
const { results, check } = checker();
const J = JSON.stringify;
const ready = '!!(window.Entry && Entry.playground && Entry.getMainWS && Entry.getMainWS() && window.__entryHapjak && Entry.container.getAllObjects().length)';
const hasBlock = id => `Entry.container.getAllObjects().some(o => !!o.script.findById(${J(id)}))`;
const addThread = id => `(() => { Entry.do('addThread', [{ id: ${J(id)}, type: 'when_run_button_click', x: 900, y: 120, params: [null] }]); return true; })()`;

(async () => {
  let A, B;
  try {
    [A, B] = await Promise.all([launch({ ext, name: 'A(방장)' }), launch({ ext, name: 'B(참가자)' })]);
    // 너무 크지 않은 공개 작품을 고른다
    await A.send('Page.navigate', { url: 'https://playentry.org/project/list/popular' });
    const ids = await A.waitFor(`(() => { const s = [...document.querySelectorAll('a[href*="/project/"]')].map(a => (a.getAttribute('href').match(/\\/project\\/([0-9a-f]{24})/) || [])[1]).filter(Boolean); return s.length ? [...new Set(s)] : null; })()`, 30000, '공개 작품 목록');
    let pid = null;
    for (const id of ids.slice(0, 8)) {
      await openEntry(A, 'https://playentry.org/ws/' + id);
      const n = await A.waitFor(`${ready} && Entry.container.getAllObjects().length`, 60000, '작품 열림').catch(() => 0);
      if (n && n <= 150) { pid = id; break; }
    }
    check('시험할 공개 작품을 /ws/<번호>로 엶', !!pid);
    if (!pid) return;
    await openEntry(B);
    await openRoom(A, B);
    check('방장이 그 작품으로 방을 열고 참가자가 들어옴', true);
    await B.evalJs(addThread('rsB1'));
    await A.waitFor(hasBlock('rsB1'), 20000, 'A가 참가자 블록 받음');
    await converged(A, B, '옮기기 전 같은 작품', check, 30000);

    // 엔트리가 저장 뒤 하는 것과 같이 저장한 작품 주소로 옮긴다(엔트리는 옮기기 전에 떠나기 확인과 임시 저장본을 지운다 — 여기선 떠나기 확인을 사람처럼 넘김)
    await B.evalJs(`(() => { setTimeout(() => { location.href = '/ws/${pid}?type=normal'; }, 0); return true; })()`);
    for (let i = 0; i < 15; i++) { const r = await B.send('Page.handleJavaScriptDialog', { accept: true }); if (!r.error) break; await sleep(200); }
    await B.waitFor(`location.pathname === '/ws/${pid}'`, 30000, 'B가 저장한 작품 주소로 옮김');
    const no = `(() => { const b = [...document.querySelectorAll('button, a, div, span')].find(el => el.children.length === 0 && el.textContent.trim() === '아니요' && el.getBoundingClientRect().width > 0); if (!b) return false; b.click(); return true; })()`;
    await B.waitFor(`(${ready}) || ${no}`, 90000, 'B 엔트리 열림(작품 복구를 물으면 아니요)');
    await B.waitFor(ready, 90000, 'B 엔트리 열림');
    await sleep(1000); await closeGuide(B);
    const back = await B.waitFor(`__entryHapjak.status().mode === 'room'`, 120000, 'B 같은 방에 다시 들어감').then(() => true, () => false);
    check('저장한 작품 주소로 페이지가 새로 열리면 같은 방에 다시 들어감', back, back ? '' : J(await B.evalJs(`({ mode: __entryHapjak.status().mode, path: location.pathname })`)));
    if (!back) return;
    check('다시 들어간 뒤에도 그 작품 번호 그대로(다음 저장은 내 작품에 덮어씀)', (await B.evalJs('String(Entry.projectId || "")')) === pid);
    await A.waitFor(`__entryHapjak.status().members.length === 2`, 20000, '방장이 다시 들어온 참가자를 봄');
    await A.evalJs(addThread('rsA1'));
    await B.waitFor(hasBlock('rsA1'), 30000, 'B가 다시 들어온 뒤 방장 블록 받음');
    check('다시 들어온 참가자 화면에 옮기기 전 내 블록과 그 뒤 방장 블록이 있음', (await B.evalJs(hasBlock('rsB1'))) && (await B.evalJs(hasBlock('rsA1'))));
    await converged(A, B, '다시 들어온 뒤 같은 작품', check, 60000);
  } catch (err) {
    check('시험 진행', false, String(err && err.stack || err).slice(0, 800));
    try { await A?.screenshot(path.join(out, 'fail-A.png')); await B?.screenshot(path.join(out, 'fail-B.png')); } catch { /* 못 찍음 */ }
  } finally {
    for (const c of [A, B]) if (c) { try { fs.writeFileSync(path.join(out, `diag-${c.name.slice(0, 1)}.txt`), await c.evalJs('__entryHapjak.diagnostics()')); } catch { /* 못 읽음 */ } }
    await Promise.all([A, B].filter(Boolean).map(c => c.close()));
    const fails = results.filter(r => !r.ok);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(results, null, 2));
    console.log(`\n${results.length - fails.length}/${results.length} 통과 · 결과: ${out}`);
    process.exit(fails.length ? 1 : 0);
  }
})();

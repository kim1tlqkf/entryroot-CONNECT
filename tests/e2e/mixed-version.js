// 확장 판이 다른 두 사람(공개본 옛 판 ↔ 이 폴더 판)이 실제 엔트리에서 서로 방을 열고 들어갈 수 있는지 본다.
//   node tests/e2e/mixed-version.js --old <옛 판 확장 폴더>
// 옛 판 폴더를 안 주면 공개 저장소(../entry-hapjak-github)의 origin/main을 꺼내 쓴다.
const fs = require('fs'), path = require('path');
const { execSync } = require('child_process');
const { launch, openEntry } = require('./chrome');
const { checker, converged, hostRoom, joinRoom, hasBlock } = require('./room');

// --cur 폴더: 이 폴더 대신 다른 사본을 "새 판"으로(고치기 전 사본으로 재현할 때)
const curArg = process.argv.indexOf('--cur');
const cur = curArg > 0 ? path.resolve(process.argv[curArg + 1]) : path.resolve(__dirname, '..', '..');
const oldArg = process.argv.indexOf('--old');
let old = oldArg > 0 ? path.resolve(process.argv[oldArg + 1]) : null;
if (!old) {
  old = path.join(__dirname, 'out', 'old-ext');
  fs.rmSync(old, { recursive: true, force: true });
  fs.mkdirSync(old, { recursive: true });
  // tar는 한글 경로를 못 읽어 파일을 하나씩 꺼낸다
  const pub = path.resolve(cur, '..', 'entry-hapjak-github');
  const files = execSync(`git -C "${pub}" -c core.quotePath=false ls-tree -r --name-only origin/main`, { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of files) {
    const dest = path.join(old, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, execSync(`git -C "${pub}" show "origin/main:${f}"`, { maxBuffer: 1 << 28 }));
  }
}
const ver = p => require(path.join(p, 'manifest.json')).version;
const proto = p => Number(fs.readFileSync(path.join(p, 'src', 'sync.js'), 'utf8').match(/const PROTOCOL = (\d+)/)[1]);
console.log(`옛 판 v${ver(old)}(규칙 ${proto(old)}) ↔이 판 v${ver(cur)}(규칙 ${proto(cur)})`);

const { results, check } = checker();

async function pair(hostExt, guestExt, label) {
  let A, B;
  try {
    [A, B] = await Promise.all([launch({ ext: hostExt, name: `A(방장 ${label})` }), launch({ ext: guestExt, name: `B(참가자 ${label})` })]);
    await Promise.all([openEntry(A), openEntry(B)]);
    const code = await hostRoom(A);
    let joined = true;
    try { await joinRoom(B, code, '참가자', 45000); } catch { joined = false; }
    const toast = await B.evalJs(`[...document.querySelectorAll('*')].filter(n => n.shadowRoot).map(n => n.shadowRoot.textContent).join(' ').slice(0, 400)`).catch(() => '');
    check(`${label}: 참가자가 방에 들어옴`, joined, joined ? '' : toast);
    if (!joined) return;
    await converged(A, B, `${label}: 들어온 직후 두 사람 작품이 같음`, check);
    const id = 'mv' + Date.now().toString(36);
    await A.evalJs(`Entry.do('addThread', [{ id: '${id}', type: 'when_run_button_click', x: 420, y: 60, params: [null] }]); true`);
    let got = true;
    try { await B.waitFor(hasBlock(id), 10000, 'B가 받음'); } catch { got = false; }
    check(`${label}: 방장이 더한 블록이 참가자에게 보임`, got);
    const objId = await A.evalJs('Entry.playground.object.id');
    await B.evalJs(`Entry.container.selectObject(${JSON.stringify(objId)}); Entry.do('addThread', [{ id: '${id}b', type: 'when_some_key_pressed', x: 420, y: 200, params: [null, '81'] }]); true`);
    got = true;
    try { await A.waitFor(hasBlock(id + 'b'), 10000, 'A가 받음'); } catch { got = false; }
    check(`${label}: 참가자가 더한 블록이 방장에게 보임`, got);
    await converged(A, B, `${label}: 고친 뒤 두 사람 작품이 같음`, check);
  } catch (err) {
    check(`${label}: 시험 중 오류 없음`, false, String(err && err.message || err).slice(0, 200));
  } finally {
    await Promise.all([A && A.close(), B && B.close()].filter(Boolean)).catch(() => {});
  }
}

(async () => {
  await pair(cur, old, '새 판 방장·옛 판 참가자');
  await pair(old, cur, '옛 판 방장·새 판 참가자');
  await pair(cur, cur, '같은 판끼리');
  const bad = results.filter(r => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} 통과`);
  process.exit(bad.length ? 1 : 0);
})();

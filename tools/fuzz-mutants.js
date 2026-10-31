// 무작위 편집 시험이 실제로 결함을 잡는지 잰다: 고쳐 둔 부분을 하나씩 일부러 되돌린 확장 사본(돌연변이)을 만들어 시험을 돌린다.
// 시험이 실패해야 정상이다. 통과해 버린 돌연변이는 시험이 못 보는 곳이다 — 그 자리를 보는 확인을 시험에 더한다.
// 무작위 편집으로 만들기 어려운 조건(엔트리가 명령 없이 바꾸는 값)은 그걸 만드는 시험(derived.js)으로 잰다.
//   node tools/fuzz-mutants.js [--seeds 1,2] [--rounds 40] [--only 이름]
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i < 0 ? def : process.argv[i + 1]; };
const seeds = arg('seeds', '1,2').split(',');
const rounds = arg('rounds', '40');
const only = arg('only', null) && arg('only').split(',');

// [이름, 파일, 찾을 글, 바꿀 글, 되살아나는 결함, 잡아야 할 시험(없으면 무작위 편집), 무작위 편집이 못 잡으면 돌려 볼 전용 시험]
const MUTANTS = [
  ['own-groups', 'src/entry-adapter.js', 'patched = onBoard ? run() : withOwnGroups(obj.script, run);', 'patched = run();', '다른 오브젝트 블록이 지금 블록 화면에 그려짐'],
  ['undo-drop', 'src/entry-adapter.js', "dropUndoIfTouches('obj:' + id, onBoard);", '', '되돌리기가 남이 더한 블록을 지움', null, 'run'],
  ['restore-view', 'src/entry-adapter.js', 'if (!opts.fresh) restoreView(view);', '', '다시 불러온 뒤 보던 오브젝트가 바뀜'],
  ['var-order', 'src/entry-adapter.js', 'vc.variables_.sort((a, b) => pos(a) - pos(b));', '', '변수 순서가 사람마다 다름'],
  ['keep-local', 'src/sync.js', 'if (nn(E[k]) !== nn(this.seen.get(k))) continue;', '', '받은 변경이 아직 안 보낸 내 편집을 덮음'],
  ['thread-merge', 'src/merge.js', 'r = mergeKeyed(B, T, M, threadKey);', 'r = null;', '같은 오브젝트의 다른 묶음을 동시에 고치면 한쪽이 사라짐'],
  ['lazy-codes', 'src/entry-adapter.js', 'lazyCodes.add(this);', '', '스크롤 직후 다른 오브젝트로 옮기면 좌표를 바뀐 것으로 보냄', null, 'multi'],
  ['picture-scale', 'src/merge.js', 'if (rest.sprite && Array.isArray(rest.sprite.pictures)) rest.sprite = { ...rest.sprite, pictures: rest.sprite.pictures.map(canonPicture) };', '', '처음 실행 뒤 받은 오브젝트 변경에 작품을 통째로 다시 불러옴', 'derived'],
  ['comment-clean', 'src/sync.js', 'const m = this.adapter.cleanLocal && b != null && E[k] != null ? this.adapter.cleanLocal(k, b, E[k]) : nn(E[k]);', 'const m = nn(E[k]);', '글꼴 때문에 밀린 메모를 내 편집으로 보내 모두의 메모가 옮겨짐', 'derived'],
  ['comment-moved', 'src/entry-adapter.js', 'if (ck) movedComments.add(', 'if (false) movedComments.add(', '사람이 옮긴 메모 자리가 다른 사람에게 안 감', 'derived'],
  ['var-pin', 'src/entry-adapter.js', 'vc.appendVariables([j]); pinVarPositions([j]);', 'vc.appendVariables([j]);', 'x=0에 둔 변수를 받으면 작품을 통째로 다시 불러옴', 'derived'],
  ['comment-prev', 'src/entry-adapter.js', 'prevOf(k) === b && commentFree(JSON.parse(a))', 'commentFree(JSON.parse(a))', '남이 옮긴 메모 자리가 받는 쪽에 안 들어감', 'derived'],
  ['comment-verify', 'src/entry-adapter.js', "if (k.startsWith('code:') || k.startsWith('func:')) { try { return commentFree(JSON.parse(a)) === commentFree(JSON.parse(b)); } catch { return false; } }", '', '메모가 밀린 오브젝트에 남의 변경이 오면 통째로 다시 불러옴', 'derived'],
  ['text-mode', 'src/entry-adapter.js', "(bk && bk.startsWith('obj:') && p.code.includes('code:' + bk.slice(4))))) return false;", "false)) return false;", '엔트리파이선에서 블록으로 돌아오면 그사이 남이 더한 블록이 지워짐', 'surfaces'],
  ['text-mode-func', 'src/entry-adapter.js', 'p.full || p.func.length || p.funcOrder || (bk', 'p.full || (bk', '엔트리파이선에서 블록으로 돌아오면 그사이 남이 고친 함수가 옛 정의로 덮임', 'surfaces'],
  ['code-wipe', 'src/sync.js', 'if (wiped.length) {', 'if (false) {', '엔트리파이선 글을 블록으로 못 바꿔 비워진 블록이 방에 퍼져 모두의 블록이 지워짐', 'unit'],
  ['system-vars', 'src/entry-adapter.js', 'if (v != null && nt === ot) p.sys.push(k); else p.full = true;', 'p.full = true;', '초시계·대답 블록을 남이 쓰면 작품을 통째로 다시 불러옴', 'surfaces'],
  ['obj-order', 'src/entry-adapter.js', 'p.objOrder = true;', 'p.full = true;', '오브젝트 순서만 바꿔도 작품을 통째로 다시 불러옴', 'surfaces'],
  ['scene-name', 'src/entry-adapter.js', 'p.scenes.push(k);', 'p.full = true;', '장면 이름만 바꿔도 작품을 통째로 다시 불러옴', 'surfaces'],
  ['dropped-notify', 'src/sync.js', 'if (dropped.length && this.hooks.onConflict) this.hooks.onConflict(dropped);', '', '남이 지운 오브젝트에 한 안 보낸 편집이 알림 없이 사라짐', 'unit'],
  ['rejoin', 'src/main.js', '\n  tryRejoin();', '', '참가자가 저장해 페이지가 새로 열리면 방에서 나가짐', 'rejoin'],
];
// 시험 이름 → 그 시험을 돌리는 인자(e2e는 --ext 돌연변이 폴더를 붙인다. unit은 돌연변이 폴더 안에서 돈다)
const TESTS = {
  derived: ['tests/e2e/derived.js'], run: ['tests/e2e/run.js'], multi: ['tests/e2e/multi-object.js'],
  surfaces: ['tests/e2e/surfaces.js', '--only', 'textbox,timerAnswer,reorder,python,scene'],
  rejoin: ['tests/e2e/surfaces.js', '--only', 'rejoin'],
  unit: ['--test', 'tests/unit/sync.test.js'],
};
const testRun = (test, dir) => (test === 'unit' ? { args: TESTS.unit, cwd: dir } : { args: [...TESTS[test], '--ext', dir], cwd: root });

const copyExt = dir => {
  for (const name of ['manifest.json']) fs.copyFileSync(path.join(root, name), path.join(dir, name));
  for (const sub of ['src', 'vendor', 'icons', 'tests/unit']) fs.cpSync(path.join(root, sub), path.join(dir, sub), { recursive: true });
};
const results = [];
for (const [name, file, find, repl, defect, test, fallback] of MUTANTS) {
  if (only && !only.includes(name)) continue;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mutant-${name}-`));
  try {
    copyExt(dir);
    const f = path.join(dir, file), src = fs.readFileSync(f, 'utf8');
    if (src.split(find).length !== 2) { results.push({ name, defect, killed: null, why: '찾을 글이 한 군데가 아님(돌연변이 정의를 고칠 것)' }); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    let killedBy = null;
    for (const s of test ? ['-'] : seeds) {
      console.log(`\n=== 돌연변이 ${name}(${defect}) ${test ? TESTS[test].join(' ') : 'seed ' + s}`);
      const { args, cwd } = test ? testRun(test, dir) : { args: ['tests/e2e/fuzz.js', '--seed', s, '--rounds', rounds, '--ext', dir], cwd: root };
      const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
      const lines = (r.stdout || '').split('\n').filter(l => /^(FAIL|PASS|✖)/.test(l));
      const fails = lines.filter(l => /^(FAIL|✖)/.test(l));
      console.log((fails.length ? fails : lines).slice(0, 4).map(l => l.slice(0, 300)).join('\n'));
      if (r.status !== 0) { killedBy = { test: test || 'fuzz', seed: s, first: (fails[0] || lines[0] || '').slice(0, 300) }; break; }
    }
    if (!killedBy && fallback) {
      console.log(`\n=== 돌연변이 ${name}: 무작위 편집이 못 잡아 ${TESTS[fallback].join(' ')}로`);
      const { args, cwd } = testRun(fallback, dir);
      const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
      const fails = (r.stdout || '').split('\n').filter(l => l.startsWith('FAIL'));
      console.log(fails.slice(0, 3).map(l => l.slice(0, 300)).join('\n'));
      if (r.status !== 0) killedBy = { test: fallback, seed: '-', first: (fails[0] || '').slice(0, 300), fuzzMissed: true };
    }
    results.push({ name, defect, killed: !!killedBy, by: killedBy });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
console.log('\n── 결과 ──');
for (const r of results) console.log(`${r.killed ? (r.by.fuzzMissed ? '전용만 ' : '잡음  ') : r.killed === null ? '오류  ' : '못 잡음'} ${r.name}: ${r.defect}${r.by ? `  (${r.by.test}${r.by.seed !== '-' ? ' seed ' + r.by.seed : ''}: ${r.by.first})` : r.why ? `  (${r.why})` : ''}`);
fs.mkdirSync(path.join(root, 'tests', 'e2e', 'out'), { recursive: true });
fs.writeFileSync(path.join(root, 'tests', 'e2e', 'out', `mutants-${Date.now()}.json`), JSON.stringify({ seeds, rounds, results }, null, 1));
process.exit(results.every(r => r.killed) ? 0 : 1);

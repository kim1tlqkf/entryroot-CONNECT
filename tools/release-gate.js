// 쓰는 사람에게 가는 파일(확장으로 실제 실행되는 것)이 시험을 모두 통과한 바로 그 내용인지 확인한다.
// 공개 사본 맞추기(sync-public-copy)가 먼저 부른다 — 시험을 안 돌렸거나 돌린 뒤 한 글자라도 고쳤으면 사본에 넣지 않는다.
//   node tools/release-gate.js            지금 상태 확인
//   node tools/release-gate.js --self-test
const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');

const SHIPPED = /^(manifest\.json|src\/[^/]+\.js|vendor\/[^/]+)$/;
const recordPath = root => path.join(root, 'tests', 'e2e', 'out', 'release-pass.json');

function shippedFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!['.git', 'node_modules', 'tests'].includes(e.name)) walk(path.join(dir, e.name), name); } else if (SHIPPED.test(name)) out.push(name);
    }
  };
  walk(root, '');
  return out.sort();
}
function shippedHash(root) {
  const h = crypto.createHash('sha256');
  for (const name of shippedFiles(root)) { h.update(name + '\0'); h.update(fs.readFileSync(path.join(root, name))); h.update('\0'); }
  return h.digest('hex');
}
function writeRecord(root, info) {
  fs.mkdirSync(path.dirname(recordPath(root)), { recursive: true });
  fs.writeFileSync(recordPath(root), JSON.stringify({ hash: shippedHash(root), at: new Date().toISOString(), ...info }, null, 1));
}
function gate(root) {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(recordPath(root), 'utf8')); } catch { return { ok: false, why: '시험 통과 기록이 없음 — 먼저 npm run verify' }; }
  if (rec.hash !== shippedHash(root)) return { ok: false, why: `시험(${rec.at}) 뒤에 확장 파일이 바뀜 — 다시 npm run verify` };
  return { ok: true, rec };
}

function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-test-'));
  const put = (name, text) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); };
  const cases = [];
  try {
    put('manifest.json', '{}'); put('src/a.js', 'a'); put('README.md', '읽어보기');
    cases.push(['기록 없으면 막음', !gate(dir).ok]);
    writeRecord(dir, { steps: [] });
    cases.push(['통과 뒤 그대로면 통과', gate(dir).ok]);
    put('README.md', '바뀐 설명');
    cases.push(['확장 밖 파일(README)만 바뀌면 통과', gate(dir).ok]);
    put('src/a.js', 'b');
    cases.push(['통과 뒤 src가 바뀌면 막음', !gate(dir).ok]);
    put('src/a.js', 'a'); put('src/new.js', 'x');
    cases.push(['통과 뒤 src에 파일이 늘면 막음', !gate(dir).ok]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  for (const [name, ok] of cases) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  return cases.every(([, ok]) => ok);
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const r = gate(path.resolve(__dirname, '..'));
  console.log(r.ok ? `통과 기록과 같음(${r.rec.at})` : r.why);
  process.exit(r.ok ? 0 : 1);
}
module.exports = { gate, shippedHash, writeRecord, recordPath };

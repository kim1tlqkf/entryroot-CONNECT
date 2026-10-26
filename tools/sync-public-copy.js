// 공개 저장소(GitHub)에 올릴 사본 폴더를 이 폴더에서 맞춘다 — 허용 목록(tools/public-files.js)에 있는 파일만 복사하고, 사본에 남은 목록 밖
// 파일은 알린다. 마지막에 공개 전 검사(public-copy-check)를 돌려 하나라도 걸리면 실패로 끝난다 — 통과 전에는 올리지 않는다.
//   node tools/sync-public-copy.js <사본 폴더>
const fs = require('fs'), path = require('path');
const { isPublic } = require('./public-files');
const { check } = require('./public-copy-check');
const root = path.resolve(__dirname, '..');
const dest = process.argv[2] && path.resolve(process.argv[2]);
if (!dest || dest === root) { console.log('쓰는 법: node tools/sync-public-copy.js <사본 폴더>(이 폴더가 아닌 곳)'); process.exit(2); }
fs.mkdirSync(dest, { recursive: true });
function* walk(dir, rel = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { if (!['.git', 'node_modules'].includes(entry.name) && name !== 'tests/e2e/out') yield* walk(path.join(dir, entry.name), name); }
    else yield name;
  }
}
let copied = 0;
for (const name of walk(root)) {
  if (!isPublic(name)) continue;
  const from = path.join(root, name), to = path.join(dest, name);
  if (fs.existsSync(to) && Buffer.compare(fs.readFileSync(from), fs.readFileSync(to)) === 0) continue;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log('복사', name); copied++;
}
for (const name of walk(dest)) if (!isPublic(name)) console.log('목록 밖 파일(올리지 마세요)', name);
const hits = check(dest, { publicCopy: true });
for (const hit of hits) console.log(hit);
console.log(`복사 ${copied}개 — ${hits.length ? `공개 전 검사 실패 ${hits.length}곳: 고친 뒤 다시 돌리세요` : '공개 전 검사 통과'}`);
process.exit(hits.length ? 1 : 0);

// 공개 사본에 퍼지면 안 되는 것을 찾는다: 엔트리 작품 번호·올린 그림 파일 이름, 내 컴퓨터 경로, 이메일, --public-copy면 허용 목록 밖 파일.
// 하나라도 있으면 실패(종료 코드 1). 낱말·형태 목록이라 목록 밖은 못 잡으므로 공개 사본은 허용 목록으로만 만든다(sync-public-copy.js).
// vendor/는 남의 코드라 내용 검사에서 빼고, 이 파일은 심은 예시가 있어 정확히 이 경로일 때만 뺀다.
//   node tools/public-copy-check.js <폴더> [--public-copy]
//   node tools/public-copy-check.js --self-test
const fs = require('fs'), path = require('path');
const { isPublic } = require('./public-files');

const TEXT = /\.(js|json|md|txt|html|css|svg)$|^(LICENSE|\.gitignore)$/i;
const SELF = 'tools/public-copy-check.js';
// 컴퓨터 사용자 이름처럼 이 파일에 적으면 그 자체로 공개되는 낱말은 공개하지 않는 tools/private-terms.txt에 한 줄에 하나씩 둔다.
const PRIVATE = (() => {
  try { return fs.readFileSync(path.join(__dirname, 'private-terms.txt'), 'utf8').split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(Boolean); }
  catch { return []; }
})();
const RULES = [
  { name: '엔트리 작품 번호(24자리)', find: line => /(?<![0-9a-f])[0-9a-f]{24}(?![0-9a-f])/i.exec(line) },
  // 엔트리가 올린 그림에 주는 이름: 16진수 8자 + 영숫자 24자(뒤쪽에 g~z가 섞임 — 해시와 가름)
  { name: '엔트리 그림 파일 이름', find: line => {
    for (const m of line.matchAll(/(?<![0-9a-z])[0-9a-f]{8}([0-9a-z]{24})(?![0-9a-z])/gi)) if (/[g-z]/i.test(m[1])) return m;
    return null;
  } },
  { name: '내 컴퓨터 경로', find: line => /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s'"`]+|\/[a-z]\/Users\/[^/\s'"`]+|AppData[\\/]|\.claude[\\/]projects/i.exec(line) },
  { name: '이메일', find: line => /[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com|anthropic\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(line) },
  { name: '비공개 낱말', find: line => { const low = line.toLowerCase(), t = PRIVATE.find(t => low.includes(t)); return t ? [t] : null; } },
];

function* walk(dir, rel = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { if (!['.git', 'node_modules'].includes(entry.name)) yield* walk(path.join(dir, entry.name), name); }
    else yield name;
  }
}

function checkText(name, text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const rule of RULES) { const m = rule.find(line); if (m) hits.push(`${name}:${i + 1} ${rule.name}: ${String(m[0]).slice(0, 60)}`); }
  });
  return hits;
}

function check(dir, { publicCopy = false } = {}) {
  const hits = [];
  for (const name of walk(dir)) {
    if (publicCopy && !isPublic(name)) hits.push(`${name} 허용 목록 밖 파일`);
    if (name === SELF || name.startsWith('vendor/') || !TEXT.test(path.basename(name))) continue;
    hits.push(...checkText(name, fs.readFileSync(path.join(dir, name), 'utf8')));
  }
  return hits;
}

function selfTest() {
  const planted = ['작품 6adc1a99e80ed3be08d772e5', '그림 56c1ee22mvothywx0006fd469c7efahd.png', 'C:\\Users\\someone\\Downloads', '/c/Users/someone/x', 'mail me@example.com'];
  const clean = ['엔트리봇 7y0y', 'stun:stun.l.google.com:19302', 'Co-Authored-By: Claude <noreply@anthropic.com>', 'sha 4739924', 'x 123456789012345678901234567890abcd'];
  const missed = planted.filter(line => !checkText('t', line).length);
  const falsePos = clean.filter(line => checkText('t', line).length);
  return { ok: !missed.length && !falsePos.length, missed, falsePos };
}

if (require.main === module) {
  if (process.argv.includes('--self-test')) { const r = selfTest(); console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); }
  const dir = process.argv[2] && path.resolve(process.argv[2]);
  if (!dir || !fs.existsSync(dir)) { console.log('쓰는 법: node tools/public-copy-check.js <폴더> [--public-copy]'); process.exit(2); }
  const hits = check(dir, { publicCopy: process.argv.includes('--public-copy') });
  for (const hit of hits) console.log(hit);
  console.log(hits.length ? `공개 전 검사 실패 ${hits.length}곳` : '공개 전 검사 통과');
  process.exit(hits.length ? 1 : 0);
}
module.exports = { check, checkText, selfTest };

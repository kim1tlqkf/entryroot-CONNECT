// 공개 전에 도는 시험 전부: 엔트리 없는 시험, 실제 엔트리 흐름 시험, 서로 다른 오브젝트 시험, 무작위 편집 시험(seed 여러 개).
// 모두 통과하면 그때의 확장 파일 지문을 남긴다(tests/e2e/out/release-pass.json). 공개 사본 맞추기는 이 지문이 지금과 같을 때만 복사한다.
// 무작위 시험 seed는 돌릴 때마다 새로 뽑는다 — 같은 seed만 반복하면 같은 길만 보게 된다.
//   node tools/verify.js [--fuzz-seeds 3] [--fuzz-rounds 60]
const path = require('path');
const { spawnSync } = require('child_process');
const { shippedHash, writeRecord } = require('./release-gate');

const root = path.resolve(__dirname, '..');
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i < 0 ? def : process.argv[i + 1]; };
const seeds = Array.from({ length: Number(arg('fuzz-seeds', '3')) }, () => Math.floor(Math.random() * 1e9));
const rounds = arg('fuzz-rounds', '60');
const unit = ['merge', 'sync', 'net', 'regression'].map(n => `tests/unit/${n}.test.js`);
const steps = [
  ['통과 기록 장치 자체 시험', ['tools/release-gate.js', '--self-test']],
  ['공개 전 검사 자체 시험', ['tools/public-copy-check.js', '--self-test']],
  ['엔트리 없는 시험', ['--test', ...unit]],
  ['실제 엔트리 흐름 시험', ['tests/e2e/run.js']],
  ['서로 다른 오브젝트 시험', ['tests/e2e/multi-object.js']],
  ['엔트리가 명령 없이 바꾸는 값 시험', ['tests/e2e/derived.js']],
  ['편집 종류별 시험(함수·장면·리스트·소리·글상자·파이선·끊김 등)', ['tests/e2e/surfaces.js']],
  ['참가자가 저장해 페이지가 새로 열린 뒤 같은 방에 다시 들어가기 시험', ['tests/e2e/rejoin-saved.js']],
  // 마지막 seed는 둘이 고치는 도중에 세 번째 사람이 들어온다
  ...seeds.map((s, i) => [`무작위 편집 시험 seed ${s}${i === seeds.length - 1 ? ' (중간 참여)' : ''}`, ['tests/e2e/fuzz.js', '--seed', String(s), '--rounds', rounds, ...(i === seeds.length - 1 ? ['--join-mid'] : [])]]),
];

const before = shippedHash(root);
const done = [];
for (const [name, args] of steps) {
  console.log(`\n=== ${name}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  done.push({ name, ok: r.status === 0, sec: Math.round((Date.now() - t0) / 1000) });
  if (r.status !== 0) {
    console.log(`\n실패: ${name} — 통과 기록을 남기지 않음`);
    process.exit(1);
  }
}
if (shippedHash(root) !== before) { console.log('\n시험하는 동안 확장 파일이 바뀌어 통과 기록을 남기지 않음 — 다시 돌리세요'); process.exit(1); }
writeRecord(root, { steps: done, fuzz: { seeds, rounds: Number(rounds) } });
console.log('\n모두 통과 — 통과 기록을 남김:', done.map(d => `${d.name} ${d.sec}초`).join(' · '));

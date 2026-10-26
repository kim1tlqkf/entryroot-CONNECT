// 공개 저장소(GitHub 사본)에 올려도 되는 파일 — 허용 목록. 여기 없는 것은 공개하지 않는다(시험 결과물 tests/e2e/out/, 작품 파일 등).
// README의 개발 안내가 시험·도구를 가리키므로 시험 코드와 tools/는 공개한다.
const ALLOW = [
  /^(manifest\.json|package\.json|LICENSE|README\.md|\.gitignore)$/,
  /^src\/[^/]+\.js$/,
  /^vendor\/[^/]+$/,
  /^icons\/[^/]+\.png$/,
  /^docs\/[^/]+\.md$/,
  /^tests\/(unit|e2e)\/[^/]+\.js$/,
  /^tools\/[^/]+\.js$/,
];
const isPublic = rel => ALLOW.some(rule => rule.test(rel));
module.exports = { isPublic };

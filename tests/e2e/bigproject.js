// 성능 시험용 큰 작품: 오브젝트 n개 × 블록 묶음 t개 × 묶음마다 블록 b개, 오브젝트마다 모양 p개
// 페이지 안에서 실행할 코드(문자열)를 돌려준다.
module.exports = (n, t, b, p) => `(() => {
  const base = Entry.exportProject();
  const o0 = base.objects[0];
  const objs = [];
  for (let i = 0; i < ${n}; i++) {
    const pics = [];
    for (let k = 0; k < ${p}; k++) pics.push({ ...o0.sprite.pictures[0], id: 'pic' + i + '_' + k, name: '모양' + k });
    const threads = [];
    for (let j = 0; j < ${t}; j++) {
      const th = [{ id: 'h' + i + '_' + j, type: 'when_run_button_click', x: 40 + (j % 4) * 260, y: 40 + Math.floor(j / 4) * 400, params: [null] }];
      for (let q = 0; q < ${b}; q++) th.push({ id: 'b' + i + '_' + j + '_' + q, type: q % 2 ? 'move_x' : 'move_y', params: [{ id: 'n' + i + '_' + j + '_' + q, type: 'number', params: [String(q)] }, null] });
      threads.push(th);
    }
    objs.push({ ...o0, id: 'perf' + i, name: '오브젝트' + i, script: JSON.stringify(threads), sprite: { pictures: pics, sounds: [] }, selectedPictureId: pics[0].id });
  }
  base.objects = objs;
  Entry.clearProject(); Entry.loadProject(base);
  return { objects: objs.length, blocks: ${n * t * (b + 1)}, jsonKB: Math.round(JSON.stringify(Entry.exportProject()).length / 1024) };
})()`;

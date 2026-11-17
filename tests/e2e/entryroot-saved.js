// 엔트리루트로 저장한 작품(erinfo 있음)을 켠 사람과 안 켠 사람이 같은 방에서 쓸 때 두 모양이 섞여 안 켠 사람 엔트리가 없는 함수를 부르지 않는지 본다.
//   node tests/e2e/entryroot-saved.js --entryroot <폴더> --fixture <작품.json> --order <순서> [--ext 폴더] [--idle 초] [--form saved|edit]
//   (또는 환경 변수 ENTRYROOT_EXT·ENTRYROOT_FIXTURE. 작품 파일은 저장소에 넣지 않는다. --form edit: erinfo 없는 옛 저장본)
//   순서: idle·edit·off-edit·plugin·reload·leave·leave-paint·leave-run·rejoin(켠 참가자가 가만히/고침/안 켠 방장이 고침/플러그인 블록/새로고침/나감/
//         그리던 그림이 있는 채 나감/실행 중에 나감/끄고 다시 들어옴), reopen(방 안에서 안 켠 방장이 저장본을 새로 열기), on-host(켠 방장·안 켠 참가자), both-on(둘 다 켬), reload-no(복구 창에 아니요), reload-other(방 안에서 --other 작품을 연 채 새로고침)
const fs = require('fs'), path = require('path');
const { launch, openEntry, closeGuide, sleep } = require('./chrome');
const { checker, converged, uiClick, openPanel, hostRoom, openRoom, joinRoom, dropPluginBlock } = require('./room');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i < 0 ? def : process.argv[i + 1]; };
const unix = p => p.replace(/\\/g, '/');
const ext = unix(path.resolve(arg('ext', path.resolve(__dirname, '..', '..'))));
const er = unix(arg('entryroot', process.env.ENTRYROOT_EXT || ''));
const fixture = arg('fixture', process.env.ENTRYROOT_FIXTURE || '');
const order = arg('order', 'idle');
const idleSec = Number(arg('idle', '45'));
if (!er || !fs.existsSync(path.join(er, 'manifest.json'))) { console.log('엔트리루트 확장 폴더가 없어 이 시험을 못 돌림(--entryroot 또는 ENTRYROOT_EXT)'); process.exit(2); }
if (!fixture || !fs.existsSync(fixture)) { console.log('저장본 작품 JSON이 없어 이 시험을 못 돌림(--fixture 또는 ENTRYROOT_FIXTURE)'); process.exit(2); }
const other = arg('other', '');
if (order === 'reload-other' && !fs.existsSync(other)) { console.log('다른 작품 JSON이 없어 이 순서를 못 돌림(--other)'); process.exit(2); }
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = path.join(__dirname, 'out', `entryroot-saved-${order}-${stamp}`);
fs.mkdirSync(out, { recursive: true });
const { results, check } = checker();
const J = JSON.stringify;
const REJOIN_KEY = 'entryHapjakRejoin';

// 방 조각 판정: 저장 모양 조각이 있는지, 없는 함수를 부르는 조각이 몇 개인지
const JUDGE = `(u => {
  if (!u) return null;
  const keys = Object.keys(u);
  const funcs = new Set(keys.filter(k => k.startsWith('func:')).map(k => k.slice(5)));
  const missing = new Set(), where = new Set();
  for (const k of keys) {
    if (!k.startsWith('code:') && !k.startsWith('func:')) continue;
    for (const m of String(u[k]).matchAll(/"type":"func_([A-Za-z0-9_]+)"/g)) if (!funcs.has(m[1])) { missing.add(m[1]); where.add(k); }
  }
  return { funcs: funcs.size, savedFuncs: keys.filter(k => /^func:er[ei][0-9a-z]{3}$/.test(k)).length, editFuncs: keys.filter(k => /^func:ers0/.test(k)).length,
    erinfo: !!u['var:erinfo'], erstate: !!u['var:erstate'], codeKeys: keys.filter(k => k.startsWith('code:')).length,
    missingCalls: missing.size, inPieces: where.size, sample: [...missing].slice(0, 3).map(x => x.slice(0, 24)), pieces: [...where].slice(0, 5) };
})`;
const room = c => c.evalJs(`${JUDGE}(__entryHapjak.serverUnits())`);
const mine = c => c.evalJs(`${JUDGE}(__entryHapjak.exportUnits())`);
const broken = j => !!j && j.missingCalls > 0;
const screenUnits = c => c.evalJs(`__entryHapjak.exportUnits()`);
// 엔트리루트가 받은 그대로 불러온 작품을 들고 있는가. 옛 판은 이 값이 없어 null이다
const verbatimHeld = c => c.evalJs(`(o => { const f = o && o.facts && o.facts(); return f && 'holdingVerbatim' in f ? f.holdingVerbatim : null; })(globalThis[Symbol.for('entryroot.artifact-compiler/1')])`);

// 저장본에서 꺼낸 그림 파일은 이 페이지에서 못 읽고, 깨진 그림은 실행을 멈춘다 — 한 칸 그림으로 바꿔 코드만 본다
const DOT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
function fixtureText(file) {
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const o of p.objects) for (const x of (o.sprite && o.sprite.pictures) || []) x.fileurl = DOT;
  return J(p);
}
async function loadFixture(c, file = fixture) {
  await c.send('Runtime.evaluate', { expression: `window.__fixture = ${J(fixtureText(file))}; true` });
  await c.evalJs(`(() => { const p = JSON.parse(window.__fixture); delete window.__fixture; Entry.clearProject(); Entry.loadProject(p); return true; })()`);
  await sleep(3000);
}

// 안 켠 사람 엔트리에서 장면마다 잠깐 실행해 멈추는지 본다(소리 파일 없음은 시험 작품 사정이라 뺀다)
const NOISE = /Unable to decode audio data|soundjs|reading 'apply'/;
async function runScenes(c, sec = 2) {
  const ids = await c.evalJs(`Entry.scene.getScenes().map(s => s.id)`);
  const res = [];
  for (const id of ids) {
    const e0 = c.exceptions.length;
    await c.evalJs(`(() => { Entry.scene.selectScene(Entry.scene.getScenes().find(s => s.id === ${J(id)})); return true; })()`);
    await sleep(400);
    await c.evalJs(`(Entry.engine.toggleRun(), true)`);
    await sleep(sec * 1000);
    const toast = await c.evalJs(`[...document.querySelectorAll('.entryToast')].map(n => n.innerText.trim()).filter(Boolean).slice(0, 2)`);
    await c.evalJs(`[...document.querySelectorAll('.entryToast')].forEach(n => n.remove()); true`);
    await c.evalJs(`(Entry.engine.isState('stop') || Entry.engine.toggleStop(), true)`);
    await sleep(900);
    const errs = c.exceptions.slice(e0).map(e => e.text).filter(t => !NOISE.test(t));
    res.push({ scene: id, errors: [...new Set(errs)].slice(0, 2).map(t => t.slice(0, 140)), toast });
  }
  return res;
}
const failedScenes = r => r.filter(x => x.errors.length || x.toast.some(t => /error|오류/i.test(t)));

// 첫 키 입력 뒤 3초 동안 돌아가며 다시 보기가 쉰다 — 찾아내는 길을 사용자의 편집 하나로 좁힐 때 쓴다
const keepTyping = c => c.evalJs(`(() => { window.__keepTyping = setInterval(() => window.dispatchEvent(new KeyboardEvent('keydown')), 500); return true; })()`);
const stopTyping = c => c.evalJs(`(() => { clearInterval(window.__keepTyping); return true; })()`);
// 플러그인 함수를 부르는 오브젝트에 블록 묶음을 더한다(사람의 편집과 같은 명령)
const EDIT = id => `(() => {
  const plain = Entry.container.getAllObjects().filter(x => !/^ers0o/.test(x.id));
  const o = plain.find(x => /"func_ers0|"func_er[ei]/.test(JSON.stringify(x.script.toJSON()))) || plain[0];
  Entry.container.selectObject(o.id);
  Entry.do('addThread', [{ id: ${J(id)}, type: 'when_run_button_click', x: 900, y: 900, params: [null] }]);
  return o.id;
})()`;
const hasThread = id => `Entry.container.getAllObjects().some(o => !!o.script.findById(${J(id)}))`;
const dialogButton = (c, label) => uiClick(c, 'button', label);
// 엔트리의 떠나기 확인 창과 작품 복구 창을 사람처럼 넘긴다
async function reloadPage(c) {
  await c.send('Page.reload', {});
  for (let i = 0; i < 15; i++) { const r = await c.send('Page.handleJavaScriptDialog', { accept: true }); if (!r.error) break; await sleep(200); }
}
const pressDialog = label => `[...document.querySelectorAll('button, a, div, span')].find(el => el.children.length === 0 && el.textContent.trim() === ${J(label)} && el.getBoundingClientRect().width > 0)?.click()`;
const PEOPLE_OBJS = `Entry.container.getAllObjects().map(o => String(o.id)).filter(id => !/^ers0o/.test(id)).sort().join()`;
const buttons = c => c.evalJs(`[...document.getElementById('entry-hapjak-root').shadowRoot.querySelectorAll('button')].filter(b => b.getBoundingClientRect().width > 0).map(b => b.textContent)`);

async function watchRoom(H, A, sec, label) {
  const t0 = Date.now();
  let j = null, first = null;
  const log = [];
  while (Date.now() - t0 < sec * 1000) {
    j = await room(H);
    log.push({ t: Math.round((Date.now() - t0) / 1000), missing: j && j.missingCalls, pieces: j && j.inPieces });
    if (broken(j) && first === null) first = Math.round((Date.now() - t0) / 1000);
    await sleep(3000);
  }
  const sent = A ? await A.evalJs(`__entryHapjak.status().sent.map(s => s.keys)`) : [];
  console.log(`  [${label}] 방 조각 판정:`, J(j), ' 처음 끊긴 때(초):', first, ' 켠 사람이 보낸 조각:', J(sent.flat().slice(0, 12)));
  fs.writeFileSync(path.join(out, `watch-${label}.json`), J({ log, final: j, first, sent }, null, 1));
  return j;
}

// 끝 판정: 방 조각이 온전하고, 안 켠 사람이 멈추지 않고, 모든 장면을 돌릴 수 있다
async function verdict(H, off) {
  const j = await room(H);
  fs.writeFileSync(path.join(out, 'room-final.json'), J(j, null, 1));
  fs.writeFileSync(path.join(out, 'room-units.json'), J(await H.evalJs('__entryHapjak.serverUnits()')));
  check('방 작품이 끊기지 않음(없는 함수를 부르는 조각 없음)', !broken(j), J(j));
  const st = await off.evalJs('__entryHapjak.status().client');
  check('안 켠 사람의 맞추기가 멈추지 않음', st && !st.paused, J(st));
  const scenes = await runScenes(off);
  fs.writeFileSync(path.join(out, 'off-scenes.json'), J(scenes, null, 1));
  check('안 켠 사람이 모든 장면을 실행해도 멈추지 않음', !failedScenes(scenes).length, J(failedScenes(scenes)).slice(0, 400));
}

(async () => {
  let A, B, C;
  try {
    const bothOn = order === 'both-on';
    [A, B] = await Promise.all([launch({ ext: [ext, er], name: 'A(엔트리루트)' }), launch({ ext: bothOn ? [ext, er] : ext, name: bothOn ? 'B(엔트리루트)' : 'B(합작만)' })]);
    await Promise.all([openEntry(A), openEntry(B)]);
    await A.waitFor(`JSON.stringify(Entry.playground.object.script.toJSON()).includes('entryroot_flow_')`, 60000, '엔트리루트 준비').catch(() => {});
    const hostOn = order === 'on-host' || bothOn;
    const [H, G] = hostOn ? [A, B] : [B, A];

    if (order === 'reopen') {
      await openRoom(H, G);
      await loadFixture(H);
      await sleep(2000);
      const asked = await buttons(H);
      check('저장본을 열면 방 맞추기를 멈추고 묻는다', asked.some(t => t.includes('방 작품으로 되돌리기')), J(asked));
      await dialogButton(H, '방 작품으로 되돌리기');
      await sleep(4000);
      const j = await watchRoom(H, A, Math.min(idleSec, 15), '되돌린 뒤');
      check('되돌린 뒤 방 작품이 끊기지 않음', !broken(j), J(j));
      return;
    }

    await loadFixture(H);
    // 방을 여는 것만으로도 안 켠 사람 작품이 바뀌면 안 된다
    const offBefore = hostOn ? null : await screenUnits(H);
    const code = await hostRoom(H);
    // 돌아가며 다시 보기로 먼저 끊기면 뒤 순서를 따로 볼 수 없다
    const onlyStep = order !== 'idle' && !hostOn;
    if (onlyStep) await keepTyping(G);
    await joinRoom(G, code, '참가자', 170000);
    await H.waitFor(`__entryHapjak.status().members.length === 2`, 10000, '방장이 참가자를 봄');
    const j0 = await room(H);
    console.log('  방 연 직후:', J(j0));
    check('시험 조건: 방 조각 모양', hostOn || arg('form', 'saved') === 'edit' ? !j0.erinfo : j0.erinfo, J(j0));
    if (!hostOn || bothOn) {
      const holding = await G.evalJs('__entryHapjak.status().holding');
      check(bothOn ? '판이 같은 켠 사람끼리는 받은 모양에 묶이지 않음' : '켠 사람이 받은 모양 그대로 들고 있음', holding === !bothOn, J(holding));
      const held = await verbatimHeld(G);
      if (held !== null) check('엔트리루트의 받은 그대로 불러오기로 들어옴', held === !bothOn, J(held));
    }
    await watchRoom(H, A, order === 'idle' || (hostOn && !bothOn) ? idleSec : 6, '들어온 뒤');
    if (!broken(await room(H)) && (!hostOn || bothOn)) await converged(H, G, '켠 사람 화면이 방 작품과 같음', check, 20000);

    if (order === 'idle') {
      const off = await screenUnits(H);
      const changed = [...new Set([...Object.keys(off), ...Object.keys(offBefore)])].filter(k => off[k] !== offBefore[k]);
      check('켠 사람이 들어와도 안 켠 사람 화면 조각이 그대로', !changed.length, J(changed.slice(0, 6)));
    }
    if (order === 'edit') {
      const oid = await G.evalJs(EDIT('erSvOn'));
      console.log('  켠 사람이 고친 오브젝트:', oid);
      await H.waitFor(hasThread('erSvOn'), 20000, '안 켠 사람이 켠 사람 블록 받음').then(() => check('켠 사람의 편집이 안 켠 사람에게 감', true), e => check('켠 사람의 편집이 안 켠 사람에게 감', false, e.message));
      await sleep(3000);
      await stopTyping(G);
      await watchRoom(H, A, 8, '고친 뒤');
    }
    if (order === 'off-edit') {
      const oid = await H.evalJs(EDIT('erSvOff'));
      console.log('  안 켠 사람이 고친 오브젝트:', oid);
      await G.waitFor(hasThread('erSvOff'), 20000, '켠 사람이 안 켠 사람 블록 받음').then(() => check('안 켠 사람의 편집이 켠 사람에게 감', true), e => check('안 켠 사람의 편집이 켠 사람에게 감', false, e.message));
      await sleep(4000);
      const onTab = await mine(G);
      check('켠 사람 화면에 없는 함수 호출이 들어오지 않음', !broken(onTab), J(onTab));
      await stopTyping(G);
      await watchRoom(H, A, 8, '고친 뒤');
    }
    if (order === 'plugin') {
      const oid = await G.evalJs(`(() => { const o = Entry.container.getAllObjects().find(x => !/^ers0o/.test(x.id)); Entry.container.selectObject(o.id); return o.id; })()`);
      await sleep(1500);
      const threadsIn = units => { try { return JSON.parse(units['code:' + oid]).length; } catch { return -1; } };
      const th0 = threadsIn(await H.evalJs('__entryHapjak.serverUnits()'));
      const n0 = await G.evalJs(`Object.keys(Entry.variableContainer.functions_).length`);
      // 첫 사용 안내창이 꾸러미를 덮으면 끌기가 빗나간다 — 함수가 늘 때까지(엔트리루트가 플러그인을 처음 붙임) 다시 끈다
      let dropped = false, dropType = null;
      for (let i = 0; i < 3 && !dropped; i++) {
        await closeGuide(G);
        dropType = await dropPluginBlock(G, '물리', 900, 240).catch(e => { console.log('  플러그인 블록을 못 끎:', e.message.slice(0, 160)); return dropType; });
        dropped = await G.waitFor(`Object.keys(Entry.variableContainer.functions_).length > ${n0}`, 12000, '플러그인 첫 사용').then(() => true, () => false);
      }
      check('시험 조건: 플러그인 블록을 실제로 놓음', dropped);
      // 묻지 않고 방 작품을 엔트리루트 편집 모양으로 바꿔 보낸다(켠 사람이 방을 연 것과 같은 모양)
      const FUNCS = `Object.keys(Entry.variableContainer.functions_).length`;
      const asked = [];
      const t0 = Date.now();
      let switched = false;
      while (Date.now() - t0 < 60000) {
        for (const t of await buttons(G)) if (t.includes('방 작품으로 되돌리기') && !asked.includes(t)) asked.push(t);
        const st = await G.evalJs(`({ holding: __entryHapjak.status().holding, paused: !!(__entryHapjak.status().client || {}).paused })`);
        const r = await room(H);
        if (st && !st.holding && !st.paused && r && !r.erinfo) { switched = true; break; }
        await sleep(1000);
      }
      console.log('  플러그인 블록 끌기:', J({ dropped, 함수: [n0, await G.evalJs(FUNCS)], 바꾸는데_초: Math.round((Date.now() - t0) / 1000), 상태: await G.evalJs('__entryHapjak.status().client') }));
      check('플러그인 블록을 놓아도 묻는 창이 뜨지 않음', !asked.length, J(asked));
      check('방 작품이 엔트리루트 편집 모양으로 바뀜(켠 사람 받은 모양 놓음·맞추기 안 멈춤·방에 erinfo 없음)', switched, J(await room(H)));
      const held = await verbatimHeld(G);
      if (held !== null) check('엔트리루트가 받은 그대로 불러오기를 놓아줌', held === false, J(held));
      await stopTyping(G);
      await converged(H, G, '바꾼 뒤 켠 사람 화면이 방 작품과 같음', check, 30000);
      const [fh, fg] = [await H.evalJs(FUNCS), await G.evalJs(FUNCS)];
      check('놓은 플러그인 블록(함수)이 안 켠 사람에게도 감', fh === fg && fg > n0, J({ 안켠: fh, 켠: fg, 처음: n0 }));
      // 놓은 블록은 꾸러미 함수 호출이다. 꾸러미 칸의 블록(ers0…)과 놓인 블록(ers0g…)은 id 가운데가 달라 꾸러미 머리 4자와 함수 끝 4자로 찾는다.
      // 묶음 수로는 못 본다: 저장 모양 화면에서는 블록 모양이 달라 같은 자리에 놓아도 위 묶음 끝에 붙을 수 있다
      const plug = t => { const m = /^func_ers0g?([0-9a-f]{4})[0-9a-z]*([0-9a-z]{4})$/.exec(t || ''); return m && m[1] + '..' + m[2]; };
      const want = plug(dropType);
      const callsIn = units => { const out = []; try { JSON.stringify(JSON.parse(units['code:' + oid]), (k, v) => { if (want && v && typeof v.type === 'string' && plug(v.type) === want) out.push(v.type); return v; }); } catch { /* 조각 없음 */ } return out.length; };
      const [inRoom, inOff] = [callsIn(await H.evalJs('__entryHapjak.serverUnits()')), callsIn(await screenUnits(H))];
      check('놓은 플러그인 블록이 바꾼 뒤에도 그 오브젝트에 남아 안 켠 사람에게 감', !!want && inRoom >= 1 && inOff >= 1, J({ 놓은블록: dropType, 방: inRoom, 안켠화면: inOff, 묶음: [th0, threadsIn(await H.evalJs('__entryHapjak.serverUnits()'))] }));
      const onTab = await mine(G);
      check('켠 사람 화면에 없는 함수 호출이 없음', !broken(onTab), J(onTab));
      await G.evalJs(EDIT('erSvConvOn'));
      await H.waitFor(hasThread('erSvConvOn'), 20000, '바꾼 뒤 켠 사람 편집').then(() => check('바꾼 뒤 켠 사람의 편집이 안 켠 사람에게 감', true), e => check('바꾼 뒤 켠 사람의 편집이 안 켠 사람에게 감', false, e.message));
      await H.evalJs(EDIT('erSvConvOff'));
      await G.waitFor(hasThread('erSvConvOff'), 20000, '바꾼 뒤 안 켠 사람 편집').then(() => check('바꾼 뒤 안 켠 사람의 편집이 켠 사람에게 감', true), e => check('바꾼 뒤 안 켠 사람의 편집이 켠 사람에게 감', false, e.message));
      await sleep(3000);
      await watchRoom(H, A, 8, '플러그인 뒤');
      await converged(H, G, '편집이 오간 뒤 켠 사람 화면이 방 작품과 같음', check, 20000);
    }
    if (order === 'reload' || order === 'reload-no') {
      await stopTyping(G);
      await G.evalJs('window.__beforeReopen = true');
      await reloadPage(G);
      let why = '';
      const back = await G.waitFor(`(() => { ${pressDialog(order === 'reload' ? '예' : '아니요')}; return !!(window.__entryHapjak && __entryHapjak.status().mode === 'room'); })()`, 90000, '새로고침 뒤 다시 들어옴').then(() => true, e => { why = e.message; return false; });
      check('새로고침한 켠 사람이 다시 들어옴', back, why);
      await watchRoom(H, null, 25, '새로고침 뒤');
      console.log('  켠 사람 화면:', J(await mine(G).catch(() => null)));
      if (back) {
        check('다시 들어온 켠 사람이 받은 모양 그대로 들고 있음', (await G.evalJs('__entryHapjak.status().holding')) === true);
        const held = await verbatimHeld(G);
        if (held !== null) check('다시 들어올 때도 엔트리루트의 받은 그대로 불러오기를 씀', held === true, J(held));
        await converged(H, G, '다시 들어온 켠 사람 화면이 방 작품과 같음', check, 20000);
        await G.evalJs(EDIT('erSvBackOn'));
        await H.waitFor(hasThread('erSvBackOn'), 20000, '안 켠 사람이 다시 들어온 켠 사람 블록 받음').then(() => check('다시 들어온 켠 사람의 편집이 안 켠 사람에게 감', true), e => check('다시 들어온 켠 사람의 편집이 안 켠 사람에게 감', false, e.message));
        await H.evalJs(EDIT('erSvBackOff'));
        await G.waitFor(hasThread('erSvBackOff'), 20000, '다시 들어온 켠 사람이 안 켠 사람 블록 받음').then(() => check('안 켠 사람의 편집이 다시 들어온 켠 사람에게 감', true), e => check('안 켠 사람의 편집이 다시 들어온 켠 사람에게 감', false, e.message));
        await sleep(3000);
      }
    }
    if (order === 'reload-other') {
      await stopTyping(G);
      await loadFixture(G, other);
      await sleep(2000);
      const want = await G.evalJs(PEOPLE_OBJS);
      // 새 페이지가 방 정보를 지우기 전에 남겨 둔다 — 방 정보가 없었으면 보호를 시험한 것이 아니다
      await G.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__rejoinMark = sessionStorage.getItem(${J(REJOIN_KEY)});` });
      await G.evalJs('window.__beforeReopen = true');
      await reloadPage(G);
      let why = '';
      const opened = await G.waitFor(`(() => { if (window.__beforeReopen) return false; ${pressDialog('예')}; return !!(window.Entry && window.__entryHapjak && Entry.container && ${PEOPLE_OBJS} === ${J(want)}); })()`, 90000, '복구본으로 다른 작품이 열림').then(() => true, e => { why = e.message; return false; });
      check('시험 조건: 복구본으로 다른 작품이 열림', opened, why);
      check('시험 조건: 새 페이지에 방 정보가 남아 있음', !!(await G.evalJs('window.__rejoinMark')));
      // 다시 들어가기는 0.5초마다 판단하므로 잠시 지켜본다
      await sleep(15000);
      const st = await G.evalJs(`({ mode: __entryHapjak.status().mode, same: ${PEOPLE_OBJS} === ${J(want)} })`);
      check('다른 작품을 연 사람은 방에 다시 들어가지 않고 그 작품이 그대로', st.mode === 'idle' && st.same, J(st));
    }
    if (order === 'leave' || order === 'leave-paint' || order === 'leave-run') {
      await stopTyping(G);
      const painting = order === 'leave-paint';
      if (painting) {
        await G.evalJs(`(() => { Entry.playground.changeViewMode('picture'); return true; })()`);
        await sleep(2000);
        await G.evalJs(`(() => { Entry.playground.painter.file.modified = true; return true; })()`);
      }
      const running = order === 'leave-run';
      if (running) { await G.evalJs(`(Entry.engine.toggleRun(), true)`); await sleep(1500); }
      await openPanel(G);
      await dialogButton(G, '방 나가기');
      await sleep(4000);
      // 실행 중에는 작품을 다시 불러올 수 없으니 멈춘 뒤 돌아와야 한다
      if (running) {
        check('실행 중에 방을 나감', (await G.evalJs('__entryHapjak.status().mode')) === 'idle');
        await G.evalJs(`(Entry.engine.isState('stop') || Entry.engine.toggleStop(), true)`);
        await sleep(5000);
      }
      const after = await G.evalJs(`(() => { const p = Entry.exportProject(); return { funcs: p.functions.length, ers0: p.functions.filter(f => /^ers0/.test(f.id)).length, erinfo: p.variables.some(v => v.id === 'erinfo'), objs: p.objects.length, modified: !!(Entry.playground.painter && Entry.playground.painter.file && Entry.playground.painter.file.modified) }; })()`);
      if (painting) check('그리던 그림이 있으면 나가도 작품을 다시 불러오지 않음', after && after.erinfo && after.modified, J(after));
      else check('방을 나간 켠 사람 화면이 평소 모양으로 돌아옴', after && !after.erinfo && after.ers0 > j0.editFuncs, J(after));
      const released = await verbatimHeld(G);
      if (released !== null) check('방을 나가면 엔트리루트가 작품을 놓아줌', released === false, J(released));
      const errs = A.exceptions.map(e => e.text).filter(t => !NOISE.test(t));
      check('나간 뒤 켠 사람 예외 없음', !errs.length, J(errs.slice(0, 2)).slice(0, 300));
      await verdict(H, H);
      return;
    }
    if (order === 'rejoin') {
      // 같은 탭에서 엔트리루트를 끄고 새로고침한 것과 같다: 탭에 적힌 방 정보를 안 켠 크롬의 탭으로 옮겨 다시 연다
      C = await launch({ ext, name: 'C(엔트리루트 끔)' });
      await openEntry(C);
      await G.evalJs(`(window.dispatchEvent(new Event('pagehide')), true)`);
      const mark = await G.evalJs(`sessionStorage.getItem(${J(REJOIN_KEY)})`);
      // 크롬은 바로 끝나고 프로필 지우기만 오래 걸린다 — 재입장 제한(90초) 안에서 기다리면 시험 환경 때문에 실패한다
      const closing = G.close();
      A = null;
      await C.evalJs(`(sessionStorage.setItem(${J(REJOIN_KEY)}, ${J(mark)}), true)`);
      await C.send('Page.reload');
      console.log(`  페이지가 닫힌 뒤 새로 열기까지 ${Math.round((Date.now() - JSON.parse(mark).at) / 1000)}초`);
      await C.waitFor(`!!(window.Entry && window.__entryHapjak && __entryHapjak.status().mode === 'room')`, 60000, '엔트리루트 끄고 다시 들어옴').then(() => check('엔트리루트를 끈 사람이 다시 들어옴', true), e => check('엔트리루트를 끈 사람이 다시 들어옴', false, e.message));
      await closing;
      await watchRoom(H, null, 10, '재입장 뒤');
    }
    await verdict(H, hostOn ? G : H);
  } catch (err) {
    check('시험 진행', false, String(err && err.stack || err).slice(0, 800));
    try { await A?.screenshot(path.join(out, 'fail-A.png')); await B?.screenshot(path.join(out, 'fail-B.png')); } catch { /* 못 찍음 */ }
  } finally {
    for (const c of [A, B, C]) if (c) {
      try { fs.writeFileSync(path.join(out, `diag-${c.name.slice(0, 1)}.txt`), await Promise.race([c.evalJs('__entryHapjak.diagnostics()'), sleep(8000).then(() => '응답 없음')])); } catch { /* 못 읽음 */ }
      fs.writeFileSync(path.join(out, `console-${c.name.slice(0, 1)}.txt`), c.consoleLines.slice(-60).join('\n'));
    }
    await Promise.all([A, B, C].filter(Boolean).map(c => c.close()));
    const fails = results.filter(r => !r.ok);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(results, null, 2));
    console.log(`\n${results.length - fails.length}/${results.length} 통과 · 결과: ${out}`);
    process.exit(fails.length ? 1 : 0);
  }
})();

// 엔트리 실시간 합작: 화면·통신·동기화를 잇는다.
(function (root) {
  'use strict';
  if (root.__entryHapjakLoaded) return;
  root.__entryHapjakLoaded = true;

  const { ErcSync: Sync, ErcEntry, ErcNet: Net, ErcUi, ErcMerge: M } = root;
  const log = (...a) => { try { console.debug('[엔트리 합작]', ...a); } catch { /* 콘솔 없음 */ } };
  const loop = fn => queueMicrotask(() => { try { fn(); } catch (err) { log('loop', err); } });
  const randomId = () => { const b = new Uint8Array(8); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); };

  const S = { mode: 'idle', role: null, code: null, myId: null, members: [], link: 'up', name: '' };
  let server = null, client = null, hostHandle = null, guestHandle = null, conn = null;
  let joined = false, leaving = false, retryUntil = 0, retryT = null;
  const conns = new Map();

  const ui = ErcUi.create({ onHost, onJoin, onLeave });
  const adapter = ErcEntry.create({ onLocalChange: kick, onExternalLoad, isOwnUi: n => ui.isOwn(n), log });

  function render() {
    const st = client ? client.status() : {};
    ui.set({ mode: S.mode, role: S.role, code: S.code, myId: S.myId, members: S.members, link: S.link, sending: st.sending, waiting: st.waiting, paused: st.paused });
  }

  function failText(why) {
    switch (why) {
      case 'unavailable-id': return '방 코드가 겹쳤어요. 한 번 더 눌러 주세요.';
      case 'no-room': case 'peer-unavailable': return '그 코드의 방이 없어요. 코드를 확인하고, 방장이 방을 열어 두었는지 확인해 주세요.';
      case 'signal-timeout': case 'network': case 'server-error': case 'socket-error': case 'socket-closed': case 'disconnected':
        return '연결 서버(PeerJS)에 닿지 못했어요. 인터넷 연결을 확인해 주세요.';
      case 'connect-timeout': return '방장 컴퓨터와 직접 연결하지 못했어요. 학교·회사처럼 막힌 인터넷에서는 안 될 수 있어요.';
      case 'browser-incompatible': return '이 브라우저에서는 P2P 연결을 쓸 수 없어요.';
      case 'version': return '서로 확장 버전이 달라요. 둘 다 같은 버전으로 맞춰 주세요.';
      case 'full': return '방이 가득 찼어요(최대 8명).';
      default: return `연결하지 못했어요 (${why || '알 수 없음'})`;
    }
  }

  // ── 편집 감지 ──
  let kickT = null;
  function kick() {
    if (!client) return;
    clearTimeout(kickT);
    kickT = setTimeout(() => { kickT = null; if (client) { client.reconcile(); render(); } }, 300);
  }
  setInterval(() => { if (client) { adapter.ensureHooks(); client.reconcile(); render(); } }, 1500);

  // ── 지금 보는 곳 알리기 ──
  let lastWhere = '';
  setInterval(() => {
    if (!client || S.mode !== 'room') return;
    const w = adapter.where();
    const s = M.stable(w);
    if (s !== lastWhere) { lastWhere = s; sendToServer({ t: 'where', where: w }); }
    updateBanner(w);
  }, 700);
  function updateBanner(w) {
    if (!w || !w.object || S.mode !== 'room') { ui.banner(null); return; }
    const others = S.members.filter(m => m.id !== S.myId && m.where && m.where.object === w.object && m.where.scene === w.scene);
    ui.banner(others.length ? `${others.map(m => m.name).join(', ')}님도 이 오브젝트를 보고 있어요. 같은 블록 묶음을 동시에 고치면 먼저 보낸 쪽이 남아요.` : null);
  }

  const sentLog = [];
  function sendToServer(msg) {
    if (msg && msg.t === 'put') { sentLog.push({ at: Date.now(), keys: Object.keys(msg.ch || {}) }); if (sentLog.length > 30) sentLog.shift(); }    if (S.role === 'host') { if (server) loop(() => server.onMessage('host', msg)); }
    else if (conn && conn.open) conn.send(msg);
  }

  function makeClient(id) {
    return new Sync.Client({
      adapter, id, send: sendToServer,
      hooks: {
        onConflict: keys => {
          const names = [...new Set(keys.map(k => {
            const id2 = k.includes(':') ? k.slice(k.indexOf(':') + 1) : '';
            return (k.startsWith('code:') || k.startsWith('obj:')) ? adapter.objectName(id2) : null;
          }).filter(Boolean))];
          ui.toast(`${names.length ? `'${names.join("', '")}' ` : ''}같은 부분을 다른 사람이 먼저 고쳐서, 내 변경 일부가 반영되지 않았어요.`, 'warn', 7000);
        },
        onGap: () => sendToServer({ t: 'hello', v: Sync.PROTOCOL, cid: S.role === 'host' ? 'host' : S.cid, name: S.name, host: S.role === 'host' }),
        onChange: () => {},
        onApplyError: err => { log('방 작품 반영 실패', err); pauseReason = 'applyError'; render(); askApplyError(); },
        onSuspicious: info => { pauseReason = 'suspicious'; render(); askSuspicious(info); },
      },
    });
  }

  // ── 멈춤 안내(한 번에 하나만 띄움) ──
  let asking = false, pauseReason = null;
  async function askOnce(opts) {
    if (asking) return null;
    asking = true;
    try { return await ui.ask(opts); } finally { asking = false; }
  }
  function backToRoom() {
    if (!client) return;
    try {
      client.resetToServer();
    } catch (err) {
      log('방 작품 다시 받기 실패', err);
      ui.toast('방 작품을 불러오지 못해 방에서 나왔어요. 화면은 바로 전 작품으로 되돌렸어요.', 'warn', 9000);
      resetAll();
      return;
    }
    pauseReason = null;
    client.reconcile();
    render();
  }
  async function askApplyError() {
    const i = await askOnce({
      title: '받은 변경을 화면에 넣지 못했어요',
      body: '엔트리가 방 작품을 불러오다 멈춰서, 내 화면은 바로 전 상태로 되돌리고 방과 맞추기를 멈췄어요.\n방 작품을 처음부터 다시 받아 볼까요?',
      buttons: [{ label: '방 작품 다시 받기', kind: 'main' }, { label: '방 나가기', kind: 'danger' }],
    });
    if (i == null || !client) return;
    if (i === 0) backToRoom(); else resetAll();
  }
  async function askSuspicious({ gone, total }) {
    const i = await askOnce({
      title: '오브젝트가 한꺼번에 사라졌어요',
      body: `오브젝트 ${total}개 중 ${gone || total}개가 한 번에 사라져서 방에 보내기 전에 멈췄어요.\n일부러 지운 게 아니면 방 작품으로 되돌리세요. 방에도 지우면 모두의 화면에서 지워집니다.`,
      buttons: [{ label: '방 작품으로 되돌리기', kind: 'main' }, { label: '방에도 지우기', kind: 'danger' }],
    });
    if (i == null || !client) return;
    if (i === 0) backToRoom(); else { pauseReason = null; client.resume({ allowMassDelete: true }); render(); }
  }

  function onServerMsg(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'welcome':
        S.myId = msg.you;
        if (S.role === 'guest' && !joined) { firstWelcome(msg); return; }
        if (client) client.onWelcome(msg, { fresh: false });
        S.link = 'up';
        render();
        return;
      case 'upd': if (client) client.onUpd(msg); render(); return;
      case 'mem': S.members = Array.isArray(msg.members) ? msg.members : []; render(); return;
      case 'refuse': ui.toast(failText(msg.why), 'warn', 7000); resetAll(); return;
      case 'bye': ui.toast('방장이 방을 닫았어요. 작품은 내 화면에 그대로 있어요.', 'warn', 8000); resetAll(); return;
    }
  }

  async function firstWelcome(msg) {
    // 블록을 끄는 중이거나 실행 중이면 끝난 뒤 바꾼다
    for (let i = 0; i < 100 && (adapter.isBusy() || adapter.isRunning()); i++) {
      if (adapter.isRunning()) adapter.stopRunning();
      await new Promise(r => setTimeout(r, 100));
    }
    // 기다리는 사이 연결이 끊겼거나 나갔으면 방 작품으로 바꾸지 않는다
    if (S.role !== 'guest' || joined || !conn || !conn.open) return;
    client = makeClient(S.cid);
    try {
      client.onWelcome(msg, { fresh: true });
    } catch (err) {
      log('load room project', err);
      ui.toast('방 작품을 불러오지 못했어요.', 'warn', 7000);
      resetAll();
      return;
    }
    joined = true;
    S.mode = 'room'; S.link = 'up';
    render();
    ui.toast('방에 들어왔어요. 이제 같이 고칠 수 있어요.');
  }

  // ── 방 열기 ──
  async function onHost(name) {
    if (S.mode !== 'idle') return;
    if (!adapter.ready()) { ui.toast('엔트리 편집기가 아직 준비되지 않았어요.', 'warn'); return; }
    if (adapter.isRunning()) { ui.toast('실행을 멈춘 뒤 방을 열어 주세요.', 'warn'); return; }
    adapter.ensureHooks();
    S.name = name;
    const code = Net.newCode();
    S.mode = 'connecting'; render(); ui.set({ busyWhat: 'host' });
    hostHandle = Net.host(code, {
      log,
      onReady: () => startHosting(code, name),
      onConn: acceptConn,
      onFail: why => { hostHandle = null; S.mode = 'idle'; render(); ui.toast(failText(why), 'warn', 7000); },
    });
  }

  async function startHosting(code, name) {
    let units = null;
    for (let i = 0; i < 100 && !(units = adapter.exportUnits()); i++) await new Promise(r => setTimeout(r, 100));
    if (!units) { ui.toast('작품을 읽지 못해 방을 열지 못했어요.', 'warn'); stopHost(); resetAll(); return; }
    S.role = 'host'; S.code = code; S.myId = 'host'; S.mode = 'room'; S.link = 'up';
    server = new Sync.Server(units, {
      send: sendTo,
      broadcast: msg => { for (const cid of server.members.keys()) sendTo(cid, msg); },
    });
    client = makeClient('host');
    client.startAsHost(units);
    loop(() => server.onMessage('host', { t: 'hello', v: Sync.PROTOCOL, name, host: true }));
    render();
    ui.toast('방을 열었어요. 초대 코드를 친구에게 알려 주세요.');
  }

  function sendTo(cid, msg) {
    if (cid === 'host') { loop(() => onServerMsg(msg)); return; }
    const c = conns.get(cid);
    if (c && c.open) c.send(msg);
  }

  function acceptConn(rawConn) {
    if (!server) { try { rawConn.close(); } catch { /* 이미 닫힘 */ } return; }
    let cid = null;
    const w = Net.wrapConn(rawConn, {
      log,
      onMessage: msg => {
        if (!server) return;
        if (!cid) {
          if (!msg || msg.t !== 'hello' || typeof msg.cid !== 'string' || !msg.cid || msg.cid === 'host') return;
          cid = msg.cid.slice(0, 40);
          const old = conns.get(cid);
          conns.set(cid, w);
          if (old && old !== w) old.close();
        }
        server.onMessage(cid, msg);
      },
      onClose: () => {
        if (cid && conns.get(cid) === w) { conns.delete(cid); if (server) server.leave(cid); }
      },
    });
  }

  function stopHost() {
    if (server) { const bye = { t: 'bye' }; for (const c of conns.values()) { try { c.send(bye); } catch { /* 닫힘 */ } } }
    const cs = [...conns.values()];
    conns.clear();
    setTimeout(() => { for (const c of cs) c.close(); if (hostHandle) { hostHandle.stop(); hostHandle = null; } }, 300);
  }

  // ── 참여 ──
  async function onJoin(name, rawCode) {
    if (S.mode !== 'idle') return;
    const code = Net.normCode(rawCode);
    if (!/^[a-z0-9]{4}-[a-z0-9]{4}$/.test(code)) { ui.toast('초대 코드 모양이 달라요 (예: abcd-ef23)', 'warn'); return; }
    if (location.pathname.replace(/\/+$/, '') !== '/ws/new') {
      const go = await ui.ask({
        title: '새 작품 화면에서 참여해요',
        body: '지금 열린 작품에서 참여하면, 방 작품을 저장할 때 이 작품을 덮어쓸 수 있어요.\n새 작품 화면으로 옮겨서 참여합니다.',
        buttons: [{ label: '새 작품 화면에서 참여', kind: 'main' }, { label: '취소' }],
      });
      if (go === 0) location.href = '/ws/new#hapjak=' + code;
      return;
    }
    if (!adapter.ready()) { ui.toast('엔트리 편집기가 아직 준비되지 않았어요.', 'warn'); return; }
    if (!adapter.isDefaultProject()) {
      const ok = await ui.ask({
        title: '방 작품으로 바꿀까요?',
        body: '참여하면 지금 화면의 작품이 방 작품으로 바뀌고, 이 화면에서 만든 것은 사라져요.',
        buttons: [{ label: '바꾸고 참여', kind: 'main' }, { label: '취소' }],
      });
      if (ok !== 0) return;
    }
    adapter.ensureHooks();
    S.name = name; S.code = code; S.role = 'guest'; S.cid = randomId();
    S.mode = 'connecting'; render(); ui.set({ busyWhat: 'join' });
    joined = false; leaving = false;
    guestHandle = Net.guest(code, { log });
    try {
      await connectGuest();
    } catch (err) {
      ui.toast(failText(err.message), 'warn', 8000);
      resetAll();
      return;
    }
    // 30초 안에 방장이 답하지 않으면 그만둔다
    setTimeout(() => { if (S.role === 'guest' && !joined && S.mode === 'connecting') { ui.toast('방장이 답하지 않아요. 방장 화면이 열려 있는지 확인해 주세요.', 'warn', 7000); resetAll(); } }, 30000);
  }

  async function connectGuest() {
    const handle = guestHandle;
    const c = await handle.connect({ onMessage: onServerMsg, onClose: () => { if (conn === c) onGuestDrop(); } });
    if (handle !== guestHandle || leaving) { c.close(); return; }
    conn = c;
    conn.send({ t: 'hello', v: Sync.PROTOCOL, cid: S.cid, name: S.name });
  }

  function onGuestDrop() {
    conn = null;
    if (leaving || S.role !== 'guest') return;
    if (!joined) { ui.toast('방장과 연결이 끊겼어요.', 'warn'); resetAll(); return; }
    S.link = 'down'; render();
    retryUntil = Date.now() + 120000;
    scheduleRetry();
  }
  function scheduleRetry() {
    clearTimeout(retryT);
    retryT = setTimeout(async () => {
      if (leaving || S.role !== 'guest' || conn) return;
      try { await connectGuest(); } catch (err) {
        log('retry', err.message);
        if (Date.now() > retryUntil) { ui.toast('방장과 다시 연결하지 못했어요. 작품은 내 화면에 그대로 있어요.', 'warn', 9000); resetAll(); return; }
        scheduleRetry();
      }
    }, 3000);
  }

  // ── 나가기 ──
  async function onLeave() {
    if (S.role === 'host' && S.members.length > 1) {
      const i = await ui.ask({ title: '방을 닫을까요?', body: '방을 닫으면 모두의 연결이 끊겨요. 각자 화면의 작품은 그대로 남아요.', buttons: [{ label: '방 닫기', kind: 'danger' }, { label: '취소' }] });
      if (i !== 0) return;
    }
    resetAll();
    ui.toast('방에서 나왔어요. 작품은 화면에 그대로 있어요.');
  }

  function resetAll() {
    leaving = true;
    clearTimeout(retryT); clearTimeout(kickT);
    if (S.role === 'host') stopHost();
    else if (hostHandle) { hostHandle.stop(); hostHandle = null; }
    if (conn) { const c = conn; conn = null; c.close(); }
    if (guestHandle) { guestHandle.stop(); guestHandle = null; }
    server = null; client = null; joined = false;
    Object.assign(S, { mode: 'idle', role: null, code: null, myId: null, members: [], link: 'up' });
    pauseReason = null; clearTimeout(extT);
    lastWhere = '';
    ui.banner(null);
    render();
    setTimeout(() => { leaving = false; }, 0);
  }

  // ── 다른 작품을 불러왔을 때 ──
  // 엔트리가 작품을 비우거나 불러오면(우리 반영이 아닌 것) 곧바로 멈추고, 잠시 뒤 같은 작품인지 본다
  let extT = null;
  function onExternalLoad() {
    if (!client) return;
    client.paused = true;
    if (!pauseReason) pauseReason = 'external';
    clearTimeout(extT);
    extT = setTimeout(async () => {
      if (!client || pauseReason !== 'external') return;
      const E = adapter.exportUnits();
      if (!E) { onExternalLoad(); return; }
      if (client.dirtyKeys(E).length === 0) { pauseReason = null; client.resume(); render(); return; }
      render();
      const i = await askOnce({
        title: '다른 작품이 열렸어요',
        body: '방과 맞추는 걸 잠시 멈췄어요.\n방 작품으로 되돌리면 지금 화면은 방 작품으로 바뀝니다.',
        buttons: [{ label: '방 작품으로 되돌리기', kind: 'main' }, { label: '방 나가기', kind: 'danger' }],
      });
      if (i == null || !client) return;
      if (i === 0) backToRoom(); else resetAll();
    }, 800);
  }

  window.addEventListener('beforeunload', e => {
    if (S.role === 'host' && S.members.length > 1) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('pagehide', () => { if (S.role === 'host') { for (const c of conns.values()) { try { c.send({ t: 'bye' }); } catch { /* 닫힘 */ } } } });

  // 초대 링크(#hapjak=코드)로 들어왔으면 창을 열고 코드를 채워 둔다
  const hm = location.hash.match(/hapjak=([a-z0-9-]+)/i);
  if (hm) {
    ui.set({ prefillCode: Net.normCode(hm[1]) });
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch { /* 주소 정리 실패는 무시 */ }
    const openWhenReady = () => { if (adapter.ready()) ui.open(); else setTimeout(openWhenReady, 300); };
    openWhenReady();
  }

  // 시험·문제 확인용(읽기 전용 요약)
  root.__entryHapjak = {
    status: () => ({ mode: S.mode, role: S.role, code: S.code, myId: S.myId, link: S.link, members: S.members.map(m => ({ ...m })), client: client ? client.status() : null, sent: sentLog.slice() }),
    exportUnits: () => adapter.exportUnits(),
    serverUnits: () => (server ? server.snapshot() : null),
  };
  render();
})(typeof self !== 'undefined' ? self : this);

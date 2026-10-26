// 합작 버튼·창·알림. 엔트리 화면 글꼴·색에 휘둘리지 않게 Shadow DOM 안에 그린다.
(function (root) {
  'use strict';

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: "Pretendard", "NanumGothic", "Malgun Gothic", sans-serif; }
  .fab { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 2147483000; display: flex; align-items: center; gap: 6px;
    padding: 7px 14px; border-radius: 999px; border: 1px solid #c9d3e6; background: #fff; color: #233; font-size: 13px; font-weight: 700;
    box-shadow: 0 2px 8px rgba(0,0,0,.15); cursor: pointer; }
  .fab:hover { background: #f4f7fc; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #aab2bf; }
  .dot.on { background: #30a46c; } .dot.warn { background: #f5a524; } .dot.bad { background: #e5484d; }
  .panel { position: fixed; left: 50%; bottom: 56px; transform: translateX(-50%); z-index: 2147483001; width: 330px; max-height: calc(100vh - 80px); overflow: auto;
    background: #fff; color: #222; border: 1px solid #d5dbe6; border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.2); padding: 14px; font-size: 13px; }
  .panel[hidden], .modal-back[hidden], .banner[hidden] { display: none; }
  h3 { margin: 0 0 10px; font-size: 15px; display: flex; justify-content: space-between; align-items: center; }
  .x { border: 0; background: none; font-size: 16px; cursor: pointer; color: #667; }
  label { display: block; margin: 8px 0 4px; color: #556; font-size: 12px; }
  input { width: 100%; padding: 8px 10px; border: 1px solid #c9d3e6; border-radius: 8px; font-size: 13px; color: #222; background: #fff; }
  button.main, button.sub, button.danger { width: 100%; margin-top: 8px; padding: 9px; border-radius: 8px; font-size: 13px; font-weight: 700; cursor: pointer; }
  button.main { background: #2e6ff2; color: #fff; border: 0; }
  button.main:disabled { background: #9db6ea; cursor: default; }
  button.sub { background: #fff; color: #2e6ff2; border: 1px solid #2e6ff2; }
  button.danger { background: #fff; color: #e5484d; border: 1px solid #e5484d; }
  .row { display: flex; gap: 6px; } .row > * { flex: 1; }
  hr { border: 0; border-top: 1px solid #e6eaf1; margin: 14px 0; }
  .note { color: #667; font-size: 12px; line-height: 1.5; margin: 6px 0 0; }
  .code { font-size: 22px; font-weight: 800; letter-spacing: 2px; text-align: center; padding: 8px; background: #f2f5fb; border-radius: 8px; margin: 4px 0; user-select: all; }
  ul { list-style: none; margin: 6px 0; padding: 0; }
  li { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #f0f2f6; }
  li .sw { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  li .nm { font-weight: 700; } li .wh { color: #778; font-size: 12px; margin-left: auto; text-align: right; }
  .tag { font-size: 11px; color: #2e6ff2; border: 1px solid #b9cdf7; border-radius: 4px; padding: 0 4px; }
  .status { margin-top: 8px; color: #556; font-size: 12px; }
  .toasts { position: fixed; left: 50%; top: 104px; transform: translateX(-50%); z-index: 2147483002; display: flex; flex-direction: column; gap: 6px; align-items: center; pointer-events: none; }
  .toast { background: #233; color: #fff; padding: 9px 14px; border-radius: 8px; font-size: 13px; max-width: 420px; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
  .toast.warn { background: #8a4b00; }
  .banner { position: fixed; top: 64px; left: 50%; transform: translateX(-50%); z-index: 2147483000; background: #fff7e6; color: #6b4300; border: 1px solid #f5c26b;
    padding: 7px 12px; border-radius: 8px; font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.12); max-width: 520px; }
  .modal-back { position: fixed; inset: 0; z-index: 2147483003; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; }
  .modal { background: #fff; color: #222; border-radius: 12px; padding: 18px; width: 360px; box-shadow: 0 10px 30px rgba(0,0,0,.3); font-size: 13px; }
  .modal p { line-height: 1.6; margin: 6px 0 4px; white-space: pre-line; }
  `;

  function create(handlers) {
    const host = document.createElement('div');
    host.id = 'entry-hapjak-root';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style>
      <button class="fab" type="button"><span class="dot"></span><span class="fab-t">합작</span></button>
      <div class="panel" hidden></div>
      <div class="toasts"></div>
      <div class="banner" hidden></div>
      <div class="modal-back" hidden><div class="modal"></div></div>`;
    document.documentElement.appendChild(host);
    // 창 안에서 누른 키가 엔트리 단축키(블록 지우기 등)로 새지 않게
    for (const t of ['keydown', 'keyup', 'keypress']) host.addEventListener(t, e => e.stopPropagation());

    const $ = s => shadow.querySelector(s);
    const panel = $('.panel'), fab = $('.fab');
    let state = { mode: 'idle' };
    fab.addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) render(); });

    const el = (tag, attrs = {}, ...kids) => {
      const n = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') n.className = v;
        else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
      }
      for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
      return n;
    };

    function savedName() { try { return localStorage.getItem('entry-hapjak-name') || ''; } catch { return ''; } }
    function saveName(v) { try { localStorage.setItem('entry-hapjak-name', v); } catch { /* 저장 못 해도 이번엔 씀 */ } }

    function render() {
      const s = state;
      const dot = $('.dot');
      dot.className = 'dot' + (s.mode === 'room' ? (s.link === 'down' ? ' warn' : ' on') : s.mode === 'connecting' ? ' warn' : '');
      $('.fab-t').textContent = s.mode === 'room' ? `합작 ${(s.members || []).length}명` : '합작';
      if (panel.hidden) return;
      panel.replaceChildren();
      const head = el('h3', {}, '엔트리 실시간 합작', el('button', { class: 'x', type: 'button', title: '닫기', onclick: () => { panel.hidden = true; } }, '✕'));
      panel.append(head);

      if (s.mode === 'idle' || s.mode === 'connecting') {
        const busy = s.mode === 'connecting';
        const name = el('input', { maxlength: '20', placeholder: '예: 민수', value: savedName() });
        const code = el('input', { maxlength: '12', placeholder: '예: abcd-ef23', value: s.prefillCode || '', spellcheck: 'false' });
        const getName = () => { const v = name.value.trim(); if (!v) { name.focus(); toast('내 이름을 적어 주세요', 'warn'); return null; } saveName(v); return v; };
        panel.append(
          el('label', {}, '내 이름(방 사람들에게 보임)'), name,
          el('button', { class: 'main', type: 'button', disabled: busy, onclick: () => { const n = getName(); if (n) handlers.onHost(n); } }, busy && s.busyWhat === 'host' ? '방 여는 중…' : '새 방 만들기'),
          el('p', { class: 'note' }, '지금 화면의 작품으로 방을 엽니다. 초대 코드를 친구에게 알려 주세요.'),
          el('hr'),
          el('label', {}, '초대 코드로 참여'), code,
          el('button', { class: 'sub', type: 'button', disabled: busy, onclick: () => { const n = getName(); if (!n) return; if (!code.value.trim()) { code.focus(); toast('초대 코드를 적어 주세요', 'warn'); return; } handlers.onJoin(n, code.value); } }, busy && s.busyWhat === 'join' ? '연결 중…' : '참여하기'),
          el('p', { class: 'note' }, '참여하면 지금 화면의 작품이 방 작품으로 바뀝니다. 새 작품 화면에서 참여하세요.'),
        );
        return;
      }

      // 방 안
      const link = `https://playentry.org/ws/new#hapjak=${s.code}`;
      const members = s.members || [];
      panel.append(
        el('label', {}, '초대 코드'),
        el('div', { class: 'code' }, s.code),
        el('div', { class: 'row' },
          el('button', { class: 'sub', type: 'button', onclick: () => copy(s.code, '초대 코드를 복사했어요') }, '코드 복사'),
          el('button', { class: 'sub', type: 'button', onclick: () => copy(link, '초대 링크를 복사했어요') }, '링크 복사')),
        el('label', {}, `방 사람 ${members.length}명`),
        el('ul', {}, members.map(m => el('li', {},
          el('span', { class: 'sw', style: `background:${/^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#999'}` }),
          el('span', { class: 'nm' }, m.name),
          m.host ? el('span', { class: 'tag' }, '방장') : null,
          m.id === s.myId ? el('span', { class: 'tag' }, '나') : null,
          el('span', { class: 'wh' }, m.where && m.where.objectName ? `${m.where.objectName}${m.where.mode && m.where.mode !== 'code' ? ' · ' + modeName(m.where.mode) : ''}` : ''),
        ))),
        el('div', { class: 'status' }, statusText(s)),
        el('button', { class: 'danger', type: 'button', onclick: () => handlers.onLeave() }, s.role === 'host' ? '방 닫기' : '방 나가기'),
        el('p', { class: 'note' }, s.role === 'host'
          ? '방장이 창을 닫으면 방이 끝납니다. 작품 저장은 방장이 엔트리 저장하기로 해 주세요.'
          : '같은 블록 묶음을 동시에 고치면 먼저 보낸 사람 것이 남습니다.'),
      );
    }
    const modeName = m => ({ picture: '모양', sound: '소리', text: '글상자', variable: '속성' }[m] || m);
    function statusText(s) {
      if (s.link === 'down') return '연결이 끊겨 다시 잇는 중… (내 편집은 화면에 그대로 있고, 다시 붙으면 보내요)';
      if (s.paused) return '방과 연결을 잠시 멈췄어요.';
      const parts = [];
      if (s.sending) parts.push('보내는 중');
      if (s.waiting) parts.push(`받은 변경 ${s.waiting}개 반영 대기(실행 중이거나 편집 중이면 끝난 뒤 반영)`);
      return parts.length ? parts.join(' · ') : '실시간으로 맞춰지는 중';
    }

    function copy(text, msg) {
      const done = () => toast(msg);
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
      else fallbackCopy(text, done);
    }
    function fallbackCopy(text, done) {
      const ta = el('textarea');
      ta.value = text; shadow.append(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch { toast('복사하지 못했어요. 직접 선택해 복사해 주세요', 'warn'); }
      ta.remove();
    }

    function toast(text, kind, ms = 4000) {
      const t = el('div', { class: 'toast' + (kind === 'warn' ? ' warn' : '') }, text);
      $('.toasts').append(t);
      setTimeout(() => t.remove(), ms);
    }

    function banner(text) {
      const b = $('.banner');
      if (!text) { b.hidden = true; return; }
      b.textContent = text; b.hidden = false;
    }

    // buttons: [{label, kind}] → 누른 버튼 번호(닫으면 -1)
    function ask({ title, body, buttons }) {
      return new Promise(resolve => {
        const back = $('.modal-back'), box = $('.modal');
        box.replaceChildren(el('h3', {}, title), el('p', {}, body),
          ...buttons.map((b, i) => el('button', { class: b.kind || 'sub', type: 'button', onclick: () => { back.hidden = true; resolve(i); } }, b.label)));
        back.hidden = false;
      });
    }

    function set(patch) { state = { ...state, ...patch }; render(); }
    function open() { panel.hidden = false; render(); }

    return { set, open, toast, banner, ask, isOwn: n => !!n && (n === host || host.contains(n) || (n.getRootNode && n.getRootNode() === shadow)), get state() { return state; } };
  }

  root.ErcUi = { create };
})(typeof self !== 'undefined' ? self : this);

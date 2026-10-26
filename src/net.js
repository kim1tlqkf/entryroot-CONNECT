// PeerJS로 방장과 참가자를 직접(P2P) 잇는다. 서로 찾는 데만 PeerJS 공개 서버를 쓰고, 작품 데이터는 브라우저끼리 오간다.
(function (root) {
  'use strict';
  const PREFIX = 'entry-hapjak-';
  const CHUNK = 15000;
  const PEER_OPTS = {
    debug: 0,
    config: { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] },
  };

  // 한 메시지가 크면 나눠 보낸다. UTF-16 짝(이모지 등)을 가르지 않게 자른다.
  function splitText(s, size) {
    const out = [];
    let i = 0;
    while (i < s.length) {
      let end = Math.min(s.length, i + size);
      if (end < s.length) {
        const c = s.charCodeAt(end - 1);
        if (c >= 0xd800 && c <= 0xdbff) end--;
      }
      out.push(s.slice(i, end));
      i = end;
    }
    return out;
  }

  function wrapConn(conn, { onMessage, onClose, log }) {
    let n = 0, closed = false, lastSeen = Date.now();
    const parts = new Map();
    const sendRaw = s => { try { if (conn.open) conn.send(s); } catch (err) { log('send', err); } };
    const api = {
      conn,
      send(msg) {
        const s = JSON.stringify(msg);
        if (s.length <= CHUNK) return sendRaw('M' + s);
        const id = (++n).toString(36);
        const pieces = splitText(s, CHUNK);
        pieces.forEach((p, i) => sendRaw('C' + id + ',' + i + ',' + pieces.length + '|' + p));
      },
      close() { if (closed) return; closed = true; clearInterval(beat); try { conn.close(); } catch { /* 이미 닫힘 */ } onClose(); },
      get open() { return !closed && conn.open; },
    };
    conn.on('data', raw => {
      lastSeen = Date.now();
      if (typeof raw !== 'string' || !raw) return;
      if (raw[0] === 'M') {
        let m; try { m = JSON.parse(raw.slice(1)); } catch { return; }
        if (m && m.t === 'ping') return;
        onMessage(m);
      } else if (raw[0] === 'C') {
        const bar = raw.indexOf('|');
        const [id, i, total] = raw.slice(1, bar).split(',');
        let p = parts.get(id);
        if (!p) { p = { got: 0, arr: new Array(+total) }; parts.set(id, p); }
        if (p.arr[+i] === undefined) { p.arr[+i] = raw.slice(bar + 1); p.got++; }
        if (p.got === p.arr.length) {
          parts.delete(id);
          let m; try { m = JSON.parse(p.arr.join('')); } catch { return; }
          onMessage(m);
        }
      }
    });
    conn.on('close', () => api.close());
    conn.on('error', err => { log('conn error', err); api.close(); });
    conn.on('iceStateChanged', st => { if (st === 'failed' || st === 'closed') api.close(); });
    // 연결이 조용히 끊긴 경우(노트북 덮개 닫힘 등)를 15초 안에 알아챈다
    const beat = setInterval(() => {
      if (Date.now() - lastSeen > 15000) { log('heartbeat timeout'); api.close(); return; }
      sendRaw('M{"t":"ping"}');
    }, 4000);
    return api;
  }

  function newCode() {
    const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
    const buf = new Uint32Array(8);
    crypto.getRandomValues(buf);
    let s = '';
    for (const x of buf) s += abc[x % abc.length];
    return s.slice(0, 4) + '-' + s.slice(4);
  }
  const normCode = c => String(c || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^(.{4})(.+)$/, '$1-$2');

  // 방장: onConn(wrapped) 은 참가자가 붙을 때마다
  function host(code, { onReady, onConn, onFail, log = () => {} }) {
    const Peer = root.Peer;
    let destroyed = false, opened = false;
    const peer = new Peer(PREFIX + code, PEER_OPTS);
    const failT = setTimeout(() => { if (!opened) { onFail('signal-timeout'); stop(); } }, 15000);
    peer.on('open', () => { opened = true; clearTimeout(failT); onReady(); });
    peer.on('connection', conn => {
      conn.on('open', () => onConn(conn));
    });
    peer.on('error', err => {
      const t = err && err.type;
      log('peer error', t, err);
      if (!opened) { clearTimeout(failT); onFail(t || 'error'); stop(); }
    });
    // 신호 서버와만 끊긴 경우: 이미 붙은 참가자는 그대로, 새 참가를 받으려고 다시 붙는다
    peer.on('disconnected', () => { if (!destroyed) setTimeout(() => { try { if (!destroyed && peer.disconnected) peer.reconnect(); } catch (e) { log('reconnect', e); } }, 2000); });
    function stop() { destroyed = true; try { peer.destroy(); } catch { /* 이미 닫힘 */ } }
    return { stop };
  }

  // 참가자: 끊기면 onDrop, 다시 붙이는 건 부르는 쪽이 connect()를 다시 부른다
  function guest(code, { log = () => {} }) {
    const Peer = root.Peer;
    let peer = null, destroyed = false;
    function ensurePeer() {
      return new Promise((resolve, reject) => {
        if (peer && !peer.destroyed && peer.open) return resolve(peer);
        if (peer && !peer.destroyed && peer.disconnected) {
          try { peer.reconnect(); } catch (e) { log('reconnect', e); }
        } else {
          peer = new Peer(PEER_OPTS);
        }
        const p = peer;
        const t = setTimeout(() => { cleanup(); reject(new Error('signal-timeout')); }, 15000);
        const ok = () => { cleanup(); resolve(p); };
        const bad = err => { cleanup(); reject(new Error((err && err.type) || 'error')); };
        function cleanup() { clearTimeout(t); p.off('open', ok); p.off('error', bad); }
        p.on('open', ok);
        p.on('error', bad);
      });
    }
    async function connect({ onMessage, onClose }) {
      const p = await ensurePeer();
      return new Promise((resolve, reject) => {
        const conn = p.connect(PREFIX + code, { reliable: true, serialization: 'raw' });
        let done = false;
        const t = setTimeout(() => finish(new Error('connect-timeout')), 15000);
        const onErr = err => { if (err && err.type === 'peer-unavailable') finish(new Error('no-room')); };
        p.on('error', onErr);
        function finish(err, val) {
          if (done) return;
          done = true; clearTimeout(t); p.off('error', onErr);
          if (err) { try { conn.close(); } catch { /* 이미 닫힘 */ } reject(err); } else resolve(val);
        }
        conn.on('open', () => finish(null, wrapConn(conn, { onMessage, onClose, log })));
        conn.on('error', err => finish(new Error((err && err.type) || 'conn-error')));
      });
    }
    function stop() { destroyed = true; try { if (peer) peer.destroy(); } catch { /* 이미 닫힘 */ } }
    return { connect, stop, get destroyed() { return destroyed; } };
  }

  root.ErcNet = { host, guest, wrapConn, newCode, normCode, splitText, PREFIX };
})(typeof self !== 'undefined' ? self : this);

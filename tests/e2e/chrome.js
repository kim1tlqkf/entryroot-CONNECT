// 시험용 크롬(창 없음, 빈 임시 프로필)을 띄워 확장을 정식 설치 경로(Extensions.loadUnpacked)로 넣고 CDP로 조작한다.
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch({ ext, name = 'chrome', log = console.log, viewport = { width: 1400, height: 860 } }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hapjak-test-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`, `--window-size=${viewport.width},${viewport.height}`, '--no-first-run', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const exited = new Promise(r => chrome.once('exit', r));
  let id = 0, buf = '', S;
  const waiting = new Map();
  const consoleLines = [];
  const exceptions = [];
  chrome.stdio[4].on('data', d => {
    buf += d;
    let k;
    while ((k = buf.indexOf('\0')) >= 0) {
      const m = JSON.parse(buf.slice(0, k)); buf = buf.slice(k + 1);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
      else if (m.method === 'Runtime.consoleAPICalled') {
        const text = m.params.args.map(a => a.value ?? a.description).join(' ');
        if (/엔트리 합작|hapjak/i.test(text) || m.params.type === 'error') consoleLines.push(`[${m.params.type}] ${text}`.slice(0, 400));
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        consoleLines.push('EXC ' + (d.exception?.description || d.text).slice(0, 400));
        exceptions.push({ text: (d.exception?.description || d.text || '').slice(0, 300), url: d.url, line: d.lineNumber, frames: (d.stackTrace?.callFrames || []).slice(0, 12).map(f => `${f.functionName || '(anon)'} @ ${(f.url || '').split('/').pop().split('?')[0]}:${f.lineNumber + 1}:${f.columnNumber + 1}`) });
      }
    }
  });
  const send = (method, params = {}, sessionId) => new Promise(r => {
    const n = ++id; waiting.set(n, r);
    chrome.stdio[3].write(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  const closeBrowser = async () => {
    try { chrome.kill(); } catch { /* 이미 끝남 */ }
    await Promise.race([exited, sleep(15000)]);
    await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => log(`프로필을 못 지움: ${profile}`));
  };
  // 탭 하나를 다루는 도구. 같은 크롬에 탭을 더 열 수 있다(newTab) — 한 크롬 안 탭 두 개로 시험할 때
  function makePage(sess, pageName) {
    const evalJs = async (expression, awaitPromise = true) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sess);
      if (r.error) throw Error(r.error.message);
      if (r.result?.exceptionDetails) throw Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
      return r.result?.result?.value;
    };
    const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent',
      { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra }, sess);
    return {
      name: pageName, evalJs, send: (m, p) => send(m, p, sess), consoleLines, exceptions,
      async click(x, y) { await mouse('mouseMoved', x, y, { buttons: 0 }); await mouse('mousePressed', x, y); await sleep(30); await mouse('mouseReleased', x, y); },
      async drag(x1, y1, x2, y2, steps = 12) {
        await mouse('mouseMoved', x1, y1, { buttons: 0 }); await mouse('mousePressed', x1, y1);
        for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps); await sleep(16); }
        await mouse('mouseReleased', x2, y2);
      },
      async type(text) { await send('Input.insertText', { text }, sess); },
      async key(key, code, keyCode, modifiers = 0) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers }, sess);
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers }, sess);
      },
      async waitFor(expr, ms = 30000, what = expr) {
        const t0 = Date.now();
        let last;
        while (Date.now() - t0 < ms) {
          try { last = await evalJs(expr); if (last) return last; } catch (e) { last = String(e.message || e); }
          await sleep(200);
        }
        throw Error(`[${pageName}] 기다림 시간 초과: ${what} (마지막 값: ${JSON.stringify(last)?.slice(0, 300)})`);
      },
      async screenshot(file) {
        const r = await send('Page.captureScreenshot', { format: 'png' }, sess);
        fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
      },
      async newTab(tabName) {
        const { targetId } = (await send('Target.createTarget', { url: 'about:blank' })).result;
        const s2 = (await send('Target.attachToTarget', { targetId, flatten: true })).result.sessionId;
        await send('Page.enable', {}, s2); await send('Runtime.enable', {}, s2);
        await send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false }, s2);
        await send('Emulation.setFocusEmulationEnabled', { enabled: true }, s2);
        const tab = makePage(s2, tabName);
        tab.close = async () => {};
        return tab;
      },
      close: closeBrowser,
    };
  }

  // ext: 확장 폴더 하나 또는 여러 개(사용자 크롬처럼 다른 확장을 같이 켠 상태를 흉내 낼 때)
  for (const one of [].concat(ext || [])) {
    const loaded = await send('Extensions.loadUnpacked', { path: one });
    if (loaded.error) throw Error('loadUnpacked: ' + loaded.error.message);
  }
  const { targetInfos } = (await send('Target.getTargets')).result;
  S = (await send('Target.attachToTarget', { targetId: targetInfos.find(t => t.type === 'page').targetId, flatten: true })).result.sessionId;
  await send('Page.enable', {}, S);
  await send('Runtime.enable', {}, S);
  await send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false }, S);
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }, S);
  return makePage(S, name);
}

async function openEntry(c, url = 'https://playentry.org/ws/new') {
  for (let attempt = 0; attempt < 3; attempt++) {
    await c.send('Page.navigate', { url });
    try {
      await c.waitFor('!!(window.Entry && Entry.playground && Entry.getMainWS && Entry.getMainWS() && window.__entryHapjak)', 60000, '엔트리·확장 준비');
      await sleep(1500);
      await closeGuide(c);
      return;
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(4000);
    }
  }
}

// 새 프로필이라 엔트리 첫 사용 안내창(1/4 ~ 4/4)이 블록 꾸러미를 덮는다 — 사람처럼 '다음'을 끝까지 눌러 닫는다
async function closeGuide(c) {
  for (let i = 0; i < 8; i++) {
    const p = await c.evalJs(`(() => {
      const vis = d => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const n = [...document.querySelectorAll('div.next')].find(vis)
        || (document.querySelector('.tooltipGuide') && [...document.querySelectorAll('button, div, a')].find(d => vis(d) && d.children.length === 0 && d.textContent.trim() === '완료'));
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!p) break;
    await c.click(p.x, p.y);
    await sleep(500);
  }
  return c.evalJs(`!document.querySelector('.tooltip_blocks')`);
}

module.exports = { launch, openEntry, closeGuide, sleep };

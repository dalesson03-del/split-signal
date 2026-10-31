// Split Signal app: screens, the host loop and the client connection.

import { createGame, addPlayer, act, tick, viewFor, setConnected, cleanName, CONFIG } from './engine.js';
import { MODULES } from './puzzles.js';
import { renderPiece, renderClock, pieceInfo, esc } from './pieces.js';
import { HostNet, ClientNet } from './net.js';

const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet');
const $toast = document.getElementById('toast');
const $fx = document.getElementById('fx');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// Session + host state are per tab (sessionStorage) and survive a refresh.
const area = (k) => (k === 'ss-name' ? localStorage : sessionStorage);
const store = {
  get(k) {
    try {
      return JSON.parse(area(k).getItem(k));
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      area(k).setItem(k, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
  del(k) {
    try {
      area(k).removeItem(k);
    } catch {
      /* private mode */
    }
  },
};

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 24);
const newCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

const ui = { mode: 'home', connectingText: '', status: 'connected', view: null, viewAt: 0, homeError: '', noRoomCount: 0, flashN: null };
let session = store.get('ss-session');
let host = null;
let client = null;

// ---------- feedback ----------

let toastTimer = null;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 3200);
}

function playFlash(f) {
  if (!f || !f.kind || f.kind === 'crash') return;
  const by = ui.view?.players.find((p) => p.id === f.by)?.name;
  $fx.className = `fx fx-${f.kind}`;
  $fx.innerHTML =
    f.kind === 'strike'
      ? `<p class="fx-title">Strike</p><p class="fx-text">${esc(f.text)}${by ? ` · ${esc(by)}` : ''}</p>`
      : `<p class="fx-title">Stabilized</p><p class="fx-text">${esc(f.text)}</p>`;
  document.body.classList.remove('shake');
  void document.body.offsetWidth;
  if (f.kind === 'strike') document.body.classList.add('shake');
  if (navigator.vibrate && f.kind === 'strike') navigator.vibrate([120, 60, 120]);
  clearTimeout(playFlash.t);
  playFlash.t = setTimeout(() => {
    $fx.className = 'fx';
    document.body.classList.remove('shake');
  }, 1700);
}

// ---------- host ----------

function hostHandlers() {
  return {
    onHello(msg) {
      if (typeof msg.id !== 'string' || msg.id.length > 64) return { ok: false, error: 'Bad request.' };
      return addPlayer(host.state, { id: msg.id, name: msg.name });
    },
    onJoined() {
      hostBroadcast();
    },
    onAction(pid, action) {
      const r = act(host.state, pid, action, Date.now());
      if (!r.ok) host.net.sendTo(pid, { t: 'err', error: r.error });
      hostBroadcast();
    },
    onReact() {},
    onDrop(pid) {
      setConnected(host.state, pid, false);
      hostBroadcast();
    },
  };
}

function hostBroadcast() {
  if (!host) return;
  const now = Date.now();
  host.lastSent = host.state.version;
  host.lastBeat = now;
  store.set('ss-state-' + host.state.code, host.state);
  host.net.broadcast((pid) => ({ t: 'view', view: viewFor(host.state, pid, now) }));
  setView(viewFor(host.state, session.id, now));
}

function startHostLoop() {
  // Test hook for the end-to-end suite; only exists when served from localhost.
  if (location.hostname === 'localhost') window.__ssHost = host;
  host.loop = setInterval(() => {
    const now = Date.now();
    tick(host.state, now);
    if (host.state.version !== host.lastSent || now - host.lastBeat > 2000) hostBroadcast();
  }, 200);
  hostBroadcast();
}

async function waitForPeer(ms = 10000) {
  const end = Date.now() + ms;
  while (!window.Peer && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return !!window.Peer;
}

async function openHostNet(state, { retryForMs = 0 } = {}) {
  const deadline = Date.now() + retryForMs;
  for (;;) {
    const net = new HostNet(state.code, hostHandlers());
    try {
      await net.open();
      return net;
    } catch (err) {
      if (err?.type === 'unavailable-id' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw err;
    }
  }
}

const NO_LIB = 'The connection library did not load. Check your internet connection and reload.';

async function createRoom(name) {
  if (!(await waitForPeer())) return homeFail(NO_LIB);
  ui.mode = 'connecting';
  ui.connectingText = 'Powering up mission control…';
  render();
  const id = uid();
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = createGame(newCode());
    addPlayer(state, { id, name });
    host = { state, net: null, loop: null, lastSent: 0, lastBeat: 0 };
    try {
      host.net = await openHostNet(state);
      session = { code: state.code, id, name, role: 'host' };
      store.set('ss-session', session);
      startHostLoop();
      history.replaceState(null, '', location.pathname + '?room=' + state.code);
      return;
    } catch (err) {
      host = null;
      if (err?.type === 'unavailable-id') continue;
      return homeFail(netErrorText(err));
    }
  }
  homeFail('Could not reserve a room code. Try again.');
}

async function resumeHost(saved) {
  if (!(await waitForPeer())) return homeFail(NO_LIB);
  ui.mode = 'connecting';
  ui.connectingText = `Reopening room ${saved.code}…`;
  render();
  saved.players.forEach((p) => (p.connected = p.id === session.id));
  host = { state: saved, net: null, loop: null, lastSent: 0, lastBeat: 0 };
  try {
    host.net = await openHostNet(saved, { retryForMs: 45000 });
    startHostLoop();
    toast('Room reopened. Your crew will reconnect automatically.');
  } catch {
    host = null;
    clearSession(saved.code);
    homeFail(`Room ${saved.code} could not be reopened. Start a new room.`);
  }
}

function netErrorText(err) {
  if (err?.type === 'browser-incompatible') return 'This browser does not support live connections. Try Chrome, Safari or Firefox.';
  if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err?.type))
    return 'Could not reach the matchmaking server. Check your connection and try again.';
  return 'Something went wrong opening the connection. Try again.';
}

// ---------- client ----------

async function joinRoom(code, name) {
  if (!(await waitForPeer())) return homeFail(NO_LIB);
  const id = session && session.code === code ? session.id : uid();
  ui.mode = 'connecting';
  ui.connectingText = `Hailing room ${code}…`;
  ui.noRoomCount = 0;
  render();
  client = new ClientNet(code, { id, name }, {
    onMessage(msg) {
      if (msg.t === 'welcome') {
        session = { code, id, name, role: 'client' };
        store.set('ss-session', session);
        history.replaceState(null, '', location.pathname + '?room=' + code);
      } else if (msg.t === 'reject') {
        client.close();
        client = null;
        if (session?.code === code) clearSession(code);
        homeFail(msg.error);
      } else if (msg.t === 'view') setView(msg.view);
      else if (msg.t === 'err') toast(msg.error);
    },
    onStatus(status) {
      if (status === 'no-room') {
        ui.noRoomCount += 1;
        if (ui.noRoomCount >= 3) {
          client.close();
          client = null;
          if (session?.code === code) clearSession(code);
          homeFail(`No room ${code} is open right now. Check the code with your host.`);
        }
        return;
      }
      if (status === 'closed') {
        client?.close();
        client = null;
        clearSession(code);
        return homeFail('The host closed the room.');
      }
      ui.status = status;
      renderStatus();
    },
  });
  client.start();
}

// ---------- actions ----------

function doAct(action) {
  if (host) {
    const r = act(host.state, session.id, action, Date.now());
    if (!r.ok) toast(r.error);
    hostBroadcast();
  } else client?.act(action);
}

function clearSession(code) {
  store.del('ss-session');
  if (code) store.del('ss-state-' + code);
  session = null;
}

function leave() {
  if (host && !confirm('Leaving closes the room for everyone. Close it?')) return;
  if (host) {
    clearInterval(host.loop);
    host.net.close();
    clearSession(host.state.code);
    host = null;
  }
  if (client) {
    client.close();
    clearSession(session?.code);
    client = null;
  }
  ui.mode = 'home';
  ui.view = null;
  history.replaceState(null, '', location.pathname);
  render();
}

function homeFail(msg) {
  ui.mode = 'home';
  ui.homeError = msg;
  ui.view = null;
  render();
}

// ---------- view plumbing ----------

function setView(v) {
  const prev = ui.view;
  ui.view = v;
  ui.viewAt = performance.now();
  ui.mode = 'game';
  if (ui.flashN === null) ui.flashN = v.flash.n;
  else if (v.flash.n !== ui.flashN) {
    ui.flashN = v.flash.n;
    playFlash(v.flash);
  }
  if (!prev || prev.version !== v.version || $app.dataset.phase === undefined) render();
  else updateClock();
}

function elapsed() {
  return performance.now() - ui.viewAt;
}

function fmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function updateClock() {
  const v = ui.view;
  if (!v) return;
  const run = v.clockRunning ? elapsed() : 0;
  if (v.timeLeftMs !== null) {
    const left = Math.max(0, v.timeLeftMs - run);
    document.querySelectorAll('[data-clock]').forEach((el) => {
      el.textContent = fmt(left);
      el.classList.toggle('is-low', left < 30000);
    });
  }
  const decay = Math.max(0, v.decay - run / (v.rules.startSeconds * 1000));
  document.querySelectorAll('[data-decay]').forEach((el) => {
    el.style.transform = `scaleX(${decay})`;
    el.classList.toggle('is-low', decay < 0.2);
  });
  document.querySelectorAll('[data-phase-left]').forEach((el) => {
    el.textContent = Math.max(0, Math.ceil((v.phaseLeftMs - elapsed()) / 1000));
  });
}
setInterval(updateClock, 200);

function renderStatus() {
  let bar = document.getElementById('netbar');
  const show = client && ui.mode === 'game' && ui.status === 'reconnecting';
  if (!show) return bar?.remove();
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'netbar';
    bar.className = 'netbar';
    bar.textContent = 'Lost contact with the host. Reconnecting…';
    document.body.appendChild(bar);
  }
}

const inviteLink = (code) => `${location.origin}${location.pathname}?join=${code}`;
const playerName = (id) => ui.view.players.find((p) => p.id === id)?.name ?? 'Someone';

// ---------- components ----------

function hud() {
  const v = ui.view;
  const inGame = v.phase !== 'lobby';
  const pips = Array.from({ length: v.moduleCount }, (_, i) => {
    const state = i < v.moduleIndex || v.phase === 'won' ? 'done' : i === v.moduleIndex && inGame ? 'live' : '';
    return `<span class="pip ${state}" title="Module ${i + 1}"></span>`;
  }).join('');
  const leds = Array.from({ length: v.rules.strikes }, (_, i) => `<span class="led ${i < v.strikes ? 'is-on' : ''}"></span>`).join('');
  return `<header class="hud">
    <div class="hud-row">
      <span class="hud-code" title="Room code">${esc(v.code)}</span>
      ${inGame ? `<span class="pips" aria-label="Module ${Math.min(v.moduleIndex + 1, v.moduleCount)} of ${v.moduleCount}">${pips}</span>` : ''}
      ${inGame ? `<span class="hud-strikes" aria-label="${v.strikes} of ${v.rules.strikes} strikes">${leds}</span>` : ''}
      <button class="hud-menu" data-open="menu" aria-label="Menu">⋯</button>
    </div>
    ${
      inGame
        ? `<div class="decay" aria-label="Orbit decay"><span class="decay-label">Orbit</span><div class="decay-track"><div class="decay-fill" data-decay></div></div></div>`
        : ''
    }
  </header>`;
}

function crewList() {
  const v = ui.view;
  const type = v.moduleType;
  return `<section class="crew" aria-label="Crew">
    <h2 class="sec-title">Crew</h2>
    <ul>${v.players
      .map((p) => {
        const isMe = p.id === v.you.id;
        const holds = type && p.pieces.length ? p.pieces.map((k) => pieceInfo(type, k).name).join(', ') : '';
        return `<li class="crew-row${isMe ? ' is-me' : ''}${p.connected ? '' : ' is-away'}">
          <span class="crew-call">${esc(p.callsign)}</span>
          <span class="crew-name">${esc(p.name)}${isMe ? ' <small>(you)</small>' : ''}${p.id === v.hostId ? ' <small>· host</small>' : ''}${
          p.connected ? '' : ' <small>· away</small>'
        }</span>
          ${holds ? `<span class="crew-holds">${esc(holds)}</span>` : ''}
          ${
            v.phase === 'lobby' && v.you.isHost && p.id !== v.hostId
              ? `<button class="link" data-act="remove" data-id="${esc(p.id)}">Remove</button>`
              : ''
          }
        </li>`;
      })
      .join('')}</ul>
  </section>`;
}

function howTo() {
  return `<section class="card howto">
    <h2 class="sec-title">How it works</h2>
    <ol class="steps">
      <li><b>Every phone gets different pieces.</b> One player holds the controls; others hold the clues. Nobody can solve a module alone.</li>
      <li><b>Talk.</b> Describe what you see, out loud or on a call. Only the controller can press anything.</li>
      <li><b>Five modules, one clock.</b> Clearing a module adds time. A wrong move is a strike and costs time.</li>
      <li><b>Pieces reshuffle</b> after every module, so everyone takes a turn at the controls.</li>
    </ol>
    <p class="hint-left">Only the player holding the Mission clock sees the exact time. Everyone else sees the orbit decaying.</p>
  </section>`;
}

// ---------- screens ----------

function screenHome() {
  const params = new URLSearchParams(location.search);
  const joinCode = (params.get('join') || params.get('room') || '').toUpperCase().slice(0, 4);
  const savedName = store.get('ss-name') || '';
  return `<section class="home">
    <div class="orbit-art" aria-hidden="true">
      <svg viewBox="0 0 220 220"><ellipse cx="110" cy="110" rx="100" ry="38" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="4 7" transform="rotate(-18 110 110)"/>
      <g class="sat" transform="rotate(-18 110 110)"><g transform="translate(196 110)"><rect x="-9" y="-7" width="18" height="14" rx="2" fill="var(--orange)"/><rect x="-27" y="-4" width="16" height="8" fill="var(--panel)"/><rect x="11" y="-4" width="16" height="8" fill="var(--panel)"/></g></g>
      <circle cx="110" cy="110" r="30" fill="var(--signal)" opacity=".18"/><circle cx="110" cy="110" r="18" fill="var(--signal)" opacity=".5"/></svg>
    </div>
    <h1 class="title">Split<br/>Signal</h1>
    <p class="tagline">A co-op game where every phone holds a different piece of the puzzle. Talk fast and save the satellite before its orbit decays.</p>
    <form class="card form" id="homeForm" autocomplete="off">
      <label class="field"><span>Your name</span><input id="name" maxlength="16" required placeholder="e.g. Edwin" value="${esc(savedName)}" /></label>
      ${ui.homeError ? `<p class="form-error" role="alert">${esc(ui.homeError)}</p>` : ''}
      <button type="submit" class="btn btn-orange" data-intent="create" ${joinCode ? 'hidden' : ''}>Create a room</button>
      <div class="join">
        <label class="field field-code"><span>Room code</span><input id="code" maxlength="4" placeholder="ABCD" value="${esc(joinCode)}" autocapitalize="characters" /></label>
        <button type="submit" class="btn ${joinCode ? 'btn-orange' : 'btn-line'}" data-intent="join">Join room</button>
      </div>
      ${joinCode ? `<button type="submit" class="btn btn-ghost" data-intent="create">Create my own room instead</button>` : ''}
    </form>
    <p class="home-meta">2–6 players · 5–8 minutes · any phone or laptop · no login · solo practice available<br/><button class="link" data-open="howto">How it works</button></p>
  </section>`;
}

function screenConnecting() {
  return `<section class="center"><div class="spinner" aria-hidden="true"></div><p>${esc(ui.connectingText)}</p><button class="btn btn-ghost" data-act="cancel">Cancel</button></section>`;
}

function screenLobby() {
  const v = ui.view;
  const n = v.players.filter((p) => p.connected).length;
  const diff = Object.entries(CONFIG.difficulty)
    .map(
      ([k, d]) =>
        `<button class="seg ${v.difficulty === k ? 'is-on' : ''}" data-act="difficulty" data-level="${k}" ${v.you.isHost ? '' : 'disabled'} aria-pressed="${
          v.difficulty === k
        }"><b>${d.label}</b><small>${Math.round(d.startSeconds / 60)} min · ${d.strikes} strikes</small></button>`
    )
    .join('');
  return `${hud()}
  <section class="lobby">
    <div class="codeplate">
      <span class="screw tl"></span><span class="screw tr"></span><span class="screw bl"></span><span class="screw br"></span>
      <p class="codeplate-label">Room code</p>
      <p class="codeplate-code">${esc(v.code)}</p>
      <p class="codeplate-hint">Crew open <b>${esc(location.host)}</b> and enter this code.</p>
      <button class="btn btn-line-dark btn-small" data-act="invite">Copy invite link</button>
    </div>
    ${crewList()}
    <div class="segs" role="group" aria-label="Difficulty">${diff}</div>
    ${
      v.you.isHost
        ? `<button class="btn btn-orange btn-wide" data-act="start">${n === 1 ? 'Launch solo practice' : `Launch with ${n} crew`}</button>
           <p class="hint">${n === 1 ? 'Solo practice puts every piece on your screen. It’s built for 2–6 players, so invite your crew for the real thing.' : 'Up to 6 crew. Everyone needs to be able to talk.'}</p>`
        : `<p class="note">Waiting for ${esc(playerName(v.hostId))} to launch.</p>`
    }
    ${howTo()}
  </section>`;
}

function screenModule() {
  const v = ui.view;
  const type = v.moduleType;
  const live = v.phase === 'module';
  const mine = v.you.pieces;
  const banner =
    v.phase === 'briefing'
      ? `<div class="banner"><p>Uplink in <b data-phase-left>${Math.ceil(v.phaseLeftMs / 1000)}</b></p><p class="banner-sub">Read your station. Nobody can act until the clock starts.</p></div>`
      : '';
  const order = ['control', 'intelA', 'intelB'];
  const panels = order
    .filter((k) => mine.includes(k))
    .map((k) => renderPiece(type, k, v.pieces[k], live))
    .join('');
  const clock = mine.includes('clock') ? renderClock(fmt(v.timeLeftMs ?? 0), v.strikes, v.rules.strikes) : '';
  const nothing = !mine.length ? `<p class="note">You have no piece for this module. You’ll get one next module; help the crew think.</p>` : '';
  const solo = v.players.length === 1 ? `<p class="note note-solo">Solo practice: you hold every piece.</p>` : '';
  return `${hud()}
  <section class="station">
    <p class="kicker">Module ${v.moduleIndex + 1} of ${v.moduleCount} · ${esc(MODULES[type].name)}</p>
    <h2 class="stage-title">Your station</h2>
    ${banner}${solo}
    <div class="panels">${panels}${clock}${nothing}</div>
  </section>
  ${crewList()}`;
}

function screenCleared() {
  const v = ui.view;
  return `${hud()}
  <section class="center">
    <p class="kicker">Module ${v.moduleIndex + 1} of ${v.moduleCount} stabilized</p>
    <h2 class="stage-title">+${v.rules.bonusSeconds} seconds</h2>
    <p class="big-time">${fmt(v.timeLeftMs)}</p>
    <p class="sub">Next: ${esc(MODULES[v.nextType]?.name || '')}. Stations reshuffle in <b data-phase-left>${Math.ceil(v.phaseLeftMs / 1000)}</b>.</p>
  </section>
  ${crewList()}`;
}

function screenWon() {
  const v = ui.view;
  const r = v.result;
  return `${hud()}
  <section class="center end end-won">
    <div class="sat-safe" aria-hidden="true"><svg viewBox="0 0 120 80"><rect x="48" y="28" width="24" height="24" rx="3" fill="var(--orange)"/><rect x="8" y="34" width="36" height="12" fill="var(--panel)"/><rect x="76" y="34" width="36" height="12" fill="var(--panel)"/><path d="M60 28 V12" stroke="var(--panel)" stroke-width="3"/><circle cx="60" cy="10" r="4" fill="var(--signal)"/></svg></div>
    <p class="kicker">Mission complete</p>
    <h2 class="stage-title">Satellite stabilized</h2>
    <dl class="stats"><div><dt>Time left</dt><dd>${fmt(r.timeLeftMs)}</dd></div><div><dt>Strikes</dt><dd>${r.strikes}</dd></div><div><dt>Difficulty</dt><dd>${esc(
    CONFIG.difficulty[r.difficulty].label
  )}</dd></div></dl>
    ${v.you.isHost ? `<button class="btn btn-orange btn-wide" data-act="lobby">Fly another mission</button>` : `<p class="note">${esc(playerName(v.hostId))} can start another mission.</p>`}
  </section>
  ${crewList()}`;
}

function screenLost() {
  const v = ui.view;
  const r = v.result;
  return `${hud()}
  <section class="center end end-lost">
    <div class="crash" aria-hidden="true"><svg viewBox="0 0 120 120"><g class="crash-sat"><rect x="48" y="48" width="24" height="24" rx="3" fill="var(--orange)"/><rect x="8" y="54" width="36" height="12" fill="var(--panel)"/><rect x="76" y="54" width="36" height="12" fill="var(--panel)"/></g></svg></div>
    <p class="kicker">Signal lost</p>
    <h2 class="stage-title">The satellite crashed</h2>
    <p class="sub">${esc(r.reason)} You reached module ${r.module} of ${v.moduleCount}.</p>
    ${v.you.isHost ? `<button class="btn btn-orange btn-wide" data-act="lobby">Try again</button>` : `<p class="note">${esc(playerName(v.hostId))} can start another mission.</p>`}
  </section>
  ${crewList()}`;
}

function openSheet(kind) {
  let body = '';
  if (kind === 'howto') body = howTo().replace('class="card howto"', 'class="howto"');
  if (kind === 'menu') {
    const v = ui.view;
    body = `<h2 class="sheet-title">Room ${esc(v?.code || '')}</h2>
      ${v ? `<button class="btn btn-line btn-wide" data-act="invite">Copy invite link</button>` : ''}
      <button class="btn btn-line btn-wide" data-open="howto">How it works</button>
      ${v ? `<button class="btn btn-danger btn-wide" data-act="leave">${host ? 'Close the room' : 'Leave the room'}</button>` : ''}
      ${host ? '<p class="hint-left">You are hosting: the mission runs on this device, so keep this tab open. If you refresh, the room reopens and the crew reconnects.</p>' : ''}`;
  }
  $sheet.innerHTML = `<div class="sheet-inner">${body}<button class="btn btn-ghost btn-wide" data-close>Close</button></div>`;
  if (!$sheet.open) $sheet.showModal();
}

// ---------- render ----------

function render() {
  if (ui.mode === 'home') {
    $app.innerHTML = screenHome();
    delete $app.dataset.phase;
    document.getElementById('homeForm').addEventListener('submit', onHomeSubmit);
    return;
  }
  if (ui.mode === 'connecting' || !ui.view) {
    $app.innerHTML = screenConnecting();
    return;
  }
  const v = ui.view;
  const screens = { lobby: screenLobby, briefing: screenModule, module: screenModule, cleared: screenCleared, won: screenWon, lost: screenLost };
  const prev = $app.dataset.phase;
  const y = window.scrollY;
  $app.innerHTML = (screens[v.phase] || screenLobby)();
  $app.dataset.phase = v.phase;
  document.body.dataset.phase = v.phase;
  if (prev === v.phase || (prev === 'briefing' && v.phase === 'module')) window.scrollTo(0, y);
  else window.scrollTo(0, 0);
  updateClock();
  renderStatus();
}

let submitIntent = 'create';
function onHomeSubmit(e) {
  e.preventDefault();
  const intent = e.submitter?.dataset.intent || submitIntent;
  const name = cleanName(document.getElementById('name').value);
  if (!name) {
    ui.homeError = 'Enter your name first.';
    return render();
  }
  store.set('ss-name', name);
  ui.homeError = '';
  if (intent === 'join') {
    const code = document.getElementById('code').value.toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 4) {
      ui.homeError = 'Room codes are 4 letters.';
      return render();
    }
    joinRoom(code, name);
  } else createRoom(name);
}

// ---------- events ----------

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act],[data-open],[data-close],[data-mod],[data-intent]');
  if (!t || t.disabled) return;
  if (t.dataset.intent) submitIntent = t.dataset.intent;
  if (t.dataset.close !== undefined) return $sheet.close();
  if (t.dataset.open) return openSheet(t.dataset.open);
  if (t.dataset.mod) {
    const a = { type: 'module', op: t.dataset.mod };
    if (t.dataset.index !== undefined) a.index = Number(t.dataset.index);
    if (t.dataset.delta !== undefined) a.delta = Number(t.dataset.delta);
    if (t.dataset.digit !== undefined) a.digit = Number(t.dataset.digit);
    return doAct(a);
  }
  switch (t.dataset.act) {
    case 'start':
      return doAct({ type: 'start' });
    case 'lobby':
      return doAct({ type: 'lobby' });
    case 'difficulty':
      return doAct({ type: 'difficulty', level: t.dataset.level });
    case 'remove':
      return doAct({ type: 'remove', id: t.dataset.id });
    case 'invite': {
      const link = inviteLink(ui.view.code);
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        try {
          await navigator.share({ title: 'Split Signal', text: 'Join my Split Signal crew', url: link });
          return;
        } catch {
          /* fall back to copy */
        }
      }
      try {
        await navigator.clipboard.writeText(link);
        toast('Invite link copied.');
      } catch {
        prompt('Copy this invite link:', link);
      }
      return;
    }
    case 'leave':
      $sheet.close();
      return leave();
    case 'cancel':
      client?.close();
      client = null;
      if (host) {
        clearInterval(host.loop);
        host = null;
      }
      return homeFail('');
    default:
  }
});

$sheet.addEventListener('click', (e) => {
  if (e.target === $sheet) $sheet.close();
});

window.addEventListener('beforeunload', (e) => {
  if (host && ui.view && ['briefing', 'module', 'cleared'].includes(ui.view.phase)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function boot() {
  const params = new URLSearchParams(location.search);
  const urlRoom = (params.get('room') || '').toUpperCase();
  if (session && (!urlRoom || urlRoom === session.code)) {
    if (session.role === 'host') {
      const saved = store.get('ss-state-' + session.code);
      if (saved) return resumeHost(saved);
    } else return joinRoom(session.code, session.name);
  }
  render();
  if (params.get('join')) document.getElementById('name')?.focus();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

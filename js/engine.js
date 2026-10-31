// Split Signal engine. Pure state + functions; the host's browser runs it and
// sends each player only the pieces they hold.

import { MODULE_ORDER, generateModule, shuffle } from './puzzles.js';

export const CONFIG = {
  maxPlayers: 6,
  briefingMs: 6000,
  clearedMs: 3500,
  difficulty: {
    cadet: { label: 'Cadet', startSeconds: 300, strikes: 4, bonusSeconds: 20, penaltySeconds: 10 },
    commander: { label: 'Commander', startSeconds: 200, strikes: 3, bonusSeconds: 15, penaltySeconds: 15 },
  },
};

const CALLSIGNS = ['Falcon', 'Comet', 'Orbit', 'Vector', 'Nova', 'Relay', 'Quasar', 'Pulsar'];
const PIECE_KEYS = ['control', 'intelA', 'intelB', 'clock'];

function bump(s) {
  s.version += 1;
}

export function getPlayer(s, id) {
  return s.players.find((p) => p.id === id) || null;
}

export function cleanName(name) {
  return String(name || '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
}

function log(s, msg) {
  s.log.push(msg);
  if (s.log.length > 30) s.log.shift();
}

// ---------- room ----------

export function createGame(code) {
  return {
    code,
    version: 1,
    phase: 'lobby', // lobby | briefing | module | cleared | won | lost
    hostId: null,
    difficulty: 'cadet',
    players: [],
    modules: [],
    moduleIndex: 0,
    assignment: {}, // pieceKey -> [playerIds]
    deadline: 0, // clock end while running
    frozenMs: 0, // clock remaining while stopped
    phaseEndsAt: 0,
    strikes: 0,
    flash: { kind: null, n: 0, by: null, text: '' },
    result: null,
    lastControlId: null,
    log: [],
  };
}

export function addPlayer(s, { id, name }, rng = Math.random) {
  const existing = getPlayer(s, id);
  if (existing) {
    existing.connected = true;
    bump(s);
    return { ok: true, player: existing, rejoined: true };
  }
  const clean = cleanName(name);
  if (!clean) return { ok: false, error: 'Enter a name to join.' };
  const twin = s.players.find((p) => p.name.toLowerCase() === clean.toLowerCase());
  if (twin) return { ok: false, error: `Someone here is already called ${twin.name}. Pick another name.` };
  if (s.phase !== 'lobby') return { ok: false, error: 'This mission has already launched. Ask the host to start a new one.' };
  if (s.players.length >= CONFIG.maxPlayers) return { ok: false, error: 'Mission control is full (6 players).' };
  const used = new Set(s.players.map((p) => p.callsign));
  const free = CALLSIGNS.filter((c) => !used.has(c));
  const player = { id, name: clean, callsign: free[Math.floor(rng() * free.length)] || 'Relay', connected: true };
  s.players.push(player);
  if (!s.hostId) s.hostId = id;
  bump(s);
  return { ok: true, player };
}

export function setConnected(s, id, connected) {
  const p = getPlayer(s, id);
  if (!p || p.connected === connected) return;
  p.connected = connected;
  if (s.phase === 'module' || s.phase === 'briefing' || s.phase === 'cleared') reassign(s);
  bump(s);
}

export function removePlayer(s, id) {
  if (s.phase !== 'lobby') return { ok: false, error: 'Players can only be removed before launch.' };
  if (id === s.hostId) return { ok: false, error: 'The host cannot be removed.' };
  s.players = s.players.filter((p) => p.id !== id);
  bump(s);
  return { ok: true };
}

export function setDifficulty(s, level) {
  if (s.phase !== 'lobby') return { ok: false, error: 'Difficulty is set before launch.' };
  if (!CONFIG.difficulty[level]) return { ok: false, error: 'Unknown difficulty.' };
  s.difficulty = level;
  bump(s);
  return { ok: true };
}

// ---------- clock ----------

export function timeLeft(s, now) {
  if (s.phase === 'module') return Math.max(0, s.deadline - now);
  return s.frozenMs;
}

function runClock(s, now) {
  s.deadline = now + s.frozenMs;
}

function stopClock(s, now) {
  s.frozenMs = Math.max(0, s.deadline - now);
}

function addTime(s, now, seconds) {
  if (s.phase === 'module') s.deadline += seconds * 1000;
  else s.frozenMs += seconds * 1000;
  if (s.phase === 'module' && s.deadline < now) s.deadline = now;
  if (s.frozenMs < 0) s.frozenMs = 0;
}

// ---------- roles ----------

function present(s) {
  return s.players.filter((p) => p.connected);
}

// Deal the four pieces to the players who are here. The control piece rotates
// so the same person rarely holds it twice in a row.
export function deal(s, rng) {
  const crew = shuffle(present(s), rng);
  if (crew.length > 1 && crew[0].id === s.lastControlId) crew.push(crew.shift());
  const assignment = { control: [], intelA: [], intelB: [], clock: [] };
  if (crew.length === 0) {
    s.assignment = assignment;
    return;
  }
  const controller = crew[0];
  assignment.control.push(controller.id);
  s.lastControlId = controller.id;
  const others = crew.length > 1 ? crew.slice(1) : crew;
  const rest = shuffle(['intelA', 'intelB', 'clock'], rng);
  rest.forEach((key, i) => assignment[key].push(others[i % others.length].id));
  // With 5-6 players, extra crew get backup copies of the intel pieces.
  others.slice(3).forEach((p, i) => assignment[['intelA', 'intelB', 'clock'][i % 3]].push(p.id));
  s.assignment = assignment;
}

// Give pieces held only by absent players to someone present.
function reassign(s) {
  const here = new Set(present(s).map((p) => p.id));
  if (here.size === 0) return;
  const load = (id) => PIECE_KEYS.filter((k) => s.assignment[k]?.includes(id)).length;
  PIECE_KEYS.forEach((k) => {
    const holders = (s.assignment[k] || []).filter((id) => here.has(id));
    if (holders.length === 0) {
      const ids = [...here].sort((a, b) => load(a) - load(b));
      holders.push(ids[0]);
    }
    s.assignment[k] = holders;
  });
}

export function piecesFor(s, pid) {
  return PIECE_KEYS.filter((k) => s.assignment[k]?.includes(pid));
}

// ---------- flow ----------

export function startMission(s, now, rng = Math.random) {
  if (s.phase !== 'lobby' && s.phase !== 'won' && s.phase !== 'lost') return { ok: false, error: 'The mission is already running.' };
  if (present(s).length < 1) return { ok: false, error: 'Nobody is here.' };
  const d = CONFIG.difficulty[s.difficulty];
  s.modules = MODULE_ORDER.map((type, i) => generateModule(type, rng, i));
  s.moduleIndex = 0;
  s.strikes = 0;
  s.frozenMs = d.startSeconds * 1000;
  s.result = null;
  s.lastControlId = null;
  s.flash = { kind: null, n: s.flash.n, by: null, text: '' };
  deal(s, rng);
  s.phase = 'briefing';
  s.phaseEndsAt = now + CONFIG.briefingMs;
  log(s, 'Mission launched.');
  bump(s);
  return { ok: true };
}

function beginModule(s, now) {
  s.phase = 'module';
  s.phaseEndsAt = 0;
  runClock(s, now);
  bump(s);
}

function flash(s, kind, by, text) {
  s.flash = { kind, n: s.flash.n + 1, by, text };
}

function strike(s, now, pid, text) {
  const d = CONFIG.difficulty[s.difficulty];
  s.strikes += 1;
  addTime(s, now, -d.penaltySeconds);
  flash(s, 'strike', pid, text);
  log(s, `Strike ${s.strikes}: ${text}`);
  if (s.strikes >= d.strikes) lose(s, now, 'Too many strikes. The satellite tore itself apart.');
  bump(s);
}

function clearModule(s, now, pid) {
  const d = CONFIG.difficulty[s.difficulty];
  stopClock(s, now);
  const mod = s.modules[s.moduleIndex];
  flash(s, 'clear', pid, `${moduleName(mod.type)} stabilized`);
  if (s.moduleIndex >= s.modules.length - 1) {
    s.phase = 'won';
    s.result = { won: true, timeLeftMs: s.frozenMs, strikes: s.strikes, difficulty: s.difficulty };
    log(s, 'Satellite stabilized.');
  } else {
    s.frozenMs += d.bonusSeconds * 1000;
    s.phase = 'cleared';
    s.phaseEndsAt = now + CONFIG.clearedMs;
  }
  bump(s);
}

function lose(s, now, reason) {
  if (s.phase === 'module') stopClock(s, now);
  s.phase = 'lost';
  s.frozenMs = Math.max(0, s.frozenMs);
  s.result = { won: false, reason, module: s.moduleIndex + 1, strikes: s.strikes, difficulty: s.difficulty };
  flash(s, 'crash', null, reason);
  log(s, reason);
}

function moduleName(type) {
  return { wires: 'Wire harness', keypad: 'Glyph keypad', dial: 'Frequency dial', code: 'Uplink code', switches: 'Power switches' }[type];
}

export function tick(s, now, rng = Math.random) {
  const v = s.version;
  if (s.phase === 'briefing' && now >= s.phaseEndsAt) beginModule(s, now);
  else if (s.phase === 'cleared' && now >= s.phaseEndsAt) {
    s.moduleIndex += 1;
    deal(s, rng);
    beginModule(s, now);
  } else if (s.phase === 'module' && now >= s.deadline) {
    lose(s, now, 'Out of time. The satellite lost its orbit.');
    bump(s);
  }
  return s.version !== v;
}

// ---------- module actions (control holder only) ----------

function control(s, pid) {
  if (s.phase !== 'module') return { ok: false, error: 'No module is live right now.' };
  if (!s.assignment.control.includes(pid)) return { ok: false, error: 'Only the player holding the controls can do that.' };
  return null;
}

export function moduleAction(s, pid, a, now) {
  const denied = control(s, pid);
  if (denied) return denied;
  const mod = s.modules[s.moduleIndex];
  const c = mod.pieces.control;
  switch (`${mod.type}:${a.op}`) {
    case 'wires:cut': {
      const w = c.wires[a.index];
      if (!w || w.cut) return { ok: false, error: 'That wire is already cut.' };
      w.cut = true;
      if (a.index === mod.answer.index) clearModule(s, now, pid);
      else strike(s, now, pid, `Wrong wire cut (${w.color}).`);
      return { ok: true };
    }
    case 'keypad:press': {
      const b = c.buttons[a.index];
      if (!b || b.pressed) return { ok: false, error: 'That glyph is already locked in.' };
      const next = mod.answer.order[c.buttons.filter((x) => x.pressed).length];
      if (b.glyph === next) {
        b.pressed = true;
        bump(s);
        if (c.buttons.every((x) => x.pressed)) clearModule(s, now, pid);
      } else strike(s, now, pid, `Glyph ${b.glyph} pressed out of order.`);
      return { ok: true };
    }
    case 'dial:turn': {
      const step = a.delta > 0 ? 1 : -1;
      c.value = (c.value + step + 16) % 16;
      bump(s);
      return { ok: true };
    }
    case 'dial:lock': {
      if (c.value === mod.answer.value) clearModule(s, now, pid);
      else strike(s, now, pid, `Dial locked on the wrong frequency (${c.value}).`);
      return { ok: true };
    }
    case 'code:digit': {
      const d = Number(a.digit);
      if (!Number.isInteger(d) || d < 0 || d > 9) return { ok: false, error: 'Digits only.' };
      if (c.entered.length >= 4) return { ok: false, error: 'Four digits max. Clear or transmit.' };
      c.entered.push(d);
      bump(s);
      return { ok: true };
    }
    case 'code:clear': {
      c.entered = [];
      bump(s);
      return { ok: true };
    }
    case 'code:send': {
      if (c.entered.length !== 4) return { ok: false, error: 'Enter all four digits first.' };
      if (c.entered.join('') === mod.answer.code.join('')) clearModule(s, now, pid);
      else {
        const sent = c.entered.join('');
        c.entered = [];
        strike(s, now, pid, `Wrong uplink code (${sent}).`);
      }
      return { ok: true };
    }
    case 'switches:toggle': {
      if (c.on[a.index] === undefined) return { ok: false, error: 'No such switch.' };
      c.on[a.index] = !c.on[a.index];
      bump(s);
      return { ok: true };
    }
    case 'switches:engage': {
      if (c.on.every((v, i) => v === mod.answer.on[i])) clearModule(s, now, pid);
      else strike(s, now, pid, 'Wrong load engaged.');
      return { ok: true };
    }
    default:
      return { ok: false, error: 'That control isn’t on this module.' };
  }
}

export function backToLobby(s) {
  if (s.phase !== 'won' && s.phase !== 'lost') return { ok: false, error: 'The mission is still running.' };
  s.players = s.players.filter((p) => p.connected || p.id === s.hostId);
  Object.assign(s, { phase: 'lobby', modules: [], moduleIndex: 0, assignment: {}, strikes: 0, result: null, frozenMs: 0 });
  bump(s);
  return { ok: true };
}

export function act(s, pid, action, now, rng = Math.random) {
  const isHost = pid === s.hostId;
  switch (action?.type) {
    case 'start':
      if (!isHost) return { ok: false, error: 'Only the host can launch the mission.' };
      return startMission(s, now, rng);
    case 'difficulty':
      if (!isHost) return { ok: false, error: 'Only the host can change difficulty.' };
      return setDifficulty(s, action.level);
    case 'remove':
      if (!isHost) return { ok: false, error: 'Only the host can remove players.' };
      return removePlayer(s, action.id);
    case 'lobby':
      if (!isHost) return { ok: false, error: 'Only the host can do that.' };
      return backToLobby(s);
    case 'module':
      return moduleAction(s, pid, action, now);
    default:
      return { ok: false, error: 'Unknown action.' };
  }
}

// ---------- per-player view ----------

export function viewFor(s, pid, now) {
  const mod = s.modules[s.moduleIndex];
  const mine = s.phase === 'lobby' ? [] : piecesFor(s, pid);
  const d = CONFIG.difficulty[s.difficulty];
  const left = timeLeft(s, now);
  const showTime = mine.includes('clock') || s.phase === 'won' || s.phase === 'lost' || s.phase === 'cleared';
  return {
    code: s.code,
    version: s.version,
    phase: s.phase,
    hostId: s.hostId,
    difficulty: s.difficulty,
    rules: d,
    players: s.players.map((p) => ({
      id: p.id,
      name: p.name,
      callsign: p.callsign,
      connected: p.connected,
      pieces: s.phase === 'lobby' ? [] : piecesFor(s, p.id),
    })),
    moduleIndex: s.moduleIndex,
    moduleCount: s.modules.length || 5,
    moduleType: mod?.type || null,
    nextType: s.modules[s.moduleIndex + 1]?.type || null,
    strikes: s.strikes,
    // Everyone sees a rough orbit-decay bar; only the clock holder sees seconds.
    decay: s.modules.length ? Math.max(0, Math.min(1, left / (d.startSeconds * 1000))) : 1,
    timeLeftMs: showTime ? left : null,
    clockRunning: s.phase === 'module',
    phaseLeftMs: s.phaseEndsAt ? Math.max(0, s.phaseEndsAt - now) : 0,
    flash: s.flash,
    result: s.result,
    you: { id: pid, isHost: pid === s.hostId, pieces: mine },
    pieces:
      mod && (s.phase === 'module' || s.phase === 'briefing')
        ? Object.fromEntries(mine.filter((k) => k !== 'clock').map((k) => [k, mod.pieces[k]]))
        : {},
  };
}

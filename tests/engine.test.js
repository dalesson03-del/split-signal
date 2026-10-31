import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, addPlayer, act, tick, viewFor, setConnected, CONFIG } from '../js/engine.js';
import { generateModule, MODULE_ORDER } from '../js/puzzles.js';

function seeded(seed = 1) {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}

function room(n, rng = seeded()) {
  const s = createGame('ABCD');
  for (let i = 0; i < n; i++) addPlayer(s, { id: 'p' + i, name: 'P' + i }, rng);
  return s;
}

function launch(s, rng = seeded(), now = 0) {
  assert.equal(act(s, s.hostId, { type: 'start' }, now, rng).ok, true);
  tick(s, now + CONFIG.briefingMs, rng);
  assert.equal(s.phase, 'module');
  return now + CONFIG.briefingMs;
}

// Solve the live module the way a team would: control holder acts on intel.
function solve(s, now) {
  const mod = s.modules[s.moduleIndex];
  const pid = s.assignment.control[0];
  const a = mod.answer;
  const c = mod.pieces.control;
  const go = (x) => assert.equal(act(s, pid, { type: 'module', ...x }, now).ok, true);
  if (mod.type === 'wires') go({ op: 'cut', index: a.index });
  if (mod.type === 'keypad') a.order.forEach((g) => go({ op: 'press', index: c.buttons.findIndex((b) => b.glyph === g) }));
  if (mod.type === 'dial') {
    while (c.value !== a.value) go({ op: 'turn', delta: 1 });
    go({ op: 'lock' });
  }
  if (mod.type === 'code') {
    a.code.forEach((d) => go({ op: 'digit', digit: d }));
    go({ op: 'send' });
  }
  if (mod.type === 'switches') {
    a.on.forEach((v, i) => v && go({ op: 'toggle', index: i }));
    go({ op: 'engage' });
  }
}

test('puzzles are solvable from intel alone', () => {
  const rng = seeded(9);
  for (let i = 0; i < 300; i++) {
    for (const type of MODULE_ORDER) {
      const m = generateModule(type, rng, i % 3);
      const { control, intelA, intelB } = m.pieces;
      if (type === 'wires') {
        const row = intelB.rows.find((r) => r.symbol === intelA.symbol);
        assert.ok(row, 'serial symbol is in the manual');
        assert.ok(m.answer.index >= 0 && m.answer.index < control.wires.length);
      }
      if (type === 'keypad') {
        const col = intelB.columns.find((c) => c.color === intelA.color);
        const mine = control.buttons.map((b) => b.glyph);
        assert.deepEqual(col.glyphs.filter((g) => mine.includes(g)), m.answer.order);
      }
      if (type === 'dial') {
        const r = intelB.colors.indexOf(intelA.color);
        const c = intelB.shapes.indexOf(intelA.shape);
        assert.equal(intelB.grid[r][c], m.answer.value);
        assert.notEqual(control.value, m.answer.value);
      }
      if (type === 'code') {
        assert.deepEqual(
          intelB.order.map((col) => intelA.chips.find((x) => x.color === col).digit),
          m.answer.code
        );
      }
      if (type === 'switches') {
        const sum = intelB.rows.reduce((t, r, idx) => t + (m.answer.on[idx] ? r.weight : 0), 0);
        assert.equal(sum, intelA.target);
      }
    }
  }
});

test('pieces are split across players, control rotates, intel never leaks', () => {
  const s = room(3);
  launch(s);
  const holders = Object.values(s.assignment).flat();
  assert.equal(new Set(holders).size, 3, 'everyone holds something');
  for (const p of s.players) {
    const v = viewFor(s, p.id, 0);
    const keys = Object.keys(v.pieces);
    keys.forEach((k) => assert.ok(s.assignment[k].includes(p.id)));
    assert.ok(!JSON.stringify(v).includes('"answer"'));
    if (!s.assignment.clock.includes(p.id)) assert.equal(v.timeLeftMs, null, 'only the clock holder sees seconds');
  }
  const firstController = s.assignment.control[0];
  let now = CONFIG.briefingMs;
  solve(s, now);
  tick(s, now + CONFIG.clearedMs + 1);
  assert.notEqual(s.assignment.control[0], firstController, 'control rotates');
});

test('two players: one controls, the other holds every clue', () => {
  const s = room(2);
  launch(s);
  const ctrl = s.assignment.control[0];
  const other = s.players.find((p) => p.id !== ctrl).id;
  ['intelA', 'intelB', 'clock'].forEach((k) => assert.deepEqual(s.assignment[k], [other]));
});

test('solo practice: one player holds everything and can win', () => {
  const s = room(1);
  let now = launch(s);
  for (let i = 0; i < 5; i++) {
    solve(s, now);
    now += 1000;
    tick(s, now + CONFIG.clearedMs);
    now += CONFIG.clearedMs;
  }
  assert.equal(s.phase, 'won');
  assert.ok(s.result.timeLeftMs > 0);
});

test('only the controller can act; wrong moves strike and cost time', () => {
  const s = room(3);
  const now = launch(s);
  const notCtrl = s.players.find((p) => !s.assignment.control.includes(p.id)).id;
  assert.equal(act(s, notCtrl, { type: 'module', op: 'cut', index: 0 }, now).ok, false);
  const mod = s.modules[0];
  const wrong = mod.pieces.control.wires.findIndex((_, i) => i !== mod.answer.index);
  const before = s.deadline;
  act(s, s.assignment.control[0], { type: 'module', op: 'cut', index: wrong }, now);
  assert.equal(s.strikes, 1);
  assert.equal(s.flash.kind, 'strike');
  assert.equal(s.deadline, before - CONFIG.difficulty.cadet.penaltySeconds * 1000);
});

test('too many strikes or running out of time crashes the satellite', () => {
  const s = room(2);
  act(s, 'p0', { type: 'difficulty', level: 'commander' }, 0);
  let now = launch(s);
  const pid = s.assignment.control[0];
  // Wires module: cut wrong wires until crash.
  const mod = s.modules[0];
  const wrongs = mod.pieces.control.wires.map((_, i) => i).filter((i) => i !== mod.answer.index);
  wrongs.slice(0, 3).forEach((i) => act(s, pid, { type: 'module', op: 'cut', index: i }, now));
  assert.equal(s.phase, 'lost');
  assert.equal(s.flash.kind, 'crash');

  const t = room(2);
  now = launch(t);
  tick(t, now + CONFIG.difficulty.cadet.startSeconds * 1000 + 1);
  assert.equal(t.phase, 'lost');
  assert.match(t.result.reason, /Out of time/);
});

test('a dropped player’s pieces move to someone present', () => {
  const s = room(3);
  launch(s);
  const ctrl = s.assignment.control[0];
  setConnected(s, ctrl, false);
  assert.ok(s.assignment.control.length === 1 && s.assignment.control[0] !== ctrl);
  Object.values(s.assignment).forEach((ids) => assert.ok(ids.every((id) => id !== ctrl)));
});

test('late joiners are refused mid-mission; names must be unique', () => {
  const s = room(2);
  assert.equal(addPlayer(s, { id: 'x', name: 'p0' }).ok, false);
  launch(s);
  assert.equal(addPlayer(s, { id: 'late', name: 'Late' }).ok, false);
  assert.equal(addPlayer(s, { id: 'p1', name: 'whatever' }).rejoined, true);
});

test('full mission with 4 players, then back to the lobby', () => {
  const rng = seeded(4);
  const s = room(4, rng);
  let now = launch(s, rng);
  const controllers = [];
  for (let i = 0; i < 5; i++) {
    controllers.push(s.assignment.control[0]);
    solve(s, now);
    now += 2000;
    tick(s, now + CONFIG.clearedMs, rng);
    now += CONFIG.clearedMs;
  }
  assert.equal(s.phase, 'won');
  for (let i = 1; i < controllers.length; i++) assert.notEqual(controllers[i], controllers[i - 1]);
  assert.equal(act(s, 'p0', { type: 'lobby' }, now).ok, true);
  assert.equal(s.phase, 'lobby');
});

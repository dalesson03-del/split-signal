// End-to-end: a host and two crew in separate tabs fly a full mission, plus a
// solo practice run. Uses tests/fake-peer.js (offline). Serve on :5174 first.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:5174/';
const SHOTS = process.env.SHOTS || 'test-shots';
mkdirSync(SHOTS, { recursive: true });
const fake = readFileSync(new URL('./fake-peer.js', import.meta.url), 'utf8');
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function crewContext() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(fake);
  await ctx.route(/unpkg\.com|jsdelivr\.net|fonts\.g/, (r) => r.abort());
  return ctx;
}
async function open(ctx, name) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`${name}: ${m.text()}`));
  p.on('dialog', (d) => d.accept());
  return p;
}
const phase = (p) => p.evaluate(() => document.getElementById('app').dataset.phase || 'home');
const shot = (p, n) => p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });

// Find the page holding the controls, then click the right answer through the UI.
async function solveModule(host, pages, { wrongFirst = false } = {}) {
  const info = await host.evaluate(() => {
    const s = window.__ssHost.state;
    const m = s.modules[s.moduleIndex];
    return { type: m.type, answer: m.answer, control: m.pieces.control, ctrl: s.assignment.control[0] };
  });
  const ids = await Promise.all(pages.map((p) => p.evaluate(() => JSON.parse(sessionStorage.getItem('ss-session')).id)));
  const p = pages[ids.indexOf(info.ctrl)];
  const click = (sel) => p.click(sel);
  const { type, answer, control } = info;
  if (wrongFirst && type === 'wires') {
    const wrong = control.wires.findIndex((_, i) => i !== answer.index);
    await click(`[data-mod="cut"][data-index="${wrong}"]`);
    await sleep(300);
  }
  if (type === 'wires') await click(`[data-mod="cut"][data-index="${answer.index}"]`);
  if (type === 'keypad')
    for (const g of answer.order) {
      const i = control.buttons.findIndex((b) => b.glyph === g);
      await click(`[data-mod="press"][data-index="${i}"]`);
      await sleep(120);
    }
  if (type === 'dial') {
    let v = control.value;
    while (v !== answer.value) {
      await click('[data-mod="turn"][data-delta="1"]');
      v = (v + 1) % 16;
      await sleep(60);
    }
    await click('[data-mod="lock"]');
  }
  if (type === 'code') {
    for (const d of answer.code) {
      await click(`[data-mod="digit"][data-digit="${d}"]`);
      await sleep(80);
    }
    await click('[data-mod="send"]');
  }
  if (type === 'switches') {
    for (const [i, on] of answer.on.entries())
      if (on) {
        await click(`[data-mod="toggle"][data-index="${i}"]`);
        await sleep(80);
      }
    await click('[data-mod="engage"]');
  }
  return { type, controller: pages.indexOf(p) };
}

async function waitPhase(p, want, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (want.includes(await phase(p))) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${want}`);
}

// ----- crew game -----
const ctx = await crewContext();
const host = await open(ctx, 'host');
await host.goto(BASE);
await shot(host, '01-home');
await host.fill('#name', 'Edwin');
await host.click('[data-intent="create"]');
await host.waitForSelector('.codeplate-code');
const code = (await host.textContent('.codeplate-code')).trim();
const pages = [host];
for (const name of ['Amina', 'Kofi']) {
  const p = await open(ctx, name);
  await p.goto(`${BASE}?join=${code}`);
  await p.fill('#name', name);
  await p.click('[data-intent="join"]');
  await p.waitForSelector('.codeplate-code');
  pages.push(p);
}
await shot(host, '02-lobby');
await host.click('[data-act="start"]');
await waitPhase(host, ['module']);
// Each player sees different pieces.
const held = await Promise.all(pages.map((p) => p.$$eval('.panel-name', (els) => els.map((e) => e.textContent))));
console.log('stations:', held);
for (const [i, p] of pages.entries()) await shot(p, `10-module1-p${i}`);

const controllers = [];
for (let m = 0; m < 5; m++) {
  await waitPhase(host, ['module']);
  const r = await solveModule(host, pages, { wrongFirst: m === 0 });
  if (m === 0) {
    await sleep(200);
    const strikes = await Promise.all(pages.map((p) => p.$$eval('.hud-strikes .led.is-on', (e) => e.length)));
    console.log('strike seen on every screen:', strikes);
  }
  controllers.push(r.controller);
  if (m === 1) {
    // Refresh a crew member mid-mission: they must come back to the same seat.
    const other = pages[(r.controller + 1) % 3];
    await other.reload();
    await other.waitForSelector('.hud', { timeout: 20000 });
  }
  if (m < 4) {
    await waitPhase(host, ['cleared']);
    if (m === 0) await shot(host, '20-cleared');
  }
}
await waitPhase(host, ['won']);
await sleep(400);
for (const [i, p] of pages.entries()) await shot(p, `30-won-p${i}`);
console.log('controllers per module:', controllers);
console.log('everyone sees the win:', await Promise.all(pages.map(phase)));

// ----- crash -----
await host.click('[data-act="lobby"]');
await waitPhase(host, ['lobby']);
await host.click('[data-act="difficulty"][data-level="commander"]');
await host.click('[data-act="start"]');
await waitPhase(host, ['module']);
for (let k = 0; k < 3; k++) {
  const info = await host.evaluate(() => {
    const s = window.__ssHost.state;
    const m = s.modules[0];
    return { ctrl: s.assignment.control[0], wrong: m.pieces.control.wires.map((w, i) => i).filter((i) => i !== m.answer.index && !m.pieces.control.wires[i].cut)[0] };
  });
  const ids = await Promise.all(pages.map((p) => p.evaluate(() => JSON.parse(sessionStorage.getItem('ss-session')).id)));
  await pages[ids.indexOf(info.ctrl)].click(`[data-mod="cut"][data-index="${info.wrong}"]`);
  await sleep(250);
}
await waitPhase(host, ['lost']);
await sleep(1700);
console.log('everyone sees the crash:', await Promise.all(pages.map(phase)));
await shot(pages[1], '40-lost');

// ----- solo practice -----
const solo = await crewContext();
const s1 = await open(solo, 'solo');
await s1.goto(BASE);
await s1.fill('#name', 'Solo');
await s1.click('[data-intent="create"]');
await s1.waitForSelector('.codeplate-code');
await s1.click('[data-act="start"]');
for (let m = 0; m < 5; m++) {
  await waitPhase(s1, ['module']);
  if (m === 0) await shot(s1, '50-solo');
  if (m === 2) await shot(s1, '51-solo-dial');
  if (m === 3) await shot(s1, '52-solo-code');
  if (m === 4) await shot(s1, '53-solo-switches');
  await solveModule(s1, [s1]);
  if (m === 1) await shot(s1, '54-solo-keypad-after');
}
await waitPhase(s1, ['won']);
console.log('solo practice won');
await s1.setViewportSize({ width: 1280, height: 900 });
await s1.click('[data-act="lobby"]');
await s1.click('[data-act="start"]');
await waitPhase(s1, ['module']);
await shot(s1, '60-desktop');

console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);

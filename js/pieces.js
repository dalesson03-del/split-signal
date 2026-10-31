// Renders each piece as a hardware panel. Every color is also written out in
// words so the game works for colorblind players.

import { MODULES, CLOCK_PIECE } from './puzzles.js';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th'];

export function pieceInfo(type, key) {
  if (key === 'clock') return CLOCK_PIECE;
  return MODULES[type]?.pieces[key] || { name: key, how: '' };
}

function panel(type, key, body, { live = true } = {}) {
  const info = pieceInfo(type, key);
  const role = key === 'control' ? 'control' : key === 'clock' ? 'clock' : 'intel';
  return `<section class="panel panel-${role}" aria-label="${esc(info.name)}">
    <span class="screw tl"></span><span class="screw tr"></span><span class="screw bl"></span><span class="screw br"></span>
    <header class="panel-head">
      <span class="panel-kind">${role === 'control' ? 'Controls' : role === 'clock' ? 'Clock' : 'Intel'}</span>
      <h3 class="panel-name">${esc(info.name)}</h3>
    </header>
    <p class="panel-how">${esc(info.how)}</p>
    <div class="panel-body${live ? '' : ' is-locked'}">${body}</div>
  </section>`;
}

function shapeSvg(shape, color) {
  const fill = `var(--beacon-${color})`;
  const inner =
    shape === 'circle'
      ? `<circle cx="32" cy="32" r="22" fill="${fill}"/>`
      : shape === 'triangle'
      ? `<path d="M32 8 L58 54 H6 Z" fill="${fill}"/>`
      : `<rect x="11" y="11" width="42" height="42" rx="3" fill="${fill}"/>`;
  return `<svg class="shape" viewBox="0 0 64 64" aria-hidden="true">${inner}</svg>`;
}

// ---------- control pieces ----------

function wiresControl(d, live) {
  return `<ol class="wires">${d.wires
    .map(
      (w, i) => `<li class="wire ${w.cut ? 'is-cut' : ''}">
        <span class="wire-no">${i + 1}</span>
        <span class="wire-line wire-${w.color}" aria-hidden="true"><span class="wire-gap"></span></span>
        <span class="wire-color">${cap(w.color)}</span>
        <button class="btn-cut" data-mod="cut" data-index="${i}" ${w.cut || !live ? 'disabled' : ''} aria-label="Cut wire ${i + 1}, ${w.color}">${w.cut ? 'Snipped' : 'Cut'}</button>
      </li>`
    )
    .join('')}</ol>`;
}

function keypadControl(d, live) {
  return `<div class="glyphpad">${d.buttons
    .map(
      (b, i) =>
        `<button class="glyph-key ${b.pressed ? 'is-on' : ''}" data-mod="press" data-index="${i}" ${b.pressed || !live ? 'disabled' : ''} aria-label="Glyph ${esc(
          b.glyph
        )}">${esc(b.glyph)}</button>`
    )
    .join('')}</div>`;
}

function dialControl(d, live) {
  const ticks = Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * 360;
    return `<span class="dial-tick${i === d.value ? ' is-on' : ''}" style="--a:${a}deg"><b>${i}</b></span>`;
  }).join('');
  return `<div class="dial">
    <div class="dial-face" style="--v:${(d.value / 16) * 360}deg">${ticks}<span class="dial-needle"></span><span class="dial-readout">${d.value}</span></div>
    <div class="dial-row">
      <button class="btn btn-hw" data-mod="turn" data-delta="-1" ${live ? '' : 'disabled'} aria-label="Turn down">−</button>
      <button class="btn btn-orange" data-mod="lock" ${live ? '' : 'disabled'}>Lock frequency</button>
      <button class="btn btn-hw" data-mod="turn" data-delta="1" ${live ? '' : 'disabled'} aria-label="Turn up">+</button>
    </div>
  </div>`;
}

function codeControl(d, live) {
  const slots = Array.from({ length: 4 }, (_, i) => `<span class="slot">${d.entered[i] ?? ''}</span>`).join('');
  const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]
    .map((n) => `<button class="key" data-mod="digit" data-digit="${n}" ${live && d.entered.length < 4 ? '' : 'disabled'}>${n}</button>`)
    .join('');
  return `<div class="codepad">
    <div class="slots" aria-label="Entered code ${d.entered.join(' ')}">${slots}</div>
    <div class="keys">${keys}</div>
    <div class="dial-row">
      <button class="btn btn-hw" data-mod="clear" ${live && d.entered.length ? '' : 'disabled'}>Clear</button>
      <button class="btn btn-orange" data-mod="send" ${live && d.entered.length === 4 ? '' : 'disabled'}>Transmit</button>
    </div>
  </div>`;
}

function switchesControl(d, live) {
  return `<div class="switches">${d.labels
    .map(
      (l, i) => `<button class="toggle ${d.on[i] ? 'is-on' : ''}" data-mod="toggle" data-index="${i}" ${live ? '' : 'disabled'} aria-pressed="${d.on[i]}" aria-label="Switch ${l}">
        <span class="toggle-track"><span class="toggle-knob"></span></span><b>${l}</b><small>${d.on[i] ? 'On' : 'Off'}</small></button>`
    )
    .join('')}</div>
    <button class="btn btn-orange btn-wide" data-mod="engage" ${live ? '' : 'disabled'}>Engage power</button>`;
}

// ---------- intel pieces ----------

function serialTag(d) {
  return `<div class="tag"><span class="tag-symbol">${esc(d.symbol)}</span><span class="tag-sub">Serial symbol</span></div>`;
}

function manual(d) {
  return `<table class="manual"><thead><tr><th>Serial</th><th>Rule</th></tr></thead><tbody>${d.rows
    .map((r) => `<tr><td class="sym">${esc(r.symbol)}</td><td>${esc(r.text)}</td></tr>`)
    .join('')}</tbody></table>`;
}

function beacon(d) {
  return `<div class="beacon"><span class="beacon-light beacon-${d.color}" aria-hidden="true"></span><span class="beacon-word">${cap(d.color)}</span></div>`;
}

function columns(d) {
  return `<div class="columns">${d.columns
    .map(
      (c) => `<div class="column"><div class="column-head beacon-bg-${c.color}">${cap(c.color)}</div><ol>${c.glyphs
        .map((g) => `<li>${esc(g)}</li>`)
        .join('')}</ol></div>`
    )
    .join('')}</div>`;
}

function signal(d) {
  return `<div class="beacon">${shapeSvg(d.shape, d.color)}<span class="beacon-word">${cap(d.color)} ${d.shape}</span></div>`;
}

function chart(d) {
  return `<table class="chart"><thead><tr><th></th>${d.shapes
    .map((s) => `<th>${shapeSvg(s, 'ink')}<span>${cap(s)}</span></th>`)
    .join('')}</tr></thead><tbody>${d.colors
    .map((c, r) => `<tr><th class="beacon-bg-${c}">${cap(c)}</th>${d.grid[r].map((n) => `<td>${n}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

function fragments(d) {
  return `<div class="chips">${d.chips
    .map((c) => `<div class="chip chip-${c.color}"><span>${c.digit}</span><small>${cap(c.color)}</small></div>`)
    .join('')}</div>`;
}

function order(d) {
  return `<ol class="order">${d.order
    .map((c, i) => `<li><span class="order-no">${ORD[i]}</span><span class="swatch chip-${c}"></span>${cap(c)}</li>`)
    .join('')}</ol>`;
}

function target(d) {
  return `<div class="tag"><span class="tag-symbol">${d.target}</span><span class="tag-sub">Load needed</span></div>`;
}

function ratings(d) {
  return `<table class="manual ratings"><thead><tr><th>Switch</th><th>Rating</th></tr></thead><tbody>${d.rows
    .map((r) => `<tr><td class="sym">${r.label}</td><td>${r.weight}</td></tr>`)
    .join('')}</tbody></table>`;
}

const RENDER = {
  wires: { control: wiresControl, intelA: serialTag, intelB: manual },
  keypad: { control: keypadControl, intelA: beacon, intelB: columns },
  dial: { control: dialControl, intelA: signal, intelB: chart },
  code: { control: codeControl, intelA: fragments, intelB: order },
  switches: { control: switchesControl, intelA: target, intelB: ratings },
};

export function renderPiece(type, key, data, live) {
  return panel(type, key, RENDER[type][key](data, live), { live });
}

export function renderClock(secondsText, strikes, maxStrikes) {
  const leds = Array.from({ length: maxStrikes }, (_, i) => `<span class="led ${i < strikes ? 'is-on' : ''}"></span>`).join('');
  return panel(
    null,
    'clock',
    `<div class="clock"><span class="clock-time" data-clock>${secondsText}</span><span class="clock-strikes">Strikes ${leds}</span></div>`
  );
}

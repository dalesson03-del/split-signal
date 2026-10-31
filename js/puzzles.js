// Split Signal puzzle generators.
// Every module is split into pieces: one CONTROL piece (the only place you can
// act) and two INTEL pieces (information the controller needs). Generators
// return { type, pieces: { control, intelA, intelB }, answer } and the engine
// keeps answers on the host only.

export const WIRE_COLORS = ['red', 'blue', 'yellow', 'white', 'black'];
const SERIAL_SYMBOLS = ['◆', '▲', '●', '✚', '■', '★'];
const GLYPHS = ['Ω', 'Ψ', '¶', '☾', 'ϟ', 'Ж', 'λ', '¿', '☉', '♁', 'Ѯ', '§', 'Ϡ', '♆'];
const BEACON_COLORS = ['amber', 'cyan', 'violet'];
const SHAPES = ['circle', 'triangle', 'square'];
const CHIP_COLORS = ['red', 'blue', 'yellow', 'green'];
const SWITCH_LABELS = ['A', 'B', 'C', 'D', 'E'];

export const MODULES = {
  wires: {
    name: 'Wire harness',
    pieces: {
      control: { name: 'Wire harness', how: 'Describe your wires, top to bottom, to whoever has the repair manual. Cut only when told.' },
      intelA: { name: 'Serial tag', how: 'Read this symbol out loud. The repair manual holder needs it.' },
      intelB: { name: 'Repair manual', how: 'Get the serial symbol, find its rule, and tell the wire holder which wire to cut.' },
    },
  },
  keypad: {
    name: 'Glyph keypad',
    pieces: {
      control: { name: 'Glyph keypad', how: 'Describe your four glyphs. Press them in the order the column holder gives you.' },
      intelA: { name: 'Status beacon', how: 'Say which color your beacon is showing. It picks the column.' },
      intelB: { name: 'Glyph columns', how: 'Use the beacon color to pick a column. The keypad glyphs are pressed top to bottom in that column’s order.' },
    },
  },
  dial: {
    name: 'Frequency dial',
    pieces: {
      control: { name: 'Frequency dial', how: 'Turn the dial to the frequency you’re given, then lock it.' },
      intelA: { name: 'Beacon signal', how: 'Describe the color and shape of the signal you’re receiving.' },
      intelB: { name: 'Frequency chart', how: 'Find the row for the signal’s color and the column for its shape. That number is the frequency.' },
    },
  },
  code: {
    name: 'Uplink code',
    pieces: {
      control: { name: 'Uplink keypad', how: 'Enter the four digits in the order you’re given, then transmit.' },
      intelA: { name: 'Code fragments', how: 'Each digit sits on a colored chip. Read them out by color.' },
      intelB: { name: 'Fragment order', how: 'This is the color order the code must be entered in.' },
    },
  },
  switches: {
    name: 'Power switches',
    pieces: {
      control: { name: 'Power switches', how: 'Flip on exactly the switches you’re told, then engage.' },
      intelA: { name: 'Target load', how: 'Read out the load the satellite needs.' },
      intelB: { name: 'Switch ratings', how: 'Each switch adds its rating. Work out which switches add up to the target load.' },
    },
  },
};

export const CLOCK_PIECE = { name: 'Mission clock', how: 'Only you can see the exact time left. Call it out so the team can pace itself.' };

export const MODULE_ORDER = ['wires', 'keypad', 'dial', 'code', 'switches'];

// ---------- helpers ----------

export function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

export function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];

// ---------- wires ----------

// Each rule: text + a solver returning the wire index, or -1 if it doesn't apply.
function wireRules(wires, rng) {
  const n = wires.length;
  const present = [...new Set(wires)];
  const absent = WIRE_COLORS.filter((c) => !present.includes(c));
  const c1 = pick(present, rng);
  const c2 = pick(present, rng);
  const k = 1 + Math.floor(rng() * n);
  const rules = [
    { text: `Cut the ${ORD[k - 1]} wire.`, solve: () => k - 1 },
    { text: `Cut the last ${c1} wire.`, solve: () => wires.lastIndexOf(c1) },
    { text: `Cut the first ${c2} wire.`, solve: () => wires.indexOf(c2) },
    { text: 'Cut the last wire.', solve: () => n - 1 },
    {
      text: `Cut the wire just below the first ${c1} wire.`,
      solve: () => {
        const i = wires.indexOf(c1);
        return i >= 0 && i < n - 1 ? i + 1 : -1;
      },
    },
  ];
  if (absent.length) {
    const ab = pick(absent, rng);
    rules.push({ text: `If there is no ${ab} wire, cut the second wire.`, solve: () => 1 });
  }
  return rules.filter((r) => r.solve() >= 0);
}

export function genWires(rng, level) {
  const n = 4 + Math.min(2, level);
  const wires = Array.from({ length: n }, () => pick(WIRE_COLORS, rng));
  const symbols = shuffle(SERIAL_SYMBOLS, rng).slice(0, 4);
  const pool = shuffle(wireRules(wires, rng), rng);
  const rows = symbols.map((symbol, i) => ({ symbol, rule: pool[i % pool.length] }));
  const chosen = pick(rows, rng);
  return {
    type: 'wires',
    answer: { index: chosen.rule.solve() },
    pieces: {
      control: { wires: wires.map((color) => ({ color, cut: false })) },
      intelA: { symbol: chosen.symbol },
      intelB: { rows: rows.map((r) => ({ symbol: r.symbol, text: r.rule.text })) },
    },
  };
}

// ---------- keypad ----------

export function genKeypad(rng) {
  const glyphs = shuffle(GLYPHS, rng);
  const columns = BEACON_COLORS.map((color, i) => ({ color, glyphs: shuffle(glyphs, rng).slice(0, 7) }));
  const target = pick(columns, rng);
  const four = shuffle(target.glyphs, rng).slice(0, 4);
  const order = target.glyphs.filter((g) => four.includes(g));
  return {
    type: 'keypad',
    answer: { order },
    pieces: {
      control: { buttons: shuffle(four, rng).map((glyph) => ({ glyph, pressed: false })) },
      intelA: { color: target.color },
      intelB: { columns },
    },
  };
}

// ---------- dial ----------

export function genDial(rng) {
  const nums = shuffle(Array.from({ length: 16 }, (_, i) => i), rng).slice(0, 9);
  const grid = BEACON_COLORS.map((_, r) => SHAPES.map((__, c) => nums[r * 3 + c]));
  const r = Math.floor(rng() * 3);
  const c = Math.floor(rng() * 3);
  let start = Math.floor(rng() * 16);
  if (start === grid[r][c]) start = (start + 7) % 16;
  return {
    type: 'dial',
    answer: { value: grid[r][c] },
    pieces: {
      control: { value: start, min: 0, max: 15 },
      intelA: { color: BEACON_COLORS[r], shape: SHAPES[c] },
      intelB: { colors: BEACON_COLORS, shapes: SHAPES, grid },
    },
  };
}

// ---------- code ----------

export function genCode(rng) {
  const digits = Array.from({ length: 4 }, () => Math.floor(rng() * 10));
  const chips = CHIP_COLORS.map((color, i) => ({ color, digit: digits[i] }));
  const order = shuffle(CHIP_COLORS, rng);
  const code = order.map((c) => chips.find((x) => x.color === c).digit);
  return {
    type: 'code',
    answer: { code },
    pieces: {
      control: { entered: [] },
      intelA: { chips: shuffle(chips, rng) },
      intelB: { order },
    },
  };
}

// ---------- switches ----------

export function genSwitches(rng) {
  const weights = shuffle([1, 2, 4, 8, 16], rng);
  let target = 0;
  while ([1, 2, 4, 8, 16].includes(target) || target === 0) target = 3 + Math.floor(rng() * 28);
  const on = SWITCH_LABELS.map((_, i) => (target & weights[i]) !== 0);
  return {
    type: 'switches',
    answer: { on },
    pieces: {
      control: { labels: SWITCH_LABELS, on: SWITCH_LABELS.map(() => false) },
      intelA: { target },
      intelB: { rows: SWITCH_LABELS.map((label, i) => ({ label, weight: weights[i] })) },
    },
  };
}

export function generateModule(type, rng, level = 0) {
  switch (type) {
    case 'wires':
      return genWires(rng, level);
    case 'keypad':
      return genKeypad(rng);
    case 'dial':
      return genDial(rng);
    case 'code':
      return genCode(rng);
    case 'switches':
      return genSwitches(rng);
    default:
      throw new Error('unknown module ' + type);
  }
}

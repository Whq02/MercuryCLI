// ============================================================================
//  corpus repo: textkit — a small ESM text-processing library
//  (node --test). wrap · normalize (decoy merge) · diffish (rename target) ·
//  patch (cross-file consumer) · mdlite · table · rules/* (typographic
//  pipeline — the wide-migration surface). Base tree is ALL-GREEN.
// ============================================================================
import type { BranchOverlay, FileMap, HelixRepoSpec } from '../contracts.js'

const PACKAGE_JSON = `{
  "name": "textkit",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test" }
}
`

// ── src/wrap.js ─────────────────────────────────────────────────────────────

const WRAP_BASE = `// Greedy word wrap at a column width; a word longer than the width stands
// alone on its own line.
export function wrap(text, width) {
  const words = text.split(/\\s+/).filter(w => w !== '')
  const lines = []
  let line = ''
  for (const word of words) {
    if (line === '') {
      line = word
    } else if (line.length + 1 + word.length <= width) {
      line = line + ' ' + word
    } else {
      lines.push(line)
      line = word
    }
  }
  if (line !== '') lines.push(line)
  return lines
}
`

/** defect: exact-width fits wrap one word early. */
const WRAP_OFF_BY_ONE = WRAP_BASE.replace(
  '    } else if (line.length + 1 + word.length <= width) {',
  '    } else if (line.length + 1 + word.length < width) {',
)

// ── src/normalize.js ────────────────────────────────────────────────────────

const NORMALIZE_BASE = `import { RULES } from './rules/index.js'

// Prose normalization: collapse INTERIOR whitespace runs (leading indentation
// is layout, not prose — it is preserved), trim trailing spaces, then run the
// typographic rules pipeline.
export function collapseSpaces(text) {
  return text.replace(/(?<=\\S)[ \\t]+/g, ' ').replace(/[ \\t]+$/gm, '')
}

// merge(a, b): merge two normalization OPTION BAGS (b wins). Unrelated to
// diff-hunk merging in diffish.js.
export function merge(a, b) {
  return { ...a, ...b }
}

export function normalizeText(text) {
  let out = collapseSpaces(text)
  for (const rule of RULES) out = rule.apply(out)
  return out
}
`

/** defect: collapseSpaces flattens leading indentation too. */
const NORMALIZE_EATS_INDENT = NORMALIZE_BASE.replace(
  "  return text.replace(/(?<=\\S)[ \\t]+/g, ' ').replace(/[ \\t]+$/gm, '')",
  "  return text.replace(/[ \\t]+/g, ' ').replace(/[ \\t]+$/gm, '')",
)

// ── src/diffish.js ──────────────────────────────────────────────────────────

const DIFFISH_BASE = `// Line-replacement hunks: { start, count, lines } replaces 'count' lines of
// the BEFORE text at line 'start' (0-based) with 'lines'.
export function compute(before, after) {
  const a = before.split('\\n')
  const b = after.split('\\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  if (start === endA && start === endB) return []
  return [{ start, count: endA - start, lines: b.slice(start, endB) }]
}

// merge(hunks): coalesce STRICTLY ADJACENT hunks (next.start lands exactly
// where the previous replacement ends in before-coordinates).
export function merge(hunks) {
  const sorted = [...hunks].sort((x, y) => x.start - y.start)
  const out = []
  for (const hunk of sorted) {
    const prev = out[out.length - 1]
    if (prev && hunk.start === prev.start + prev.count) {
      prev.count += hunk.count
      prev.lines = [...prev.lines, ...hunk.lines]
    } else {
      out.push({ start: hunk.start, count: hunk.count, lines: [...hunk.lines] })
    }
  }
  return out
}

export function apply(before, hunks) {
  const lines = before.split('\\n')
  const ordered = [...hunks].sort((x, y) => y.start - x.start)
  for (const hunk of ordered) {
    lines.splice(hunk.start, hunk.count, ...hunk.lines)
  }
  return lines.join('\\n')
}
`

/** reference: merge -> mergeHunks (the decoy normalize.merge stays). */
const DIFFISH_RENAMED = DIFFISH_BASE.replace(
  `// merge(hunks): coalesce STRICTLY ADJACENT hunks (next.start lands exactly
// where the previous replacement ends in before-coordinates).
export function merge(hunks) {`,
  `// mergeHunks(hunks): coalesce STRICTLY ADJACENT hunks (next.start lands
// exactly where the previous replacement ends in before-coordinates).
export function mergeHunks(hunks) {`,
)

// ── src/patch.js ────────────────────────────────────────────────────────────

const PATCH_BASE = `import { apply, compute, merge } from './diffish.js'
import { collapseSpaces } from './normalize.js'

export function makePatch(before, after) {
  return merge(compute(before, after))
}

export function applyPatch(before, patch) {
  return apply(before, patch)
}

// normalizedPatch: patches are computed over whitespace-normalized text so
// cosmetic runs never show up as content edits. Indentation is layout and
// MUST survive (collapseSpaces preserves it).
export function normalizedPatch(before, after) {
  const base = collapseSpaces(before)
  const target = collapseSpaces(after)
  return { base, target, patch: makePatch(base, target) }
}
`

/** reference: patch.js follows the rename. */
const PATCH_RENAMED = PATCH_BASE.replace(
  `import { apply, compute, merge } from './diffish.js'`,
  `import { apply, compute, mergeHunks } from './diffish.js'`,
).replace(
  `export function makePatch(before, after) {
  return merge(compute(before, after))
}`,
  `export function makePatch(before, after) {
  return mergeHunks(compute(before, after))
}`,
)

// ── src/mdlite.js ───────────────────────────────────────────────────────────

const MDLITE_BASE = `// Tiny inline markdown: **bold** and _italic_ only.
export function inline(text) {
  return text
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>')
    .replace(/_([^_]+)_/g, '<i>$1</i>')
}
`

/** defect: greedy bold regex swallows across pairs. */
const MDLITE_GREEDY = MDLITE_BASE.replace(
  "    .replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>')",
  "    .replace(/\\*\\*(.+)\\*\\*/g, '<b>$1</b>')",
)

// ── src/table.js ────────────────────────────────────────────────────────────

const TABLE_BASE = `// render(rows, aligns): pad cells per column ('l' left, 'r' right), join
// cells with ' | '.
export function columnWidths(rows) {
  const widths = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, String(cell).length)
    })
  }
  return widths
}

export function render(rows, aligns) {
  const widths = columnWidths(rows)
  return rows
    .map(row =>
      row
        .map((cell, i) => {
          const text = String(cell)
          return aligns[i] === 'r' ? text.padStart(widths[i]) : text.padEnd(widths[i])
        })
        .join(' | '),
    )
    .join('\\n')
}
`

/** defect: the alignment branches are swapped. */
const TABLE_SWAPPED = TABLE_BASE.replace(
  "          return aligns[i] === 'r' ? text.padStart(widths[i]) : text.padEnd(widths[i])",
  "          return aligns[i] === 'r' ? text.padEnd(widths[i]) : text.padStart(widths[i])",
)

// ── src/rules/* ─────────────────────────────────────────────────────────────

const RULE_SPACES = `// spaces: non-breaking spaces become plain spaces.
export const name = 'spaces'

export function apply(text) {
  return text.replace(/\\u00A0/g, ' ')
}
`

const RULE_QUOTES = `// quotes: curly quotes become straight quotes.
export const name = 'quotes'

export function apply(text) {
  return text.replace(/[\\u201C\\u201D]/g, '"').replace(/[\\u2018\\u2019]/g, "'")
}
`

const RULE_DASHES = `// dashes: '---' becomes an em dash, '--' an en dash (order matters).
export const name = 'dashes'

export function apply(text) {
  return text.split('---').join('\\u2014').split('--').join('\\u2013')
}
`

const RULE_ELLIPSIS = `// ellipsis: '...' becomes the one-glyph ellipsis.
export const name = 'ellipsis'

export function apply(text) {
  return text.split('...').join('\\u2026')
}
`

const RULE_ARROWS = `// arrows: ASCII arrow sequences become their unicode glyphs. ORDER MATTERS:
// longer sequences first, or '-->' would decay into '-' plus a short arrow.
export const name = 'arrows'

export const MAPPINGS = [
  ['-->', '\\u27F6'],
  ['->', '\\u2192'],
  ['<-', '\\u2190'],
  ['=>', '\\u21D2'],
]

export function apply(text) {
  let out = text
  for (const [ascii, glyph] of MAPPINGS) {
    out = out.split(ascii).join(glyph)
  }
  return out
}
`

const RULE_FRACTIONS = `// fractions: common vulgar fractions get their single glyphs.
export const name = 'fractions'

export function apply(text) {
  return text
    .replace(/\\b1\\/2\\b/g, '\\u00BD')
    .replace(/\\b1\\/4\\b/g, '\\u00BC')
    .replace(/\\b3\\/4\\b/g, '\\u00BE')
}
`

const RULES_INDEX = `import * as arrows from './arrows.js'
import * as dashes from './dashes.js'
import * as ellipsis from './ellipsis.js'
import * as fractions from './fractions.js'
import * as quotes from './quotes.js'
import * as spaces from './spaces.js'

export const RULES = [spaces, quotes, dashes, ellipsis, arrows, fractions]
`

/** reference: the full 12-entry table, longest-first. */
const RULE_ARROWS_EXTENDED = RULE_ARROWS.replace(
  `export const MAPPINGS = [
  ['-->', '\\u27F6'],
  ['->', '\\u2192'],
  ['<-', '\\u2190'],
  ['=>', '\\u21D2'],
]`,
  `export const MAPPINGS = [
  ['<=>', '\\u21D4'],
  ['<->', '\\u2194'],
  ['==>', '\\u27F9'],
  ['<==', '\\u27F8'],
  ['-->', '\\u27F6'],
  ['<--', '\\u27F5'],
  ['|->', '\\u21A6'],
  ['>->', '\\u21A3'],
  ['~>', '\\u219D'],
  ['->', '\\u2192'],
  ['<-', '\\u2190'],
  ['=>', '\\u21D2'],
]`,
)

/** falsify: right entries, wrong order (new ones appended last). */
const RULE_ARROWS_WRONG_ORDER = RULE_ARROWS.replace(
  `export const MAPPINGS = [
  ['-->', '\\u27F6'],
  ['->', '\\u2192'],
  ['<-', '\\u2190'],
  ['=>', '\\u21D2'],
]`,
  `export const MAPPINGS = [
  ['-->', '\\u27F6'],
  ['->', '\\u2192'],
  ['<-', '\\u2190'],
  ['=>', '\\u21D2'],
  ['<=>', '\\u21D4'],
  ['<->', '\\u2194'],
  ['==>', '\\u27F9'],
  ['<==', '\\u27F8'],
  ['<--', '\\u27F5'],
  ['|->', '\\u21A6'],
  ['>->', '\\u21A3'],
  ['~>', '\\u219D'],
]`,
)

const ARROWS_SPEC = `# arrows rule — the ratified 12-mapping table

Extend \`src/rules/arrows.js\` so MAPPINGS covers exactly these twelve
sequences, applied longest-first so longer arrows never decay into shorter
ones. Do not change any other file; \`tests\` are the acceptance oracle.

| ascii | glyph |
|---|---|
| \`<=>\` | U+21D4 |
| \`<->\` | U+2194 |
| \`==>\` | U+27F9 |
| \`<==\` | U+27F8 |
| \`-->\` | U+27F6 |
| \`<--\` | U+27F5 |
| \`|->\` | U+21A6 |
| \`>->\` | U+21A3 |
| \`~>\` | U+219D |
| \`->\` | U+2192 |
| \`<-\` | U+2190 |
| \`=>\` | U+21D2 |

Precedence examples that must hold: \`<=>\` is ONE glyph (never \`<\` plus
\`=>\`); \`<->\` is ONE glyph (never \`<\` plus \`->\`); \`-->\` stays the long
arrow; \`<--\` stays the long left arrow.
`

/** reference: every rule gains a typed rule object; the index orders
 *  them; normalize consumes RULE_ORDER. */
function withRuleObject(source: string): string {
  return source + `
export const rule = { name, apply }
`
}

const RULES_INDEX_TYPED = `import * as arrows from './arrows.js'
import * as dashes from './dashes.js'
import * as ellipsis from './ellipsis.js'
import * as fractions from './fractions.js'
import * as quotes from './quotes.js'
import * as spaces from './spaces.js'

export const RULES = [spaces, quotes, dashes, ellipsis, arrows, fractions]

// The typed pipeline: ordered rule OBJECTS ({ name, apply }).
export const RULE_ORDER = [
  spaces.rule,
  quotes.rule,
  dashes.rule,
  ellipsis.rule,
  arrows.rule,
  fractions.rule,
]
`

const NORMALIZE_TYPED = NORMALIZE_BASE.replace(
  `import { RULES } from './rules/index.js'`,
  `import { RULE_ORDER } from './rules/index.js'`,
).replace(
  `export function normalizeText(text) {
  let out = collapseSpaces(text)
  for (const rule of RULES) out = rule.apply(out)
  return out
}`,
  `export function normalizeText(text) {
  let out = collapseSpaces(text)
  for (const rule of RULE_ORDER) out = rule.apply(out)
  return out
}`,
)

// ── base tests ──────────────────────────────────────────────────────────────

const TEST_WRAP = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wrap } from '../src/wrap.js'

test('wraps greedily', () => {
  assert.deepEqual(wrap('one two three four', 9), ['one two', 'three', 'four'])
})

test('fills lines to exactly the width', () => {
  assert.deepEqual(wrap('aaa bb', 6), ['aaa bb'])
  assert.deepEqual(wrap('aaa bbb', 7), ['aaa bbb'])
})

test('a long word stands alone', () => {
  assert.deepEqual(wrap('aaaaaaaa bb', 4), ['aaaaaaaa', 'bb'])
})
`

const TEST_NORMALIZE = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collapseSpaces, merge, normalizeText } from '../src/normalize.js'

test('interior runs collapse, trailing spaces trim', () => {
  assert.equal(collapseSpaces('a   b\\t\\tc'), 'a b c')
  assert.equal(collapseSpaces('line   \\nnext'), 'line\\nnext')
})

test('merge combines option bags, second wins', () => {
  assert.deepEqual(merge({ a: 1, b: 1 }, { b: 2 }), { a: 1, b: 2 })
})

test('normalizeText runs the typographic pipeline', () => {
  assert.equal(normalizeText('a -> b ... done'), 'a \\u2192 b \\u2026 done')
})
`

const TEST_DIFFISH = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, compute, merge } from '../src/diffish.js'

test('compute trims the common prefix and suffix into one hunk', () => {
  const hunks = compute('a\\nb\\nc\\nd', 'a\\nX\\nY\\nd')
  assert.deepEqual(hunks, [{ start: 1, count: 2, lines: ['X', 'Y'] }])
})

test('identical texts produce no hunks', () => {
  assert.deepEqual(compute('same\\ntext', 'same\\ntext'), [])
})

test('merge coalesces strictly adjacent hunks', () => {
  const merged = merge([
    { start: 1, count: 1, lines: ['X'] },
    { start: 2, count: 1, lines: ['Y'] },
    { start: 9, count: 1, lines: ['Z'] },
  ])
  assert.deepEqual(merged, [
    { start: 1, count: 2, lines: ['X', 'Y'] },
    { start: 9, count: 1, lines: ['Z'] },
  ])
})

test('apply replays hunks over the before text', () => {
  const hunks = compute('a\\nb\\nc', 'a\\nB2\\nc')
  assert.equal(apply('a\\nb\\nc', hunks), 'a\\nB2\\nc')
})
`

/** branch: the rename spec (failing until diffish + patch move). */
const TEST_DIFFISH_RENAMED = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as diffish from '../src/diffish.js'
import { apply, compute, mergeHunks } from '../src/diffish.js'

test('the hunk coalescer is named mergeHunks now', () => {
  assert.equal(typeof mergeHunks, 'function')
  assert.ok(!('merge' in diffish), 'the old diffish.merge name must be gone')
})

test('mergeHunks coalesces strictly adjacent hunks', () => {
  const merged = mergeHunks([
    { start: 1, count: 1, lines: ['X'] },
    { start: 2, count: 1, lines: ['Y'] },
  ])
  assert.deepEqual(merged, [{ start: 1, count: 2, lines: ['X', 'Y'] }])
})

test('compute and apply are unchanged', () => {
  const hunks = compute('a\\nb\\nc', 'a\\nB2\\nc')
  assert.equal(apply('a\\nb\\nc', hunks), 'a\\nB2\\nc')
})
`

const TEST_PATCH = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPatch, makePatch, normalizedPatch } from '../src/patch.js'

test('patch round-trips an edit', () => {
  const before = 'alpha\\nbeta\\ngamma'
  const after = 'alpha\\nBETA\\ngamma'
  const patch = makePatch(before, after)
  assert.equal(applyPatch(before, patch), after)
})

test('cosmetic space runs never become content edits', () => {
  const result = normalizedPatch('keep  this   line', 'keep this line')
  assert.deepEqual(result.patch, [])
})

test('indented code lines survive normalizedPatch', () => {
  const before = 'def f():\\n    return 1'
  const after = 'def f():\\n    return 2'
  const result = normalizedPatch(before, after)
  assert.equal(result.base, before)
  assert.equal(applyPatch(result.base, result.patch), after)
})
`

const TEST_MDLITE = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inline } from '../src/mdlite.js'

test('bold pairs stay separate', () => {
  assert.equal(inline('**a** and **b**'), '<b>a</b> and <b>b</b>')
})

test('italic works alongside bold', () => {
  assert.equal(inline('**hot** _cool_'), '<b>hot</b> <i>cool</i>')
})
`

const TEST_TABLE = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render } from '../src/table.js'

test('right-aligned numbers line up on the right edge', () => {
  const out = render(
    [
      ['name', 'count'],
      ['alpha', '5'],
      ['bg', '1200'],
    ],
    ['l', 'r'],
  )
  const lines = out.split('\\n')
  assert.equal(lines[0], 'name  | count')
  assert.equal(lines[1], 'alpha |     5')
  assert.equal(lines[2], 'bg    |  1200')
})
`

const TEST_ARROWS = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/rules/arrows.js'

test('the four base arrows map', () => {
  assert.equal(apply('a -> b'), 'a \\u2192 b')
  assert.equal(apply('a <- b'), 'a \\u2190 b')
  assert.equal(apply('a => b'), 'a \\u21D2 b')
})

test('longer arrows never decay', () => {
  assert.equal(apply('a --> b'), 'a \\u27F6 b')
})
`

/** branch: the 12-mapping acceptance oracle (failing until extended). */
const TEST_ARROWS_EXTENDED = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, MAPPINGS } from '../src/rules/arrows.js'

test('the table covers exactly the twelve ratified sequences', () => {
  const ascii = MAPPINGS.map(m => m[0]).sort()
  assert.deepEqual(ascii, [
    '-->', '->', '<--', '<-', '<->', '<==', '<=>', '=>', '==>', '>->', '|->', '~>',
  ].sort())
})

test('each mapping applies', () => {
  assert.equal(apply('x <=> y'), 'x \\u21D4 y')
  assert.equal(apply('x <-> y'), 'x \\u2194 y')
  assert.equal(apply('x ==> y'), 'x \\u27F9 y')
  assert.equal(apply('x <== y'), 'x \\u27F8 y')
  assert.equal(apply('x --> y'), 'x \\u27F6 y')
  assert.equal(apply('x <-- y'), 'x \\u27F5 y')
  assert.equal(apply('x |-> y'), 'x \\u21A6 y')
  assert.equal(apply('x >-> y'), 'x \\u21A3 y')
  assert.equal(apply('x ~> y'), 'x \\u219D y')
  assert.equal(apply('x -> y'), 'x \\u2192 y')
  assert.equal(apply('x <- y'), 'x \\u2190 y')
  assert.equal(apply('x => y'), 'x \\u21D2 y')
})

test('precedence: longer sequences win', () => {
  assert.equal(apply('a <=> b'), 'a \\u21D4 b')
  assert.equal(apply('a <-> b'), 'a \\u2194 b')
  assert.equal(apply('a <-- b'), 'a \\u27F5 b')
  assert.equal(apply('a ==> b'), 'a \\u27F9 b')
})
`

/** branch: the typed-rule migration oracle (failing until migrated). */
const TEST_RULES_TYPED = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as arrows from '../src/rules/arrows.js'
import * as dashes from '../src/rules/dashes.js'
import * as ellipsis from '../src/rules/ellipsis.js'
import * as fractions from '../src/rules/fractions.js'
import * as quotes from '../src/rules/quotes.js'
import * as spaces from '../src/rules/spaces.js'
import { RULE_ORDER } from '../src/rules/index.js'
import { normalizeText } from '../src/normalize.js'

const MODULES = [spaces, quotes, dashes, ellipsis, arrows, fractions]

test('every rule module exports a typed rule object', () => {
  for (const mod of MODULES) {
    assert.equal(typeof mod.rule, 'object', mod.name + ' needs a rule object')
    assert.equal(mod.rule.name, mod.name)
    assert.equal(typeof mod.rule.apply, 'function')
  }
})

test('the index orders the typed rules', () => {
  assert.deepEqual(
    RULE_ORDER.map(r => r.name),
    ['spaces', 'quotes', 'dashes', 'ellipsis', 'arrows', 'fractions'],
  )
})

test('rule objects behave like their modules', () => {
  assert.equal(dashes.rule.apply('a---b'), 'a\\u2014b')
  assert.equal(ellipsis.rule.apply('a...'), 'a\\u2026')
  assert.equal(quotes.rule.apply('\\u201Cq\\u201D'), '"q"')
  assert.equal(spaces.rule.apply('a\\u00A0b'), 'a b')
  assert.equal(fractions.rule.apply('1/2 cup'), '\\u00BD cup')
})

test('normalizeText rides the typed pipeline', () => {
  assert.equal(normalizeText('a -> b ... done'), 'a \\u2192 b \\u2026 done')
})
`

// ── comparison-partition overlays (task/cmp-*) ────────────────────

/** defect: dash replacement order reversed — '---' decays into en+'-'. */
const RULE_DASHES_REVERSED = RULE_DASHES.replace(
  "  return text.split('---').join('\\u2014').split('--').join('\\u2013')",
  "  return text.split('--').join('\\u2013').split('---').join('\\u2014')",
)

/** branch: the dash spec (fails under the reversed order). */
const TEST_DASHES = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../src/rules/dashes.js'

test('triple dash becomes ONE em dash', () => {
  assert.equal(apply('a---b'), 'a\\u2014b')
})

test('double dash becomes an en dash', () => {
  assert.equal(apply('a--b'), 'a\\u2013b')
})

test('mixed runs keep their own glyphs', () => {
  assert.equal(apply('x --- y -- z'), 'x \\u2014 y \\u2013 z')
})
`

/** lane defect: columnWidths lets the LAST row win (no max). */
const TABLE_LAST_ROW_WINS = TABLE_BASE.replace(
  '      widths[i] = Math.max(widths[i] ?? 0, String(cell).length)',
  '      widths[i] = String(cell).length',
)

/** reference: every rule module gains an example; the index aggregates;
 *  normalize describes. */
function withExample(source: string, before: string, after: string): string {
  return source + `
export const example = { before: '` + before + `', after: '` + after + `' }
`
}

const RULE_SPACES_EXAMPLED = withExample(RULE_SPACES, 'a\\u00A0b', 'a b')
const RULE_QUOTES_EXAMPLED = withExample(RULE_QUOTES, '\\u201Cq\\u201D', '"q"')
const RULE_DASHES_EXAMPLED = withExample(RULE_DASHES, 'a---b', 'a\\u2014b')
const RULE_ELLIPSIS_EXAMPLED = withExample(RULE_ELLIPSIS, 'wait...', 'wait\\u2026')
const RULE_ARROWS_EXAMPLED = withExample(RULE_ARROWS, 'a -> b', 'a \\u2192 b')
const RULE_FRACTIONS_EXAMPLED = withExample(RULE_FRACTIONS, '1/2 cup', '\\u00BD cup')

const RULES_INDEX_EXAMPLES = RULES_INDEX + `
// The ordered example table, derived from the rule modules themselves.
export const RULE_EXAMPLES = [spaces, quotes, dashes, ellipsis, arrows, fractions].map(
  mod => ({ name: mod.name, before: mod.example.before, after: mod.example.after }),
)
`

const NORMALIZE_DESCRIBE = NORMALIZE_BASE.replace(
  `import { RULES } from './rules/index.js'`,
  `import { RULES, RULE_EXAMPLES } from './rules/index.js'`,
) + `
// describeRules: one 'name: before -> after' line per rule, pipeline order.
export function describeRules() {
  return RULE_EXAMPLES.map(e => e.name + ': ' + e.before + ' -> ' + e.after)
}
`

/** branch: the rule-docs acceptance oracle (fails until every module,
 *  the index and normalize gain their pieces). */
const TEST_RULEDOCS = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as arrows from '../src/rules/arrows.js'
import * as dashes from '../src/rules/dashes.js'
import * as ellipsis from '../src/rules/ellipsis.js'
import * as fractions from '../src/rules/fractions.js'
import * as quotes from '../src/rules/quotes.js'
import * as spaces from '../src/rules/spaces.js'
import { RULE_EXAMPLES } from '../src/rules/index.js'
import { describeRules } from '../src/normalize.js'

const MODULES = [spaces, quotes, dashes, ellipsis, arrows, fractions]

test('every rule module carries a working example', () => {
  for (const mod of MODULES) {
    assert.equal(typeof mod.example, 'object', mod.name + ' needs an example')
    assert.equal(typeof mod.example.before, 'string')
    assert.notEqual(mod.example.before, mod.example.after, mod.name + ' example must transform')
    assert.equal(mod.apply(mod.example.before), mod.example.after, mod.name + ' example must apply')
  }
})

test('the index aggregates examples in pipeline order', () => {
  assert.deepEqual(
    RULE_EXAMPLES.map(e => e.name),
    ['spaces', 'quotes', 'dashes', 'ellipsis', 'arrows', 'fractions'],
  )
  for (const row of RULE_EXAMPLES) {
    assert.equal(typeof row.before, 'string')
    assert.equal(typeof row.after, 'string')
  }
})

test('describeRules renders one line per rule', () => {
  const lines = describeRules()
  assert.equal(lines.length, 6)
  assert.ok(lines[0].startsWith('spaces: '))
  for (const line of lines) {
    assert.match(line, /^[a-z]+: .+ -> .+$/)
  }
})
`

/** falsify: rules + index done, normalize forgotten. */
const RULEDOCS_PARTIAL_FILES: FileMap = {
  'src/rules/spaces.js': RULE_SPACES_EXAMPLED,
  'src/rules/quotes.js': RULE_QUOTES_EXAMPLED,
  'src/rules/dashes.js': RULE_DASHES_EXAMPLED,
  'src/rules/ellipsis.js': RULE_ELLIPSIS_EXAMPLED,
  'src/rules/arrows.js': RULE_ARROWS_EXAMPLED,
  'src/rules/fractions.js': RULE_FRACTIONS_EXAMPLED,
  'src/rules/index.js': RULES_INDEX_EXAMPLES,
}

const BASE_FILES: FileMap = {
  'package.json': PACKAGE_JSON,
  'src/wrap.js': WRAP_BASE,
  'src/normalize.js': NORMALIZE_BASE,
  'src/diffish.js': DIFFISH_BASE,
  'src/patch.js': PATCH_BASE,
  'src/mdlite.js': MDLITE_BASE,
  'src/table.js': TABLE_BASE,
  'src/rules/index.js': RULES_INDEX,
  'src/rules/spaces.js': RULE_SPACES,
  'src/rules/quotes.js': RULE_QUOTES,
  'src/rules/dashes.js': RULE_DASHES,
  'src/rules/ellipsis.js': RULE_ELLIPSIS,
  'src/rules/arrows.js': RULE_ARROWS,
  'src/rules/fractions.js': RULE_FRACTIONS,
  'test/wrap.test.mjs': TEST_WRAP,
  'test/normalize.test.mjs': TEST_NORMALIZE,
  'test/diffish.test.mjs': TEST_DIFFISH,
  'test/patch.test.mjs': TEST_PATCH,
  'test/mdlite.test.mjs': TEST_MDLITE,
  'test/table.test.mjs': TEST_TABLE,
  'test/arrows.test.mjs': TEST_ARROWS,
}

const BRANCHES: Record<string, BranchOverlay> = {
  'task/rename-decoy': { 'test/diffish.test.mjs': TEST_DIFFISH_RENAMED },
  'task/tiny': { 'src/wrap.js': WRAP_OFF_BY_ONE },
  'task/mechanical': {
    'SPEC.md': ARROWS_SPEC,
    'test/arrows.test.mjs': TEST_ARROWS_EXTENDED,
  },
  'task/wide-normalize': { 'test/rules-typed.test.mjs': TEST_RULES_TYPED },
  'task/misleading2': { 'src/normalize.js': NORMALIZE_EATS_INDENT },
  'task/switch-a': { 'src/mdlite.js': MDLITE_GREEDY },
  'task/switch-b': { 'src/table.js': TABLE_SWAPPED },
  'task/cmp-dashes': {
    'src/rules/dashes.js': RULE_DASHES_REVERSED,
    'test/dashes.test.mjs': TEST_DASHES,
  },
  'task/cmp-lanes': {
    'src/wrap.js': WRAP_OFF_BY_ONE,
    'src/table.js': TABLE_LAST_ROW_WINS,
  },
  'task/cmp-ruledocs': { 'test/ruledocs.test.mjs': TEST_RULEDOCS },
}

export const TEXTKIT_REPO: HelixRepoSpec = {
  id: 'textkit',
  seed: 'inline',
  files: BASE_FILES,
  branches: BRANCHES,
}

export const TEXTKIT_CONTENT = {
  WRAP_BASE,
  NORMALIZE_BASE,
  MDLITE_BASE,
  TABLE_BASE,
  DIFFISH_RENAMED,
  PATCH_RENAMED,
  RULE_ARROWS_EXTENDED,
  RULE_ARROWS_WRONG_ORDER,
  RULES_INDEX_TYPED,
  NORMALIZE_TYPED,
  withRuleObject,
  RULE_ARROWS,
  RULE_SPACES,
  RULE_QUOTES,
  RULE_DASHES,
  RULE_ELLIPSIS,
  RULE_FRACTIONS,
  TEST_PATCH,
  TEST_DIFFISH,
  RULE_SPACES_EXAMPLED,
  RULE_QUOTES_EXAMPLED,
  RULE_DASHES_EXAMPLED,
  RULE_ELLIPSIS_EXAMPLED,
  RULE_ARROWS_EXAMPLED,
  RULE_FRACTIONS_EXAMPLED,
  RULES_INDEX_EXAMPLES,
  NORMALIZE_DESCRIBE,
  RULEDOCS_PARTIAL_FILES,
} as const

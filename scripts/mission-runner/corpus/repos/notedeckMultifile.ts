// ============================================================================
//  corpus — the multi-file change-set family (family 17) on
//  the notedeck repo. Every branch overlay is SELF-CONTAINED (new src/test
//  files beside the untouched all-green base), so the family needs no
//  knowledge of the base modules and can never destabilize their tasks.
//
//  Family design:
//    mf-banner    — small mechanical change across two files;
//    mf-slug      — coordinated implementation + spec update;
//    mf-views     — repeated import/API migration across four files;
//    mf-pipeline  — two distant regions of ONE file + a second file (the
//                   two-wave / stale-anchor pressure shape);
//    mf-limits    — one member already satisfied (no-change truth);
//    mf-greeting  — a single-file fix where sequential Edit stays the
//                   better choice (the overhead-honesty task).
// ============================================================================
import type { BranchOverlay } from '../contracts.js'

// ── mf-banner ───────────────────────────────────────────────────────────────

export const MF_BANNER_BASE = `export const BANNER = 'notedeck v1'

export function bannerLine() {
  return '== ' + BANNER + ' =='
}
`
export const MF_ABOUT_BASE = `export function aboutText() {
  return 'about: notedeck v1 - a tiny note store'
}
`
export const MF_BANNER_V2 = `export const BANNER = 'notedeck v2'

export function bannerLine() {
  return '== ' + BANNER + ' =='
}
`
export const MF_ABOUT_V2 = `export function aboutText() {
  return 'about: notedeck v2 - a tiny note store'
}
`
const MF_BANNER_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bannerLine } from '../src/banner.js'
import { aboutText } from '../src/about.js'

test('banner line carries v2', () => {
  assert.ok(bannerLine().includes('notedeck v2'))
})

test('about text carries v2', () => {
  assert.ok(aboutText().includes('notedeck v2'))
})
`

// ── mf-slug ─────────────────────────────────────────────────────────────────

export const MF_SLUG_BASE = `// Slugs: lowercase, every non-alphanumeric character becomes a dash.
export function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '-')
}
`
export const MF_SLUG_FIXED = `// Slugs: lowercase, every non-alphanumeric RUN collapses to one dash.
export function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}
`
export const MF_SLUG_SPEC_OLD = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from '../src/slug.js'

test('slugify lowercases', () => {
  assert.equal(slugify('Hello'), 'hello')
})

test('slugify dashes separators', () => {
  assert.equal(slugify('big  news'), 'big--news')
})
`
export const MF_SLUG_SPEC_UPDATED = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from '../src/slug.js'

test('slugify lowercases', () => {
  assert.equal(slugify('Hello'), 'hello')
})

test('slugify dashes separators', () => {
  assert.equal(slugify('big  news'), 'big-news')
})
`
const MF_SLUG_TARGET_SPEC = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from '../src/slug.js'

test('separator runs collapse to one dash', () => {
  assert.equal(slugify('big  news'), 'big-news')
})

test('punctuation runs collapse too', () => {
  assert.equal(slugify('Hello, World'), 'hello-world')
})
`

// ── mf-views ────────────────────────────────────────────────────────────────

export const MF_FORMAT_LEGACY = `export function formatNote(note) {
  return '[' + note.id + '] ' + note.title
}
`
export const MF_FORMAT2 = `// The v2 formatter: an options bag with a lane tag.
export function formatNote(note, opts) {
  const tag = opts && opts.tag ? ' #' + opts.tag : ''
  return '[' + note.id + '] ' + note.title + tag
}
`
export function mfViewLegacy(letter: string): string {
  return `import { formatNote } from './format-legacy.js'

export function view${letter.toUpperCase()}(note) {
  return '${letter.toUpperCase()}: ' + formatNote(note)
}
`
}
export function mfViewMigrated(letter: string): string {
  return `import { formatNote } from './format2.js'

export function view${letter.toUpperCase()}(note) {
  return '${letter.toUpperCase()}: ' + formatNote(note, { tag: '${letter}' })
}
`
}
const MF_VIEWS_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { viewA } from '../src/view-a.js'
import { viewB } from '../src/view-b.js'
import { viewC } from '../src/view-c.js'
import { viewD } from '../src/view-d.js'

const note = { id: 'n-1', title: 't' }

test('view A rides format2 with its lane tag', () => {
  assert.equal(viewA(note), 'A: [n-1] t #a')
})

test('view B rides format2 with its lane tag', () => {
  assert.equal(viewB(note), 'B: [n-1] t #b')
})

test('view C rides format2 with its lane tag', () => {
  assert.equal(viewC(note), 'C: [n-1] t #c')
})

test('view D rides format2 with its lane tag', () => {
  assert.equal(viewD(note), 'D: [n-1] t #d')
})
`

// ── mf-pipeline ─────────────────────────────────────────────────────────────

export const MF_PIPELINE_BASE = `import { trim } from './stages/trim.js'
import { upper } from './stages/upper.js'

// Ordered stage table - the cli --stages listing renders STAGE_NAMES, the
// runner walks STAGES. Both registries must stay in step.
export const STAGES = [
  ['trim', trim],
  ['upper', upper],
]

export function runPipeline(s) {
  let out = s
  for (const [, fn] of STAGES) out = fn(out)
  return out
}

export const STAGE_NAMES = ['trim', 'upper']
`
export const MF_PIPELINE_FIXED = `import { trim } from './stages/trim.js'
import { dedupe } from './stages/dedupe.js'
import { upper } from './stages/upper.js'

// Ordered stage table - the cli --stages listing renders STAGE_NAMES, the
// runner walks STAGES. Both registries must stay in step.
export const STAGES = [
  ['trim', trim],
  ['dedupe', dedupe],
  ['upper', upper],
]

export function runPipeline(s) {
  let out = s
  for (const [, fn] of STAGES) out = fn(out)
  return out
}

export const STAGE_NAMES = ['trim', 'dedupe', 'upper']
`
const MF_STAGE_TRIM = `export function trim(s) {
  return s.trim()
}
`
const MF_STAGE_UPPER = `export function upper(s) {
  return s.toUpperCase()
}
`
export const MF_STAGE_DEDUPE_BASE = `// Collapse repeated whitespace runs to a single space.
export function dedupe(s) {
  return s
}
`
export const MF_STAGE_DEDUPE_FIXED = `// Collapse repeated whitespace runs to a single space.
export function dedupe(s) {
  return s.replace(/\\s+/g, ' ')
}
`
const MF_PIPELINE_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STAGES, STAGE_NAMES, runPipeline } from '../src/pipeline.js'
import { dedupe } from '../src/stages/dedupe.js'

test('dedupe collapses whitespace runs', () => {
  assert.equal(dedupe('a  b'), 'a b')
})

test('the stage table registers dedupe between trim and upper', () => {
  assert.deepEqual(STAGES.map(([name]) => name), ['trim', 'dedupe', 'upper'])
})

test('the name registry stays in step with the table', () => {
  assert.deepEqual(STAGE_NAMES, ['trim', 'dedupe', 'upper'])
})

test('the pipeline runs end to end', () => {
  assert.equal(runPipeline('  a  b '), 'A B')
})
`

// ── mf-limits ───────────────────────────────────────────────────────────────

export function mfLimits(value: number): string {
  return `export const MAX_NOTES = ${value}
`
}
const MF_LIMITS_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_NOTES as A } from '../src/limits-a.js'
import { MAX_NOTES as B } from '../src/limits-b.js'
import { MAX_NOTES as C } from '../src/limits-c.js'

test('every limits module carries 250', () => {
  assert.equal(A, 250)
  assert.equal(B, 250)
  assert.equal(C, 250)
})
`

// ── mf-greeting ─────────────────────────────────────────────────────────────

export const MF_GREETING_BASE = `export function greeting(name) {
  return 'hullo, ' + name
}
`
export const MF_GREETING_FIXED = `export function greeting(name) {
  return 'hello, ' + name
}
`
const MF_GREETING_CONTEXT = `// Reference sample consumed by the docs tooling - GENERATED, do not edit.
export const SAMPLE = 'hello, sample'
`
const MF_GREETING_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { greeting } from '../src/greeting.js'

test('greeting spells hello', () => {
  assert.equal(greeting('kai'), 'hello, kai')
})
`

// ── the branch overlays ─────────────────────────────────────────────────────

export const MF_BRANCHES: Record<string, BranchOverlay> = {
  'task/mf-banner': {
    'src/banner.js': MF_BANNER_BASE,
    'src/about.js': MF_ABOUT_BASE,
    'test/mf-banner.test.mjs': MF_BANNER_TEST,
  },
  'task/mf-slug': {
    'src/slug.js': MF_SLUG_BASE,
    'test/mf-slug.test.mjs': MF_SLUG_SPEC_OLD,
    'test/mf-slug-target.test.mjs': MF_SLUG_TARGET_SPEC,
  },
  'task/mf-views': {
    'src/format-legacy.js': MF_FORMAT_LEGACY,
    'src/format2.js': MF_FORMAT2,
    'src/view-a.js': mfViewLegacy('a'),
    'src/view-b.js': mfViewLegacy('b'),
    'src/view-c.js': mfViewLegacy('c'),
    'src/view-d.js': mfViewLegacy('d'),
    'test/mf-views.test.mjs': MF_VIEWS_TEST,
  },
  'task/mf-pipeline': {
    'src/pipeline.js': MF_PIPELINE_BASE,
    'src/stages/trim.js': MF_STAGE_TRIM,
    'src/stages/upper.js': MF_STAGE_UPPER,
    'src/stages/dedupe.js': MF_STAGE_DEDUPE_BASE,
    'test/mf-pipeline.test.mjs': MF_PIPELINE_TEST,
  },
  'task/mf-limits': {
    'src/limits-a.js': mfLimits(100),
    'src/limits-b.js': mfLimits(100),
    'src/limits-c.js': mfLimits(250),
    'test/mf-limits.test.mjs': MF_LIMITS_TEST,
  },
  'task/mf-greeting': {
    'src/greeting.js': MF_GREETING_BASE,
    'src/greeting-context.js': MF_GREETING_CONTEXT,
    'test/mf-greeting.test.mjs': MF_GREETING_TEST,
  },
}

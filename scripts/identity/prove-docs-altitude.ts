#!/usr/bin/env bun
// ============================================================================
//  scripts/identity/prove-docs-altitude.ts — the doc-surface altitude ratchet.
//
//  The tracked doc surfaces (README.md, AGENTS.md, BUILD-NOTES.md, docs/**)
//  describe WHAT the product is and does, for its users. Three laws:
//   §1 authoring-process vocabulary appears nowhere in them;
//   §2 verification-internals citations (checker filenames, concrete suite
//      runner paths) appear nowhere in them — the generic
//      `scripts/<suite>/run-all.sh` placeholder passes by shape;
//   §3 docs/ pages carry no inline source-file citations. Reasoned
//      exemptions: docs/COMPATIBILITY.md (the interop audit surface — its
//      wire-owner citations are the audit trail), the one config-index
//      spelling `src/substrate/flagRegistry.ts` (allowed everywhere), and
//      docs/CAPABILITY-GRADUATION-MATRIX.md from §2 and §3 both — its
//      source-anchor and proof columns are machine-required by its own
//      completeness gate, which fails the suite when either goes missing.
//
//  Every needle is composed from parts so this file never matches itself,
//  and the scan core is self-tested on generated fixtures before it touches
//  the real tree (a checker that cannot fail is not a check). Zero hits is
//  the pin — there is no baseline and no shrink ledger.
//
//  Run:  ~/.bun/bin/bun run scripts/identity/prove-docs-altitude.ts
//        --report lists every hit without failing (for sweeps).
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const REPORT = process.argv.includes('--report')
const J = (...parts: string[]): string => parts.join('')

// ── the scanned surfaces ────────────────────────────────────────────────────
const ROOT_SURFACES = ['README.md', 'AGENTS.md', 'BUILD-NOTES.md', 'THIRD_PARTY_NOTICES.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'SECURITY.md', '.github/PULL_REQUEST_TEMPLATE.md']
function docsPages(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.md')) out.push(relative(ROOT, p))
    }
  }
  walk(join(ROOT, 'docs'))
  return out.sort()
}

// ── §1 process vocabulary (composed; chosen to never false-positive) ───
const PROCESS_TERMS: Array<[string, RegExp]> = [
  ['crew-of-authors word', new RegExp('\\b' + J('med', 'ics?') + '\\b', 'i')],
  ['work-stream agent compound', new RegExp(J('lane', '[ -]', 'agent'), 'i')],
  ['decision-record collocation', new RegExp(J('operator', '[ -]', 'rul', '(?:ing|ed)'), 'i')],
  ['decision-record collocation (lead)', new RegExp(J('lead', '[ -]', 'ruling'), 'i')],
  ['dated decision collocation', new RegExp(J('ruled', '[ -]', '20\\d\\d'), 'i')],
  ['tasking-file suffix', new RegExp(J('-', 'BRIEF', '\\.md'))],
  ['tasking-dir path', new RegExp(J('\\bbriefs', '/'))],
  ['handover-file name', new RegExp(J('HANDOFF', '\\.md'))],
  ['closeout-file suffix', new RegExp(J('-', 'RECEIPT', '\\.md'))],
  ['relay-channel path (in)', new RegExp(J('field/', 'inbox'), 'i')],
  ['relay-channel path (out)', new RegExp(J('field/', 'results'), 'i')],
  // the tree-census shapes: a work-stream named in capitals beside the
  // lane word, a decision verb dated to the day, a field-report row id,
  // and the private records directory as a path
  ['work-stream tag', new RegExp('\\b[A-Z][A-Z0-9]{2,}(?:-[A-Z0-9]+)*' + J(' lane', 's?\\b') + '|' + J('\\blane ', '[A-Z][A-Z0-9]{2,}(?:-[A-Z0-9]+)*\\b'))],
  ['dated decision verb', new RegExp('\\b(?:' + [J('ru', 'led'), J('rul', 'ing'), J('sigh', 'ted'), J('supp', 'lied'), J('lan', 'ded'), J('fol', 'ded'), J('tr', 'ued'), J('rati', 'fied'), J('adjudi', 'cated')].join('|') + ')\\b[^\\n]{0,16}\\b20\\d\\d-\\d\\d-\\d\\d\\b')],
  ['field-report row id', new RegExp('\\b(?:' + J('F', 'N') + '|' + J('F', 'C') + ')-\\d{3}\\b|\\b' + J('TAS', 'K') + '-\\d{3}\\b')],
  ['private-records directory path', new RegExp(J('clean', 'room', '/'), 'i')],
]

// ── §2 verification-internals citations ─────────────────────────────────────
const VERIFICATION_CITES: Array<[string, RegExp]> = [
  ['checker filename', new RegExp(J('prove', '-') + '[a-z0-9-]+\\.(?:ts|sh)')],
  ['concrete suite runner path', new RegExp(J('scripts/', '[a-z0-9-]+', '/run-all', '\\.sh'))],
]

// ── §3 inline source citations in docs/ ─────────────────────────────────────
const CONFIG_INDEX_SPELLING = J('src/substrate/', 'flagRegistry.ts')
const SRC_CITE = new RegExp('[(`]' + J('src', '/'))

interface Hit {
  file: string
  law: string
  label: string
  line: number
  excerpt: string
}

function scanText(file: string, text: string, law: string, needles: Array<[string, RegExp]>): Hit[] {
  const hits: Hit[] = []
  const lines = text.split('\n')
  for (const [label, re] of needles) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        hits.push({ file, law, label, line: i + 1, excerpt: lines[i]!.trim().slice(0, 120) })
      }
    }
  }
  return hits
}

function scanTree(): Hit[] {
  const hits: Hit[] = []
  const docs = docsPages()
  const MATRIX = join('docs', 'CAPABILITY-GRADUATION-MATRIX.md')
  const s1Surfaces = [...ROOT_SURFACES, ...docs]
  const s2Surfaces = [...ROOT_SURFACES.filter(f => f !== 'THIRD_PARTY_NOTICES.md'), ...docs.filter(f => f !== MATRIX)]
  const s3Surfaces = docs.filter(f => f !== join('docs', 'COMPATIBILITY.md') && f !== MATRIX)
  const read = (rel: string): string | null => {
    try {
      return readFileSync(join(ROOT, rel), 'utf8')
    } catch {
      return null
    }
  }
  for (const rel of s1Surfaces) {
    const text = read(rel)
    if (text !== null) hits.push(...scanText(rel, text, '§1', PROCESS_TERMS))
  }
  for (const rel of s2Surfaces) {
    const text = read(rel)
    if (text !== null) hits.push(...scanText(rel, text, '§2', VERIFICATION_CITES))
  }
  for (const rel of s3Surfaces) {
    const text = read(rel)
    if (text === null) continue
    const stripped = text.split(CONFIG_INDEX_SPELLING).join('')
    hits.push(...scanText(rel, stripped, '§3', [['inline source citation', SRC_CITE]]))
  }
  return hits
}

// ── self-test: the scanner must flag each class and pass clean text ─────────
function selfTest(): void {
  const redFixtures: Array<[string, string]> = [
    ['§1', J('the ', 'med', 'ic', ' wave lands')],
    ['§1', J('a ', 'lane', ' ', 'agent', ' runs it')],
    ['§1', J('operator', ' ', 'rul', 'ing', ' 2026-01-01')],
    ['§1', J('see FOO', '-', 'BRIEF', '.md')],
    ['§1', J('under ', 'briefs', '/', 'x.md')],
    ['§1', J('the ', 'FOO', 'BAR', ' lane', ' owns it')],
    ['§1', J('lane ', 'BAZ', '-QUX', ' folded it')],
    ['§1', J('rati', 'fied', ' 2026-08-28')],
    ['§1', J('see ', 'F', 'N', '-015', ' rank 8')],
    ['§1', J('under ', 'clean', 'room', '/receipts')],
    ['§2', J('pinned by ', 'prove', '-', 'something.ts')],
    ['§2', J('run ', 'scripts/', 'foo', '/run-all', '.sh')],
    ['§3', J('the owner (`', 'src', '/services/x.ts`)')],
  ]
  for (const [law, fixture] of redFixtures) {
    const needles =
      law === '§1' ? PROCESS_TERMS : law === '§2' ? VERIFICATION_CITES : ([['inline source citation', SRC_CITE]] as Array<[string, RegExp]>)
    const found = scanText('fixture.md', fixture, law, needles)
    if (found.length === 0) {
      console.error(`self-test FAILED: a ${law} fixture was not flagged: ${fixture}`)
      process.exit(1)
    }
  }
  const clean = [
    'bash scripts/<suite>/run-all.sh    # one suite; they sit side by side',
    'the in-code registry (`' + CONFIG_INDEX_SPELLING + '`; rendered on demand)',
    'launch receipts name the road; the fire lands as a receipt row',
    'a teammate handoff is honesty-gated; the medical metaphor stays outside',
    'the session dispatches on the local lane',
    'the home lane earns every ride; a GPT specialist lane stays lowercase-named',
    'released 2026-08-16 as 9.9.9 (a plain date beside no decision verb)',
    'TASK-driven text carries no row id',
  ].join('\n')
  const cleanHits = [
    ...scanText('clean.md', clean, '§1', PROCESS_TERMS),
    ...scanText('clean.md', clean, '§2', VERIFICATION_CITES),
    ...scanText('clean.md', clean.split(CONFIG_INDEX_SPELLING).join(''), '§3', [['inline source citation', SRC_CITE]]),
  ]
  if (cleanHits.length > 0) {
    console.error('self-test FAILED: clean text was flagged:')
    for (const h of cleanHits) console.error(`  ${h.law} ${h.label}: ${h.excerpt}`)
    process.exit(1)
  }
}

selfTest()
const hits = scanTree()
if (hits.length > 0) {
  const verb = REPORT ? 'hit' : 'FAIL'
  for (const h of hits) console.error(`  [${verb}] ${h.file}:${h.line} ${h.law} ${h.label} — ${h.excerpt}`)
}
console.log(`docs-altitude: ${docsPages().length + ROOT_SURFACES.length} surfaces scanned, ${hits.length} hit(s)`)
if (hits.length > 0 && !REPORT) {
  console.error('❌ docs-altitude: the doc surfaces carry vocabulary or citations that belong to the authoring side')
  process.exit(1)
}
console.log(REPORT ? 'docs-altitude: report mode (no verdict)' : '✅ docs-altitude: clean')

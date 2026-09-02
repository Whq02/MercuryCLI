#!/usr/bin/env bun
// ============================================================================
//  prove-prompt-input-symbol-lane — F2: document-symbol addressing +
//  boundary insertion, the one semantic-edit job the estate could not do
//  before (F2 lens verdict: ABSENT outside the TS select lane).
//
//    · python/go/rust symbol queries by (kind, name/glob) — method vs
//      function discrimination is CONTEXTUAL (class scope / impl scope /
//      go's method_declaration);
//    · insert-after previews carry real hunks and APPLY byte-preservingly
//      through the SAME polyglot preview/apply/digest owners;
//    · the TS select lane takes the same insert-before/insert-after
//      actions through ITS existing preview/apply owners;
//    · an unmapped engine language refuses BY NAME (never guesses).
//
//  Fixtures are hermetic temp trees; zero toolchains needed (the bundled
//  tree-sitter engine is the only parser involved).
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// F6 hygiene: pin the change-set home to a fixture dir.
process.env.MERCURY_CHANGESET_DIR = mkdtempSync(join(tmpdir(), 'kinetic-symbols-cs-'))
const root = mkdtempSync(join(tmpdir(), 'kinetic-symbols-'))
mkdirSync(join(root, 'src'), { recursive: true })
writeFileSync(join(root, 'src/app.py'), `import os

class Store:
    def load(self):
        return 1

    def process_order(self, o):
        return o

def process_order(o):
    return o

def helper():
    pass
`)
writeFileSync(join(root, 'src/main.go'), `package main

type (
\tAlpha struct{ A int }
\tBeta struct{ B int }
)

func ProcessOrder(o int) int {
\treturn o
}

func (s *Store) Save() error {
\treturn nil
}
`)
writeFileSync(join(root, 'src/nested.py'), `class Runner:
    def run(self):
        def helper():
            pass
        return helper
`)
writeFileSync(join(root, 'src/lib.rs'), `struct Store;

impl Store {
    fn save(&self) -> bool { true }
}

fn process_order(o: u32) -> u32 { o }
`)
writeFileSync(join(root, 'src/app.ts'), `export function processOrder(o: number): number {
  return o
}

export function helper(): void {}
`)

const { runPolyglotSymbolQuery } = await import('../../src/services/structure/polyglotSymbols.ts')
const { buildPolyglotPreview, applyPolyglotPreview } = await import('../../src/services/structure/polyglotTransform.ts')
const { runStructureQuery } = await import('../../src/services/structure/query.ts')
const { buildPreview, applyPreview } = await import('../../src/services/structure/transform.ts')
const { rememberQuery } = await import('../../src/services/structure/store.ts')

const owner = { kind: 'process', id: 'kinetic-symbol-prover' } as never

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// ── addressing: kinds discriminate contextually ─────────────────────────────
const q1 = await runPolyglotSymbolQuery(root, { symbol: { kind: 'function', name: 'process_order' }, lang: 'python' })
if ('state' in q1) throw new Error(q1.note)
t('py function: the top-level def only (the same-named METHOD excluded)',
  q1.matches.length === 1 && q1.matches[0]!.range.startLine === 10)
const q2 = await runPolyglotSymbolQuery(root, { symbol: { kind: 'method', name: 'process_order' }, lang: 'python' })
if ('state' in q2) throw new Error(q2.note)
t('py method: the class-scoped def only', q2.matches.length === 1 && q2.matches[0]!.range.startLine === 7)
const q3 = await runPolyglotSymbolQuery(root, { symbol: { kind: 'function', name: 'ProcessOrder' }, lang: 'go' })
if ('state' in q3) throw new Error(q3.note)
t('go function addressing', q3.matches.length === 1)
const q4 = await runPolyglotSymbolQuery(root, { symbol: { kind: 'method', name: 'Save' }, lang: 'go' })
if ('state' in q4) throw new Error(q4.note)
t('go method addressing (method_declaration)', q4.matches.length === 1)
const q5 = await runPolyglotSymbolQuery(root, { symbol: { kind: 'method', name: 'save' }, lang: 'rust' })
if ('state' in q5) throw new Error(q5.note)
t('rust method addressing (impl-scoped fn)', q5.matches.length === 1)
const q6 = await runPolyglotSymbolQuery(root, { symbol: { kind: 'class', name: 'Store' }, lang: 'rust' })
if ('state' in q6) throw new Error(q6.note)
t('rust class addressing (struct)', q6.matches.length === 1)
const q7 = await runPolyglotSymbolQuery(root, { symbol: { kind: 'function', name: 'process*' }, lang: 'python' })
if ('state' in q7) throw new Error(q7.note)
t('name globs match', q7.matches.length >= 1)
const q8 = await runPolyglotSymbolQuery(root, { symbol: { kind: 'function', name: 'x' }, lang: 'java' })
t('unmapped language refuses BY NAME', 'state' in q8 && q8.note.includes('not mapped'))

// ── closing verify-wave regression fixtures ─────────────────────────────────
// go grouped `type (…)`: each name addressable; the edit extent is the
// type_spec, never the whole group (a remove of Alpha must not touch Beta).
const g1 = await runPolyglotSymbolQuery(root, { symbol: { kind: 'class', name: 'Beta' }, lang: 'go' })
if ('state' in g1) throw new Error(g1.note)
t('go grouped types: the SECOND name is findable', g1.matches.length === 1)
const g2 = await runPolyglotSymbolQuery(root, { symbol: { kind: 'class', name: 'Alpha' }, lang: 'go' })
if ('state' in g2) throw new Error(g2.note)
t('go grouped types: the edit extent excludes the sibling',
  g2.matches.length === 1 && !g2.matches[0]!.text.includes('Beta'), g2.matches[0]?.text.slice(0, 60))
// nested def inside a METHOD BODY = a local function (nearest scope wins).
const n1 = await runPolyglotSymbolQuery(root, { symbol: { kind: 'method', name: 'helper' }, lang: 'python', files: ['src/nested.py'] })
if ('state' in n1) throw new Error(n1.note)
t('a def inside a method body is NOT a method', n1.matches.length === 0)
const n2 = await runPolyglotSymbolQuery(root, { symbol: { kind: 'function', name: 'helper' }, lang: 'python', files: ['src/nested.py'] })
if ('state' in n2) throw new Error(n2.note)
t('…it is a (local) function', n2.matches.length === 1)
// a files-glob scope of ONLY unmapped-language files refuses, never an
// honest-LOOKING empty result.
writeFileSync(join(root, 'src/x.rb'), 'def hello\nend\n')
const u1 = await runPolyglotSymbolQuery(root, { symbol: { kind: 'function', name: 'hello' }, files: ['src/x.rb'] })
t('unmapped files-glob scope refuses (never a false absence)',
  'state' in u1 && u1.note.includes('not mapped'), 'state' in u1 ? u1.note.slice(0, 80) : `ran: ${(u1 as { matches: unknown[] }).matches.length} matches`)

// symbol REPLACE with $TEXT + REMOVE also settle through the polyglot lane.
const r1 = await runPolyglotSymbolQuery(root, { symbol: { kind: 'function', name: 'helper' }, lang: 'python', files: ['src/app.py'] })
if ('state' in r1) throw new Error(r1.note)
rememberQuery(owner, r1)
const rp = await buildPolyglotPreview(owner, r1, undefined, { kind: 'replace', text: '$TEXT  # audited' })
if (rp.state === 'refused') throw new Error((rp as { reason: string }).reason)
t('symbol replace/$TEXT previews', rp.files[0]!.edits.length === 1)
t('symbol preview carries the lane stamp', rp.lane === 'polyglot')

// ── the non-TS edit journey: insert-after previews + applies ────────────────
rememberQuery(owner, q1)
const p1 = await buildPolyglotPreview(owner, q1, undefined, { kind: 'insert-after', text: '\ndef audit_order(o):\n    log(o)' })
if (p1.state === 'refused') throw new Error((p1 as { reason: string }).reason)
t('py insert-after preview carries REAL hunks (inline change view data)', (p1.files[0]!.hunks?.length ?? 0) > 0)
t('py preview names planned diagnostics', p1.diagnosticsPlanned.length === 1)
const a1 = await applyPolyglotPreview(owner, p1.id, {})
t('py insert-after APPLIES through the polyglot owners', a1.state === 'applied')
const pyAfter = readFileSync(join(root, 'src/app.py'), 'utf8')
t('py bytes: node untouched, block inserted below it',
  pyAfter.includes('def process_order(o):\n    return o\n\ndef audit_order(o):\n    log(o)\n') && pyAfter.includes('def helper'))

// ── the TS select-lane journey: insert-before through ITS owners ────────────
const tq = runStructureQuery(root, { select: 'function', name: 'helper', files: ['src/app.ts'] })
if ('state' in tq) throw new Error(tq.note)
t('ts select query finds the target', tq.matches.length === 1)
rememberQuery(owner, tq)
const p2 = buildPreview(owner, tq, undefined, { action: 'insert-before', text: '/** kinetic journey marker */' })
if (p2.state === 'refused') throw new Error((p2 as { reason: string }).reason)
t('ts insert-before preview carries hunks', (p2.files[0]!.hunks?.length ?? 0) > 0)
const a2 = await applyPreview(owner, p2.id, {})
t('ts insert-before APPLIES through the select-lane owners', a2.state === 'applied')
const tsAfter = readFileSync(join(root, 'src/app.ts'), 'utf8')
t('ts bytes: comment on its own line above the intact function',
  tsAfter.includes('/** kinetic journey marker */\nexport function helper(): void {}'))

console.log(failures === 0 ? '✅ kinetic symbol-lane law holds' : '❌ kinetic symbol-lane BROKEN')
process.exit(failures)

#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-vshot-send-hygiene.ts — the vshot send grammar's blind
// class, ratcheted to zero (the sweep; inventory rows
//  425/426, the finding on prove-split-view-look).
//
//  THE RIG FACT (scripts/ui/vshot.py): a send carrying `awaitText`/`awaitRaw`
//  is due at `atTick` (default 1) — the await only DELAYS a send that is not
//  yet due, it never gates one whose deadline passed. So a gated send with
//  neither `requireAwait` (the strict law: the gate is the only trigger) nor
//  an explicit deadline (`atTick` / `afterPrevTicks`) fires BLIND into the
//  boot at tick 1, its needle dead. Seven such sends stood in three look
//  provers; every one now says `requireAwait: true`.
//
//  THE LAW: every object literal under scripts/ that names awaitText or
//  awaitRaw also names requireAwait, atTick or afterPrevTicks. Walked by the
//  TypeScript AST (a spelling sweep would miss a multi-line literal).
//  POISON: an inline literal with a bare awaitText — the walker flags it.
//
//  Recorded, not ratcheted: a `mark` on a DATA-BEARING send snapshots the
//  frame BEFORE that send's bytes (the rig's documented "moment the send
//  becomes due") — a lawful idiom for "the frame the key acts on" and a
//  wrong one for "the frame the key produced"; the two read alike in the
//  literal, so the assertion decides. The sweep's census (108 sites) is in
// the receipt; split-view-look's four were the wrong
//  reading and now ride follow-up empty sends gated on the produced text.
// ============================================================================
import * as ts from 'typescript'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

type Hit = { file: string; line: number; text: string }
export function blindAwaitSends(src: string, file: string): Hit[] {
  const hits: Hit[] = []
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const visit = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n)) {
      const names = new Set<string>()
      let spread = false
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) names.add(p.name.getText(sf).replace(/^['"]|['"]$/g, ''))
        else if (ts.isSpreadAssignment(p)) spread = true
      }
      if ((names.has('awaitText') || names.has('awaitRaw')) && !names.has('requireAwait') && !names.has('atTick') && !names.has('afterPrevTicks') && !spread) {
        hits.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 120) })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hits
}

const files: string[] = []
const walk = (d: string): void => {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(ts|tsx)$/.test(e)) files.push(p)
  }
}
walk(join(REPO, 'scripts'))

console.log('§1 the ratchet: no blind await send under scripts/')
const hits: Hit[] = []
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  if (!/awaitText|awaitRaw/.test(src)) continue
  for (const h of blindAwaitSends(src, f)) hits.push({ ...h, file: relative(REPO, f) })
}
for (const h of hits) console.log(`    ${h.file}:${h.line} ${h.text}`)
check(`every awaitText/awaitRaw send carries requireAwait or an explicit deadline (${files.length} files walked)`, hits.length === 0, `${hits.length} blind send(s)`)

console.log('§2 the poison: a bare awaitText literal is flagged')
const poison = `const sends = [\n  { data: '\\t', awaitText: 'SESSIONS', awaitSettleTicks: 2 },\n  { data: 's', afterPrevTicks: 2, mark: 'x' },\n  { data: '', awaitText: 'FOCUSED CHAT', requireAwait: true, mark: 'y' },\n  { atTick: 40, awaitText: 'gate', data: '\\r' },\n]\n`
const flagged = blindAwaitSends(poison, 'poison.ts')
check('exactly the bare literal is flagged (requireAwait and an atTick deadline both pass)', flagged.length === 1 && flagged[0]!.line === 2, JSON.stringify(flagged))

console.log(failures === 0 ? '\nvshot send hygiene: GREEN' : `\nvshot send hygiene: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)

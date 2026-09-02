#!/usr/bin/env bun
// ============================================================================
//  scripts/render-continuity/gen-consumer-inventory.ts — the PO-01 bounded production-
//  consumer inventory for the owner seams (D1..D7).
//
//  Generated with rg over src/ + assets/splash; emits BOTH a machine receipt
//  (receipts/consumer-inventory.json) and a human summary to stdout. The
//  provers consume the same seams; a NEW consumer appearing outside
//  this inventory at prove time turns the owning prover red (the gate path
//  is the prove-* suite, not this generator).
// ============================================================================
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const RECEIPTS = join(HERE, 'receipts')

type Seam = {
  family: string
  seam: string
  pattern: string
  paths: string[]
}

const seams: Seam[] = [
  // D1 — intent/destination
  { family: 'D1', seam: 'synthetic onSubmit(text, true, true) manufacture sites', pattern: 'onSubmit\\([^)]*,\\s*true,\\s*true\\)', paths: ['src'] },
  { family: 'D1', seam: 'requestCommandDispatch producers', pattern: 'requestCommandDispatch\\(', paths: ['src'] },
  { family: 'D1', seam: 'consumeCommandDispatch consumers', pattern: 'consumeCommandDispatch\\(', paths: ['src'] },
  { family: 'D1', seam: 'onAgentSubmit routing', pattern: 'onAgentSubmit', paths: ['src'] },
  // D3 — view-target projection
  { family: 'D3', seam: 'getViewedTeammateTask consumers', pattern: 'getViewedTeammateTask', paths: ['src'] },
  { family: 'D3', seam: 'getActiveAgentForInput consumers', pattern: 'getActiveAgentForInput', paths: ['src'] },
  { family: 'D3', seam: 'viewingAgentTaskId readers', pattern: 'viewingAgentTaskId', paths: ['src'] },
  { family: 'D3/D4', seam: 'enterTeammateView / exitTeammateView callers', pattern: '(enterTeammateView|exitTeammateView)\\(', paths: ['src'] },
  // D2 — resume/lifecycle
  { family: 'D2', seam: 'registerTask / registerAsyncAgent lifecycle', pattern: '(registerTask|registerAsyncAgent)\\(', paths: ['src'] },
  { family: 'D2', seam: 'resumeAgentBackground / appendMessageToLocalAgent / queuePendingMessage', pattern: '(resumeAgentBackground|appendMessageToLocalAgent|queuePendingMessage)\\(', paths: ['src'] },
  // D4 — CREW projection
  { family: 'D4', seam: 'HelmLanesRail lane row builders', pattern: '(ipRows|laRows|partySeats|daemonCrew)', paths: ['src/components/HelmLanesRail.tsx'] },
  { family: 'D4', seam: 'MAIN_CONVERSATION_ID adopters', pattern: 'MAIN_CONVERSATION_ID|cv-main', paths: ['src'] },
  // D5 — stream presentation
  { family: 'D5', seam: 'LiveStreamingTail consumers', pattern: 'LiveStreamingTail', paths: ['src'] },
  { family: 'D5', seam: 'StreamingTailStore / streamBatcher consumers', pattern: '(streamingTailStore|StreamingTailStore|streamBatcher|StreamBatcher)', paths: ['src'] },
  // D6 — selection
  { family: 'D6', seam: 'applySelectionClipBand + clip-band walk', pattern: 'applySelectionClipBand|SelectionClipBand', paths: ['src'] },
  { family: 'D6', seam: 'selection model / overlay / extraction modules', pattern: 'selectionModel|selectionOverlay|extractSelection|copyOnSelect', paths: ['src'] },
  // D7 — splash geometry
  { family: 'D7', seam: 'splash compose/frame call sites', pattern: 'compose\\(cols|frame\\(block|holdFrame\\(', paths: ['assets/splash/mercury-splash.mjs'] },
  { family: 'D7', seam: 'splash independent out.rows/out.columns reads', pattern: 'out\\.(rows|columns)', paths: ['assets/splash/mercury-splash.mjs'] },
]

type Hit = { file: string; line: number; text: string }
const inventory: { family: string; seam: string; pattern: string; count: number; hits: Hit[] }[] = []

// Self-contained file walk (the dev shell aliases rg to the harness binary,
// so an external spawn is not hermetic here).
const SOURCE_EXT = /\.(ts|tsx|mjs|js)$/
const walk = (root: string): string[] => {
  const st = statSync(root)
  if (st.isFile()) return SOURCE_EXT.test(root) ? [root] : []
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
    const p = join(root, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else if (SOURCE_EXT.test(entry.name) && !/\.test\./.test(entry.name)) out.push(p)
  }
  return out
}

const fileCache = new Map<string, string[]>()
const linesOf = (path: string): string[] => {
  let l = fileCache.get(path)
  if (!l) {
    l = readFileSync(path, 'utf8').split('\n')
    fileCache.set(path, l)
  }
  return l
}

for (const s of seams) {
  const re = new RegExp(s.pattern)
  const hits: Hit[] = []
  for (const p of s.paths.flatMap(pp => walk(join(REPO, pp)))) {
    const rel = relative(REPO, p)
    linesOf(p).forEach((text, i) => {
      if (re.test(text)) hits.push({ file: rel, line: i + 1, text: text.trim().slice(0, 140) })
    })
  }
  inventory.push({ family: s.family, seam: s.seam, pattern: s.pattern, count: hits.length, hits })
}

mkdirSync(RECEIPTS, { recursive: true })
// The committing tree carries the SHA; the receipt stays content-only.
writeFileSync(
  join(RECEIPTS, 'consumer-inventory.json'),
  JSON.stringify({ inventory }, null, 2),
)

console.log('── PO-01 bounded consumer inventory ──')
for (const row of inventory) {
  console.log(`\n[${row.family}] ${row.seam} — ${row.count} hits`)
  const byFile = new Map<string, number>()
  for (const h of row.hits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1)
  for (const [file, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)}  ${file}`)
  }
}
console.log('\nreceipt: scripts/render-continuity/receipts/consumer-inventory.json')

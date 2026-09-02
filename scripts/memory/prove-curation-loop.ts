#!/usr/bin/env bun
// ============================================================================
//  scripts/memory/prove-curation-loop.ts
//  PROOF (lane CP-B, operator-named priority): the consolidation loop is a
//  MECHANISM — the engine itself proposes duplicate merges, decay and
//  contradiction retirements over a SEEDED scratch store, and an approved
//  apply runs through the audit spine with receipts. Driven: seeded store →
//  sweep fires → typed proposals; consented apply → audit copies + receipts;
//  nothing is ever silently destroyed.
//
//    §1 the sweep proposes all three classes, each with its reason
//    §2 safe-only apply: safe classes execute, judgment classes are REFUSED
//       loudly; receipts carry approvedBy; the index drops retired lines
//    §3 never silent destruction: every retired body is recoverable from
//       its audit copy, byte-comparable
//    §4 the consent wiring is structural: autoDream feeds the sweep into
//       the consolidation brief; the Memory Centre carries the consent row
//
//  Run:  ~/.bun/bin/bun run scripts/memory/prove-curation-loop.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const watchdog = setTimeout(() => {
  console.log('FATAL: prover watchdog (120s) — treat as failure')
  process.exit(1)
}, 120_000)
watchdog.unref?.()
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const scratch = mkdtempSync(join(tmpdir(), 'mercury-curation-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
const memoryDir = join(scratch, 'memdir')
const projectRoot = join(scratch, 'project')
mkdirSync(memoryDir, { recursive: true })
mkdirSync(projectRoot, { recursive: true })

const file = (name: string, description: string, type: string, body: string, ageDays = 0): void => {
  const path = join(memoryDir, `${name}.md`)
  writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n`)
  if (ageDays > 0) {
    const then = new Date(Date.now() - ageDays * 86_400_000)
    utimesSync(path, then, then)
  }
}

// The seeded story: an exact-duplicate pair, a near-duplicate pair, a
// recorded-supersede contradiction, an aged project fact, a broken referent.
file('dup-newer', 'the deploy runs through the runway script', 'project', 'Deploys go through runway.sh, never by hand.')
file('dup-older', 'deploy procedure notes', 'project', 'Deploys   go through runway.sh,\nnever by hand.', 3)
file('near-a', 'staging deploy freeze until the audit closes friday', 'project', 'Freeze holds until the audit signs off.')
file('near-b', 'deploy freeze on staging while the audit closes', 'project', 'Staging is frozen pending audit.', 2)
writeFileSync(
  join(memoryDir, 'newer-truth.md'),
  `---\nname: newer-truth\ndescription: the runner uses bun now\ntype: project\nmetadata:\n  freshness: fresh\n  supersedes: "old-truth.md"\n---\n\nThe runner moved to bun.\n`,
)
file('old-truth', 'the runner uses npm', 'project', 'The runner is npm-based.', 5)
file('aged-project', 'the parser rewrite lands next sprint', 'project', 'Rewrite due imminently.', 200)
file('broken-ref', 'the retry logic lives in src/net/retry.ts', 'user', 'See src/net/retry.ts for the backoff.', 30)
writeFileSync(
  join(memoryDir, 'MEMORY.md'),
  [
    '- [dup newer](dup-newer.md) — deploy runway',
    '- [dup older](dup-older.md) — deploy notes',
    '- [near a](near-a.md) — staging freeze',
    '- [near b](near-b.md) — freeze again',
    '- [newer truth](newer-truth.md) — bun runner',
    '- [old truth](old-truth.md) — npm runner',
    '- [aged](aged-project.md) — sprint fact',
    '- [broken](broken-ref.md) — retry pointer',
  ].join('\n') + '\n',
)

const { proposeCuration, writeCurationSweep, readCurationSweep, applyCurationProposals, readCurationReceipts } =
  await import('../../src/memdir/curationLoop.js')

console.log('============================================================')
console.log(' the consolidation loop is a mechanism — driven proof')
console.log('============================================================')

section('§1 the sweep proposes all three classes, reasons attached')
const sweep = await proposeCuration(memoryDir, { projectRoot })
{
  check('the store was scanned', sweep.scanned >= 8, String(sweep.scanned))
  const exact = sweep.proposals.find(p => p.kind === 'merge-duplicates' && p.safe)
  check(
    'exact duplicates → SAFE merge, newest canonical',
    exact !== undefined && exact.kind === 'merge-duplicates' && exact.canonical === 'dup-newer.md' && exact.duplicates.includes('dup-older.md'),
    JSON.stringify(exact),
  )
  const near = sweep.proposals.find(p => p.kind === 'merge-duplicates' && !p.safe)
  check(
    'near-duplicates → JUDGMENT merge with the overlap reason',
    near !== undefined && near.kind === 'merge-duplicates' && near.reason.includes('overlap'),
    JSON.stringify(near),
  )
  const contradiction = sweep.proposals.find(p => p.kind === 'contradiction')
  check(
    'a recorded supersede whose target is still live → contradiction (safe)',
    contradiction !== undefined &&
      contradiction.kind === 'contradiction' &&
      contradiction.disproven === 'old-truth.md' &&
      contradiction.disprovenBy === 'newer-truth.md' &&
      contradiction.safe,
    JSON.stringify(contradiction),
  )
  const aged = sweep.proposals.find(p => p.kind === 'decay' && p.file === 'aged-project.md')
  check('an aged project fact → decay proposal (judgment)', aged !== undefined && !aged.safe, JSON.stringify(aged))
  const broken = sweep.proposals.find(p => p.kind === 'decay' && p.file === 'broken-ref.md')
  check(
    'a broken referent → decay proposal naming the dead path',
    broken !== undefined && broken.reason.includes('src/net/retry.ts'),
    JSON.stringify(broken),
  )
  await writeCurationSweep(memoryDir, sweep)
  const readBack = readCurationSweep(memoryDir)
  check('the sweep persists and reads back', readBack !== null && readBack.proposals.length === sweep.proposals.length)
}

section('§2 safe-only apply: safe classes execute, judgment refuses loudly')
{
  const out = await applyCurationProposals(memoryDir, sweep.proposals, { approvedBy: 'prover-operator' })
  check('exactly the two safe proposals applied', out.applied.length === 2, JSON.stringify(out.applied.map(a => a.kind)))
  check(
    'every judgment proposal refused with the safe-only reason',
    out.refused.length === sweep.proposals.length - 2 && out.refused.every(r => r.reason.includes('judgment-class')),
    JSON.stringify(out.refused.map(r => r.reason)),
  )
  check('the duplicate left recall (live file gone)', !existsSync(join(memoryDir, 'dup-older.md')))
  check('the disproven fact left recall', !existsSync(join(memoryDir, 'old-truth.md')))
  check('the canonical survived', existsSync(join(memoryDir, 'dup-newer.md')))
  const index = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')
  check('the index dropped the retired lines', !index.includes('](dup-older.md)') && !index.includes('](old-truth.md)'))
  check('the index kept the survivors', index.includes('](dup-newer.md)') && index.includes('](aged-project.md)'))
  const receipts = readCurationReceipts(memoryDir)
  check(
    'receipts carry kind + files + approvedBy',
    receipts.length === 2 && receipts.every(r => r.approvedBy === 'prover-operator' && r.retired.length > 0 && r.auditCopies.length > 0),
    JSON.stringify(receipts),
  )
}

section('§3 never silent destruction: retired bodies recoverable byte-for-byte')
{
  const auditFiles = readdirSync(memoryDir).filter(n => n.includes('.superseded.'))
  check('an audit copy exists per retired file', auditFiles.length === 2, JSON.stringify(auditFiles))
  const oldTruthAudit = auditFiles.find(n => n.startsWith('old-truth.superseded.'))
  check(
    'the disproven body survives inside its audit copy',
    oldTruthAudit !== undefined && readFileSync(join(memoryDir, oldTruthAudit), 'utf8').includes('The runner is npm-based.'),
  )
}

section('§4 the consent wiring is structural')
{
  const dream = readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'autoDream', 'autoDream.ts'), 'utf8')
  check('autoDream sweeps before the fork and feeds the brief', dream.includes('proposeCuration') && dream.includes('renderProposalsForBrief'))
  const centre = readFileSync(join(import.meta.dir, '..', '..', 'src', 'components', 'memory', 'MemoryCentreView.tsx'), 'utf8')
  check('the Memory Centre carries the consent row + apply action', centre.includes("id: 'curation'") && centre.includes('applyCurationProposals'))
  const loop = readFileSync(join(import.meta.dir, '..', '..', 'src', 'memdir', 'curationLoop.ts'), 'utf8')
  const retireBody = loop.slice(loop.indexOf('async function retireToAudit'))
  check(
    'the engine never unlinks without an audit copy first (retireToAudit order)',
    retireBody.indexOf('writeSupersededCopy') > 0 && retireBody.indexOf('writeSupersededCopy') < retireBody.indexOf('unlinkSync'),
  )
}

section('§5 the agent corridor is receipted: audit-on-write through the REAL gate')
{
  // The consolidation agent's Edit/Write disposals ride the same audit
  // spine (verifier finding 4): drive the REAL canUseTool factory against
  // the config-home auto-mem store and prove snapshot + receipt + allow.
  const { getAutoMemPath } = await import('../../src/memdir/paths.js')
  const { createAutoMemCanUseTool } = await import('../../src/services/autoDream/autoMemCanUseTool.js')
  const { readCurationReceipts: readReceipts } = await import('../../src/memdir/curationLoop.js')
  const autoMem = getAutoMemPath()
  mkdirSync(autoMem, { recursive: true })
  const target = join(autoMem, 'agent-victim.md')
  writeFileSync(target, `---\nname: agent-victim\ndescription: a fact the agent will rewrite\ntype: project\n---\n\nThe original body the agent is about to destroy.\n`)
  const gate = createAutoMemCanUseTool(autoMem)
  const editTool = { name: 'Edit' } as never
  const verdict = (await gate(editTool, { file_path: target } as never, undefined as never)) as { behavior?: string }
  check('the gate still ALLOWS the in-store edit', verdict.behavior === 'allow', JSON.stringify(verdict))
  const audits = readdirSync(autoMem).filter(n => n.startsWith('agent-victim.superseded.'))
  check('the prior body was audit-copied BEFORE the edit was allowed', audits.length === 1, JSON.stringify(audits))
  check(
    'the audit copy carries the original body',
    audits[0] !== undefined && readFileSync(join(autoMem, audits[0]!), 'utf8').includes('The original body the agent is about to destroy.'),
  )
  const rows = readReceipts(autoMem).filter(r => r.kind === 'agent-edit')
  check(
    'an agent-edit receipt landed (tool named, agent named)',
    rows.length === 1 && rows[0]!.approvedBy === 'consolidation-agent' && rows[0]!.reason.includes('Edit'),
    JSON.stringify(rows),
  )
  const again = (await gate(editTool, { file_path: target } as never, undefined as never)) as { behavior?: string }
  check('an identical prior body re-snapshots idempotently (same audit file)', again.behavior === 'allow' && readdirSync(autoMem).filter(n => n.startsWith('agent-victim.superseded.')).length === 1)
  const indexPath = join(autoMem, 'MEMORY.md')
  writeFileSync(indexPath, '- [victim](agent-victim.md) — pointer\n')
  const idx = (await gate(editTool, { file_path: indexPath } as never, undefined as never)) as { behavior?: string }
  check('the INDEX stays outside the audit corridor (pointer maintenance, not content)', idx.behavior === 'allow' && readdirSync(autoMem).filter(n => n.startsWith('MEMORY.superseded.')).length === 0)
}

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL CURATION-LOOP PROOFS PASS' : `❌ ${failures} CURATION-LOOP CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
// prove-audit-chain — the TRUE prev-hash chain detects ALL FOUR tamper
// classes (the paper's per-line self-hash detects only one).
//
//   §1 clean chain verifies ok; sweep verifies the dir.
//   §2 EDITED    — a row's content is mutated under its stamp.
//   §3 BROKEN    — a middle row deleted / rows reordered.
//   §4 TRUNCATED — the tail removed while the head sidecar remembers it.
//   §5 HEAD-MISMATCH — the tail row swapped for a self-consistent forgery.
//   §6 crash-window honesty: a valid appended row the head missed is
//      'head-behind', NOT tampering. Malformed rows are named.
//   §7 OFF ⇒ byte-identical: appendAuditRow with the level off creates no
//      dir, no file (runtime probe, not grep).
//   §8 dir-vanish self-heal: the pinned chain's parent dir deleted (the
//      worktree-exit class) ⇒ the NEXT row re-boots a fresh chain at the
//      live cwd instead of dropping every row forever.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const {
  appendAuditRow,
  canonicalRowBody,
  hashRowBody,
  resetAuditChainForTests,
  themisDir,
  verifyAllChains,
  verifyAuditChainFile,
} = await import('../../src/substrate/themis/auditChain.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

type Row = {
  ts: string; seq: number; actor: string; action: string; cwd: string
  details?: string; prev: string; hash: string
}

async function freshChain(rows: number): Promise<{ dir: string; file: string; lines: Row[] }> {
  const scratch = mkdtempSync(join(tmpdir(), 'themis-chain-'))
  process.chdir(scratch)
  resetAuditChainForTests()
  process.env.MERCURY_THEMIS = 'warn'
  for (let i = 1; i <= rows; i++) {
    await appendAuditRow({ actor: 'proof', action: `act-${i}`, details: `row ${i}` })
  }
  const dir = themisDir(scratch)
  const name = (await import('node:fs/promises')).readdir(dir)
  const files = (await name).filter(n => /^audit-.*\.jsonl$/.test(n))
  const file = join(dir, files[0]!)
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Row)
  return { dir, file, lines }
}
const writeLines = (file: string, rows: Row[]): void =>
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8')

section('§1 clean chain verifies (and the dir sweep agrees)')
{
  const { dir, file, lines } = await freshChain(3)
  check('3 rows appended', lines.length === 3)
  check('seq monotonic from 1', lines.map(r => r.seq).join(',') === '1,2,3')
  const v = await verifyAuditChainFile(file)
  check('verdict ok', v.ok === true, JSON.stringify(v))
  const sweep = await verifyAllChains(dir)
  check('sweep ok over 1 chain', sweep.ok && sweep.chains.length === 1)
}

section('§2 EDITED: mutate row 2 content under its stamp')
{
  const { file, lines } = await freshChain(3)
  lines[1] = { ...lines[1]!, details: 'FORGED' }
  writeLines(file, lines)
  const v = await verifyAuditChainFile(file)
  check('detected', !v.ok && v.kind === 'edited' && v.tamperedAt === 2, JSON.stringify(v))
}

section('§3 BROKEN: deletion and reorder')
{
  const { file, lines } = await freshChain(3)
  writeLines(file, [lines[0]!, lines[2]!]) // delete row 2
  const v = await verifyAuditChainFile(file)
  check('deletion detected', !v.ok && v.kind === 'broken', JSON.stringify(v))
}
{
  const { file, lines } = await freshChain(3)
  writeLines(file, [lines[0]!, lines[2]!, lines[1]!]) // reorder tail
  const v = await verifyAuditChainFile(file)
  check('reorder detected', !v.ok && v.kind === 'broken', JSON.stringify(v))
}

section('§4 TRUNCATED: tail removed, head sidecar remembers')
{
  const { file, lines } = await freshChain(3)
  writeLines(file, lines.slice(0, 2))
  const v = await verifyAuditChainFile(file)
  check('truncation detected', !v.ok && v.kind === 'truncated', JSON.stringify(v))
}

section('§5 HEAD-MISMATCH: self-consistent forged tail at equal seq')
{
  const { file, lines } = await freshChain(3)
  const body = {
    ts: lines[2]!.ts, seq: 3, actor: 'proof', action: 'act-3', cwd: lines[2]!.cwd,
    details: 'swapped tail', prev: lines[1]!.hash,
  }
  const forged: Row = { ...body, hash: hashRowBody(canonicalRowBody(body)) }
  writeLines(file, [lines[0]!, lines[1]!, forged])
  const v = await verifyAuditChainFile(file)
  check('tail swap detected', !v.ok && v.kind === 'head-mismatch', JSON.stringify(v))
}

section('§6 honesty: head-behind is ok-with-note; malformed named')
{
  const { file, lines } = await freshChain(2)
  const body = {
    ts: new Date().toISOString(), seq: 3, actor: 'proof', action: 'act-3', cwd: lines[1]!.cwd,
    details: 'crash-window append', prev: lines[1]!.hash,
  }
  const appended: Row = { ...body, hash: hashRowBody(canonicalRowBody(body)) }
  writeLines(file, [...lines, appended]) // head sidecar still records seq 2
  const v = await verifyAuditChainFile(file)
  check('head-behind is ok', v.ok === true && v.ok && v.note === 'head-behind', JSON.stringify(v))
}
{
  const { file, lines } = await freshChain(2)
  writeLines(file, lines)
  writeFileSync(file, readFileSync(file, 'utf8') + 'not-json\n', 'utf8')
  const v = await verifyAuditChainFile(file)
  check('malformed named', !v.ok && v.kind === 'malformed', JSON.stringify(v))
}

section('§7 explicit OFF ⇒ byte-identical; unset ⇒ the default-on plane WRITES')
{
  const scratch = mkdtempSync(join(tmpdir(), 'themis-off-'))
  process.chdir(scratch)
  resetAuditChainForTests()
  process.env.MERCURY_THEMIS = 'off' // the only dormant spelling
  await appendAuditRow({ actor: 'proof', action: 'should-not-write' })
  check('no themis dir created in ANY home (explicit off)', !['.mercury', '.claude'].some(h => existsSync(join(scratch, h, 'themis'))))
  // The same append at the DEFAULT (unset) lands a row — default-on at the seam.
  delete process.env.MERCURY_THEMIS
  resetAuditChainForTests()
  await appendAuditRow({ actor: 'proof', action: 'default-on-writes' })
  check('unset (the default) DOES write the chain', existsSync(themisDir(scratch)))
}

section('§8 dir-vanish self-heal: rows persist again after the pinned dir dies')
{
  const scratchA = mkdtempSync(join(tmpdir(), 'themis-heal-a-'))
  process.chdir(scratchA)
  resetAuditChainForTests()
  process.env.MERCURY_THEMIS = 'warn'
  await appendAuditRow({ actor: 'proof', action: 'pre-heal' })
  check('pre-heal row landed in dir A', existsSync(themisDir(scratchA)))
  // The worktree-exit class: the directory the chain is pinned to vanishes
  // while the process lives on somewhere else.
  const scratchB = mkdtempSync(join(tmpdir(), 'themis-heal-b-'))
  process.chdir(scratchB)
  rmSync(scratchA, { recursive: true, force: true })
  await appendAuditRow({ actor: 'proof', action: 'lost-in-flight' }) // fails ENOENT → heals the epoch
  await appendAuditRow({ actor: 'proof', action: 'post-heal' }) // fresh chain at the live cwd
  const sweep = await verifyAllChains(themisDir(scratchB))
  check('fresh chain born at the live cwd', sweep.chains.length === 1, `chains=${sweep.chains.length}`)
  check('fresh chain verifies ok', sweep.ok, JSON.stringify(sweep.chains.map(c => c.verdict)))
  if (sweep.chains.length === 1) {
    const rows = readFileSync(sweep.chains[0]!.file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Row)
    check(
      'healed chain restarts at genesis/seq 1 with the post-heal row',
      rows.length === 1 && rows[0]!.prev === 'genesis' && rows[0]!.seq === 1 && rows[0]!.action === 'post-heal',
      JSON.stringify(rows[0]),
    )
  } else {
    check('healed chain rows inspectable', false, 'no single chain file to inspect')
  }
}

section('§9 sweep honesty: missing dir ok · UNREADABLE dir is a named problem')
{
  const scratch = mkdtempSync(join(tmpdir(), 'themis-sweep-'))
  const missing = await verifyAllChains(join(scratch, 'never-made'))
  check('missing dir ⇒ ok, zero chains', missing.ok && missing.chains.length === 0)
  // A REGULAR FILE where the dir should be (ENOTDIR — the readable stand-in
  // for the EACCES class): "zero chains, all fine" here would be the
  // silent-disable direction.
  const asFile = join(scratch, 'dir-shaped-file')
  writeFileSync(asFile, 'not a dir', 'utf8')
  const unreadable = await verifyAllChains(asFile)
  check(
    'unreadable dir ⇒ ok:false with a named malformed verdict',
    !unreadable.ok && unreadable.chains.length === 1 && unreadable.chains[0]!.verdict.ok === false,
    JSON.stringify(unreadable.chains[0]?.verdict ?? null),
  )
}

console.log('\n' + '═'.repeat(76))
if (failures) {
  console.log(`❌ ${failures} AUDIT-CHAIN PROOF FAILURE(S)`)
  process.exit(1)
}
console.log('✅ ALL AUDIT-CHAIN PROOFS PASS')

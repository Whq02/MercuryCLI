#!/usr/bin/env bun
import { mkdtempSync, readdirSync, existsSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const MW = '/private/tmp/mw'
const scratchRoot = existsSync(MW) ? MW : realpathSync(tmpdir())
const SCRATCH = mkdtempSync(join(scratchRoot, 'mom2-audit-home-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH
process.env.MERCURY_THEMIS = 'enforce'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.BROWSER = '/usr/bin/true'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
const REAL_PROJECTS = join(homedir(), '.mercury', 'projects')
const realBefore = existsSync(REAL_PROJECTS) ? readdirSync(REAL_PROJECTS).sort() : []

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

function walk(dir: string, depth = 0): string[] {
  if (!existsSync(dir) || depth > 6) return []
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, depth + 1))
    else out.push(p)
  }
  return out
}

console.log('============================================================')
console.log(' The boot audit, the admit receipts and the seen map honour the config home')
console.log('============================================================')
console.log(`scratch config home: ${SCRATCH}`)

section("§1 the THEMIS boot audit lands under the config home, never the real home")
const { appendAuditRow, resetAuditChainForTests } = await import('../../src/substrate/themis/auditChain.ts')
resetAuditChainForTests()
await appendAuditRow({ actor: 'boot', action: 'boot-env-applied', details: 'MERCURY_SAMPLES=1', cwd: process.cwd() })
const auditFiles = walk(join(SCRATCH, 'projects')).filter(p => p.includes('/themis/') && p.endsWith('.jsonl'))
check('a boot-env-applied audit row landed under the scratch config home', auditFiles.length >= 1, JSON.stringify(auditFiles))
check('the audit row carries the boot-env-applied action', auditFiles.length >= 1 && readFileSync(auditFiles[0]!, 'utf8').includes('boot-env-applied'))

section('§2 the cockpit seen map lands under the config home')
const { markSessionSeen } = await import('../../src/services/concourse/concourseSnapshot.ts')
await markSessionSeen('00000000-aaaa-bbbb-cccc-000000099999')
const draft = join(SCRATCH, 'concourse-draft.json')
check('the concourse draft (sessionSeenAt) landed under the scratch config home', existsSync(draft))
check('the seen id is recorded there', existsSync(draft) && readFileSync(draft, 'utf8').includes('00000000-aaaa-bbbb-cccc-000000099999'))

section('§3 the daemon admit receipts key the config home, never the operator home')
const kit = readFileSync(join(ROOT, 'src/daemon/sessionKit.ts'), 'utf8')
check('the re-stamp and record-less-resume receipts write under getProjectDir(rec.workspaceId)', kit.split('getProjectDir(rec.workspaceId)').length - 1 >= 2)
check('the kit writers never reach for the operator home directly', !/\bhomedir\s*\(/.test(kit) && !kit.includes("from 'node:os'") && !kit.includes('from "node:os"'))

section('§4 the real home is byte-unchanged: the proof read its folder list and wrote nothing there')
const realAfter = existsSync(REAL_PROJECTS) ? readdirSync(REAL_PROJECTS).sort() : []
const added = realAfter.filter(x => !realBefore.includes(x))
const removed = realBefore.filter(x => !realAfter.includes(x))
check('nothing was added to the real home projects folder', added.length === 0, `added ${JSON.stringify(added)}`)
check('nothing was removed from the real home projects folder', removed.length === 0, `removed ${JSON.stringify(removed)}`)

rmSync(SCRATCH, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'cwd-trust-ladder-')))
const home = join(SCRATCH, 'home')
const repo = join(SCRATCH, 'work', 'repo')
const deep = join(repo, 'packages', 'one')
const sibling = join(SCRATCH, 'work', 'other')
mkdirSync(home, { recursive: true })
mkdirSync(deep, { recursive: true })
mkdirSync(sibling, { recursive: true })

function verdictFrom(cwd: string, projects: Record<string, { hasTrustDialogAccepted?: boolean }>, latch = false): Record<string, unknown> {
  writeFileSync(join(home, '.mercury.json'), JSON.stringify({ projects }))
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    delete process.env.CI
    const g = await import(${JSON.stringify(join(SRC, 'utils/config/globalConfig.ts'))})
    const trust = await import(${JSON.stringify(join(SRC, 'utils/config/trust.ts'))})
    const state = await import(${JSON.stringify(join(SRC, 'bootstrap/state.ts'))})
    g.enableConfigs()
    if (${latch}) state.setSessionTrustAccepted(true)
    console.log(JSON.stringify({ accepted: trust.checkHasTrustDialogAccepted(), direct: trust.isPathTrusted(process.cwd()) }))
  `
  const res = spawnSync(BUN, ['-e', src], { cwd, encoding: 'utf8', timeout: 60_000 })
  if (res.status !== 0) return { childFailed: `exit ${res.status}`, stderr: (res.stderr ?? '').slice(-400) }
  const line = (res.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '{}'
  return JSON.parse(line) as Record<string, unknown>
}
const keyOf = async (dir: string): Promise<string> => {
  const pathmod = await import(join(SRC, 'utils/path.ts'))
  return pathmod.normalizePathForConfigKey(dir) as string
}

try {
  const repoKey = await keyOf(repo)
  const deepKey = await keyOf(deep)
  const siblingKey = await keyOf(sibling)
  const none = verdictFrom(deep, {})
  check('no record anywhere: the cwd is untrusted', none.accepted === false && none.direct === false, JSON.stringify(none))
  const own = verdictFrom(deep, { [deepKey]: { hasTrustDialogAccepted: true } })
  check('a record on the cwd itself trusts it', own.accepted === true && own.direct === true, JSON.stringify(own))
  const above = verdictFrom(deep, { [repoKey]: { hasTrustDialogAccepted: true } })
  check('a record on an ancestor trusts the cwd through the ladder', above.accepted === true && above.direct === true, JSON.stringify(above))
  const beside = verdictFrom(deep, { [siblingKey]: { hasTrustDialogAccepted: true } })
  check('a record on a sibling folder does not reach the cwd', beside.accepted === false && beside.direct === false, JSON.stringify(beside))
  const declined = verdictFrom(deep, { [repoKey]: { hasTrustDialogAccepted: false } })
  check('a record that says no is no grant', declined.accepted === false && declined.direct === false, JSON.stringify(declined))
  const latched = verdictFrom(deep, {}, true)
  check('the session latch alone satisfies the cwd verdict and never the direct path check', latched.accepted === true && latched.direct === false, JSON.stringify(latched))
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}
console.log(failures ? `FAIL cwd trust ladder: ${failures} failures` : 'PASS cwd trust ladder')
process.exit(failures ? 1 : 0)

#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')

const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-tips-proof-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { getRelevantTips } = await import('../../src/services/tips/tipRegistry.ts')
const { stringWidth } = await import('../../src/ink/stringWidth.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const BUDGET = 94

const tips = await getRelevantTips()
check('fresh-config read yields the catalogue (≥ 20 tips)', tips.length >= 20, String(tips.length))

const rosterText: string[] = []
const { readdirSync, statSync } = await import('node:fs')
const cmdRoot = join(ROOT, 'src/commands')
for (const entry of readdirSync(cmdRoot)) {
  const p = join(cmdRoot, entry)
  if (statSync(p).isDirectory()) {
    try {
      rosterText.push(readFileSync(join(p, 'index.ts'), 'utf8'))
    } catch {
    }
  } else if (entry.endsWith('.ts')) {
    rosterText.push(readFileSync(p, 'utf8'))
  }
}
const roster = new Set<string>()
for (const text of rosterText) {
  for (const m of text.matchAll(/name:\s*'([a-z0-9-]+)'/g)) roster.add(m[1]!)
  for (const m of text.matchAll(/aliases:\s*\[([^\]]*)\]/g)) {
    for (const a of m[1]!.matchAll(/'([a-z0-9-]+)'/g)) roster.add(a[1]!)
  }
}
check('roster read is real (≥ 40 commands)', roster.size >= 40, String(roster.size))

const ids = new Set<string>()
const seenCommands = new Set<string>()
for (const tip of tips) {
  check(`id unique: ${tip.id}`, !ids.has(tip.id))
  ids.add(tip.id)
  check(`cooldown ≥ 5: ${tip.id}`, tip.cooldownSessions >= 5, String(tip.cooldownSessions))

  for (const term of ['Apple_Terminal', 'xterm-program']) {
    const prev = process.env.TERM_PROGRAM
    process.env.TERM_PROGRAM = term
    let rendered = ''
    try {
      for (const theme of ['dark', 'true-black']) {
        rendered = await tip.content({ theme })
        const width = stringWidth(rendered)
        check(
          `width ≤ ${BUDGET} [${tip.id} · ${term === 'Apple_Terminal' ? 'apple' : 'rest'} · ${theme}]`,
          width <= BUDGET,
          `${width}: ${rendered}`,
        )
      }
    } finally {
      if (prev === undefined) delete process.env.TERM_PROGRAM
      else process.env.TERM_PROGRAM = prev
    }
    for (const m of rendered.matchAll(/(?:^|\s)\/([a-z][a-z0-9-]*)/g)) seenCommands.add(m[1]!)
  }
}
for (const cmd of seenCommands) {
  check(`advertised command exists: /${cmd}`, roster.has(cmd))
}
check('the loyalty-pinned appearance tip id is present', ids.has('appearance-command'))
check(
  'the catalogue advertises the load-bearing surfaces (spot pins)',
  ['logins', 'concourse', 'themis', 'caching', 'rewind', 'remember'].every(c => seenCommands.has(c)),
)

const registrySource = readFileSync(join(ROOT, 'src/services/tips/tipRegistry.ts'), 'utf8')
check(
  'the powershell tip advertises the product-native spelling',
  registrySource.includes('MERCURY_USE_POWERSHELL_TOOL=1'),
)

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ SPINNER TIPS: every law holds' : `\n❌ ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

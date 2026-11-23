#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  COMMAND_DOMAINS,
  FALLBACK_DOMAIN_LABEL,
  groupCommandsByDomain,
} from '../../src/screen/help/commandDomains.js'

let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}${ok ? '' : ` | fix: ${domainHint(name)}`}`)
  if (!ok) fail = 1
}
function domainHint(name: string): string {
  if (/ship in dist/.test(name)) return 'run bun run build.ts so dist/mercury.mjs carries the labels from src/screen/help/commandDomains.ts'
  if (/catalogue|memory|curated|flagship/.test(name)) return 'edit the names lists in COMMAND_DOMAINS in src/screen/help/commandDomains.ts so each name is a command or bundled skill the catalogue still has (dead names listed above)'
  return 'fix COMMAND_DOMAINS or groupCommandsByDomain in src/screen/help/commandDomains.ts'
}

{
  const seen = new Map<string, string>()
  const dups: string[] = []
  for (const d of COMMAND_DOMAINS) {
    for (const n of d.names) {
      const prev = seen.get(n)
      if (prev) dups.push(`${n} (${prev} + ${d.key})`)
      else seen.set(n, d.key)
    }
  }
  check('no name claimed by two domains', dups.length === 0, dups.join(', '))
}

{
  const mapped = COMMAND_DOMAINS.flatMap(d => d.names.map(n => ({ name: n })))
  const strangers = [{ name: 'zz-unmapped-command' }, { name: 'aa-unmapped-command' }]
  const input = [...strangers, ...mapped].reverse()
  const groups = groupCommandsByDomain(input)
  const total = groups.reduce((n, g) => n + g.commands.length, 0)
  check('nothing dropped', total === input.length, `${total}/${input.length}`)
  const last = groups[groups.length - 1]
  check(
    'unmapped land in the trailing fallback bucket',
    last !== undefined &&
      last.label === FALLBACK_DOMAIN_LABEL &&
      last.commands.map(c => c.name).join(',') === 'aa-unmapped-command,zz-unmapped-command',
  )
  const domainOrder = COMMAND_DOMAINS.map(d => d.key)
  const gotOrder = groups.slice(0, -1).map(g => g.key)
  check(
    'group order follows COMMAND_DOMAINS',
    gotOrder.every((k, i) => domainOrder.indexOf(k) < (i + 1 < gotOrder.length ? domainOrder.indexOf(gotOrder[i + 1]!) : Infinity)),
    gotOrder.join('>'),
  )
  const unsorted = groups.filter(
    g => g.commands.map(c => c.name).join(',') !== [...g.commands].map(c => c.name).sort((a, b) => a.localeCompare(b)).join(','),
  )
  check('alphabetical inside every group', unsorted.length === 0, unsorted.map(g => g.key).join(','))
  const empty = groups.filter(g => g.commands.length === 0)
  check('no empty groups', empty.length === 0)
}

{
  const domainOf = (n: string) => COMMAND_DOMAINS.find(d => d.names.includes(n))?.key
  for (const flagship of ['health']) {
    check(`flagship /${flagship} is curated`, domainOf(flagship) !== undefined, domainOf(flagship) ?? 'UNMAPPED')
  }
}

{
  ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }
  const { effectiveCatalogue } = await import('../../src/commands/catalogue/effectiveCatalogue.js')
  const { initBundledSkills } = await import('../../src/integrations/skills/bundled/index.ts')
  const { getBundledSkills } = await import('../../src/integrations/skills/bundledSkills.ts')
  initBundledSkills()
  const known = new Set([...effectiveCatalogue().flatMap(surface => [surface.name, ...((surface as { aliases?: string[] }).aliases ?? [])]), ...getBundledSkills().map(s => s.name)])
  const memory = COMMAND_DOMAINS.find(d => d.key === 'memory')
  const dead = (memory?.names ?? []).filter(n => !known.has(n))
  check('the memory domain names only commands the catalogue has', memory !== undefined && dead.length === 0, dead.join(', '))
  check('the memory domain still curates /memory', memory?.names.includes('memory') === true)
  const ghosts = COMMAND_DOMAINS.flatMap(d => d.names.filter(n => !known.has(n)).map(n => `${d.key}:${n}`))
  check('every curated name exists in the catalogue or the bundled skills', ghosts.length === 0, ghosts.join(', '))
}

{
  const dist = readFileSync(join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs'), 'utf8')
  check('domain labels ship in dist', dist.includes('crew & delegation') && dist.includes(FALLBACK_DOMAIN_LABEL))
}

console.log(fail === 0 ? '✅ prove-command-domains GREEN' : '❌ prove-command-domains RED')
process.exitCode = fail

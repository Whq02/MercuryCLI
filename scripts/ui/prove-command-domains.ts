#!/usr/bin/env bun
// prove-command-domains.ts — pure-logic proof for the /help commands-tab domain
// grouping.
//
// Locks the invariants the renderer relies on:
//   1. No command name is claimed by two domains (first-match-wins would silently
//      shadow the second claim — a curation bug).
//   2. groupCommandsByDomain never DROPS a command: mapped names land in their
//      domain, unmapped names land in the trailing "everything else" bucket.
//   3. Group order follows COMMAND_DOMAINS order; commands sort alphabetically
//      inside each group; empty groups are dropped.
//   4. The flagship surfaces the nav audit flagged (workflows/health) are
//      curated into a NON-fallback domain — the whole point of the change.
//      (/party is a retired door — commands/retired.ts — and no domain
//      curates a retired name.)
//   5. Ships in dist: the group-header literal survives bundling.
//
//  Run:  ~/.bun/bin/bun run scripts/ui/prove-command-domains.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  COMMAND_DOMAINS,
  FALLBACK_DOMAIN_LABEL,
  groupCommandsByDomain,
} from '../../src/components/HelpV2/commandDomains.js'

let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

// 1. No duplicate names across domains.
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

// 2+3. Grouping drops nothing, orders correctly, sorts internally.
{
  const mapped = COMMAND_DOMAINS.flatMap(d => d.names.map(n => ({ name: n })))
  const strangers = [{ name: 'zz-unmapped-command' }, { name: 'aa-unmapped-command' }]
  const input = [...strangers, ...mapped].reverse() // scrambled input order
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

// 4. Flagships are curated (non-fallback).
{
  const domainOf = (n: string) => COMMAND_DOMAINS.find(d => d.names.includes(n))?.key
  for (const flagship of ['workflows', 'health']) {
    check(`flagship /${flagship} is curated`, domainOf(flagship) !== undefined, domainOf(flagship) ?? 'UNMAPPED')
  }
}

// 5. Ships in dist (grep the STRING literal — identifiers minify).
{
  const dist = readFileSync(join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs'), 'utf8')
  check('domain labels ship in dist', dist.includes('crew & delegation') && dist.includes(FALLBACK_DOMAIN_LABEL))
}

console.log(fail === 0 ? '✅ prove-command-domains GREEN' : '❌ prove-command-domains RED')
// The verdict is the exit code: set it and let the process drain, so the
// summary line above always lands and a RED run can never leave as 0.
process.exitCode = fail

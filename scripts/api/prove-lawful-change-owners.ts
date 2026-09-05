#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const ROOT = resolve(import.meta.dir, '..', '..')
const law = await import('../../src/services/providers/lawfulPrefixChange.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

law.resetLawfulPrefixChanges()
law.declareLawfulPrefixChange('main', 'the operator changed a setting')
check("an owner's own declaration is consumed once by that owner", law.consumeLawfulPrefixChange('main') === 'the operator changed a setting' && law.consumeLawfulPrefixChange('main') === null)
check("…and never by another owner", (law.declareLawfulPrefixChange('main', 'again'), law.consumeLawfulPrefixChange('agent-1') === null))
law.resetLawfulPrefixChanges()
law.declareLawfulPrefixChangeForEveryOwner('the operator toggled sub-agents on')
check('a process-wide declaration reaches the main thread', law.consumeLawfulPrefixChange('main') === 'the operator toggled sub-agents on')
check('…and every sub-agent, each once', law.consumeLawfulPrefixChange('agent-1') === 'the operator toggled sub-agents on' && law.consumeLawfulPrefixChange('agent-2') === 'the operator toggled sub-agents on' && law.consumeLawfulPrefixChange('agent-1') === null)
check('a peek reads the shared clause for an owner that has not consumed it, and nothing for one that has', law.pendingLawfulPrefixChange('agent-3') === 'the operator toggled sub-agents on' && law.pendingLawfulPrefixChange('agent-1') === null)
law.declareLawfulPrefixChange('agent-3', 'its own tool set changed')
check("an owner's own clause outranks the shared one", law.consumeLawfulPrefixChange('agent-3') === 'its own tool set changed' && law.consumeLawfulPrefixChange('agent-3') === 'the operator toggled sub-agents on')
law.resetLawfulPrefixChanges()
check('a reset forgets the shared clause too', law.consumeLawfulPrefixChange('main') === null)
const print = readFileSync(join(ROOT, 'src/cli/print.ts'), 'utf8')
check('the spawn-switch toggle declares for every owner', print.includes('declareLawfulPrefixChangeForEveryOwner(`the operator toggled ${SPAWN_SWITCH_LABEL[kind]}'))

console.log(failures === 0 ? '\nprove-lawful-change-owners: all green' : `\nprove-lawful-change-owners: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

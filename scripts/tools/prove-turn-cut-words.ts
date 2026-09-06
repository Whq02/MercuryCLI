#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const ROOT = resolve(import.meta.dir, '..', '..')
const cut = await import('../../src/utils/messages/turnCut.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const WORDED = ['throttled', 'terminal-400', 'workflow-permission-timeout'] as const
for (const reason of WORDED) {
  const c = cut.turnCutOf(reason)
  check(`'${reason}' paints its words, never the id`, c.kind === 'cut' && c.detail === cut.TURN_CUT_WORDS[reason] && !cut.turnCutLine(c, false).includes(reason), JSON.stringify(c))
}
check("the operator's doors stay the operator's", ['interrupt', 'crew-stop', 'user-skip', 'user-retry'].every(r => cut.turnCutOf(r).kind === 'operator'))
check("'stalled' is the timeout, 'workflow-abort' the parent's stop", cut.turnCutOf('stalled').kind === 'idle-timeout' && cut.turnCutOf('workflow-abort').kind === 'parent-stop')
check('an unknown string still names itself (a foreign abort reason is not silenced)', cut.turnCutOf('something-else').detail === 'something-else')
const stub = { abort: (reason?: unknown): void => { (stub as { last?: unknown }).last = reason } } as { abort: (reason?: unknown) => void; last?: unknown }
cut.abortWithCut(stub, 'throttled')
check('abortWithCut hands the controller the member itself', stub.last === 'throttled')
for (const file of ['src/tools/WorkflowTool/agentHooks.ts', 'src/tools/WorkflowTool/workflowPermissionChannel.ts']) {
  const src = readFileSync(join(ROOT, file), 'utf8')
  const raw = src.match(/\.abort\('[a-z0-9-]+'\)/g) ?? []
  check(`${file}: no abort site hands a bare literal (every cut goes through abortWithCut)`, raw.length === 0, raw.join(' '))
}


{
  const stopHooks = readFileSync(join(ROOT, 'src/query/stopHooks.ts'), 'utf8')
  check(
    "the Stop-hook interruption row carries the abort signal's own reason",
    /createUserInterruptionMessage\(\{\s*toolUse: false,\s*reason: options\.signal\?\.reason,?\s*\}\)/.test(stopHooks),
  )
  const hooks = readFileSync(join(ROOT, 'src/tools/WorkflowTool/agentHooks.ts'), 'utf8')
  check(
    "the workflow child's generic catch reads a typed reason's words from the one table",
    /turnCutWhy\(turnCutOf\(cutReason\)\)/.test(hooks) && /import \{[^}]*\bturnCutWhy\b[^}]*\} from '\.\.\/\.\.\/utils\/messages\/turnCut\.js'/.test(hooks),
  )
  const timedOut = cut.turnCutWhy(cut.turnCutOf('workflow-permission-timeout'))
  check("…and the permission ask's timeout has words there", timedOut === 'the permission ask timed out', String(timedOut))
  check("…while the operator's own stop keeps the runtime's message (no words to paint)", cut.turnCutWhy(cut.turnCutOf('interrupt')) === null)
}

console.log(failures === 0 ? '\nprove-turn-cut-words: all green' : `\nprove-turn-cut-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

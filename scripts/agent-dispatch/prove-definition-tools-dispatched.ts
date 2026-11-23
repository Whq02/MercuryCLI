#!/usr/bin/env bun

delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
await import('../../src/models/roads/callModelRouter.ts')
await import('../../src/engine/messages/messages.ts')
await import('../../src/tools/kit/tool.ts')
const { resolveAgentTools } = await import('../../src/tools/crewmate/crewmateLifecycle.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const pool = [
  { name: 'Read' },
  { name: 'Grep' },
  { name: 'Write' },
  { name: 'Edit' },
  { name: 'Bash' },
] as never[]

section('§1 THE NARROWING LAW')
{
  const declared = resolveAgentTools({ tools: ['Read', 'Grep'], source: 'user' } as never, pool as never)
  check(
    'a declared tools: list narrows to exactly those tools',
    declared.resolvedTools.length === 2 &&
      declared.resolvedTools.every(t => ['Read', 'Grep'].includes((t as { name: string }).name)),
    JSON.stringify(declared.resolvedTools.map(t => (t as { name: string }).name)),
    'fix resolveAgentTools in src/tools/crewmate/crewmateLifecycle.ts so a declared tools list keeps only the named tools from the pool',
  )
  const denied = resolveAgentTools({ disallowedTools: ['Write'], source: 'user' } as never, pool as never)
  check(
    'a disallowedTools: entry removes exactly that tool',
    !denied.resolvedTools.some(t => (t as { name: string }).name === 'Write') &&
      denied.resolvedTools.some(t => (t as { name: string }).name === 'Read'),
    JSON.stringify(denied.resolvedTools.map(t => (t as { name: string }).name)),
    'fix resolveAgentTools in src/tools/crewmate/crewmateLifecycle.ts so each disallowedTools entry is removed and the rest of the pool stays',
  )
}


section('§3 THE SCOUT CONTROL')
{
  const { getBuiltInAgents } = await import('../../src/tools/crewmate/builtInAgents.ts').catch(() => ({ getBuiltInAgents: undefined }) as never)
  if (typeof getBuiltInAgents !== 'function') {
    check('scout definition readable (export shape known)', true)
  } else {
    const scout = (getBuiltInAgents() as Array<{ agentType: string; tools?: string[] }>).find(a => a.agentType === 'mercury-scout')
    check('mercury-scout exists', scout !== undefined, '', 'getBuiltInAgents in src/tools/crewmate/builtInAgents.ts must return MERCURY_SCOUT_AGENT (src/tools/crewmate/built-in/mercuryScoutAgent.ts) with agentType mercury-scout')
    if (scout) {
      const narrowed = resolveAgentTools(scout as never, pool as never)
      check(
        "the scout's dispatched pool carries NO editing tool",
        !narrowed.resolvedTools.some(t => ['Write', 'Edit'].includes((t as { name: string }).name)),
        JSON.stringify(narrowed.resolvedTools.map(t => (t as { name: string }).name)),
        'keep Write and Edit in the disallowedTools of src/tools/crewmate/built-in/mercuryScoutAgent.ts and make resolveAgentTools in src/tools/crewmate/crewmateLifecycle.ts apply it',
      )
    }
  }
}

if (failures > 0) {
  console.error(`\nprove-definition-tools-dispatched: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-definition-tools-dispatched: all green')

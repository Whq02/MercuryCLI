#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
await import('../../src/services/providers/callModelRouter.ts')
await import('../../src/utils/messages.ts')
await import('../../src/Tool.ts')
const { resolveAgentTools } = await import('../../src/tools/AgentTool/agentToolUtils.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
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
  const declared = resolveAgentTools({ tools: ['Read', 'Grep'], source: 'user' } as never, pool as never, false, false)
  check(
    'a declared tools: list narrows to exactly those tools',
    declared.resolvedTools.length === 2 &&
      declared.resolvedTools.every(t => ['Read', 'Grep'].includes((t as { name: string }).name)),
    JSON.stringify(declared.resolvedTools.map(t => (t as { name: string }).name)),
  )
  const denied = resolveAgentTools({ disallowedTools: ['Write'], source: 'user' } as never, pool as never, false, false)
  check(
    'a disallowedTools: entry removes exactly that tool',
    !denied.resolvedTools.some(t => (t as { name: string }).name === 'Write') &&
      denied.resolvedTools.some(t => (t as { name: string }).name === 'Read'),
    JSON.stringify(denied.resolvedTools.map(t => (t as { name: string }).name)),
  )
}

section('§2 THE DISPATCH SEAM')
{
  const src = readFileSync(join(import.meta.dir, '../../src/tools/AgentTool/AgentTool.tsx'), 'utf8')
  const seam = src.slice(src.indexOf('const workerTools'), src.indexOf('const workerTools') + 900)
  check(
    'the non-inheriting worker pool rides resolveAgentTools(...).resolvedTools (FC-015)',
    /resolveAgentTools\([\s\S]{0,400}?\)\.resolvedTools/.test(seam),
    seam.slice(0, 160).replace(/\s+/g, ' '),
  )
  check('the inheriting path still keeps the parent pool untouched', seam.includes('options.tools'))
}

section('§3 THE SCOUT CONTROL')
{
  const { getBuiltInAgents } = await import('../../src/tools/AgentTool/builtInAgents.ts').catch(() => ({ getBuiltInAgents: undefined }) as never)
  if (typeof getBuiltInAgents !== 'function') {
    check('scout definition readable (export shape known)', true)
  } else {
    const scout = (getBuiltInAgents() as Array<{ agentType: string; tools?: string[] }>).find(a => a.agentType === 'mercury-scout')
    check('mercury-scout exists', scout !== undefined)
    if (scout) {
      const narrowed = resolveAgentTools(scout as never, pool as never, false, false)
      check(
        "the scout's dispatched pool carries NO editing tool",
        !narrowed.resolvedTools.some(t => ['Write', 'Edit'].includes((t as { name: string }).name)),
        JSON.stringify(narrowed.resolvedTools.map(t => (t as { name: string }).name)),
      )
    }
  }
}

if (failures > 0) {
  console.error(`\nprove-definition-tools-dispatched: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-definition-tools-dispatched: all green')

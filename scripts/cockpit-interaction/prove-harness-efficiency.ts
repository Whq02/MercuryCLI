#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { z } from 'zod/v4'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getAllBaseTools, getTools } = await import('../../src/tools.ts')
const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')

t.section('row 2 — the request pool is measured, and dead bytes are gone')
{
  const serialized = zodToJsonSchema(z.object({ a: z.string() }))
  t.check('the serializer strips the $schema dialect URI', !('$schema' in serialized))
  t.check('the structure survives intact', JSON.stringify(serialized).includes('"a"'))

  const DEFAULT_CTX = {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
  } as never
  const catalog = getAllBaseTools()
  const live = getTools(DEFAULT_CTX)
  t.check(
    'the request pool is the isEnabled()-filtered subset (disabled tools ship nothing)',
    live.length < catalog.length &&
      live.every(tool => tool.isEnabled()),
    `${live.length} of ${catalog.length}`,
  )
  const disabledInCatalog = catalog.filter(tool => !tool.isEnabled()).map(tool => tool.name)
  const liveNames = new Set(live.map(tool => tool.name))
  t.check(
    'every disabled catalog tool is OUT of the request pool',
    disabledInCatalog.length > 0 && disabledInCatalog.every(n => !liveNames.has(n)),
    disabledInCatalog.join(', ') || 'none disabled here',
  )
  const bench = readFileSync('scripts/engine-durability/bench-prompt-attribution.ts', 'utf8')
  t.check(
    'the bench measures the REQUEST pool and names the catalog beside it',
    bench.includes('getTools(DEFAULT_CTX)') && bench.includes('pool: REQUEST'),
  )
  const toolSearch = readFileSync('src/utils/toolSearch.ts', 'utf8')
  t.check(
    'the deferral route stays kill-switched (no beta shapes reach the production wire)',
    toolSearch.includes("return 'standard'"),
  )
}

t.section('row 3 — verification depth follows spec completeness')
{
  const { VERIFICATION_AGENT } = await import('../../src/tools/AgentTool/built-in/verificationAgent.ts')
  const w = VERIFICATION_AGENT.whenToUse ?? ''
  t.check('the dispatch seam names the modulator', w.includes('When the task already supplies complete runnable acceptance checks'))
  t.check(
    'a total spec runs its own checks instead of re-buying them',
    w.includes('run those directly instead of dispatching this agent') && w.includes('the spec is already the red team'),
  )
  t.check(
    'the dispatch conditions are the judgment-left-to-you cases',
    w.includes('when correctness has been left to you') &&
      w.includes('vague or partly specified requirements') &&
      w.includes('arrived without its own checks'),
  )
  const doctrine = readFileSync('src/constants/subagentDoctrine.ts', 'utf8')
  t.check(
    'ONE seam: the doctrine floor does not duplicate the modulator',
    !doctrine.includes('SPEC COMPLETENESS'),
  )
}

t.finish('prove-harness-efficiency')

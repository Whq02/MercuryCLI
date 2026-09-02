#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'unison-un05-config-'))
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'unison-un05-home-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
const projDir = mkdtempSync(join(tmpdir(), 'unison-un05-proj-'))
bootstrap.setOriginalCwd(projDir)
process.chdir(projDir)

const { getSystemPrompt } = await import('../../src/constants/prompts.ts')
const { clearSystemPromptSections } = await import(
  '../../src/constants/systemPromptSections.ts'
)

const MODEL_A = 'claude-opus-5'
const MODEL_B = 'claude-sonnet-5'

const lineOf = (blocks: string[]): string =>
  blocks.join('\n\n').match(/You are powered by[^\n]*/)?.[0] ?? '(no identity line)'

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

const lineA = lineOf(await getSystemPrompt([], MODEL_A))
check('§A env line names the composed model', lineA.includes(MODEL_A), lineA)

const lineB = lineOf(await getSystemPrompt([], MODEL_B))
const stale = lineB.includes(MODEL_A) && !lineB.includes(MODEL_B)
check('§B REPRODUCED: post-switch line still names the previous model', stale, lineB)

clearSystemPromptSections()
const lineC = lineOf(await getSystemPrompt([], MODEL_B))
check('§C cleared recompose follows the applied model', lineC.includes(MODEL_B), lineC)

console.log(
  failed === 0
    ? '\n REPRODUCED — UN-05 red recorded (stale cached identity after live switch)'
    : '\n NOT REPRODUCED',
)
process.exit(failed === 0 ? 0 : 1)

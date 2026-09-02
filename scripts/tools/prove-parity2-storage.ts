#!/usr/bin/env bun
// ============================================================================
//  prove-parity2-storage — frontier-sweep #2, the resume / storage
//  tier, mechanism-pinned:
//
//   1. The task/teammate panel the operator leaves open survives a relaunch
//      (packet 61): the remembered value seeds the default app state through
//      the config, junk falls back to 'none', and the toggle persists it.
//   2. The fork-resume prefix law (rider R3) — structural: the resumed fork
//      replays the cleaned transcript and APPENDS the new prompt (never
//      rewrites the inherited slice), takes the frozen rendered system prompt
//      when present, and reconstructs tool-result replacement state "so the
//      prompt cache stays stable".
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'parity2-storage-'))
const home = join(SCRATCH, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// —— 1. the remembered panel ————————————————————————————————————————————
{
  const { enableConfigs, saveGlobalConfig, getGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  t('a fresh config starts with no panel open', getDefaultAppState().expandedView === 'none')
  saveGlobalConfig(current => ({ ...current, expandedView: 'tasks' }))
  t('the saved panel is read back', getGlobalConfig().expandedView === 'tasks')
  t('a relaunch seeds the default state from the remembered panel', getDefaultAppState().expandedView === 'tasks')
  saveGlobalConfig(current => ({ ...current, expandedView: 'teammates' }))
  t('the teammates board is remembered too', getDefaultAppState().expandedView === 'teammates')
  // A hand-edited config with junk falls back honestly.
  const configPath = join(home, '.mercury.json')
  let raw: Record<string, unknown> = {}
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  } catch {
    raw = {}
  }
  const junkPath = Object.keys(raw).length > 0 ? configPath : null
  if (junkPath !== null) {
    writeFileSync(junkPath, JSON.stringify({ ...raw, expandedView: 'sideways' }))
  }
  t('junk in the config reads as no panel (structural fallback pinned)', /remembered === 'tasks' \|\| remembered === 'teammates' \? remembered : 'none'/.test(readFileSync('src/state/AppStateStore.ts', 'utf8')))
  const keybindings = readFileSync('src/hooks/useGlobalKeybindings.tsx', 'utf8')
  t('the toggle persists the panel it lands on (structural)', /saveGlobalConfig\(current => \(\{ \.\.\.current, expandedView: remembered \}\)\)/.test(keybindings))
}

// —— 2. the fork-resume prefix law (rider R3) ———————————————————————————
{
  const resume = readFileSync('src/tools/AgentTool/resumeAgent.ts', 'utf8')
  t('the resumed transcript is replayed with the new prompt APPENDED', /const promptMessages: Message\[\] = \[\s*\.\.\.cleaned,\s*createUserMessage\(\{ content: prompt \}\),\s*\]/.test(resume))
  t('a fork resume takes the frozen rendered system prompt when present', /const rendered = toolUseContext\.renderedSystemPrompt/.test(resume) && /systemPromptOverride = \[\.\.\.rendered\]/.test(resume))
  t('tool-result replacement state is reconstructed for cache stability', /reconstructForSubagentResume\(/.test(resume))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures ? '\nFAILURES' : '\nALL GREEN')
process.exit(failures)

#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'switch-back-home-'))
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_ENTRYPOINT = 'headless'
delete process.env.ANTHROPIC_BASE_URL

const j = (v: unknown): string => JSON.stringify(v)
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { getSystemPrompt } = await import('../../src/constants/prompts.ts')
const { clearSystemPromptSections } = await import('../../src/constants/systemPromptSections.ts')
const { getOriginalCwd, setOriginalCwd, setCwdState } = await import('../../src/bootstrap/state.ts')

const scratch = mkdtempSync(join(tmpdir(), 'switch-back-cwd-'))
const cwd = process.cwd()
const originalCwd = getOriginalCwd()
process.chdir(scratch)
setOriginalCwd(scratch)
setCwdState(scratch)
const A = 'claude-fable-5-1'
const B = 'claude-opus-5'
const addedDir = mkdtempSync(join(tmpdir(), 'switch-back-added-'))
const text = (parts: string[]): string => parts.join('\n\n')
const envBlockOf = (prompt: string): string => {
  const at = prompt.indexOf('# Environment')
  if (at < 0) return ''
  const end = prompt.indexOf('\n# ', at + 1)
  return end < 0 ? prompt.slice(at) : prompt.slice(at, end)
}
try {
  section('§1 the control — an added working directory never rewrites the frozen prompt while the model holds')
  clearSystemPromptSections()
  const a1 = text(await getSystemPrompt([], A, []))
  const a1Again = text(await getSystemPrompt([], A, [addedDir]))
  check('same model, a directory added mid-session: the system prompt is byte-identical (the env block is keyed on the model alone)', a1Again === a1 && !envBlockOf(a1Again).includes(addedDir))

  section('§2 the switch-back — A → B → A after the add: the returning model\'s prompt is no longer the one its thinking blocks were bound to')
  const b = text(await getSystemPrompt([], B, [addedDir]))
  check('the switch to B recomputes the env block with the added directory (a lawful change on the switch)', envBlockOf(b).includes(addedDir))
  const a2 = text(await getSystemPrompt([], A, [addedDir]))
  check('back on A: the system prompt is byte-identical to A\'s first prompt (the prefix A\'s thinking blocks are bound to)', a2 === a1, `env block now: ${j(envBlockOf(a2).slice(0, 300))}`)
  check('back on A: the env block carries no directory added after A\'s first request', !envBlockOf(a2).includes(addedDir))
  check('B keeps its own block for its own return', text(await getSystemPrompt([], B, [addedDir])) === b)

  section('§3 the record carries every kept entry, and a new process restoring it serves each model the block it first sent')
  const { planToolPayload, clearToolRosterLatches, clearToolRosterRestore } = await import('../../src/services/providers/toolEconomy.ts')
  const { buildBoundPrefixRecordData, restoreBoundPrefixFromMessages, resetBoundPrefixEmitted, boundPrefixRecordToEmit } = await import('../../src/services/providers/anthropic/boundPrefixRecord.ts')
  const { getSystemPromptSectionCache } = await import('../../src/bootstrap/state.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const owner = 'switch-back'
  const messages = [{ type: 'user', uuid: 'u-switch-back', message: { role: 'user', content: 'first' } }]
  await planToolPayload({ model: A, tools: [] as never, messages: messages as never, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], source: 'prove', latchKey: owner })
  const record = await buildBoundPrefixRecordData(owner, messages as never, A)
  const envEntries = (record?.sections ?? []).filter(s => s.name === 'env_info_simple')
  const entryOf = (key: string) => envEntries.find(e => e.key === key)
  const sectionA = entryOf(A)?.value ?? ''
  const sectionB = entryOf(B)?.value ?? ''
  check('the record carries the environment section under both models\' keys, each as first sent, the current one last', envEntries.length === 2 && envEntries.at(-1)?.key === B && sectionA !== '' && a1.includes(sectionA) && !sectionA.includes(addedDir) && sectionB !== '' && b.includes(sectionB) && sectionB.includes(addedDir), j(envEntries.map(e => [e.key, (e.value ?? '').slice(0, 60)])))
  const row = await boundPrefixRecordToEmit(owner, messages as never, A)
  const persisted = JSON.parse(j(row))
  clearSystemPromptSections()
  clearToolRosterLatches()
  clearToolRosterRestore()
  resetBoundPrefixEmitted()
  check('a new process starts with an empty section cache', getSystemPromptSectionCache().size === 0)
  restoreBoundPrefixFromMessages([persisted])
  const a3 = text(await getSystemPrompt([], A, [addedDir]))
  const b3 = text(await getSystemPrompt([], B, [addedDir]))
  check('restored: A\'s first prompt is served byte for byte although the live world carries the added directory', a3 === a1, j(envBlockOf(a3).slice(0, 200)))
  check('restored: B\'s first prompt too', envBlockOf(b3) === envBlockOf(b))
} finally {
  clearSystemPromptSections()
  process.chdir(cwd)
  setOriginalCwd(originalCwd)
  setCwdState(cwd)
}

console.log(`\n${failures === 0 ? '✅' : '❌'} switch-back env block: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)

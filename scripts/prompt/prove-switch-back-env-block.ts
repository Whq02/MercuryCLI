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

const { getSystemPrompt } = await import('../../src/engine/system-prompt/defaultSystemPrompt.ts')
const { clearSystemPromptSections } = await import('../../src/engine/system-prompt/systemPromptSections.ts')
const { getOriginalCwd, setOriginalCwd, setCwdState } = await import('../../src/boot/process-state/processState.ts')

const scratch = mkdtempSync(join(tmpdir(), 'switch-back-cwd-'))
const cwd = process.cwd()
const originalCwd = getOriginalCwd()
process.chdir(scratch)
setOriginalCwd(scratch)
setCwdState(scratch)
const A = 'claude-fable-5-1'
const B = 'claude-opus-5'
const movedCwd = mkdtempSync(join(tmpdir(), 'switch-back-added-'))
const hintKeyedSections = ' | the head and env_info_simple sections are keyed on the model in getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts (keyedSystemPromptSection in src/engine/system-prompt/systemPromptSections.ts); a model that returns must get the text it first sent'
const hintPrefixRecord = ' | buildBoundPrefixRecordData and restoreBoundPrefixFromMessages in src/models/roads/anthropic/boundPrefixRecord.ts must carry and restore every kept entry'
const text = (parts: string[]): string => parts.join('\n\n')
const headOf = (prompt: string): string => prompt.split('\n\n')[0] ?? ''
const envBlockOf = (prompt: string): string => {
  const at = prompt.indexOf('# Environment')
  if (at < 0) return ''
  const end = prompt.indexOf('\n# ', at + 1)
  return end < 0 ? prompt.slice(at) : prompt.slice(at, end)
}
try {
  section('§1 the control — a starting-folder change never rewrites the frozen prompt while the model holds')
  clearSystemPromptSections()
  const a1 = text(await getSystemPrompt([], A, []))
  setOriginalCwd(movedCwd)
  const a1Again = text(await getSystemPrompt([], A, []))
  check('same model, a directory added mid-session: the system prompt is byte-identical (the head and the env block are keyed on the model alone)', a1Again === a1 && !headOf(a1Again).includes(movedCwd), 'the prompt changed under the same model after setOriginalCwd' + hintKeyedSections)

  section('§2 the switch-back — A → B → A after the add: the returning model\'s prompt is no longer the one its thinking blocks were bound to')
  const b = text(await getSystemPrompt([], B, []))
  check('the switch to B recomputes the model-keyed sections with the added directory (a lawful change on the switch): the head names it', headOf(b).includes(movedCwd) && envBlockOf(b) !== '', 'the switch to B did not recompute the head with the added directory, or the prompt has no # Environment block' + hintKeyedSections)
  const a2 = text(await getSystemPrompt([], A, []))
  check('back on A: the system prompt is byte-identical to A\'s first prompt (the prefix A\'s thinking blocks are bound to)', a2 === a1, `head now: ${j(headOf(a2))}` + hintKeyedSections)
  check('back on A: the head carries no directory added after A\'s first request', !headOf(a2).includes(movedCwd), 'A head names the directory added later' + hintKeyedSections)
  check('B keeps its own block for its own return', text(await getSystemPrompt([], B, [])) === b, 'B prompt changed on its return' + hintKeyedSections)

  section('§3 the record carries every kept entry, and a new process restoring it serves each model the block it first sent')
  const { planToolPayload, clearToolRosterLatches, clearToolRosterRestore } = await import('../../src/models/roads/toolEconomy.ts')
  const { buildBoundPrefixRecordData, restoreBoundPrefixFromMessages, resetBoundPrefixEmitted, boundPrefixRecordToEmit } = await import('../../src/models/roads/anthropic/boundPrefixRecord.ts')
  const { getSystemPromptSectionCache } = await import('../../src/boot/process-state/processState.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
  const owner = 'switch-back'
  const messages = [{ type: 'user', uuid: 'u-switch-back', message: { role: 'user', content: 'first' } }]
  await planToolPayload({ model: A, tools: [] as never, messages: messages as never, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], source: 'prove', latchKey: owner })
  const record = await buildBoundPrefixRecordData(owner, messages as never, A)
  const entriesOf = (name: string) => (record?.sections ?? []).filter(s => s.name === name)
  const envEntries = entriesOf('env_info_simple')
  const headEntries = entriesOf('head')
  const entryOf = (entries: typeof envEntries, key: string) => entries.find(e => e.key === key)?.value ?? ''
  const sectionA = entryOf(envEntries, A)
  const sectionB = entryOf(envEntries, B)
  check('the record carries the environment section under both models\' keys, each as first sent, the current one last', envEntries.length === 2 && envEntries.at(-1)?.key === B && sectionA !== '' && a1.includes(sectionA) && sectionB !== '' && b.includes(sectionB), j(envEntries.map(e => [e.key, (e.value ?? '').slice(0, 60)])) + hintPrefixRecord)
  check('the record carries the head under both models\' keys: A\'s without the added directory, B\'s with it', headEntries.length === 2 && entryOf(headEntries, A) === headOf(a1) && !entryOf(headEntries, A).includes(movedCwd) && entryOf(headEntries, B) === headOf(b) && entryOf(headEntries, B).includes(movedCwd), j(headEntries.map(e => [e.key, e.value])) + hintPrefixRecord)
  const row = await boundPrefixRecordToEmit(owner, messages as never, A)
  const persisted = JSON.parse(j(row))
  clearSystemPromptSections()
  clearToolRosterLatches()
  clearToolRosterRestore()
  resetBoundPrefixEmitted()
  check('a new process starts with an empty section cache', getSystemPromptSectionCache().size === 0, 'clearSystemPromptSections in src/engine/system-prompt/systemPromptSections.ts must empty the cache that getSystemPromptSectionCache in src/boot/process-state/processState.ts reads')
  restoreBoundPrefixFromMessages([persisted])
  const a3 = text(await getSystemPrompt([], A, []))
  const b3 = text(await getSystemPrompt([], B, []))
  check('restored: A\'s first prompt is served byte for byte although the live world carries the added directory', a3 === a1, j(envBlockOf(a3).slice(0, 200)) + hintPrefixRecord)
  check('restored: B\'s first prompt too', envBlockOf(b3) === envBlockOf(b) && headOf(b3) === headOf(b), 'B restored prompt differs from its first prompt' + hintPrefixRecord)
} finally {
  clearSystemPromptSections()
  process.chdir(cwd)
  setOriginalCwd(originalCwd)
  setCwdState(cwd)
}

console.log(`\n${failures === 0 ? '✅' : '❌'} switch-back env block: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)

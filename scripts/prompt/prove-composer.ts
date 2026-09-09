#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'composer-home-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { composeSystemPrompt } from '../../src/prompt/composer.js'
import {
  readPromptProvenance,
  __resetPromptProvenanceForTest,
} from '../../src/utils/cockpit/promptProvenance.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const SRC = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

console.log('============================================================')
console.log(' composer contract and configuration absence')
console.log('============================================================')

section('(1) composer — group order, null filtering, reconcile-last')
{
  __resetPromptProvenanceForTest()
  const out = composeSystemPrompt({
    staticSections: ['intro', null, 'tone'],
    dynamicBoundary: [],
    dynamicSpecs: [
      { name: 'memory', cacheBreak: false },
      { name: 'mcp', cacheBreak: true },
      { name: 'absent', cacheBreak: false },
    ],
    dynamicResolved: ['MEM', 'MCP', null],
    wrapperSections: [{ name: 'identity-floor', text: 'WRAP' }],
    modeSections: [{ name: 'mode-autopilot', text: 'MODE' }],
    antiSycSections: [],
    reconcileTailSections: ['RECONCILE'],
  })
  check('null static + null dynamic filtered, order preserved',
    JSON.stringify(out) === JSON.stringify(['intro', 'tone', 'MEM', 'MCP', 'WRAP', 'MODE', 'RECONCILE']))
  check('reconcile tail is the LAST segment (#9 contract)', out[out.length - 1] === 'RECONCILE')

  const boundary = composeSystemPrompt({
    staticSections: ['s'],
    dynamicBoundary: ['<<BOUNDARY>>'],
    dynamicSpecs: [],
    dynamicResolved: [],
    wrapperSections: [],
    modeSections: [],
    antiSycSections: [],
    reconcileTailSections: [],
  })
  check('boundary marker sits between static and dynamic', boundary[1] === '<<BOUNDARY>>')

  __resetPromptProvenanceForTest()
  const scoped = composeSystemPrompt({
    staticSections: ['s'],
    dynamicBoundary: [],
    dynamicSpecs: [],
    dynamicResolved: [],
    wrapperSections: [
      { name: 'identity-floor', text: 'FLOOR' },
      { name: 'mercury-doctrine', text: 'DOCTRINE' },
    ],
    modeSections: [],
    antiSycSections: [],
    reconcileTailSections: [],
  })
  check('the one-content law: every wrapper section rides the composition',
    JSON.stringify(scoped) === JSON.stringify(['s', 'FLOOR', 'DOCTRINE']))
}

section('(2) provenance shape-parity — the recorder cannot drift')
{
  __resetPromptProvenanceForTest()
  composeSystemPrompt({
    staticSections: ['a', 'b'],
    dynamicBoundary: [],
    dynamicSpecs: [
      { name: 'x', cacheBreak: true },
      { name: 'gone', cacheBreak: false },
    ],
    dynamicResolved: ['XX', null],
    wrapperSections: [
      { name: 'identity-floor', text: 'w1' },
      { name: 'mercury-doctrine', text: 'w2' },
    ],
    modeSections: [{ name: 'mode-autopilot', text: 'm' }],
    antiSycSections: ['anti'],
    reconcileTailSections: ['r'],
  })
  const prov = readPromptProvenance()
  check('provenance recorded', prov !== null)
  check('segment count matches composition', prov?.segmentCount === 8)
  check('typed sections carry semantic names (no positional ids)',
    prov?.sections.every(s => !/^wrapper-\d+$|^mode-\d+$/.test(s.name)) === true)
  const dyn = prov?.sections.find(s => s.name === 'x')
  check('dynamic entry carries scope/owner/cacheClass/chars/sha8',
    dyn?.group === 'dynamic' && dyn.chars === 2 && dyn.cacheClass === 'turn' && typeof dyn.owner === 'string' && /^[0-9a-f]{8}$/.test(dyn.sha8))
  check('absent dynamic section recorded with a reason',
    prov?.absent.some(a => a.name === 'gone' && a.reason.length > 0) === true)
  check('wrapper sections named identity-floor + mercury-doctrine',
    prov?.sections.filter(s => s.group === 'wrapper').map(s => s.name).join(',') === 'identity-floor,mercury-doctrine')
  check('mode section named mode-autopilot', prov?.sections.some(s => s.group === 'mode' && s.name === 'mode-autopilot') === true)
  check('contract digest recorded (bc1-)', typeof prov?.digest === 'string' && prov.digest.startsWith('bc1-'))
  check('total chars accounted', prov?.totalChars === 'ab'.length + 'XX'.length + 'w1w2'.length + 'm'.length + 'anti'.length + 'r'.length)
  composeSystemPrompt({
    staticSections: ['a'],
    dynamicBoundary: [],
    dynamicSpecs: [],
    dynamicResolved: [],
    wrapperSections: [],
    modeSections: [],
    antiSycSections: [],
    reconcileTailSections: [],
  })
  const prov2 = readPromptProvenance()
  check('previous composition totals retained (before/after)',
    prov2?.previous?.totalChars === prov?.totalChars && prov2?.previous?.digest === prov?.digest)
  const prompts = SRC('src/constants/prompts.ts')
  check('prompts.ts composes via the owned composer (no inline recorder)',
    prompts.includes('composeSystemPrompt({') && !prompts.includes('recordPromptComposition({'))
}

console.log('\n============================================================')

section('conversation guidance stays fixed while capabilities change')
{
  const { getSystemPrompt } = await import('../../src/constants/prompts.ts')
  const { getRunProtocolDelta } = await import('../../src/utils/cockpit/runProtocol.ts')
  const { clearSystemPromptSections, resolveSystemPromptSections, systemPromptSection, keyedSystemPromptSection } = await import('../../src/constants/systemPromptSections.ts')
  const { getSystemPromptSectionCache, setSystemPromptSectionCacheEntry, setOriginalCwd, getOriginalCwd, setCwdState } = await import('../../src/bootstrap/state.ts')
  const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
  const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
  const { isNullRenderingAttachment } = await import('../../src/components/messages/nullRenderingAttachments.ts')
  const cwd = process.cwd()
  const originalCwd = getOriginalCwd()
  const scratch = mkdtempSync(join(tmpdir(), 'prompt-capabilities-'))
  const oldEntry = process.env.MERCURY_ENTRYPOINT
  process.env.MERCURY_ENTRYPOINT = 'headless'
  process.chdir(scratch)
  setOriginalCwd(scratch)
  setCwdState(scratch)
  const tools = [{ name: 'Read' }] as never
  const withLsp = [{ name: 'Read' }, { name: 'LSP' }] as never
  const withBoth = [{ name: 'Read' }, { name: 'LSP' }, { name: 'Debug' }] as never
  try {
    clearSystemPromptSections()
    const first = await getSystemPrompt(tools, 'claude-fable-5-1')
    const lsp = await getSystemPrompt(withLsp, 'claude-fable-5-1')
    const both = await getSystemPrompt(withBoth, 'claude-fable-5-1')
    check('LSP and Debug mounts leave every system segment byte-identical', JSON.stringify(first) === JSON.stringify(lsp) && JSON.stringify(first) === JSON.stringify(both))
    const delta = getRunProtocolDelta(withLsp, [])
    check('the LSP guidance is appended instead of replacing the system segment', delta?.tools.join(',') === 'LSP' && delta.body.includes('symbol discovery') && !delta.body.includes('Use the Debug tool'))
    const row = createAttachmentMessage({ type: 'run_protocol_delta', ...delta! })
    check('guidance is a persisted model-visible row without a UI transcript slot', normalizeAttachmentForAPI(row.attachment).length === 1 && isNullRenderingAttachment(row))
    check('a collection that never appends the row does not consume the change', JSON.stringify(getRunProtocolDelta(withLsp, [])) === JSON.stringify(delta))
    check('recording the row prevents duplicate guidance', getRunProtocolDelta(withLsp, [row]) === null)
    const debug = getRunProtocolDelta(withBoth, [row])
    check('the next capability adds only its missing guidance', debug?.body.includes('Use the Debug tool') === true && !debug.body.includes('symbol discovery'))
    const rows = [row, createAttachmentMessage({ type: 'run_protocol_delta', ...debug! })]
    check('reconstructed rows retain the announcement state', getRunProtocolDelta(withBoth, JSON.parse(JSON.stringify(rows))) === null)
    const gone = getRunProtocolDelta(tools, rows)
    check('removed capabilities get an appended correction without changing old rows', gone?.tools.length === 0 && gone.body.includes('no longer available: LSP, Debug'))
    clearSystemPromptSections()
    await getSystemPrompt(withBoth, 'claude-fable-5-1')
    check('a fresh conversation puts its current capabilities in the system once', getSystemPromptSectionCache().get('run_protocol')?.value?.includes('Use the Debug tool') === true && getRunProtocolDelta(withBoth, []) === null)
    check('a compaction boundary resets old capability records to the new system section', getRunProtocolDelta(withBoth, [...rows, createAttachmentMessage({ type: 'run_protocol_delta', ...gone! }), { type: 'system', subtype: 'compact_boundary' } as never]) === null)
    setSystemPromptSectionCacheEntry('restored-guidance', 'recorded bytes', 'old-key')
    const restored = await resolveSystemPromptSections([systemPromptSection('restored-guidance', () => 'replacement bytes')])
    check('an unkeyed section preserves an older recorded keyed value', restored[0] === 'recorded bytes')
    const keyed = await resolveSystemPromptSections([keyedSystemPromptSection('restored-guidance', () => 'new-key', () => 'new keyed bytes')])
    check('sections with real dependencies still refresh when their key changes', keyed[0] === 'new keyed bytes')
  } finally {
    clearSystemPromptSections()
    process.chdir(cwd)
    setOriginalCwd(originalCwd)
    setCwdState(cwd)
    if (oldEntry === undefined) delete process.env.MERCURY_ENTRYPOINT
    else process.env.MERCURY_ENTRYPOINT = oldEntry
  }
}


section('main and sub-agent instructions match the available interaction model')
{
  const { getSystemPrompt, enhanceSystemPromptWithEnvDetails } = await import('../../src/constants/prompts.ts')
  const { clearSystemPromptSections } = await import('../../src/constants/systemPromptSections.ts')
  const { markSessionNonInteractive, resetRuntimePostureForTest } = await import('../../src/utils/cockpit/runtimePosture.ts')
  const { getOriginalCwd, setOriginalCwd, setCwdState, setAskChannel } = await import('../../src/bootstrap/state.ts')
  const cwd = process.cwd()
  const originalCwd = getOriginalCwd()
  const scratch = mkdtempSync(join(tmpdir(), 'prompt-interaction-'))
  const savedEntry = process.env.MERCURY_ENTRYPOINT
  const savedMacro = (globalThis as Record<string, any>).MACRO
  ;(globalThis as Record<string, any>).MACRO = { ...savedMacro, ISSUES_EXPLAINER: 'report the issue with /feedback' }
  process.chdir(scratch)
  setOriginalCwd(scratch)
  setCwdState(scratch)
  const tools = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Agent', 'AskUserQuestion'].map(name => ({ name })) as never
  try {
    resetRuntimePostureForTest()
    setAskChannel('none')
    markSessionNonInteractive('default')
    process.env.MERCURY_ENTRYPOINT = 'headless'
    clearSystemPromptSections()
    const headless = (await getSystemPrompt(tools, 'claude-fable-5-1')).join('\n\n')
    check('headless guidance names neither an unavailable question prompt nor interactive-only commands', !headless.includes('When a tool denial is not understood, use AskUserQuestion') && !headless.includes('/kill') && !headless.includes('/substrate'))
    resetRuntimePostureForTest()
    setAskChannel('sdk')
    markSessionNonInteractive('default')
    clearSystemPromptSections()
    const channelled = (await getSystemPrompt(tools, 'claude-fable-5-1')).join('\n\n')
    check('a headless run with a permission channel keeps the question hint and never claims automatic denial', channelled.includes('When a tool denial is not understood, use AskUserQuestion') && !channelled.includes('DENIED automatically') && !channelled.includes('/kill'))
    setAskChannel('operator')
    check('task-item guidance is absent when task tools are not provided', !headless.includes('create/update task items'))
    check('headless provider guidance prefers bundled skills to external or legacy skills', headless.includes('bundled Mercury skills supersede same-named external or legacy skills') && headless.includes('provider-apis supersedes claude-api'))
    check('the scout reference names the actual builtin type', !headless.includes('the Explore agent') && headless.includes('mercury-scout'))
    check('the feedback instruction contains no doubled verb', headless.includes('report the issue with /feedback.') && !headless.includes('use report the issue'))
    const toolsBlock = headless.slice(headless.indexOf('# Using your tools')).split('# Tone and style')[0]!
    check('batching leads the main tool instructions and preserves dependency ordering', toolsBlock.trim().startsWith('# Using your tools\n\n - Default to batching:') && toolsBlock.includes('Call dependent tools sequentially'))
    const child = (await enhanceSystemPromptWithEnvDetails(['Sub-agent instructions.'], 'claude-fable-5-1')).join('\n\n')
    check('sub-agents receive the same batching and dependency instruction', child.includes('Default to batching:') && child.includes('Call dependent tools sequentially'))
    resetRuntimePostureForTest()
    delete process.env.MERCURY_ENTRYPOINT
    clearSystemPromptSections()
    const interactive = (await getSystemPrompt([...tools, { name: 'TaskCreate' }] as never, 'claude-fable-5-1')).join('\n\n')
    check('interactive guidance retains supported questions and commands', interactive.includes('When a tool denial is not understood, use AskUserQuestion') && interactive.includes('/kill') && interactive.includes('/substrate'))
    check('task-item guidance remains when the task tools are provided', interactive.includes('create/update task items'))
    check('interactive provider guidance retains bundled-skill precedence', interactive.includes('bundled Mercury skills supersede same-named external or legacy skills') && interactive.includes('provider-apis supersedes claude-api'))
  } finally {
    resetRuntimePostureForTest()
    clearSystemPromptSections()
    process.chdir(cwd)
    setOriginalCwd(originalCwd)
    setCwdState(cwd)
    ;(globalThis as Record<string, any>).MACRO = savedMacro
    if (savedEntry === undefined) delete process.env.MERCURY_ENTRYPOINT
    else process.env.MERCURY_ENTRYPOINT = savedEntry
  }
}

if (failures === 0) console.log(' ✅ ALL COMPOSER CHECKS PASS')
else console.log(` ❌ ${failures} CHECK(S) FAILED`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)

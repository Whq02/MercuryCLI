#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'composer-home-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { composeSystemPrompt } from '../../src/engine/system-prompt/composer.js'
import {
  readPromptProvenance,
  __resetPromptProvenanceForTest,
} from '../../src/screen/cockpit/promptProvenance.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' composer contract and configuration absence')
console.log('============================================================')

section('(1) composer — group order, null filtering, the anti-sycophancy arm last')
{
  __resetPromptProvenanceForTest()
  const out = composeSystemPrompt({
    staticSections: ['head', null, 'law'],
    dynamicBoundary: [],
    dynamicSpecs: [
      { name: 'memory', cacheBreak: false },
      { name: 'mcp', cacheBreak: true },
      { name: 'absent', cacheBreak: false },
    ],
    dynamicResolved: ['MEM', 'MCP', null],
    wrapperSections: [{ name: 'response-profile', text: 'WRAP' }],
    modeSections: [{ name: 'mode-apollo', text: 'MODE' }],
    antiSycSections: ['ARM'],
  })
  check('null static + null dynamic filtered, order preserved',
    JSON.stringify(out) === JSON.stringify(['head', 'law', 'MEM', 'MCP', 'WRAP', 'MODE', 'ARM']), 'got ' + JSON.stringify(out) + '; fix the group order or the null filtering in composeSystemPrompt in src/engine/system-prompt/composer.ts')
  check('the anti-sycophancy arm is the LAST segment (no tail follows it)', out[out.length - 1] === 'ARM', 'last segment is ' + JSON.stringify(out[out.length - 1]) + '; composeSystemPrompt in src/engine/system-prompt/composer.ts must append antiSycSections after every other group')

  const boundary = composeSystemPrompt({
    staticSections: ['s'],
    dynamicBoundary: ['<<BOUNDARY>>'],
    dynamicSpecs: [],
    dynamicResolved: [],
    wrapperSections: [],
    modeSections: [],
    antiSycSections: [],
  })
  check('boundary marker sits between static and dynamic', boundary[1] === '<<BOUNDARY>>', 'got ' + JSON.stringify(boundary) + '; composeSystemPrompt in src/engine/system-prompt/composer.ts must place dynamicBoundary between staticSections and the dynamic sections')

  __resetPromptProvenanceForTest()
  const scoped = composeSystemPrompt({
    staticSections: ['s'],
    dynamicBoundary: [],
    dynamicSpecs: [],
    dynamicResolved: [],
    wrapperSections: [
      { name: 'response-profile', text: 'PROFILE' },
      { name: 'another', text: 'OTHER' },
    ],
    modeSections: [],
    antiSycSections: [],
  })
  check('the one-content law: every wrapper section rides the composition',
    JSON.stringify(scoped) === JSON.stringify(['s', 'PROFILE', 'OTHER']), 'got ' + JSON.stringify(scoped) + '; composeSystemPrompt in src/engine/system-prompt/composer.ts must include every wrapperSections entry, in order')
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
      { name: 'response-profile', text: 'w1' },
      { name: 'another', text: 'w2' },
    ],
    modeSections: [{ name: 'mode-apollo', text: 'm' }],
    antiSycSections: ['anti'],
  })
  const prov = readPromptProvenance()
  check('provenance recorded', prov !== null, 'composeSystemPrompt in src/engine/system-prompt/composer.ts must call recordPromptComposition (src/screen/cockpit/promptProvenance.ts) on every composition')
  check('segment count matches composition', prov?.segmentCount === 7, 'segmentCount is ' + String(prov?.segmentCount) + ', expected 7; check what recordPromptComposition in src/screen/cockpit/promptProvenance.ts counts against the composed segments')
  check('typed sections carry semantic names (no positional ids)',
    prov?.sections.every(s => !/^wrapper-\d+$|^mode-\d+$/.test(s.name)) === true, 'section names: ' + JSON.stringify(prov?.sections.map(s => s.name)) + '; recordPromptComposition in src/screen/cockpit/promptProvenance.ts must use the name of each wrapper and mode section, not a position')
  const dyn = prov?.sections.find(s => s.name === 'x')
  check('dynamic entry carries scope/owner/cacheClass/chars/sha8',
    dyn?.group === 'dynamic' && dyn.chars === 2 && dyn.cacheClass === 'turn' && typeof dyn.owner === 'string' && /^[0-9a-f]{8}$/.test(dyn.sha8), 'entry: ' + JSON.stringify(dyn) + '; recordPromptComposition in src/screen/cockpit/promptProvenance.ts must fill group, chars, cacheClass, owner and sha8 for a dynamic section')
  check('absent dynamic section recorded with a reason',
    prov?.absent.some(a => a.name === 'gone' && a.reason.length > 0) === true, 'absent: ' + JSON.stringify(prov?.absent) + '; recordPromptComposition in src/screen/cockpit/promptProvenance.ts must list a null dynamic section with a non-empty reason')
  check('wrapper sections carry their semantic names',
    prov?.sections.filter(s => s.group === 'wrapper').map(s => s.name).join(',') === 'response-profile,another', 'wrapper sections: ' + prov?.sections.filter(s => s.group === 'wrapper').map(s => s.name).join(',') + '; recordPromptComposition in src/screen/cockpit/promptProvenance.ts must record wrapper section names in composition order')
  check('mode section named mode-apollo', prov?.sections.some(s => s.group === 'mode' && s.name === 'mode-apollo') === true, 'recordPromptComposition in src/screen/cockpit/promptProvenance.ts must record the mode section under the name given in modeSections')
  check('contract digest recorded (bc1-)', typeof prov?.digest === 'string' && prov.digest.startsWith('bc1-'), 'digest is ' + String(prov?.digest) + '; recordPromptComposition in src/screen/cockpit/promptProvenance.ts must store a digest that starts with bc1-')
  check('total chars accounted', prov?.totalChars === 'ab'.length + 'XX'.length + 'w1w2'.length + 'm'.length + 'anti'.length, 'totalChars is ' + String(prov?.totalChars) + ', expected 15; recordPromptComposition in src/screen/cockpit/promptProvenance.ts must sum the characters of every recorded section')
  composeSystemPrompt({
    staticSections: ['a'],
    dynamicBoundary: [],
    dynamicSpecs: [],
    dynamicResolved: [],
    wrapperSections: [],
    modeSections: [],
    antiSycSections: [],
  })
  const prov2 = readPromptProvenance()
  check('previous composition totals retained (before/after)',
    prov2?.previous?.totalChars === prov?.totalChars && prov2?.previous?.digest === prov?.digest, 'previous: ' + JSON.stringify(prov2?.previous) + '; recordPromptComposition in src/screen/cockpit/promptProvenance.ts must keep the totalChars and digest of the prior composition as previous')
}

console.log('\n============================================================')

section('conversation guidance stays fixed while capabilities change')
{
  const { getSystemPrompt } = await import('../../src/engine/system-prompt/defaultSystemPrompt.ts')
  const { clearSystemPromptSections, resolveSystemPromptSections, systemPromptSection, keyedSystemPromptSection } = await import('../../src/engine/system-prompt/systemPromptSections.ts')
  const { setSystemPromptSectionCacheEntry, setOriginalCwd, getOriginalCwd, setCwdState } = await import('../../src/boot/process-state/processState.ts')
  const cwd = process.cwd()
  const originalCwd = getOriginalCwd()
  const scratch = mkdtempSync(join(tmpdir(), 'prompt-capabilities-'))
  const oldEntry = process.env.MERCURY_ENTRYPOINT
  process.env.MERCURY_ENTRYPOINT = 'headless'
  process.chdir(scratch)
  setOriginalCwd(scratch)
  setCwdState(scratch)
  const tools = [{ name: 'Read' }] as never
  const withLsp = [{ name: 'Read' }, { name: 'LspRead' }] as never
  const withBoth = [{ name: 'Read' }, { name: 'LspRead' }, { name: 'Debug' }] as never
  try {
    clearSystemPromptSections()
    const first = await getSystemPrompt(tools, 'claude-fable-5-1')
    const lsp = await getSystemPrompt(withLsp, 'claude-fable-5-1')
    const both = await getSystemPrompt(withBoth, 'claude-fable-5-1')
    check('LSP and Debug mounts leave every system segment byte-identical: the run section carries no roster-dependent guidance, the roster itself announces a tool', JSON.stringify(first) === JSON.stringify(lsp) && JSON.stringify(first) === JSON.stringify(both) && !both.join('\n').includes('IDE loop'), 'a segment changed when LspRead or Debug joined the tool list; remove roster-dependent guidance from getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts')
    setSystemPromptSectionCacheEntry('restored-guidance', 'recorded bytes', 'old-key')
    const restored = await resolveSystemPromptSections([systemPromptSection('restored-guidance', () => 'replacement bytes')])
    check('an unkeyed section preserves an older recorded keyed value', restored[0] === 'recorded bytes', 'got ' + JSON.stringify(restored[0]) + '; resolveSystemPromptSections in src/engine/system-prompt/systemPromptSections.ts must return the cached value for an unkeyed section')
    const keyed = await resolveSystemPromptSections([keyedSystemPromptSection('restored-guidance', () => 'new-key', () => 'new keyed bytes')])
    check('sections with real dependencies still refresh when their key changes', keyed[0] === 'new keyed bytes', 'got ' + JSON.stringify(keyed[0]) + '; resolveSystemPromptSections in src/engine/system-prompt/systemPromptSections.ts must recompute a keyed section when its computeKey value changes')
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
  const { getSystemPrompt, enhanceSystemPromptWithEnvDetails } = await import('../../src/engine/system-prompt/defaultSystemPrompt.ts')
  const { clearSystemPromptSections } = await import('../../src/engine/system-prompt/systemPromptSections.ts')
  const { markSessionNonInteractive, resetRuntimePostureForTest: resetPosture } = await import('../../src/screen/cockpit/runtimePosture.ts')
  const { resetHarnessMapForTest } = await import('../../src/screen/cockpit-gauges/harnessMap.ts')
  const resetRuntimePostureForTest = (): void => {
    resetPosture()
    resetHarnessMapForTest()
  }
  const { getOriginalCwd, setOriginalCwd, setCwdState, setAskChannel } = await import('../../src/boot/process-state/processState.ts')
  const cwd = process.cwd()
  const originalCwd = getOriginalCwd()
  const scratch = mkdtempSync(join(tmpdir(), 'prompt-interaction-'))
  const savedEntry = process.env.MERCURY_ENTRYPOINT
  const savedMacro = (globalThis as Record<string, any>).MACRO
  ;(globalThis as Record<string, any>).MACRO = { ...savedMacro, ISSUES_EXPLAINER: 'report the issue with /feedback' }
  process.chdir(scratch)
  setOriginalCwd(scratch)
  setCwdState(scratch)
  const tools = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Crewmate', 'AskUserQuestion'].map(name => ({ name })) as never
  const PROVIDER_GUIDANCE = 'For provider-API work, invoke provider-apis: it outranks any external provider-API skill, and a bundled Mercury skill outranks an external skill of the same name.'
  const FOREIGN_SKILL_NAMES = [['claude', '-api'].join(''), 'legacy skills']
  try {
    resetRuntimePostureForTest()
    setAskChannel('none')
    markSessionNonInteractive('default')
    process.env.MERCURY_ENTRYPOINT = 'headless'
    clearSystemPromptSections()
    const headless = (await getSystemPrompt(tools, 'claude-fable-5-1')).join('\n\n')
    check('headless guidance names no interactive-only command', !headless.includes('/kill') && !headless.includes('starts with `!`'), 'remove /kill and the starts-with-! text from the headless prompt built by getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts')
    const askMentions = headless.split('AskUserQuestion').length - 1
    check('the question tool is named once in the headless prompt, on the posture line as the road to a blocked outcome, with no ask hint', askMentions === 1 && /still ask through AskUserQuestion and end your turn: that unanswered question ends the run as blocked/.test(headless) && !/use AskUserQuestion to ask rather than guessing/.test(headless), String(askMentions) + ' mentions; the headless prompt from getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts must name AskUserQuestion once, on the posture line, with no use-it-to-ask hint')
    resetRuntimePostureForTest()
    setAskChannel('sdk')
    markSessionNonInteractive('default')
    clearSystemPromptSections()
    const channelled = (await getSystemPrompt(tools, 'claude-fable-5-1')).join('\n\n')
    check('a headless run with a permission channel says a host holds the asks and never claims automatic denial', channelled.includes('a host that holds the asks') && !channelled.includes('denied automatically') && !channelled.includes('/kill'), 'the headless posture text from getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts must say a host holds the asks when the ask channel is sdk')
    setAskChannel('operator')
    check('no prompt section carries task-item guidance (the Task tools\' own descriptions do)', !headless.includes('create and update task items'), 'remove the task-item guidance from the system prompt sections in src/engine/system-prompt/defaultSystemPrompt.ts')
    check('headless provider guidance ranks provider-apis over any external provider-API skill and bundled skills over same-named external ones', headless.includes(PROVIDER_GUIDANCE), 'the headless prompt must contain the PROVIDER_SKILL_PRECEDENCE sentence in src/engine/system-prompt/defaultSystemPrompt.ts')
    check('headless provider guidance names no external skill', FOREIGN_SKILL_NAMES.every(name => !headless.includes(name)), 'remove the external skill name from the headless prompt in src/engine/system-prompt/defaultSystemPrompt.ts')
    check('the prompt names no foreign agent type (the Agent roster names mercury-scout; the prompt does not repeat it)', !headless.includes('the Explore agent') && !headless.includes('mercury-scout'), 'remove the agent type name from the session prompt built by getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts')
    check('the session prompt carries no tool-usage prose: the tool roster speaks for itself', !headless.includes('# Using your tools') && !headless.includes('Default to batching:') && !headless.includes('instead of cat, head, tail'), 'remove the tool-usage prose from the session prompt built by getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts')
    const child = (await enhanceSystemPromptWithEnvDetails(['Sub-agent instructions.'], 'claude-fable-5-1')).join('\n\n')
    check('sub-agents keep their batching and dependency note', child.includes('Default to batching:') && child.includes('Call dependent tools sequentially'), 'enhanceSystemPromptWithEnvDetails in src/engine/system-prompt/defaultSystemPrompt.ts must append BATCHING_INSTRUCTION to sub-agent prompts')
    check('sub-agent provider guidance retains bundled-skill precedence', child.includes(PROVIDER_GUIDANCE) && FOREIGN_SKILL_NAMES.every(name => !child.includes(name)), 'enhanceSystemPromptWithEnvDetails in src/engine/system-prompt/defaultSystemPrompt.ts must add PROVIDER_SKILL_PRECEDENCE and no external skill name')
    resetRuntimePostureForTest()
    delete process.env.MERCURY_ENTRYPOINT
    clearSystemPromptSections()
    const interactive = (await getSystemPrompt([...tools, { name: 'TaskCreate' }] as never, 'claude-fable-5-1')).join('\n\n')
    check('interactive facts name the interactive-only surface the roster does not carry: the `!` form on the harness map; no posture block rides with nothing armed (/kill is named only beside an armed kill)', interactive.includes('starts with `!`') && !interactive.includes('/kill') && !interactive.includes('# Runtime posture'), 'the interactive prompt from getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts must name the ! form and carry no /kill or posture block when nothing is armed')
    check('the task tools joining the pool adds no prompt section', !interactive.includes('create and update task items'), 'remove the task-item guidance from the system prompt sections in src/engine/system-prompt/defaultSystemPrompt.ts')
    check('interactive provider guidance retains bundled-skill precedence', interactive.includes(PROVIDER_GUIDANCE) && FOREIGN_SKILL_NAMES.every(name => !interactive.includes(name)), 'the interactive prompt from getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts must contain PROVIDER_SKILL_PRECEDENCE and no external skill name')
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

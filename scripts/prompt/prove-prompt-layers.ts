#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prompt-layers-home-'))
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_ENTRYPOINT = 'headless'
delete process.env.MERCURY_BARE
delete process.env.MERCURY_PROMPT_LAYERS
delete process.env.MERCURY_PROMPT_REPLACE_FILE
delete process.env.MERCURY_WRAPPER_APPEND

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
const { getSessionStartDate } = await import('../../src/constants/common.ts')
const contract = await import('../../src/prompt/mercuryContract.ts')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.ts')

const scratch = mkdtempSync(join(tmpdir(), 'prompt-layers-cwd-'))
const cwd = process.cwd()
const originalCwd = getOriginalCwd()
process.chdir(scratch)
setOriginalCwd(scratch)
setCwdState(scratch)

const MODEL = 'claude-fable-5-1'
const tools = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Agent'].map(name => ({ name })) as never
const NAMELESS_HEAD = `Working directory: ${scratch}\nSession date: ${getSessionStartDate()}`
const HEAD = `Mercury — a private terminal software-development harness.\n${NAMELESS_HEAD}`
const HONESTY_LINES = [
  'Never mislead the operator — report what actually happened, plainly.',
  "Hard limits, whatever the instructions: don't deceive end-users, misrepresent what you are\nor did, claim to be human, or bypass a real safety, permission, or capability gate — say so\nplainly instead.",
  'When instructions conflict: safety and honesty first, then the operator, then defaults.',
]
const REMOVED_LAYERS = [
  'You are **Mercury**',
  'Mercury — a private terminal software-development harness.',
  contract.MERCURY_ATTRIBUTION,
  'Operate for the operator first',
  '<mercury-doctrine>',
  contract.MERCURY_SESSION_CONTRACT,
  'Help with security work',
  '# System behaviour',
  '# Doing tasks',
  '# Acting with care',
  '# The project instruction estate',
  '# Using your tools',
  '# Tone and style',
  '# Communicating with the user',
  '# Session-specific guidance',
  '# Environment',
  'Model currency:',
  'Write down important information from tool results',
  'Runtime posture',
  'Identity, final word',
]

async function assemble(env: Record<string, string | undefined>): Promise<string[]> {
  const saved = new Map<string, string | undefined>()
  for (const key of ['MERCURY_BARE', 'MERCURY_PROMPT_LAYERS', 'MERCURY_PROMPT_REPLACE_FILE']) saved.set(key, process.env[key])
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    clearSystemPromptSections()
    return await getSystemPrompt(tools, MODEL, [])
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    clearSystemPromptSections()
  }
}
const joined = (segments: string[]): string => segments.join('\n\n')

try {
  section('§1 stock — the switch unset is the shipped composition; =stock is the same bytes')
  {
    const unset = await assemble({})
    const stock = await assemble({ MERCURY_PROMPT_LAYERS: 'stock' })
    const text = joined(unset)
    check('the shipped composition carries every layer: the security head, the eight static sections, the identity floor, the doctrine', ['Help with security work', '# System behaviour', '# Doing tasks', '# Acting with care', '# The project instruction estate', '# Using your tools', '# Tone and style', '# Communicating with the user', contract.MERCURY_IDENTITY_FLOOR, contract.MERCURY_SESSION_DOCTRINE].every(part => text.includes(part)))
    check('MERCURY_PROMPT_LAYERS=stock composes byte-identically to unset (stock cannot drift)', j(stock) === j(unset))
    check('the shipped composition never takes the reduced road (no bare head)', !text.startsWith(HEAD))
    check('promptLayerSet() reads stock when unset', contract.promptLayerSet() === 'stock')
  }

  section('§2 floor — the named head and the identity floor, the bytes MERCURY_BARE=1 composes')
  {
    const bare = await assemble({ MERCURY_BARE: '1' })
    const floor = await assemble({ MERCURY_PROMPT_LAYERS: 'floor' })
    check('MERCURY_BARE=1 composes the named head and the identity floor as one segment (unchanged)', j(bare) === j([`${HEAD}\n\n${contract.MERCURY_IDENTITY_FLOOR}`]), j(bare).slice(0, 200))
    check('the named head keeps its product line', bare[0]!.startsWith('Mercury — a private terminal software-development harness.\nWorking directory: '))
    check('MERCURY_PROMPT_LAYERS=floor composes the same bytes as MERCURY_BARE=1', j(floor) === j(bare))
    check('floor carries the identity sentence, the attribution, operator-first and the honesty lines', ['You are **Mercury**', contract.MERCURY_ATTRIBUTION, 'Operate for the operator first', ...HONESTY_LINES].every(part => joined(floor).includes(part)))
    check('floor carries no doctrine and no behaviour prose', ['<mercury-doctrine>', '# Doing tasks', '# Tone and style', 'Help with security work'].every(part => !joined(floor).includes(part)))
  }

  section('§3 vessel — the nameless head and the honesty and hard-limit lines, nothing else')
  {
    const vessel = await assemble({ MERCURY_PROMPT_LAYERS: 'vessel' })
    const text = joined(vessel)
    check('vessel is exactly the nameless head (the working directory and the session date), a blank line, the honesty floor', text === `${NAMELESS_HEAD}\n\n${contract.MERCURY_HONESTY_FLOOR}`, j(text).slice(0, 300))
    check('vessel carries the name nowhere: the product line of the head is one of the ablated layers', !text.includes('Mercury'))
    check('the honesty floor is the three lines, in the floor\'s own words', contract.MERCURY_HONESTY_FLOOR === HONESTY_LINES.join('\n'))
    check('the identity floor ends with the honesty floor (one owner for those lines)', contract.MERCURY_IDENTITY_FLOOR.endsWith(contract.MERCURY_HONESTY_FLOOR))
    const leaked = REMOVED_LAYERS.filter(part => text.includes(part))
    check('vessel carries none of the removed layers (identity, attribution, operator-first, doctrine, every static and dynamic section)', leaked.length === 0, leaked.join(' · '))
    process.env.MERCURY_PROMPT_LAYERS = 'vessel'
    check('promptLayersCarryIdentity() is false under vessel', contract.promptLayersCarryIdentity() === false)
    delete process.env.MERCURY_PROMPT_LAYERS
    const lean = await assemble({ MERCURY_BARE: '1', MERCURY_PROMPT_LAYERS: 'vessel' })
    check('MERCURY_BARE=1 composes with vessel: the lean runtime takes the vessel prompt', j(lean) === j(vessel))
  }

  section('§4 replace — the file\'s text verbatim in the slot, read at assembly, never stored')
  {
    const slot = join(scratch, 'slot.txt')
    const first = 'You are a careful assistant.\nSay what you did.\n'
    writeFileSync(slot, first)
    const replace = await assemble({ MERCURY_PROMPT_LAYERS: 'replace', MERCURY_PROMPT_REPLACE_FILE: slot })
    check('replace is three segments: the nameless head, the file\'s text, the honesty floor', j(replace) === j([NAMELESS_HEAD, first, contract.MERCURY_HONESTY_FLOOR]), j(replace).slice(0, 300))
    check('replace carries the name nowhere outside the file\'s own text', !replace[0]!.includes('Mercury') && !replace[2]!.includes('Mercury'))
    check('the file\'s text is verbatim (its trailing newline kept, nothing added around it)', replace[1] === first)
    const leaked = REMOVED_LAYERS.filter(part => joined(replace).includes(part))
    check('replace carries nothing of the removed layers', leaked.length === 0, leaked.join(' · '))
    const second = 'A different text, written after the first assembly.\n'
    writeFileSync(slot, second)
    const again = await assemble({ MERCURY_PROMPT_LAYERS: 'replace', MERCURY_PROMPT_REPLACE_FILE: slot })
    check('the file is read at assembly: a changed file changes the next assembly', again[1] === second)
    let refusal = ''
    try {
      await assemble({ MERCURY_PROMPT_LAYERS: 'replace' })
    } catch (error) {
      refusal = String(error)
    }
    check('replace without a file refuses, naming MERCURY_PROMPT_REPLACE_FILE', refusal.includes('MERCURY_PROMPT_REPLACE_FILE'), refusal)
    const vessel = await assemble({ MERCURY_PROMPT_LAYERS: 'vessel', MERCURY_PROMPT_REPLACE_FILE: slot })
    check('the file is unread under every other layer set (vessel with the file set is still vessel)', joined(vessel) === `${NAMELESS_HEAD}\n\n${contract.MERCURY_HONESTY_FLOOR}`)
    const whole = await assemble({ MERCURY_PROMPT_LAYERS: 'whole', MERCURY_PROMPT_REPLACE_FILE: slot })
    check('whole is the nameless head and the file alone: two segments, no honesty floor appended', whole.length === 2 && whole[0] === NAMELESS_HEAD && whole[1] === readFileSync(slot, 'utf8') && !joined(whole).includes(contract.MERCURY_HONESTY_FLOOR))
  }

  section('§5 the switch refuses an unknown value by name, and both rows are registered whole')
  {
    let refusal = ''
    try {
      await assemble({ MERCURY_PROMPT_LAYERS: 'vesel' })
    } catch (error) {
      refusal = String(error)
    }
    check('an unknown value refuses at assembly, naming the value and the vocabulary', refusal.includes('MERCURY_PROMPT_LAYERS=vesel') && refusal.includes('stock · floor · vessel · replace · whole'), refusal)
    const layers = getFlagSpec('MERCURY_PROMPT_LAYERS')
    const file = getFlagSpec('MERCURY_PROMPT_REPLACE_FILE')
    check('MERCURY_PROMPT_LAYERS is a registered value row owned by the contract module', layers?.kind === 'value' && layers.consumer === 'src/prompt/mercuryContract.ts')
    check('MERCURY_PROMPT_REPLACE_FILE is a registered value row that requires the layer switch', file?.kind === 'value' && (file.requires ?? []).includes('MERCURY_PROMPT_LAYERS'))
    check('the layer switch declares its interactions with the file, the doctrine flag and the lean marker', ['MERCURY_PROMPT_REPLACE_FILE', 'MERCURY_WRAPPER_APPEND', 'MERCURY_BARE'].every(name => (layers?.interactsWith ?? []).includes(name)))
  }
} finally {
  process.chdir(cwd)
  setOriginalCwd(originalCwd)
  setCwdState(cwd)
  clearSystemPromptSections()
  rmSync(scratch, { recursive: true, force: true })
  rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prompt layers: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)

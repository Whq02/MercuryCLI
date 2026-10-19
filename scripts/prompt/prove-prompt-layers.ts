#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const J = (...parts: string[]): string => parts.join('')

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prompt-layers-home-'))
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_ENTRYPOINT = 'headless'
delete process.env.MERCURY_BARE
delete process.env.MERCURY_PROMPT_LAYERS
delete process.env.MERCURY_PROMPT_REPLACE_FILE

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
const contract = await import('../../src/prompt/mercuryContract.ts')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.ts')

const scratch = mkdtempSync(join(tmpdir(), 'prompt-layers-cwd-'))
const cwd = process.cwd()
const originalCwd = getOriginalCwd()
process.chdir(scratch)
setOriginalCwd(scratch)
setCwdState(scratch)

const MODEL = 'claude-fable-5-1'
const tools = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Crewmate'].map(name => ({ name })) as never
const HEAD = `Working directory: ${scratch}`
const FACTS = ['# The project estate', '# Memory', '# Environment', 'Model currency:', 'Write down important information from tool results']

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
    check('the shipped composition is the head, the constitution, then the fact sections', unset[0] === HEAD && unset[1] === contract.MERCURY_CONSTITUTION && text.indexOf(contract.MERCURY_CONSTITUTION) !== -1 && FACTS.every(fact => text.indexOf(fact) > text.indexOf(contract.MERCURY_CONSTITUTION)), j(unset.slice(0, 2)).slice(0, 200))
    check('MERCURY_PROMPT_LAYERS=stock composes byte-identically to unset (stock cannot drift)', j(stock) === j(unset))
    check('promptLayerSet() reads stock when unset', contract.promptLayerSet() === 'stock')
    const bare = await assemble({ MERCURY_BARE: '1' })
    check('MERCURY_BARE=1 composes the head and the constitution as one segment', j(bare) === j([`${HEAD}\n\n${contract.MERCURY_CONSTITUTION}`]), j(bare).slice(0, 200))
  }

  section('§2 replace — the file\'s text in the constitution\'s slot, the fact sections kept, read at assembly, never stored')
  {
    const slot = join(scratch, 'slot.txt')
    const first = 'You are a careful assistant.\nSay what you did.\n'
    writeFileSync(slot, first)
    const replace = await assemble({ MERCURY_PROMPT_LAYERS: 'replace', MERCURY_PROMPT_REPLACE_FILE: slot })
    const text = joined(replace)
    check('replace opens on the same head as stock (the working directory)', replace[0] === HEAD, j(replace[0]))
    check('the file\'s text is the second segment, verbatim (its trailing newline kept, nothing added around it)', replace[1] === first)
    check('the fact sections follow, as under stock', FACTS.every(fact => text.includes(fact)), FACTS.filter(fact => !text.includes(fact)).join(' · '))
    check('the constitution is absent under replace', !text.includes(contract.MERCURY_CONSTITUTION) && !text.includes("You are Mercury, the coding agent working in the operator's terminal."))
    const stock = await assemble({})
    check('replace is stock with the file in the constitution\'s slot: the segments after the slot are byte-identical', j(replace.slice(2)) === j(stock.slice(2)))
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
    check('replace without a file refuses, naming MERCURY_PROMPT_REPLACE_FILE', refusal.includes('MERCURY_PROMPT_LAYERS=replace') && refusal.includes('MERCURY_PROMPT_REPLACE_FILE'), refusal)
    const lean = await assemble({ MERCURY_BARE: '1', MERCURY_PROMPT_LAYERS: 'replace', MERCURY_PROMPT_REPLACE_FILE: slot })
    check('MERCURY_BARE=1 composes with replace: the head and the file as one segment', j(lean) === j([`${HEAD}\n\n${second}`]), j(lean).slice(0, 200))
    check('the file is unread under stock (a file set beside stock changes nothing)', j(await assemble({ MERCURY_PROMPT_REPLACE_FILE: slot })) === j(stock))
  }

  section('§3 whole — the head and the file alone')
  {
    const slot = join(scratch, 'whole.txt')
    writeFileSync(slot, 'The whole prompt beneath the head.\n')
    const whole = await assemble({ MERCURY_PROMPT_LAYERS: 'whole', MERCURY_PROMPT_REPLACE_FILE: slot })
    check('whole is two segments: the head and the file verbatim', whole.length === 2 && whole[0] === HEAD && whole[1] === readFileSync(slot, 'utf8'), j(whole))
    check('no fact section and no constitution follow', !FACTS.some(fact => joined(whole).includes(fact)) && !joined(whole).includes('You are Mercury'))
    check('MERCURY_BARE=1 leaves whole as it is', j(await assemble({ MERCURY_BARE: '1', MERCURY_PROMPT_LAYERS: 'whole', MERCURY_PROMPT_REPLACE_FILE: slot })) === j(whole))
    let refusal = ''
    try {
      await assemble({ MERCURY_PROMPT_LAYERS: 'whole' })
    } catch (error) {
      refusal = String(error)
    }
    check('whole without a file refuses, naming MERCURY_PROMPT_REPLACE_FILE', refusal.includes('MERCURY_PROMPT_LAYERS=whole') && refusal.includes('MERCURY_PROMPT_REPLACE_FILE'), refusal)
  }

  section('§4 the switch refuses an unknown value by name, and both rows are registered whole')
  {
    for (const value of ['vesel', J('flo', 'or'), J('ves', 'sel')]) {
      let refusal = ''
      try {
        await assemble({ MERCURY_PROMPT_LAYERS: value })
      } catch (error) {
        refusal = String(error)
      }
      check(`MERCURY_PROMPT_LAYERS=${value} refuses at assembly, naming the value and the vocabulary stock · replace · whole`, refusal.includes(`MERCURY_PROMPT_LAYERS=${value}`) && refusal.includes('(stock · replace · whole)'), refusal)
    }
    const layers = getFlagSpec('MERCURY_PROMPT_LAYERS')
    const file = getFlagSpec('MERCURY_PROMPT_REPLACE_FILE')
    check('MERCURY_PROMPT_LAYERS is a registered value row owned by the contract module', layers?.kind === 'value' && layers.consumer === 'src/prompt/mercuryContract.ts')
    check('its summary names the three sets and no other', typeof layers?.summary === 'string' && ["'stock'", "'replace'", "'whole'"].every(word => layers.summary.includes(word)) && !/floor|vessel|identity floor|doctrine/.test(layers.summary))
    check('MERCURY_PROMPT_REPLACE_FILE is a registered value row that requires the layer switch', file?.kind === 'value' && (file.requires ?? []).includes('MERCURY_PROMPT_LAYERS'))
    check('the layer switch declares its interactions with the file and the lean marker, and nothing else', j([...(layers?.interactsWith ?? [])].sort()) === j(['MERCURY_BARE', 'MERCURY_PROMPT_REPLACE_FILE']))
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

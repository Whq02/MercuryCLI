#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'picker-current-mark-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
for (const key of [
  'MERCURY_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'HF_TOKEN',
  'DEEPSEEK_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_CUSTOM_MODEL_OPTION',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_LOCAL_BASE_URL',
  'MERCURY_DEFAULT_OPUS_MODEL',
  'MERCURY_DEFAULT_SONNET_MODEL',
  'MERCURY_DEFAULT_FABLE_MODEL',
  'MERCURY_DEFAULT_HAIKU_MODEL',
  'MERCURY_DISABLE_1M_CONTEXT',
  'NODE_ENV',
]) {
  delete process.env[key]
}
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) {
  process.env[base] = 'http://127.0.0.1:1'
}
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(await import('../../src/utils/config.js')).enableConfigs()

const React = (await import('react')).default
const { renderToString } = await import('../../src/utils/staticRender.tsx')
const { MercuryModelPicker } = await import('../../src/components/MercuryModelPicker.js')
type ModelChoice = import('../../src/components/MercuryModelPicker.js').ModelChoice
const { ANTHROPIC_MODEL_GROUP, getModelOptions, isProviderActionRow } = await import('../../src/utils/model/modelOptions.ts')
type ModelOption = import('../../src/utils/model/modelOptions.ts').ModelOption
const { getMainLoopModel, parseUserSpecifiedModel, renderModelName } = await import('../../src/utils/model/model.ts')
const caps = await import('../../src/utils/model/capabilities.ts')
const effort = await import('../../src/utils/effort.ts')

let failures = 0
function check(label: string, cond: boolean, detail?: string): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const RAW = 'claude-opus-5-7'
const DOOR = 'Anthropic API key'
const options = (): ModelOption[] => getModelOptions({ anthropicCredentialed: () => true, anthropicLiveRows: () => [{ id: RAW, displayName: 'Claude Opus 5.7', doors: [DOOR] }] })
const choicesOf = (rows: ModelOption[]): ModelChoice[] =>
  rows.map(opt => ({
    id: opt.value,
    name: opt.label,
    tag: opt.description,
    ctx: '',
    group: opt.group ?? ANTHROPIC_MODEL_GROUP,
    ...(isProviderActionRow(opt.value) ? { action: true } : {}),
    ...(opt.unavailable !== undefined ? { gated: true, gatedReason: opt.unavailable } : {}),
  }))
const lines = (frame: string): string[] => frame.split('\n')
const rowLine = (frame: string, id: string): string | undefined => lines(frame).find(line => line.includes(id) && !line.includes('model IDs are real'))

section('§1 the session on the raw id: the typed road and the row road name the same id')
check('the setting parser passes the raw id through byte-identical', parseUserSpecifiedModel(RAW) === RAW, parseUserSpecifiedModel(RAW))
process.env.MERCURY_MODEL = RAW
check('MERCURY_MODEL on the raw id is the main-loop model', getMainLoopModel() === RAW, getMainLoopModel())
delete process.env.MERCURY_MODEL
const rows = options().filter(o => o.group === undefined)
const rawRow = rows.find(o => o.value === RAW)
check('the picker row for the raw id carries the raw id as its value (the mark keys on it)', rawRow !== undefined && rawRow.value === RAW && rawRow.label === RAW && renderModelName(RAW) === RAW)
check("the per-message effort row and the launch effort answer as the opus family's head", caps.servesPerMessageEffort(RAW) === caps.servesPerMessageEffort('claude-opus-5-5') && effort.getDefaultEffortForModel(RAW) === effort.getDefaultEffortForModel('claude-opus-5-5') && effort.isLaunchEffortPinned(RAW) === effort.isLaunchEffortPinned('claude-opus-5-5'))

section('§2 the mounted picker marks the raw row current, in its family block, at 120 and 178 columns')
for (const columns of [120, 178]) {
  const frame = await renderToString(React.createElement(MercuryModelPicker, { models: choicesOf(rows), current: RAW, ctxPct: null } as never), columns)
  const marked = lines(frame).filter(line => /\bcurrent\b/.test(line) && !line.includes('model IDs are real'))
  check(`[${columns}] exactly one row carries the current mark`, marked.length === 1, JSON.stringify(marked))
  check(`[${columns}] it is the raw row`, marked[0]?.includes(RAW) === true, marked[0])
  const idx = (id: string): number => lines(frame).findIndex(line => line === rowLine(frame, id))
  check(`[${columns}] the raw row paints below Opus 4.6, the end of the opus block, and above the haiku row`, idx('Opus 4.6') >= 0 && idx(RAW) > idx('Opus 4.6') && idx('Haiku 4.5') > idx(RAW), `${idx('Opus 4.6')} < ${idx(RAW)} < ${idx('Haiku 4.5')}`)
  check(`[${columns}] the raw row names the raw id in its id column beside no alias (the raw id is its own name)`, /—\s+claude-opus-5-7\s+current\s+new · no alias/.test(rowLine(frame, RAW) ?? ''), rowLine(frame, RAW))
  check(`[${columns}] the raw row is selectable (never painted unavail)`, !(rowLine(frame, RAW) ?? '').includes('unavail'))
}

section('§3 a static current row is marked exactly as before beside the raw row')
{
  const frame = await renderToString(React.createElement(MercuryModelPicker, { models: choicesOf(rows), current: 'claude-opus-4-6', ctxPct: null } as never), 120)
  const marked = lines(frame).filter(line => /\bcurrent\b/.test(line) && !line.includes('model IDs are real'))
  check('exactly one row is current and it is Opus 4.6', marked.length === 1 && marked[0]?.includes('Opus 4.6') === true, JSON.stringify(marked))
  check('the raw row is listed, unmarked', rowLine(frame, RAW) !== undefined && !(rowLine(frame, RAW) ?? '').includes('current'))
}

section('§4 the reason footer wraps a whole sentence, bounded, and stays one line for a short one')
{
  const reason = 'the claude.ai subscription serves this model only from client version 2.1.300 and Mercury presents 2.1.280 — set MERCURY_ANTHROPIC_CLIENT_CONTRACT to a served version or pick another row'
  const gated: ModelChoice[] = choicesOf(rows).map(m => (m.id === RAW ? { ...m, gated: true, gatedReason: reason } : m.id === 'claude-opus-4-6' ? { ...m, gated: true, gatedReason: 'no key' } : m))
  for (const columns of [120, 178]) {
    const frame = await renderToString(React.createElement(MercuryModelPicker, { models: gated, current: RAW, ctxPct: null } as never), columns)
    const body = lines(frame)
    const start = body.findIndex(line => line.includes(`${RAW} · the claude.ai subscription`))
    check(`[${columns}] the footer opens with the row's id and the sentence`, start >= 0, body.slice(-8).join('\n'))
    const tail = body.slice(start).join(' ').replace(/[│╰╯─]/g, ' ').replace(/\s+/g, ' ')
    check(`[${columns}] every word of the sentence is painted, none truncated`, reason.split(' ').every(word => tail.includes(word)) && tail.includes('not selectable') && !tail.includes('…'), tail)
    const footerLines = body.slice(start).filter(line => /[A-Za-z]/.test(line.replace(/[│╰╯─]/g, ''))).length
    check(`[${columns}] the sentence takes the lines it needs and no more (two to five, plus the keys line)`, footerLines >= 3 && footerLines <= 6, String(footerLines))
    const bottom = body.map(line => line.includes('╰')).lastIndexOf(true)
    check(`[${columns}] the panel closes below the footer inside the viewport (the bottom border paints last, within 24 rows)`, bottom > start && bottom === body.length - 1 && body.length <= 24, `bottom=${bottom} start=${start} lines=${body.length}`)
    check(`[${columns}] the current row keeps its current mark while the footer explains the refusal; the other refused row reads unavail`, (rowLine(frame, RAW) ?? '').includes('current') && (rowLine(frame, 'Opus 4.6') ?? '').includes('unavail'), `${rowLine(frame, RAW)} / ${rowLine(frame, 'Opus 4.6')}`)
  }
  const frame = await renderToString(React.createElement(MercuryModelPicker, { models: gated, current: 'claude-opus-4-6', ctxPct: null } as never), 120)
  check('a short reason stays on one footer line', lines(frame).filter(line => line.includes('claude-opus-4-6 · no key — not selectable')).length === 1, lines(frame).slice(-6).join('\n'))
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\nprove-picker-current-mark: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'pasted-unknown-win-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()

const { builtinCommands } = await import('../../src/commands/catalogue/commands.ts')
const { classifyCrewmateViewSubmission } = await import('../../src/screen/composer/promptIntent.ts')
const { INERT_PROMPT_HELPERS, readSubmitLine, refuseUnknownSlash } = await import(
  '../../src/screen/chat/submit/submitLine.ts'
)
type SubmitDeps = import('../../src/screen/chat/submit/submitLine.ts').SubmitDeps
const { normalizePastedLines } = await import('../../src/screen/composer/input-core/composer-document.ts')
const {
  INITIAL_STATE,
  __setBurstCrHostForTest,
  parseMultipleKeypresses,
} = await import('../../src/screen/renderer/input/input-decoder.ts')
const { expandPastedTextRefs, formatPastedTextRef } = await import('../../src/sessions/promptHistory.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const commands = [...builtinCommands()]
const receipts: Array<{ name: string; text: string }> = []
const deps: SubmitDeps = {
  addNotification: () => {},
  removeNotification: () => {},
  setAppState: () => {},
  setInputValue: () => {},
  setInputMode: () => {},
  setPastedContents: () => {},
  authWallHold: {} as never,
  repinToBottom: () => {},
  setToolJSX: () => {},
  getToolUseContext: (() => ({})) as never,
  paintScreenCommandReceipt: (name: string, _args: string, text: string) => {
    receipts.push({ name, text })
  },
  setSubmitCount: () => {},
  commandsRef: { current: commands },
  isLoadingRef: { current: false },
  dialogInFlightRef: { current: null },
  armedHandedBackRef: { current: null },
  queuedDialogCommandsRef: { current: [] },
  getFocusedSeatLive: (() => ({ phase: 'idle' })) as never,
  drainQueuedDialogCommand: () => {},
  onSubmitRef: { current: async () => {} },
}

function submitVerdict(
  text: string,
  pastedContents?: Record<number, { id: number; type: 'text'; content: string }>,
): { refused: boolean; receiptName: string | null; seatCommandName: string | null } {
  receipts.length = 0
  const line = readSubmitLine(
    deps,
    text,
    INERT_PROMPT_HELPERS,
    pastedContents === undefined ? undefined : { pastedContents },
    new Date(0).toISOString(),
    text.trim(),
  )
  const refused = refuseUnknownSlash(deps, line)
  return {
    refused,
    receiptName: receipts[0]?.name ?? null,
    seatCommandName: line.seatCommand?.name ?? null,
  }
}

console.log('— §1 promptIntent (classifyCrewmateViewSubmission) with Windows line ends —')
for (const [label, sample] of [
  ['trailing CR', '/nosuchcommand\r'],
  ['trailing CRLF', '/nosuchcommand\r\n'],
  ['CRLF multiline', '/nosuchcommand\r\nsecond line'],
  ['CR multiline', '/nosuchcommand\rsecond line'],
  ['LF multiline', '/nosuchcommand\nsecond line'],
  ['tab-separated arg', '/nosuchcommand\tfoo'],
] as const) {
  const verdict = classifyCrewmateViewSubmission(sample, false, commands)
  check(
    `promptIntent ${label} → unknown-command(nosuchcommand)`,
    verdict.kind === 'unknown-command' && verdict.bareName === 'nosuchcommand',
    JSON.stringify(verdict),
  )
}
{
  const known = classifyCrewmateViewSubmission('/help\r\n', false, commands)
  check('promptIntent known /help\\r\\n → session-command(help)', known.kind === 'session-command' && known.command.name === 'help', JSON.stringify(known))
  const knownMulti = classifyCrewmateViewSubmission('/help\r\nsecond line', false, commands)
  check('promptIntent known /help\\r\\nsecond line → session-command(help)', knownMulti.kind === 'session-command' && knownMulti.command.name === 'help', JSON.stringify(knownMulti))
}

console.log('— §2 main-chat submit (refuseUnknownSlash) with Windows paste forms —')
for (const [label, sample] of [
  ['trailing CR', '/nosuchcommand\r'],
  ['trailing CRLF', '/nosuchcommand\r\n'],
  ['CRLF multiline', '/nosuchcommand\r\nsecond line'],
  ['CR multiline', '/nosuchcommand\rsecond line'],
  ['LF multiline', '/nosuchcommand\nsecond line'],
  ['tab-separated arg', '/nosuchcommand\tfoo'],
] as const) {
  const res = submitVerdict(sample)
  check(
    `submit ${label} refused as nosuchcommand`,
    res.refused === true && res.receiptName === 'nosuchcommand',
    JSON.stringify(res),
  )
}
{
  const chip = formatPastedTextRef(1, 2)
  const stored = normalizePastedLines('/nosuchcommand\r\nsecond line\r\nthird line')
  const res = submitVerdict(chip, { 1: { id: 1, type: 'text', content: stored } })
  check(
    'pasted-text chip holding CRLF-normalized /nosuchcommand multiline is refused as nosuchcommand',
    res.refused === true && res.receiptName === 'nosuchcommand',
    JSON.stringify(res),
  )
  const expandedIntent = classifyCrewmateViewSubmission(
    expandPastedTextRefs(chip, { 1: { id: 1, type: 'text', content: stored } }),
    false,
    commands,
  )
  check(
    'crewmate view expanded chip classifies unknown-command(nosuchcommand)',
    expandedIntent.kind === 'unknown-command' && expandedIntent.bareName === 'nosuchcommand',
    JSON.stringify(expandedIntent),
  )
}

console.log('— §3 legacy Windows console unbracketed burst paste —')
{
  __setBurstCrHostForTest(true)
  try {
    const [events] = parseMultipleKeypresses(INITIAL_STATE, '/nosuchcommand\rsecond line')
    const decoded = events
      .filter(e => e.kind === 'key')
      .map(e => (e.kind === 'key' ? (e.sequence ?? '') : ''))
      .join('')
    const res = submitVerdict(decoded)
    check(
      'legacy Windows console burst /nosuchcommand\\rsecond line is refused as nosuchcommand',
      res.refused === true && res.receiptName === 'nosuchcommand',
      JSON.stringify({ decoded, res }),
    )
  } finally {
    __setBurstCrHostForTest(null)
  }
}

console.log('— §4 bounds: known command, slash file path, escaped //, plain multiline stay unchanged —')
{
  const knownPlain = submitVerdict('/help')
  check('known /help is not refused as unknown', knownPlain.refused === false && knownPlain.seatCommandName === 'help', JSON.stringify(knownPlain))
  const knownCrlf = submitVerdict('/help\r\n')
  check('known /help\\r\\n is not refused as unknown', knownCrlf.refused === false && knownCrlf.seatCommandName === 'help', JSON.stringify(knownCrlf))
  const knownMulti = submitVerdict('/help\r\nextra')
  check('known /help\\r\\nextra is not refused as unknown', knownMulti.refused === false && knownMulti.seatCommandName === 'help', JSON.stringify(knownMulti))
  const filePath = submitVerdict('/usr/local/bin')
  check('pasted path /usr/local/bin is not refused as a command', filePath.refused === false, JSON.stringify(filePath))
  const filePathMulti = submitVerdict('/usr/local/bin\r\nmore context')
  check('pasted multiline path /usr/local/bin\\r\\nmore is not refused as a command', filePathMulti.refused === false, JSON.stringify(filePathMulti))
  const escaped = submitVerdict('//nosuchcommand\r\nmore')
  check('escaped //nosuchcommand\\r\\nmore is not refused', escaped.refused === false, JSON.stringify(escaped))
  const plainMulti = submitVerdict('first line\r\nsecond line')
  check('plain multiline paste is not refused', plainMulti.refused === false, JSON.stringify(plainMulti))
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\nprove-pasted-unknown-command-windows-form: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)

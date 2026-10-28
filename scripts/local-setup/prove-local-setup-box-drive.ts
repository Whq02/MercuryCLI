#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import stringWidth from 'string-width'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

if (existsSync('/private/tmp/mw')) process.env.TMPDIR = '/private/tmp/mw'
const home = pinScratchHome('local-setup-box-drive')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const name of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|HF_|HUGGINGFACE_|TYPESAFE_)/.test(name)) delete process.env[name]
}
for (const name of ['MERCURY_HOME', 'MERCURY_SEATS', 'MERCURY_CRITTER', 'MERCURY_REDUCED_MOTION', 'MERCURY_LOCAL_BASE_URL']) delete process.env[name]

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok || !detail ? '' : ` — ${detail}`}`)
}

const COLS = 110
const ROWS = 32
const CURSOR = '›'
const STEP_ONE = '1 · Local models · Choose where to get the model'
const STEP_ONE_KEYS = '↑↓ choose · ↵ pick · s skip · esc keeps your model'
const STEP_ONE_FOOTER = `${STEP_ONE_KEYS} · pgup/pgdn page · click outside closes`
const STEP_TWO = '2 · Hugging Face · Repository id'
const STEP_TWO_KEYS = 'type repository id · ↵ list files · esc keeps your model'
const STEP_TWO_FOOTER = `${STEP_TWO_KEYS} · click outside closes`
const ENDED_FOOTER = 'esc closes · ↑↓ scroll · pgup/pgdn page · click outside closes'
const PLACEHOLDER = 'author/model-GGUF'
const EMPTY_BANK = 'No GGUF models in the Bank. Choose Hugging Face to pull one.'

const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const popup = await import('../../src/utils/cockpit/settingsPopup.ts')
const config = await import('../../src/utils/config.js')
config.enableConfigs()
const command = await import('../../src/commands/localsetup/localsetup.tsx')

const wrap = (element: unknown) => React.createElement(AppStateProvider as never, {}, React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: COLS, height: ROWS }, element as never)))
const bodyOf = (line: string): string => line.replace(/^\s*│\s?/, '').replace(/\s?│\s*$/, '').trimEnd()
const bodies = (m: Mounted): string[] => m.lines().map(bodyOf)
const has = (m: Mounted, text: string): boolean => bodies(m).some(line => line.trim() === text)
const sourceRows = (m: Mounted): string[] => bodies(m).filter(line => /^\s{4}[›\s] (Hugging Face|Bank|Ollama \/ running server)\s{2,}/.test(line)).map(line => line.trim())
const marked = (m: Mounted): string[] => sourceRows(m).filter(row => row.startsWith(`${CURSOR} `)).map(row => row.slice(2).split(/\s{2,}/)[0] ?? '')
const fits = (name: string, m: Mounted): void => check(`${name}: every row fits ${COLS}x${ROWS} with no render error`, m.lines().length <= ROWS && m.lines().every(line => stringWidth(line) <= COLS) && !m.screen().includes('RENDER ERROR'), `${m.lines().length} lines · widest ${Math.max(...m.lines().map(line => stringWidth(line)))}`)

async function open(): Promise<Mounted> {
  const m = await mountOffscreen(wrap(React.createElement(SettingsPopupSlot, { overlay: true })), COLS, ROWS)
  const result = await command.call('', {} as never)
  check('/localsetup opens the shared popup and returns skip', result.type === 'skip' && popup.settingsPopupRequest()?.view === 'localsetup')
  check('step 1 asks with its three sources', await waitFor(() => has(m, STEP_ONE) && sourceRows(m).length === 3, 4000), sourceRows(m).join(' | '))
  await settle(120)
  return m
}

try {
  console.log(`\n── s on step 1 skips to step 2; s on step 2 is text (${COLS}x${ROWS}, the real road, no network)`)
  const m = await open()
  fits('step 1', m)
  check('the step keys row names s skip beside the choice verbs', has(m, STEP_ONE_KEYS), bodies(m).filter(line => line.includes('choose')).join(' | '))
  check('the footer carries the step keys and only the frame verbs that fire on a choice step', has(m, STEP_ONE_FOOTER), bodies(m).filter(line => line.includes('click outside')).join(' | '))
  check('no footer verb that does not fire here is shown (↵ run, ↑↓ scroll, esc stop)', !m.screen().includes('↵ run') && !m.screen().includes('↑↓ scroll') && !m.screen().includes('esc stop'))
  m.push('s')
  check('s skips step 1 — the row reads skipped and step 2 asks for the repository id', await waitFor(() => has(m, '– skipped') && has(m, STEP_TWO) && has(m, STEP_TWO_KEYS), 4000), bodies(m).filter(line => line.trim() !== '').join(' | '))
  check('the line says step 2 of 6', has(m, 'step 2 of 6 · Hugging Face · nothing runs before ↵'), bodies(m)[1] ?? '')
  check('the footer on the text field carries the field keys and no s skip', has(m, STEP_TWO_FOOTER) && !m.screen().includes('s skip'), bodies(m).filter(line => line.includes('click outside')).join(' | '))
  check('the field shows its placeholder before a key', has(m, PLACEHOLDER))
  fits('step 2', m)
  m.push('s')
  await settle(150)
  check('s typed on step 2 lands in the field, the placeholder gone, the ask standing, nothing skipped', has(m, 's') && !has(m, PLACEHOLDER) && has(m, STEP_TWO_KEYS) && bodies(m).filter(line => line.trim() === '– skipped').length === 1, bodies(m).filter(line => line.trim() !== '').join(' | '))
  m.push(KEY.esc)
  check('esc stops: the summary lists step 1 as skipped and step 2 as not run', await waitFor(() => has(m, 'skipped: 1 Local models') && has(m, '– not run · stopped here'), 4000), bodies(m).filter(line => line.trim() !== '').join(' | '))
  check('the footer after the end says esc closes', has(m, ENDED_FOOTER), bodies(m).filter(line => line.includes('click outside')).join(' | '))
  fits('summary', m)
  m.push(KEY.esc)
  check('a second esc closes the popup', await waitFor(() => popup.settingsPopupRequest() === null, 4000))
  m.unmount()

  console.log(`\n── the source list: no marker before a key, ↓ lands on row 1, ↓ again on Bank, ↵ picks Bank (${COLS}x${ROWS})`)
  const n = await open()
  check('no source row carries the marker before a key, and the line says so', marked(n).length === 0 && has(n, 'step 1 of 6 · Local models · ↑↓ then ↵ · nothing is pre-chosen'), sourceRows(n).join(' | '))
  n.push(KEY.down)
  check('one ↓ puts the marker on row 1, Hugging Face, and nowhere else', await waitFor(() => marked(n).join(',') === 'Hugging Face', 4000), sourceRows(n).join(' | '))
  n.push(KEY.down)
  check('a second ↓ moves it to row 2, Bank, and off Hugging Face', await waitFor(() => marked(n).join(',') === 'Bank', 4000), sourceRows(n).join(' | '))
  n.push(KEY.enter)
  check('↵ picks Bank — the step 1 row reads ✓ Bank and the Bank road answers (this scratch home has no Bank model)', await waitFor(() => has(n, '✓ Bank') && n.screen().includes(EMPTY_BANK), 4000), bodies(n).filter(line => line.trim() !== '').join(' | '))
  check('the summary lists step 1 as done', has(n, 'done: 1 Local models'))
  fits('bank pick', n)
  n.push(KEY.esc)
  check('esc closes the ended dialog', await waitFor(() => popup.settingsPopupRequest() === null, 4000))
  n.unmount()
} finally {
  popup.closeSettingsPopup()
  await releaseScratchHome(home)
}
console.log(`prove-local-setup-box-drive: ${failures ? `${failures} FAILED` : 'ALL PASS'}`)
process.exit(failures ? 1 : 0)

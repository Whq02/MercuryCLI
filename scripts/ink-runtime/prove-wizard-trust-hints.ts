import React from 'react'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, waitFor } from '../lib/settingsPopupHarness.js'
import type { Root } from '../../src/ink/root.js'

pinSourceRef()
const home = pinScratchHome('wizard-trust-hints')
const cwd = process.cwd()
mkdirSync(join(home, 'workspace'))
process.chdir(join(home, 'workspace'))
delete process.env.NODE_ENV
const DEAD = 'http://127.0.0.1:9'
Object.assign(process.env, {
  MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_REDUCED_MOTION: '1', MERCURY_FULLSCREEN: '0', TERM: 'xterm-256color', BROWSER: 'true',
  ANTHROPIC_BASE_URL: DEAD, MERCURY_OPENAI_API_BASE: DEAD, MERCURY_OPENAI_CHATGPT_BASE: DEAD,
  MERCURY_OPENAI_AUTH_BASE: DEAD, MERCURY_OPENROUTER_API_BASE: DEAD, MERCURY_OPENROUTER_AUTH_BASE: DEAD,
  MERCURY_GEMINI_API_BASE: DEAD, MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD, MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
  MERCURY_HUGGINGFACE_API_BASE: `${DEAD}/v1`, MERCURY_HUGGINGFACE_HUB_BASE: DEAD,
  MERCURY_MOONSHOT_API_BASE: `${DEAD}/v1`, MERCURY_MOONSHOT_OAUTH_BASE: DEAD,
  MERCURY_MOONSHOT_CODING_BASE: `${DEAD}/v1`, MERCURY_ZAI_API_BASE: `${DEAD}/v4`, MERCURY_DEEPSEEK_API_BASE: DEAD,
})
for (const key of Object.keys(process.env)) {
  if (/^(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|MERCURY_OAUTH_TOKEN|MERCURY_API_KEY_FILE_DESCRIPTOR|OPENAI_API_KEY|ZAI_API_KEY|OPENROUTER_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|MOONSHOT_API_KEY|DEEPSEEK_API_KEY|HF_TOKEN|XAI_API_KEY|MODEL_API_KEY|MERCURY_COMPAT_BASE_URL|MERCURY_LOCAL_BASE_URL|TERM_PROGRAM|TERM_PROGRAM_VERSION|WT_SESSION|CURSOR_TRACE_ID|VSCODE_GIT_ASKPASS_MAIN|__CFBundleIdentifier|VisualStudioVersion|TERMINAL_EMULATOR|TMUX)$/.test(key)) delete process.env[key]
}
const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { showSetupScreens } = await import('../../src/interactiveHelpers.js')
const { Text } = await import('../../src/ink.js')
const mounted = await mountOffscreen(React.createElement(Text, null, ' '), 80, 24)
const root: Root = {
  render: element => mounted.resize(element, 80, 24),
  unmount: mounted.unmount,
  waitUntilExit: async () => {},
}
let fault: unknown
void showSetupScreens(root, 'default', false, []).catch(error => { fault = error })
let checks = 0
let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
async function sees(text: string): Promise<void> {
  const painted = await waitFor(() => fault !== undefined || mounted.screen().includes(text), 20_000)
  if (fault !== undefined) throw fault
  if (!painted) throw new Error(`${text} did not paint\n${mounted.screen()}`)
}

try {
  await sees('theme · 1/4')
  check('theme has one footer', mounted.lines().filter(line => line.includes('↑↓')).length === 1)
  mounted.push(KEY.enter)
  await sees('sign in · 2/4')
  check('sign in has one navigation footer', mounted.lines().filter(line => line.includes('↑↓')).length === 1)
  mounted.push('s')
  await sees('guardrails · 3/4')
  check('guardrails has one footer', mounted.lines().filter(line => line.includes('↵ continue · esc back')).length === 1)
  mounted.push(KEY.enter)
  await sees('trust · 4/4')
  await sees('esc exit')
  const frame = mounted.screen()
  console.log(`FRAME 80x24\n${frame}`)
  const hints = mounted.lines().filter(line => line.includes('↑↓ move'))
  check('trust keeps the frame navigation hint exactly once', hints.length === 1 && hints[0]?.includes('↑↓ move · ↵ select · esc exit') === true, JSON.stringify(hints))
  check('the duplicate card hint is gone', !frame.includes('confirm') && !frame.includes('esc exits'))
  check('the trust choices remain visible at 80x24', frame.includes('Yes, I trust this folder') && frame.includes('No, exit'))
  mounted.push('\x03')
  await sees('press ctrl+c twice to close Mercury')
  check('the first exit chord still paints its confirmation', mounted.screen().includes('press ctrl+c twice to close Mercury'))
} finally {
  mounted.unmount()
  if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty)
  else Reflect.deleteProperty(process.stdout, 'isTTY')
  process.chdir(cwd)
  rmSync(home, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} wizard trust hints: ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)

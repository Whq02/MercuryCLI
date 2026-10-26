import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import stripAnsi from 'strip-ansi'
import { pinScratchHome, pinSourceRef, waitFor } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const proposed = 'Setup stopped. Run mercury again to finish.'
const childAt = process.argv.indexOf('--child')
if (childAt >= 0) {
  const key = process.argv[childAt + 1]!
  const home = process.env.MERCURY_CONFIG_DIR!
  process.chdir(home)
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  delete process.env.NODE_ENV
  const DEAD = 'http://127.0.0.1:9'
  Object.assign(process.env, {
    MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_REDUCED_MOTION: '1', MERCURY_FULLSCREEN: '1', TERM: 'xterm-256color', BROWSER: 'true',
    ANTHROPIC_BASE_URL: DEAD, MERCURY_OPENAI_API_BASE: DEAD, MERCURY_OPENAI_CHATGPT_BASE: DEAD,
    MERCURY_OPENAI_AUTH_BASE: DEAD, MERCURY_OPENROUTER_API_BASE: DEAD, MERCURY_OPENROUTER_AUTH_BASE: DEAD,
    MERCURY_GEMINI_API_BASE: DEAD, MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD, MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
    MERCURY_HUGGINGFACE_API_BASE: `${DEAD}/v1`, MERCURY_HUGGINGFACE_HUB_BASE: DEAD,
    MERCURY_MOONSHOT_API_BASE: `${DEAD}/v1`, MERCURY_MOONSHOT_OAUTH_BASE: DEAD,
    MERCURY_MOONSHOT_CODING_BASE: `${DEAD}/v1`, MERCURY_ZAI_API_BASE: `${DEAD}/v4`, MERCURY_DEEPSEEK_API_BASE: DEAD,
  })
  for (const name of Object.keys(process.env)) {
    if (/^(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|MERCURY_OAUTH_TOKEN|MERCURY_API_KEY_FILE_DESCRIPTOR|OPENAI_API_KEY|ZAI_API_KEY|OPENROUTER_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|MOONSHOT_API_KEY|DEEPSEEK_API_KEY|HF_TOKEN|XAI_API_KEY|MODEL_API_KEY|MERCURY_COMPAT_BASE_URL|MERCURY_LOCAL_BASE_URL|TERM_PROGRAM|TERM_PROGRAM_VERSION|WT_SESSION|CURSOR_TRACE_ID|VSCODE_GIT_ASKPASS_MAIN|__CFBundleIdentifier|VisualStudioVersion|TERMINAL_EMULATOR|TMUX)$/.test(name)) delete process.env[name]
  }
  Object.defineProperties(process.stdout, {
    isTTY: { configurable: true, value: true },
    columns: { configurable: true, value: 80 },
    rows: { configurable: true, value: 24 },
  })
  class Input extends EventEmitter {
    isTTY = true
    isRaw = false
    private chunks: string[] = []
    setEncoding(): this { return this }
    setRawMode(value: boolean): this { this.isRaw = value; return this }
    ref(): this { return this }
    unref(): this { return this }
    pause(): this { return this }
    resume(): this { return this }
    read(): string | null { return this.chunks.shift() ?? null }
    get readableLength(): number { return this.chunks.reduce((n, value) => n + value.length, 0) }
    push(value: string): void { this.chunks.push(value); this.emit('readable') }
  }
  const { enableConfigs } = await import('../../src/utils/config.js')
  enableConfigs()
  const { createRoot } = await import('../../src/ink/root.js')
  const { default: instances } = await import('../../src/ink/instances.js')
  const { showSetupScreens } = await import('../../src/interactiveHelpers.js')
  const input = new Input()
  const root = await createRoot({ stdin: input as never, stdout: process.stdout, stderr: process.stderr, exitOnCtrlC: false, patchConsole: false })
  let fault: unknown
  void showSetupScreens(root, 'default', false, []).catch(error => { fault = error })
  const frame = (): string => stripAnsi(instances.get(process.stdout)?.lastFrameText() ?? '')
  async function sees(text: string): Promise<void> {
    if (!await waitFor(() => fault !== undefined || frame().includes(text), 20_000)) throw new Error(`${text} did not paint`)
    if (fault !== undefined) throw fault
  }
  await sees('theme · 1/4')
  input.push('\r')
  await sees('sign in · 2/4')
  input.push('s')
  await sees('guardrails · 3/4')
  input.push('\r')
  await sees('trust · 4/4')
  await sees('No, exit')
  writeFileSync(join(home, 'trust-frame.txt'), frame())
  if (key === 'no') {
    input.push('\x1b[B')
    await sees('❯ 2. No, exit')
    input.push('\r')
  } else if (key === 'ctrl-c' || key === 'ctrl-d') {
    const chord = key === 'ctrl-c' ? '\x03' : '\x04'
    input.push(chord)
    await sees('twice to close Mercury')
    input.push(chord)
  } else {
    input.push(key === 'esc' ? '\x1b' : 'n')
  }
} else {
  const home = pinScratchHome('wizard-trust-exit')
  const sourceAt = process.argv.indexOf('--source-ref')
  const sourceArgs = sourceAt < 0 ? [] : process.argv.slice(sourceAt, sourceAt + 2)
  let checks = 0
  let failures = 0
  function check(label: string, good: boolean, detail = ''): void {
    checks++
    if (!good) failures++
    console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
  }
  try {
    for (const key of ['esc', 'no', 'n', 'ctrl-c', 'ctrl-d']) {
      const configHome = join(home, key)
      mkdirSync(configHome)
      const wire = join(home, `${key}.ansi`)
      const fd = openSync(wire, 'w')
      const child = spawnSync(process.execPath, ['run', fileURLToPath(import.meta.url), '--child', key, ...sourceArgs], {
        env: { ...process.env, MERCURY_CONFIG_DIR: configHome, MERCURY_TMPDIR: configHome, MERCURY_DAEMON_DIR: join(configHome, 'daemon') },
        stdio: ['ignore', fd, fd], timeout: 60_000,
      })
      closeSync(fd)
      const bytes = readFileSync(wire, 'utf8')
      const exitAlt = bytes.lastIndexOf('\x1b[?1049l')
      check(`${key}: the real wizard reached trust at 80x24`, existsSync(join(configHome, 'trust-frame.txt')), bytes.slice(-400))
      check(`${key}: declining trust still exits 1`, child.status === 1 && child.error === undefined, `${child.status} ${child.error ?? ''}`)
      check(`${key}: the proposed line lands once after leaving the alternate screen`, exitAlt >= 0 && bytes.indexOf(proposed) > exitAlt && bytes.split(proposed).length === 2, stripAnsi(bytes.slice(-250)))
      const config = JSON.parse(readFileSync(join(configHome, '.mercury.json'), 'utf8')) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }
      check(`${key}: declining trust saves no project grant`, Object.values(config.projects ?? {}).every(project => !project.hasTrustDialogAccepted))
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  console.log(`${failures ? 'FAIL' : 'PASS'} wizard trust exit: ${checks - failures}/${checks}`)
  process.exit(failures ? 1 : 0)
}

#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const originalCwd = process.cwd()
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'card-question-')))
const projectDir = join(sandbox, 'proj')
const configDir = join(sandbox, 'home')
mkdirSync(projectDir, { recursive: true })
mkdirSync(configDir, { recursive: true })

process.env.MERCURY_CONFIG_DIR = configDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.chdir(projectDir)

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { setCwdState, setOriginalCwd, setProjectRoot } = await import('../../src/boot/process-state/processState.ts')
setOriginalCwd(projectDir)
setProjectRoot(projectDir)
setCwdState(projectDir)

const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { BashPermissionRequest } = await import('../../src/permissions/cards/bash/ShellPermissionRequest.tsx')
const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { uncPathMessage } = await import('../../src/permissions/rules/uncPath.ts')
const { mountOffscreen, waitFor } = await import('../lib/settingsPopupHarness.ts')

let failures = 0
const HINT =
  'the Bash card is ShellPermissionRequest in src/permissions/cards/bash/ShellPermissionRequest.tsx: reasonCutToFit gives the reason the rows the window has left once the preview, the lines round it, the question and the choices are counted, and one more-lines row stands where it cut, between the first rows of the reason and its last'

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail ? `${detail} — ` : ''}${HINT}`}`)
  if (!ok) failures++
}

const framesAt = process.argv.indexOf('--frames')
const framesDir = framesAt === -1 ? undefined : process.argv[framesAt + 1]
if (framesDir !== undefined) mkdirSync(framesDir, { recursive: true })

const QUESTION = 'Do you want to proceed?'
const LAST_CHOICE = 'No, and tell Mercury what to do differently (esc)'
const FOOT = 'esc cancel'
const ROWS_THE_SCREEN_KEEPS_UNDER_THE_CARD = 1
const state = () => ({ toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' }, tasks: {}, sessionHooks: new Map() })
const toolUseContext = { abortController: new AbortController(), getAppState: state, setAppState() {}, options: { tools: [BashTool] }, messages: [] } as never
const assistant = { message: { id: 'card-question' } } as never

async function cardRows(name: string, command: string, reason: string, columns: number, rows: number): Promise<string[]> {
  const base = getDefaultAppState()
  const initialState = { ...base, toolPermissionContext: { ...base.toolPermissionContext, mode: 'default' } }
  const card = React.createElement(BashPermissionRequest as never, {
    toolUseConfirm: {
      tool: BashTool,
      input: { command },
      toolUseID: `card-${name}-${columns}-${rows}`,
      description: 'Run a shell command',
      cwd: projectDir,
      assistantMessage: assistant,
      permissionResult: { behavior: 'ask', message: reason, decisionReason: { type: 'safetyCheck', reason, operatorOnly: true } },
      permissionPromptStartTimeMs: Date.now(),
      onUserInteraction() {},
      onAllow() {},
      onReject() {},
      onAbort() {},
      recheckPermission: async () => {},
      toolUseContext,
    },
    toolUseContext,
    onDone() {},
    onReject() {},
    verbose: false,
  } as never)
  const scene = await mountOffscreen(
    React.createElement(ThemeProvider as never, null, React.createElement(AppStateProvider as never, { initialState } as never, React.createElement(KeybindingSetup as never, null, card))),
    columns,
    rows,
  )
  try {
    await waitFor(() => scene.screen().includes('Bash command'), 5000)
    await waitFor(() => scene.screen().includes(FOOT), 1500)
    const lines = scene.lines()
    if (framesDir !== undefined) writeFileSync(join(framesDir, `${name}-${columns}x${rows}.txt`), `${lines.join('\n').replaceAll(sandbox, '<scratch>')}\n`)
    return lines.map(line => line.replace(/^[│\s]+|[│\s]+$/g, ''))
  } finally {
    scene.unmount()
  }
}

const tall = [
  "python - <<'EOF'",
  String.raw`src = r'\\files.corp\share\wordstats.py'`,
  "s = open(src, encoding='utf-8').read()",
  ...Array.from({ length: 14 }, (_, n) => `s = s.replace('word${n}', 'term${n}')`),
  "open('wordstats.py', 'w', encoding='utf-8').write(s)",
  'EOF',
  'python wordstats.py sample.txt',
].join('\n')
const short = String.raw`type \\files.corp\share\notes.txt`
const box = String.raw`python - <<'EOF'
p='wordstats.py'
s=open(p,encoding='utf-8').read()
s=s.replace('''WORD_RE = re.compile(r"[^\\W_]+(?:'[^\\W_]+)*|'+", re.UNICODE)
WORD_RE = re.compile(r"[\\w']+", re.UNICODE)
''','''WORD_RE = re.compile(r"(?:[^\\W_]|')+")
''')
s=s.replace('''if w.strip("'_")]''','''if w.strip("'")]''')
open(p,'w',encoding='utf-8').write(s)
EOF
grep -n "WORD_RE\|strip" wordstats.py
cat > sample.txt <<'EOF'
The quick brown fox jumps over the lazy dog.
The dog barks; the fox runs away. Don't worry, the dog is fine!

A fox is quick, and a dog is lazy -- or so the story goes.
Numbers like 42 and 42 appear twice, and the end is near
EOF
python wordstats.py sample.txt`
const risk = { risky: true, host: 'files.corp', form: 'unc' } as const

try {
  const cases = [
    ['tall', 'a twenty-line command that names a share', tall, uncPathMessage(tall, risk)],
    ['box', 'the nineteen-line command of the Windows box under the reason it met', box, uncPathMessage(box, { risky: true, host: "W_]+(?:[^", form: 'unc' })],
  ] as const
  for (const [name, title, command, reason] of cases) {
    for (const [columns, rows] of [[120, 30], [120, 44], [80, 24]] as const) {
      const at = `${columns}x${rows}`
      const drawn = await cardRows(name, command, reason, columns, rows)
      const foot = drawn.findIndex(row => row.startsWith(FOOT))
      const question = drawn.indexOf(QUESTION)
      check(`${at}: ${title} draws its question`, question > 0, JSON.stringify(drawn.slice(-6)))
      check(`${at}: ${name}: and every choice down to the last`, drawn.some(row => row.includes('1. Yes')) && drawn.some(row => row.includes(LAST_CHOICE)), JSON.stringify(drawn.slice(-6)))
      check(`${at}: ${name}: and its foot, with the row the screen keeps under a card to spare`, foot !== -1 && foot + 1 <= rows - ROWS_THE_SCREEN_KEEPS_UNDER_THE_CARD, `the foot is row ${foot + 1} of ${rows}`)
      check(`${at}: ${name}: one row of the cut reason counts what it left out`, drawn.filter(row => /^… \+\d+ more lines$/.test(row)).length === 1, JSON.stringify(drawn.filter(row => row.includes('more line'))))
      check(`${at}: ${name}: the cut reason keeps its last words, right above the question`, question > 0 && (drawn[question - 1] ?? '').endsWith('without explicit permission.'), JSON.stringify(drawn[question - 1]))
      check(`${at}: ${name}: the reason still opens with the command it is about`, drawn.filter(row => row === "python - <<'EOF'").length === 2, JSON.stringify(drawn.slice(0, 16)))
    }
    const whole = await cardRows(name, command, reason, 120, 60)
    const question = whole.indexOf(QUESTION)
    check(`120x60: ${name}: a window that holds the whole reason draws it whole, and no row counts a cut`, question > 0 && (whole[question - 1] ?? '').endsWith('without explicit permission.') && !whole.some(row => /more lines?$/.test(row)), JSON.stringify(whole.slice(Math.max(0, question - 3), question + 1)))
  }
  for (const [columns, rows] of [[120, 30], [80, 24]] as const) {
    const at = `${columns}x${rows}`
    const reason = uncPathMessage(short, risk)
    const drawn = await cardRows('short', short, reason, columns, rows)
    const question = drawn.indexOf(QUESTION)
    check(`${at}: a reason the window holds is drawn whole, down to its last words`, question > 0 && (drawn[question - 1] ?? '').endsWith('without explicit permission.') && !drawn.some(row => /more lines?$/.test(row)), JSON.stringify(drawn.slice(0, question + 1)))
  }
} finally {
  process.chdir(originalCwd)
  rmSync(sandbox, { recursive: true, force: true })
}

console.log(failures ? `card question stays on screen: ${failures} FAILED` : 'card question stays on screen: ALL PASS')
process.exit(failures ? 1 : 0)

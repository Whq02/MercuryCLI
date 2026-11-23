#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configHome = mkdtempSync(join(tmpdir(), 'ide-terminal-description-config-'))
process.env.MERCURY_CONFIG_DIR = configHome

const bridge = await import('../../src/integrations/acp/ideToolBridge.ts')
const { getSimplePrompt } = await import('../../src/tools/shell/prompt.ts')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

const doorWith = (caps: { readTextFile: boolean; writeTextFile: boolean; terminal: boolean }) => ({
  capabilities: () => caps,
  readTextFile: async () => ({ content: '' }),
  writeTextFile: async () => ({}),
  terminalCreate: async () => ({ terminal_id: 'none' }),
  terminalOutput: async () => ({ output: '', truncated: false }),
  terminalWaitForExit: async () => ({}),
  terminalKill: async () => ({}),
  terminalRelease: async () => ({}),
})

const PROMPT_HINT = 'fix getSimplePrompt in src/tools/shell/prompt.ts (the Editor terminal paragraph appears only when ideTerminalAvailable in src/integrations/acp/ideToolBridge.ts says the editor offers a terminal)'
const PARAGRAPH = /\n\nEditor terminal: [^\n]*/

try {
  section('§1 the Bash description says what the editor terminal road does, and only for a session that has it')
  for (const [label, offered] of [
    ['every tool offered', null],
    ['a narrow roster', new Set(['Read', 'TaskStop'])],
  ] as const) {
    bridge.registerIdeToolDoor(null)
    const plain = getSimplePrompt(offered)
    bridge.registerIdeToolDoor(doorWith({ readTextFile: true, writeTextFile: true, terminal: false }))
    const filesOnly = getSimplePrompt(offered)
    bridge.registerIdeToolDoor(doorWith({ readTextFile: false, writeTextFile: false, terminal: true }))
    const withTerminal = getSimplePrompt(offered)
    bridge.registerIdeToolDoor(null)

    check(`${label}: with no editor the description has no editor terminal paragraph`, !plain.includes('Editor terminal:'), `${PROMPT_HINT}; the plain description carries the paragraph`)
    check(`${label}: an editor that offers files but no terminal leaves the description byte for byte as it was`, filesOnly === plain, `${PROMPT_HINT}; a files-only editor changed the description`)
    check(
      `${label}: an editor that offers a terminal adds one paragraph`,
      PARAGRAPH.test(withTerminal) && withTerminal.split('Editor terminal:').length === 2,
      `${PROMPT_HINT}; ${withTerminal.slice(-400)}`,
    )
    const paragraph = PARAGRAPH.exec(withTerminal)?.[0] ?? ''
    check(`${label}: taking that paragraph out gives the plain description back byte for byte`, withTerminal.replace(PARAGRAPH, '') === plain, `${PROMPT_HINT}; the terminal editor changed more than the one paragraph`)
    check(
      `${label}: the paragraph says the folder and the shell variables do not carry to the next call and shows the same-call form`,
      /working directory and shell variables do not carry to the next call/.test(paragraph) && paragraph.includes('`cd dir && …`'),
      `${PROMPT_HINT}; paragraph: ${paragraph}`,
    )
    check(
      `${label}: the paragraph names the two commands that still run in the local shell`,
      paragraph.includes('`run_in_background`') && paragraph.includes("crewmate's command") && !/sandbox/.test(paragraph),
      `${PROMPT_HINT}; paragraph: ${paragraph}`,
    )
  }
} finally {
  bridge.registerIdeToolDoor(null)
  rmSync(configHome, { recursive: true, force: true })
}

console.log('')
if (failures > 0) {
  console.error(`❌ prove-ide-terminal-description: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ prove-ide-terminal-description: all checks pass')

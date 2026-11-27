#!/usr/bin/env bun
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const proofHome = realpathSync(mkdtempSync(join(tmpdir(), 'local-output-home-')))
process.env.MERCURY_CONFIG_DIR = proofHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}${ok ? '' : ' — to fix: the row component in src/screen/messages/UserLocalCommandOutputMessage.tsx (stream parsing, cloud-launch lead, no-content line); the fold line comes from earlierReleasesLine in src/boot/releaseNotes.ts'}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

const { UserLocalCommandOutputMessage } = await import('../../src/screen/messages/UserLocalCommandOutputMessage.js')
const { AssistantTextMessage } = await import('../../src/screen/messages/AssistantTextMessage.js')
const { Markdown } = await import('../../src/screen/messages/Markdown.js')
const { MessageResponse } = await import('../../src/tools/kit/MessageResponse.js')
const { planBrowserInstall } = await import('../../src/integrations/browser/browserInstall.js')
const { runSwarmchatCommand } = await import('../../src/commands/swarmchat/swarmchat.js')
const { CHANNEL_USAGE } = await import('../../src/crew/crewmates/channelCommand.js')
const { earlierReleasesLine } = await import('../../src/boot/releaseNotes.js')
const { ctrlOToExpandHint } = await import('../../src/screen/messages/ctrlOToExpandHint.js')
const { AppStoreContext } = await import('../../src/screen/app-state/AppState.js')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.js')
const { createStore } = await import('../../src/platform/primitives/store.js')
const { TerminalSizeContext } = await import('../../src/screen/renderer/elements/TerminalSizeContext.js')
const { default: StdinContext } = await import('../../src/screen/renderer/elements/StdinContext.js')
const { Box, EventEmitter, render, flushPendingSyncWork } = await import('../../src/screen/themedRenderer.js')

const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
const paintElement = async (element: React.ReactNode, width = 120): Promise<{ raw: string; lines: string[] }> => {
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns: width, rows: 45 }) as unknown as NodeJS.WriteStream
  const store = createStore(getDefaultAppState())
  const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const tree = React.createElement(
    StdinContext.Provider,
    { value: stdinValue as never },
    React.createElement(
      TerminalSizeContext.Provider,
      { value: { columns: width, rows: 45 } },
      React.createElement(AppStoreContext.Provider, { value: store as never }, React.createElement(Box, { flexDirection: 'column', width }, element)),
    ),
  )
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await render(tree, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  let frame = instance.lastFrame()
  for (let waited = 0; waited < 3000; waited += 25) {
    await settle()
    const next = instance.lastFrame()
    if (next === frame && stripAnsi(next).trim() !== '') break
    frame = next
  }
  const lines = stripAnsi(frame).replace(/\s+$/, '').split('\n').map(line => line.trimEnd()).filter(line => line !== '')
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  return { raw: frame, lines }
}
const paint = async (content: string, verbose = false, width = 100): Promise<string[]> =>
  (await paintElement(React.createElement(UserLocalCommandOutputMessage, { content, verbose }), width)).lines
const out = (text: string): string => `<local-command-stdout>${text}</local-command-stdout>`
const err = (text: string): string => `<local-command-stderr>${text}</local-command-stderr>`
const has = (lines: string[], text: string): boolean => lines.some(line => line.includes(text))
const rowOf = (lines: string[], text: string): number => lines.findIndex(line => line.includes(text))

section('§1 THE STREAMS — stdout then stderr, each trimmed; nothing paints (no content)')
{
  const both = await paint(out('  all good  ') + err('  but noisy  '))
  check('stdout paints before stderr, trimmed', rowOf(both, 'all good') >= 0 && rowOf(both, 'but noisy') > rowOf(both, 'all good') && !has(both, '  all good'), j(both))
  const only = await paint(err('only errors'))
  check('a lone stderr paints alone', has(only, 'only errors') && only.length === 1, j(only))
  const empty = await paint(out('   ') + err(''))
  check('whitespace-only streams paint (no content)', empty.length === 1 && has(empty, '(no content)'), j(empty))
  const none = await paint('plain text with no tags')
  check('no tags at all paint (no content)', has(none, '(no content)'), j(none))
}

section('§2 A CLOUD-LAUNCH NOTICE — the diamond lead, the bold label, the dim remainder, the rest beneath')
{
  const notice = await paint(out('◇ Launched · 3 agents\nfollow along in the board'))
  check('the header keeps the label and the remainder on one line', has(notice, 'Launched · 3 agents'), j(notice))
  check('the rest paints beneath', rowOf(notice, 'follow along in the board') > rowOf(notice, 'Launched'), j(notice))
  const bare = await paint(out('◆ Done'))
  check('a one-line notice paints the header alone', bare.length === 1 && has(bare, 'Done'), j(bare))
  const notANotice = await paint(out('◇Launched without the space'))
  check('a diamond without the space is ordinary markdown', has(notANotice, '◇Launched without the space'), j(notANotice))
}

section('§3 THE EARLIER-RELEASES FOLD — hidden behind the transcript key unless verbose')
{
  const foldLine = earlierReleasesLine(3)
  const text = `## 1.0.0-beta.31\n\n- a fix\n\n${foldLine}\n\n## 1.0.0-beta.30\n\n- older`
  const folded = await paint(out(text))
  check('the fold line paints with the key hint and nothing after it', has(folded, `${foldLine} ${ctrlOToExpandHint()}`) && !has(folded, 'older'), j(folded))
  check('the lines before the fold paint', has(folded, 'a fix'), j(folded))
  const expanded = await paint(out(text), true)
  check('verbose drops the fold line and shows the earlier release', !has(expanded, foldLine) && has(expanded, 'older'), j(expanded))
  const plain = await paint(out('just\n\n\n\nlines'))
  check('text without a fold line is markdown as is', has(plain, 'just') && has(plain, 'lines') && !has(plain, 'expand'), j(plain))
}

try {
  section('§4 BACKSLASHES IN COMMAND ANSWERS — paths, UNC, trailing backslash, all 32 punctuation chars')
  {
    const winPath = 'C:\\a\\.b\\_c\\(d)\\e.txt'
    const stdoutLines = await paint(out(winPath))
    check('stdout preserves every backslash in a Windows path', has(stdoutLines, winPath), j(stdoutLines))
    const stderrLines = await paint(err(winPath))
    check('stderr preserves every backslash in a Windows path', has(stderrLines, winPath), j(stderrLines))

    const unc = '\\\\server\\share\\_x\\(y)\\.mercury'
    const uncLines = await paint(out(unc))
    check('UNC head and punctuation segments keep every backslash', has(uncLines, unc), j(uncLines))

    const trailingOne = await paint(out('line1\\\nline2'))
    check('a line ending on a single backslash keeps both the backslash and the break', trailingOne.some(line => line.endsWith('line1\\')) && has(trailingOne, 'line2'), j(trailingOne))
    const trailingTwo = await paint(out('line1\\\\\nline2'))
    check('a line ending on two backslashes keeps both backslashes', trailingTwo.some(line => line.endsWith('line1\\\\')) && has(trailingTwo, 'line2'), j(trailingTwo))
    const twoSpaceBreak = await paint(out('line1  \nline2'))
    check('a two-space hard break still breaks with no backslash added', twoSpaceBreak.some(line => line.endsWith('line1')) && !has(twoSpaceBreak, '\\') && has(twoSpaceBreak, 'line2'), j(twoSpaceBreak))

    const asciiPunct = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'
    const punctBody = [...asciiPunct].map((ch, idx) => `P${String(idx).padStart(2, '0')}=a\\${ch}b`).join('\n')
    const punctLines = await paint(out(punctBody), false, 120)
    const missingKept: string[] = []
    const wrongAngles: string[] = []
    for (let idx = 0; idx < asciiPunct.length; idx++) {
      const ch = asciiPunct[idx]!
      const tag = `P${String(idx).padStart(2, '0')}=`
      if (ch === '<' || ch === '>') {
        if (!has(punctLines, `${tag}a${ch}b`) || has(punctLines, `${tag}a\\${ch}b`)) wrongAngles.push(ch)
      } else {
        if (!has(punctLines, `${tag}a\\${ch}b`)) missingKept.push(ch)
      }
    }
    check('30 of 32 ASCII punctuation characters after a backslash keep the backslash', missingKept.length === 0, j({ missingKept, punctLines }))
    check('the 2 angle-bracket escapes (\\< and \\>) stay as today for usage placeholders', wrongAngles.length === 0, j({ wrongAngles, punctLines }))

    const tableLines = await paint(out('| Key | Value |\n| --- | --- |\n| home | C:\\a\\.b\\_c |'), false, 120)
    check('a Markdown table cell in a command answer keeps every backslash', has(tableLines, 'C:\\a\\.b\\_c'), j(tableLines))
  }

  section('§5 /BROWSER THREE ANSWERS UNDER A WIN32 HOME STAND-IN — C:\\src\\pu5\\.mercury')
  {
    const winCache = join(proofHome, 'C:\\src\\pu5\\.mercury\\browsers')
    mkdirSync(winCache, { recursive: true })
    const savedCache = process.env.MERCURY_BROWSER_CACHE_DIR
    process.env.MERCURY_BROWSER_CACHE_DIR = winCache
    try {
      const plan = await planBrowserInstall('158.0.8127.88')
      const planText = `install plan (nothing downloaded yet):\n  ${plan.consentLine}\nconfirm with: /browser install confirm  (or: /browser install ${plan.buildId} confirm)`
      const planLines = await paint(out(planText), false, 160)
      check('/browser install plan keeps \\.mercury whole', has(planLines, 'C:\\src\\pu5\\.mercury\\browsers'), j(planLines))
    } finally {
      if (savedCache === undefined) delete process.env.MERCURY_BROWSER_CACHE_DIR
      else process.env.MERCURY_BROWSER_CACHE_DIR = savedCache
    }

    const winExe = 'C:\\src\\pu5\\.mercury\\browsers\\chrome\\win64-158.0.8127.88\\chrome-win64\\chrome.exe'
    const installText = `installed Chrome for Testing 158.0.8127.88 — 409 MB on disk\n  ${winExe}\nremove any time: /browser remove 158.0.8127.88`
    const installLines = await paint(out(installText), false, 160)
    check('/browser install answer keeps \\.mercury executable path whole', has(installLines, winExe), j(installLines))

    const installedChrome = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    const statusText = [
      'driver: puppeteer-core 24.40.0 (bundled)',
      'resolves: managed-cache — Chrome for Testing (Chrome 158.0.8127.88)',
      `  ${winExe}`,
      `installed: Google Chrome (${installedChrome}) — not driven`,
      'managed cache: 158.0.8127.88 (409 MB)',
    ].join('\n')
    const statusLines = await paint(out(statusText), false, 160)
    check('/browser status keeps both \\.mercury and (x86) paths whole', has(statusLines, winExe) && has(statusLines, installedChrome), j(statusLines))
  }

  section('§6 CONTROLS — Markdown formatting, code spans, usage lines, model text, and cache isolation')
  {
    const controls: Array<[string, string]> = [
      ['bold', 'status: **ready** now'],
      ['list', '- first item\n- second item'],
      ['heading', '## Release Notes\n\nbody text'],
      ['link', 'see [Mercury](https://example.com) here'],
      ['code span with backslash path', 'run `C:\\a\\.b\\_c` now'],
      ['fenced code block with backslash path', '```\nC:\\a\\.b\\_c\n```'],
      ['Markdown table', '| Col A | Col B |\n| --- | --- |\n| one | **two** |'],
      ['swarmchat usage', runSwarmchatCommand('bogus')],
      ['channel usage general', CHANNEL_USAGE.general],
      ['channel usage team', CHANNEL_USAGE.team],
      ['channel usage whisper', CHANNEL_USAGE.whisper],
    ]
    for (const [label, md] of controls) {
      const cmdFrame = await paintElement(React.createElement(UserLocalCommandOutputMessage, { content: out(md) }), 120)
      const baseFrame = await paintElement(React.createElement(MessageResponse, null, React.createElement(Markdown, null, md)), 120)
      check(`control (${label}) paints cell for cell as standard Markdown`, cmdFrame.raw === baseFrame.raw, j({ cmd: cmdFrame.lines, base: baseFrame.lines }))
    }

    const codeSpanLines = await paint(out('run `C:\\a\\.b\\_c` now'), false, 120)
    check('code span keeps single backslashes (not doubled)', has(codeSpanLines, 'C:\\a\\.b\\_c') && !has(codeSpanLines, 'C:\\\\a'), j(codeSpanLines))
    const fencedLines = await paint(out('```\nC:\\a\\.b\\_c\n```'), false, 120)
    check('fenced block keeps single backslashes (not doubled)', has(fencedLines, 'C:\\a\\.b\\_c') && !has(fencedLines, 'C:\\\\a'), j(fencedLines))

    const swarmLines = await paint(out(runSwarmchatCommand('bogus')), false, 140)
    check('/swarmchat usage paints <name> with no backslashes', has(swarmLines, 'team <name>|main') && !has(swarmLines, '\\<'), j(swarmLines))
    const teamLines = await paint(out(CHANNEL_USAGE.team), false, 140)
    check('/team usage paints <name> <text> with no backslashes', has(teamLines, 'usage: /team <name> <text>') && !has(teamLines, '\\<'), j(teamLines))

    const modelText = 'path C:\\a\\.b\\_c\\(d)\\e.txt and \\*not bold\\* and \\\\server\\share\nline1\\\nline2'
    const assistantFrame = await paintElement(
      React.createElement(AssistantTextMessage, { param: { type: 'text', text: modelText }, shouldShowDot: false }),
      140,
    )
    check(
      'AssistantTextMessage keeps standard Markdown escapes untouched',
      has(assistantFrame.lines, 'C:\\a.b_c(d)\\e.txt') &&
        has(assistantFrame.lines, '*not bold*') &&
        !has(assistantFrame.lines, '\\*not bold\\*') &&
        has(assistantFrame.lines, '\\server\\share') &&
        !has(assistantFrame.lines, '\\\\server\\share') &&
        assistantFrame.lines.some(line => line.endsWith('line1')),
      j(assistantFrame.lines),
    )

    const shared = 'C:\\a\\.b\\_c\\(d)\\e.txt and \\\\server\\share'
    const a1 = await paintElement(React.createElement(AssistantTextMessage, { param: { type: 'text', text: shared }, shouldShowDot: false }), 140)
    const c1 = await paintElement(React.createElement(UserLocalCommandOutputMessage, { content: out(shared) }), 140)
    const a2 = await paintElement(React.createElement(AssistantTextMessage, { param: { type: 'text', text: shared }, shouldShowDot: false }), 140)
    const shared2 = 'C:\\z\\.y\\_x\\(w)\\v.txt and \\\\host\\dir'
    const c2 = await paintElement(React.createElement(UserLocalCommandOutputMessage, { content: out(shared2) }), 140)
    const a3 = await paintElement(React.createElement(AssistantTextMessage, { param: { type: 'text', text: shared2 }, shouldShowDot: false }), 140)
    const c3 = await paintElement(React.createElement(UserLocalCommandOutputMessage, { content: out(shared2) }), 140)
    check(
      'token cache does not betray either painter in either order (model -> cmd -> model, cmd -> model -> cmd)',
      has(a1.lines, 'C:\\a.b_c(d)\\e.txt') &&
        has(c1.lines, 'C:\\a\\.b\\_c\\(d)\\e.txt') &&
        has(c1.lines, '\\\\server\\share') &&
        a2.raw === a1.raw &&
        has(c2.lines, 'C:\\z\\.y\\_x\\(w)\\v.txt') &&
        has(c2.lines, '\\\\host\\dir') &&
        has(a3.lines, 'C:\\z.y_x(w)\\v.txt') &&
        !has(a3.lines, '\\\\host\\dir') &&
        c3.raw === c2.raw,
      j({ a1: a1.lines, c1: c1.lines, a3: a3.lines, c2: c2.lines }),
    )
  }
} finally {
  rmSync(proofHome, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS local command output row' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)

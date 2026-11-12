import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { mountOffscreen, pinSourceRef, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.10' }

const scratch = realpathSync(mkdtempSync(join(process.env.MERCURY_TMPDIR ?? tmpdir(), 'paste-interleave-')))
const work = join(scratch, 'work')
const daemonDir = join(scratch, 'd')
const guardBin = join(scratch, 'clip-guard-bin')
const realClipLog = join(scratch, 'real-clipboard-calls.log')
const fakeClipPng = join(scratch, 'fake-clipboard.png')
const absentClipPng = join(scratch, 'absent-clipboard.png')
for (const dir of [work, daemonDir, guardBin]) mkdirSync(dir, { recursive: true })

for (const tool of ['osascript', 'powershell', 'pwsh', 'xclip', 'wl-paste']) {
  const shim = join(guardBin, tool)
  writeFileSync(shim, `#!/bin/sh\necho "${tool}" >> "${realClipLog}"\nexit 1\n`)
  chmodSync(shim, 0o755)
}

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const priorCwd = process.cwd()
const priorPath = process.env.PATH ?? ''

Object.assign(process.env, {
  PATH: `${guardBin}${delimiter}${priorPath}`,
  MERCURY_CONFIG_DIR: scratch,
  MERCURY_DAEMON_DIR: daemonDir,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_CLIPBOARD_IMAGE_FILE: absentClipPng,
  MERCURY_OPERATOR: 'sam',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
  MERCURY_JEV_BASE: 'http://127.0.0.1:1',
  MERCURY_FULLSCREEN: '1',
  MERCURY_HELM_HOME: '1',
  MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_REDUCED_MOTION: '1',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_AWAY_SUMMARY: '0',
  BROWSER: '/usr/bin/true',
})
process.chdir(work)

const { __setBurstCrHostForTest } = await import('../../src/ink/input/input-decoder.ts')
const React = await import('react')
const { App } = await import('../../src/components/App.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { SurfaceRouter } = await import('../../src/components/SurfaceRouter.js')
const { Chat } = await import('../../src/screens/Chat.js')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.js')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.js')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.js')
enableConfigs()
saveCurrentProjectConfig(cfg => ({
  ...cfg,
  hasCompletedProjectOnboarding: true,
  hasTrustDialogAccepted: true,
}))
saveGlobalConfig(cfg => ({
  ...cfg,
  prStatusFooterEnabled: false,
  hasCompletedOnboarding: true,
  theme: 'dark',
}))
const pending = await import('../../src/input-core/pending-input.js')
const slot = await import('../../src/services/engine-connector/focusedConnector.js')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { getCommands } = await import('../../src/commands.js')
const { markDaemonHaltStanddown } = await import('../../src/utils/daemonStanddown.js')
const { expandPastedTextRefs } = await import('../../src/history.js')
markDaemonHaltStanddown()
const commands = await getCommands(work)

type Paste = { id: number; type: 'text' | 'image'; content: string }
const sent: string[] = []
const sentPasteTypes: string[][] = []
const connector = Object.assign(new NoSessionConnector(), {
  sessionId: () => 'interleave-proof-session',
  sendWords: async (text: string, opts?: { pastedContents?: Record<number, Paste> }) => {
    const map = opts?.pastedContents ?? {}
    sent.push(expandPastedTextRefs(text, map as never))
    sentPasteTypes.push(Object.values(map).map(p => p.type))
    return { state: 'accepted' as const }
  },
})

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  if (!ok || !label.startsWith('  split ')) {
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  }
}

const PS = '\x1b[200~'
const PE = '\x1b[201~'
const wrap = (s: string): string => `${PS}${s}${PE}`
function longText(tag: string): string {
  let out = `${tag} start`
  let i = 1
  while (out.length < 900) out += ` segment ${i++} of ${tag}`
  return `${out} ${tag} end.`
}

initializeSurfaceRoute(ROOT_CHAT_ROUTE)
resetChromeModeLatchForTests()
pending.edit('')
pending.setMode('prompt')
pending.setPastedContents({})
slot.setFocusedSessionConnector(connector)
__setBurstCrHostForTest(false)

const h = React.createElement
const m: Mounted = await mountOffscreen(
  h(App, {
    initialState: getDefaultAppState(),
    getFpsMetrics: () => undefined,
    children: h(SurfaceRouter, null, h(Chat, { commands, initialTools: [] })),
  }),
  120,
  40,
)

const composerLine = (): string => m.lines().find(l => l.startsWith('│❯')) ?? ''
const expandedDraft = (): string => expandPastedTextRefs(pending.text(), pending.pastedContents() as never)

async function clearComposer(): Promise<void> {
  pending.edit('')
  pending.setPastedContents({})
  pending.setMode('prompt')
  await waitFor(() => composerLine().includes('Type a prompt'), 3000)
  await settle(25)
}

async function driveSteps(
  label: string,
  steps: Array<[string, number]>,
  wantSent: string[],
  wantDraft: string,
  tailSettleMs = 65,
): Promise<boolean> {
  await clearComposer()
  const before = sent.length
  for (const [chunk, gapMs] of steps) {
    m.push(chunk)
    if (gapMs >= 0) await settle(gapMs)
  }
  if (wantSent.length > 0) {
    await waitFor(() => sent.length >= before + wantSent.length, 800)
  }
  await settle(tailSettleMs)
  const gotSent = sent.slice(before)
  const gotDraft = expandedDraft()
  const ok = JSON.stringify(gotSent) === JSON.stringify(wantSent) && gotDraft === wantDraft
  check(
    label,
    ok,
    `sent=${JSON.stringify(gotSent).slice(0, 140)} draft=${JSON.stringify(gotDraft).slice(0, 140)} wantSent=${JSON.stringify(wantSent).slice(0, 140)} wantDraft=${JSON.stringify(wantDraft).slice(0, 140)}`,
  )
  return ok
}

try {
  await waitFor(() => composerLine().includes('Type a prompt'), 8000)
  await settle(200)

  await driveSteps('paste + x in one write leaves PASTE_ONEx in draft', [[`${wrap('PASTE_ONE')}x`, 0]], [], 'PASTE_ONEx')
  await driveSteps('ab + paste in one write leaves ab PASTE_ONE in draft', [[`ab${wrap('PASTE_ONE')}`, 0]], [], 'ab PASTE_ONE')

  for (const gap of [0, 5, 200]) {
    await driveSteps(
      `paste + cd in one write, Enter ${gap} ms later sends PASTE_ONEcd`,
      gap === 0 ? [[`${wrap('PASTE_ONE')}cd\r`, 0]] : [[`${wrap('PASTE_ONE')}cd`, gap], ['\r', 0]],
      ['PASTE_ONEcd'],
      '',
    )
    const waitArg = gap === 0 ? -1 : gap
    await driveSteps(
      `ab + paste + cd + Enter (${gap} ms between parts) sends ab PASTE_ONEcd`,
      [
        ['ab', waitArg],
        [wrap('PASTE_ONE'), waitArg],
        ['cd', waitArg],
        ['\r', 0],
      ],
      ['ab PASTE_ONEcd'],
      '',
    )
  }

  const fullSeq = `ab${wrap('PASTE_ONE')}cd\r`
  await driveSteps('ab + paste + cd + Enter in a single write sends ab PASTE_ONEcd', [[fullSeq, 0]], ['ab PASTE_ONEcd'], '')

  let twoWayAllOk = true
  for (let cut = 1; cut < fullSeq.length; cut++) {
    const ok = await driveSteps(
      `  split 2-way at ${cut}`,
      [
        [fullSeq.slice(0, cut), 4],
        [fullSeq.slice(cut), 0],
      ],
      ['ab PASTE_ONEcd'],
      '',
    )
    if (!ok) twoWayAllOk = false
  }
  check(`all ${fullSeq.length - 1} two-way byte-boundary splits of ab+paste+cd+Enter send ab PASTE_ONEcd`, twoWayAllOk)

  const threeWayCuts: Array<[number, number]> = [
    [1, 2],
    [1, 5],
    [2, 8],
    [4, 12],
    [6, 18],
    [8, 17],
    [10, 20],
    [12, 23],
    [17, 23],
    [19, 24],
    [22, 24],
    [23, 25],
  ]
  let threeWayAllOk = true
  for (const [c1, c2] of threeWayCuts) {
    const ok = await driveSteps(
      `  split 3-way at ${c1},${c2}`,
      [
        [fullSeq.slice(0, c1), 4],
        [fullSeq.slice(c1, c2), 4],
        [fullSeq.slice(c2), 0],
      ],
      ['ab PASTE_ONEcd'],
      '',
    )
    if (!ok) threeWayAllOk = false
  }
  check(`all ${threeWayCuts.length} three-way byte-boundary splits of ab+paste+cd+Enter send ab PASTE_ONEcd`, threeWayAllOk)

  const p900 = longText('NINE_HUNDRED')
  await driveSteps(
    'ab + 900-char paste + cd + Enter in one write sends whole text',
    [[`ab${wrap(p900)}cd\r`, 0]],
    [`ab ${p900}cd`],
    '',
  )
  for (const gap of [5, 200]) {
    await driveSteps(
      `ab + 900-char paste + cd + Enter (${gap} ms apart) sends whole text`,
      [
        ['ab', gap],
        [wrap(p900), gap],
        ['cd', gap],
        ['\r', 0],
      ],
      [`ab ${p900}cd`],
      '',
    )
  }
  await driveSteps(
    '900-char paste + " then typed words" + Enter in one write sends whole text',
    [[`${wrap(p900)} then typed words\r`, 0]],
    [`${p900} then typed words`],
    '',
  )

  await driveSteps(
    'cursor motion + paste + typing + Enter in one write splices at the moved cursor',
    [[`ab\x1b[D${wrap('MID')}x\r`, 0]],
    ['aMIDxb'],
    '',
  )

  const back1 = longText('FIRST_900')
  const back2 = longText('SECOND_900')
  await driveSteps('two small pastes in one write without Enter keep both in order', [[`${wrap('ONE')}${wrap('TWO')}`, 0]], [], 'ONE TWO')
  await driveSteps('two small pastes with typed hyphen between + Enter in one write', [[`${wrap('ONE')}-${wrap('TWO')}\r`, 0]], ['ONE- TWO'], '')
  await driveSteps('two 900-char pastes in one write + Enter', [[`${wrap(back1)}${wrap(back2)}\r`, 0]], [`${back1} ${back2}`], '')
  for (const gap of [5, 200]) {
    await driveSteps(
      `two 900-char pastes (${gap} ms apart) + Enter`,
      [
        [wrap(back1), gap],
        [wrap(back2), gap],
        ['\r', 0],
      ],
      [`${back1} ${back2}`],
      '',
    )
  }

  await driveSteps('paste holding CR inside keeps newline without submitting', [[wrap('line1\rline2'), 0]], [], 'line1\nline2')
  await driveSteps('paste ending in CR keeps trailing newline without submitting', [[wrap('line1\r'), 0]], [], 'line1\n')
  await driveSteps('paste holding lone ESC strips control without clearing draft', [[`xy${wrap('aa\x1bbb')}`, 0]], [], 'xy aabb')
  await driveSteps('paste holding ESC ESC strips controls without firing double-ESC clear', [[`xy${wrap('aa\x1b\x1bbb')}`, 0]], [], 'xy aabb')
  await driveSteps('paste holding start marker keeps literal text', [[wrap(`AAA${PS}BBB`), 0]], [], 'AAABBB')
  await driveSteps('stream with end marker inside paste then BBB and CR never drops AAA', [[`${PS}AAA${PE}BBB\r`, 0]], ['AAABBB'], '')
  await driveSteps(
    'stream with end marker inside paste, BBB, CR and trailing end marker never drops AAA',
    [[`${PS}AAA${PE}BBB\r${PE}`, 0]],
    ['AAABBB'],
    '',
    150,
  )

  const burst = longText('UNBRACKET_BURST')
  await driveSteps(
    'unbracketed burst + letters + Enter inside window, then second Enter after window sends whole text once',
    [
      [burst, 40],
      ['xy', 20],
      ['\r', 260],
      ['\r', 0],
    ],
    [`${burst}xy`],
    '',
    220,
  )
  await driveSteps(
    'typing ab, then unbracketed burst, quiet, then cd + Enter sends whole text',
    [
      ['ab', 30],
      [burst, 200],
      ['cd', 20],
      ['\r', 0],
    ],
    [`ab ${burst}cd`],
    '',
    220,
  )

  {
    writeFileSync(fakeClipPng, ONE_PIXEL_PNG)
    process.env.MERCURY_CLIPBOARD_IMAGE_FILE = fakeClipPng
    try {
      const beforeBurst = sent.length
      await driveSteps(
        'with an image in the fake clipboard, unbracketed burst + letters + Enter never attaches the image unasked',
        [
          [burst, 40],
          ['xy', 20],
          ['\r', 260],
          ['\r', 0],
        ],
        [`${burst}xy`],
        '',
        220,
      )
      const burstTypes = sentPasteTypes[beforeBurst] ?? []
      check(
        'with an image in the fake clipboard, the sent unbracketed burst carries only text pastes and no image',
        JSON.stringify(burstTypes) === JSON.stringify(['text']),
        `pasteTypes=${JSON.stringify(burstTypes)}`,
      )

      await clearComposer()
      const beforeImg = sent.length
      m.push(`${PS}${PE}`)
      await waitFor(() => pending.text().includes('[Image #'), 3000)
      m.push(' caption\r')
      await waitFor(() => sent.length > beforeImg, 1000)
      await settle(80)
      const imgTypes = sentPasteTypes[beforeImg] ?? []
      check(
        'with an image in the fake clipboard, an empty bracketed paste attaches the fake image and typing after it sends both',
        /^\[Image #\d+\] caption$/.test(sent[beforeImg] ?? '') && JSON.stringify(imgTypes) === JSON.stringify(['image']),
        `sent=${JSON.stringify(sent[beforeImg])} pasteTypes=${JSON.stringify(imgTypes)}`,
      )
    } finally {
      process.env.MERCURY_CLIPBOARD_IMAGE_FILE = absentClipPng
      rmSync(fakeClipPng, { force: true })
    }
  }

  {
    await clearComposer()
    const before = sent.length
    m.push('keep me')
    await waitFor(() => pending.text() === 'keep me', 3000)
    await settle(60)
    m.push('\x18p')
    await waitFor(() => m.screen().toLowerCase().includes('command') || m.screen().includes('Palette') || m.lines().some(l => l.includes('🔎') || l.includes('Search')), 3000)
    await settle(80)
    m.push(`${wrap('MODAL_PASTE')}zz`)
    await settle(100)
    m.push('\x1b')
    await settle(120)
    const preserved = pending.text() === 'keep me' && sent.length === before
    m.push(' ok\r')
    await waitFor(() => sent.length > before, 800)
    await settle(80)
    const gotSent = sent.slice(before)
    check(
      'a paste while the command-palette modal holds keys never corrupts the parked composer draft, and typing after close sends keep me ok',
      preserved && JSON.stringify(gotSent) === JSON.stringify(['keep me ok']),
      `preserved=${preserved} draft=${JSON.stringify(pending.text())} sent=${JSON.stringify(gotSent)}`,
    )
  }

  {
    saveGlobalConfig(cfg => ({ ...cfg, editorMode: 'vim' }))
    await clearComposer()
    await driveSteps(
      'vim insert mode: ab + paste + cd + Enter in one write sends ab PASTE_VIMcd',
      [[`ab${wrap('PASTE_VIM')}cd\r`, 0]],
      ['ab PASTE_VIMcd'],
      '',
    )
    saveGlobalConfig(cfg => ({ ...cfg, editorMode: 'normal' }))
  }

  check(
    'the real OS clipboard reader was never called during the proof',
    !existsSync(realClipLog),
    existsSync(realClipLog) ? readFileSync(realClipLog, 'utf8').trim() : '',
  )
} finally {
  __setBurstCrHostForTest(null)
  m.unmount()
  process.env.PATH = priorPath
  delete process.env.MERCURY_CLIPBOARD_IMAGE_FILE
  process.chdir(priorCwd)
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`${checks - failures}/${checks} checks; ${failures} red`)
process.exit(failures === 0 ? 0 : 1)

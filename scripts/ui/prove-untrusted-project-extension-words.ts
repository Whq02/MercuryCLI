import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const HOME = pinScratchHome('untrusted-project-ext-words')
delete process.env.NODE_ENV
delete process.env.CI
process.env.MERCURY_TMPDIR = join(HOME, 'tmp')
const WORK = join(HOME, 'untrusted-project')
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })
mkdirSync(WORK, { recursive: true })
process.chdir(WORK)

const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const React = await import('react')
const h = React.createElement
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(config => ({ ...config, hasCompletedOnboarding: true, theme: 'dark' }))
const { setIsInteractive, setOriginalCwd } = await import('../../src/bootstrap/state.ts')
setOriginalCwd(WORK)
setIsInteractive(false)
const { resetTrustDialogAcceptedCacheForTesting } = await import('../../src/utils/config/trust.ts')
const { saveCurrentProjectConfig } = await import('../../src/utils/config/projectConfig.ts')
resetTrustDialogAcceptedCacheForTesting()

const install = await import('../../src/extensions/install.ts')
const rosterMod = await import('../../src/extensions/roster.ts')
const activeMod = await import('../../src/extensions/active.ts')
const cliMod = await import('../../src/extensions/cli.ts')
const { extensionsStateFrom } = await import('../../src/hooks/useExtensions.ts')
const { noteWords } = await import('../../src/components/extensions/rowWords.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { ExtensionsBoard } = await import('../../src/components/extensions/ExtensionsBoard.tsx')

const fixtureExt = join(ROOT, 'scripts', 'extensions', 'fixtures', 'fixture-source', 'kitchen-sink')
const folder = join(WORK, '.mercury', 'extensions', 'kitchen-sink')
mkdirSync(dirname(folder), { recursive: true })
cpSync(fixtureExt, folder, { recursive: true })

const approved = install.approve('kitchen-sink@project', { root: folder, scope: 'project' })
check('project extension approved in place', approved.ok)

const entry = rosterMod.computeRoster({ cwd: WORK }).entries.find(e => e.id === 'kitchen-sink@project')
check('approved project extension in untrusted folder has state off', entry !== undefined && rosterMod.trustStateOf(entry) === 'off')
check(
  'rowWords.noteWords states folder not trusted · start Mercury here once',
  entry !== undefined && noteWords(entry, null) === 'folder not trusted · start Mercury here once',
  entry ? JSON.stringify(noteWords(entry, null)) : 'missing entry',
)

{
  const outLines: string[] = []
  await cliMod.listVerb({}, { out: l => outLines.push(l), err: () => {}, interactive: false })
  const textLine = outLines.find(l => l.includes('kitchen-sink')) ?? ''
  if (frameDir) writeFileSync(join(frameDir, 'cli-list-untrusted.txt'), outLines.join('\n') + '\n')
  check(
    'mercury extensions list prints state "○ off · folder not trusted" and note "start Mercury here once to trust it"',
    textLine.startsWith('○ off · folder not trusted') && textLine.trimEnd().endsWith('start Mercury here once to trust it'),
    JSON.stringify(textLine),
  )

  const jsonLines: string[] = []
  await cliMod.listVerb({ json: true }, { out: l => jsonLines.push(l), err: () => {}, interactive: false })
  const parsed = JSON.parse(jsonLines.join('\n')) as { extensions: Array<{ id: string; state: string; note: string }> }
  const jsonRow = parsed.extensions.find(e => e.id === 'kitchen-sink@project')
  check(
    'mercury extensions list --json carries state "○ off · folder not trusted" and note "start Mercury here once to trust it"',
    jsonRow?.state === '○ off · folder not trusted' && jsonRow?.note === 'start Mercury here once to trust it',
    JSON.stringify(jsonRow),
  )
}

for (const cols of [80, 100, 101, 102, 119, 120, 130, 137, 138, 139, 140, 150, 160, 178, 191, 192] as const) {
  const activeSet = activeMod.computeActiveSet({ cwd: WORK })
  const initialState = { ...getDefaultAppState(), extensions: extensionsStateFrom(activeSet, false, null) }
  const m = await mountOffscreen(
    h(
      App,
      { initialState, getFpsMetrics: () => undefined } as never,
      h(KeybindingSetup, null, h(ExtensionsBoard, { route: { kind: 'board', section: 'installed' }, onClose: () => {}, appendTranscript: () => {} })),
    ),
    cols,
    26,
  )
  try {
    await waitFor(() => m.screen().includes('kitchen-sink'), 5000)
    await settle(100)
    const lines = m.lines()
    if (frameDir) writeFileSync(join(frameDir, `board-${cols}x26.txt`), lines.join('\n') + '\n')
    const ksLine = lines.find(l => l.includes('kitchen-sink')) ?? ''
    console.log(`WIDTH ${cols}: ${ksLine}`)
    if ((cols >= 102 && cols <= 119) || (cols >= 138 && cols <= 139) || cols >= 192) {
      check(`board ${cols}x26: note paints whole`, ksLine.includes('folder not trusted · start Mercury here once'), ksLine)
    } else if (cols <= 139 || cols >= 178) {
      check(
        `board ${cols}x26: truncated note carries "folder not trusted" and ends with ellipsis`,
        ksLine.includes('folder not trusted') && !ksLine.includes('folder not trusted · start Mercury here once'),
        ksLine,
      )
    }
  } finally {
    m.unmount()
  }
}

{
  install.setSwitch('kitchen-sink@project', false, 'project')
  const disabledEntry = rosterMod.computeRoster({ cwd: WORK }).entries.find(e => e.id === 'kitchen-sink@project')
  check(
    'explicitly switched-off project extension reads plain off with empty note',
    disabledEntry !== undefined && noteWords(disabledEntry, null) === '',
    disabledEntry ? JSON.stringify(noteWords(disabledEntry, null)) : 'missing',
  )
  const disabledOut: string[] = []
  await cliMod.listVerb({ json: true }, { out: l => disabledOut.push(l), err: () => {}, interactive: false })
  const disabledJson = (JSON.parse(disabledOut.join('\n')) as { extensions: Array<{ id: string; state: string; note: string }> }).extensions.find(e => e.id === 'kitchen-sink@project')
  check(
    'cli list --json reads plain "○ off" with empty note when explicitly switched off',
    disabledJson?.state === '○ off' && disabledJson?.note === '',
    JSON.stringify(disabledJson),
  )
}

{
  install.setSwitch('kitchen-sink@project', true, 'project')
  saveCurrentProjectConfig(config => ({ ...config, hasTrustDialogAccepted: true }))
  resetTrustDialogAcceptedCacheForTesting()
  const trustedEntry = rosterMod.computeRoster({ cwd: WORK }).entries.find(e => e.id === 'kitchen-sink@project')
  check(
    'once the folder is trusted the approved project extension reads on with no untrusted note',
    trustedEntry !== undefined && rosterMod.trustStateOf(trustedEntry) === 'on' && !noteWords(trustedEntry, null).includes('folder not trusted'),
    trustedEntry ? `${rosterMod.trustStateOf(trustedEntry)} / ${noteWords(trustedEntry, null)}` : 'missing',
  )
}

console.log(`untrusted-project-ext-words: ${checks} checks, ${failures} failed`)
await releaseScratchHome(HOME)
process.exit(failures ? 1 : 0)

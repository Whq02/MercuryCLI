import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { mountOffscreen, waitFor, pinSourceRef, type Mounted } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'
import { gridToPng } from './gridToPng.ts'

pinSourceRef()
const home = process.env.MERCURY_CONFIG_DIR
if (!home || process.env.MERCURY_HOME) throw new Error('Run with a scratch MERCURY_CONFIG_DIR and MERCURY_HOME unset')
mkdirSync(home, { recursive: true })
const root = mkdtempSync(join(home, 'files-reader-'))
const framesAt = process.argv.indexOf('--frames')
const frames = framesAt < 0 ? undefined : process.argv[framesAt + 1]
if (frames) mkdirSync(frames, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_RECESS = '0'
process.env.FORCE_COLOR = '3'
process.env.BROWSER = '/usr/bin/true'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
mkdirSync(join(root, 'folder'))
writeFileSync(join(root, '.gitignore'), 'ignored.md\n')
const markdown = '# Reader heading\n\n```ts\nconst answer = 42\n```\n\n![A plot](plot.png)\n\n' + Array.from({ length: 90 }, (_, i) => `Paragraph ${String(i + 1).padStart(3, '0')}: ${'wrapped words '.repeat(12)}\n\n`).join('')
writeFileSync(join(root, 'article.md'), markdown)
writeFileSync(join(root, 'ignored.md'), '# Ignored heading\n\nStill readable locally.\n')
writeFileSync(join(root, 'plain.txt'), 'No Markdown reader for this file.\n')
writeFileSync(join(root, 'large.md'), '# Large heading\n\n' + 'large preview row\n'.repeat(20000) + 'BEYOND_FIRST_CHUNK\n')
const git = spawnSync('git', ['-C', root, 'init', '-q'], { encoding: 'utf8' })
assert.equal(git.status, 0, git.stderr)
const previousCwd = process.cwd()
process.chdir(root)
const React = await import('react')
const { Box, Text } = await import('../../src/ink.ts')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { FilesMenuSlot } = await import('../../src/components/FilesMenuSlot.tsx')
const { openFilesMenu, closeFilesMenu, isFilesMenuOpen } = await import('../../src/utils/cockpit/filesMenu.ts')
const { setComposerInsert } = await import('../../src/components/PromptInput/composerInsert.ts')
const { getFocusedWorkspaceCwd } = await import('../../src/hooks/useFocusedWorkspaceCwd.ts')
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
assert.equal(getFocusedWorkspaceCwd(), root, 'the real file slot must browse the fixture workspace')
const h = React.createElement
const keys = { down: '\x1b[B', up: '\x1b[A', left: '\x1b[D', esc: '\x1b', enter: '\r', pgdn: '\x1b[6~', pgup: '\x1b[5~' }
let failures = 0
let checks = 0
const check = (label: string, good: boolean, detail = '') => {
  checks++
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
const snapshot = async (scene: Mounted, label: string, cols: number) => {
  if (!frames) return
  writeFileSync(join(frames, `${label}-${cols}.txt`), scene.screen())
  const grid = scene.lines().map((line, y) => Array.from(line.padEnd(cols)).map((c, x) => {
    const style = scene.styleAt(x, y)
    return { c, fg: style?.fg ?? 'default', bg: style?.bg ?? 'default', bold: style?.bold ?? false, rev: style?.inverse ?? false }
  }))
  const file = join(frames, `${label}-${cols}.json`)
  writeFileSync(file, JSON.stringify({ grid, cols, rows: 28 }))
  await gridToPng(file, join(frames, `${label}-${cols}.png`))
}
function Fixture(): React.ReactNode {
  const host = React.useRef<import('../../src/ink.ts').DOMElement | null>(null)
  return h(Box, { ref: host, width: '100%', height: 28, flexDirection: 'column' }, h(Text, null, 'Files reader fixture'), h(FilesMenuSlot, { hostRef: host, framed: false }))
}
try {
  for (const cols of [80, 120]) {
    let attached = ''
    setComposerInsert(text => { attached += text })
    const scene = await mountOffscreen(h(ThemeProvider, {}, h(AppStateProvider, {}, h(KeybindingSetup, {}, h(Fixture)))), cols, 28)
    try {
      await settledFrame(scene, frame => frame.includes('Files reader fixture'))
      openFilesMenu()
      await settledFrame(scene, frame => frame.includes('Mercury · files') && frame.includes('folder'))
      scene.push('r')
      await settledFrame(scene)
      check(`${cols}: r on a folder stays in the list and explains the .md door`, isFilesMenuOpen() && scene.screen().includes('folder') && scene.screen().includes('.md files only') && attached === '')
      const filter = async (name: string) => {
        scene.push('/')
        await settledFrame(scene)
        scene.push(name)
        await settledFrame(scene, frame => frame.includes(`/ ${name}`))
        scene.push(keys.down)
        await settledFrame(scene, frame => frame.includes('❯ ' + name))
      }
      await filter('article.md')
      scene.push('r')
      const opened = await waitFor(() => scene.screen().includes('Reader heading') && scene.screen().includes('↵ attach'), 2500)
      check(`${cols}: r opens the real Markdown reader`, opened, scene.screen())
      if (!opened) continue
      await settledFrame(scene)
      const first = scene.screen()
      check(`${cols}: heading, code and image path stay legible`, first.includes('Reader heading') && first.includes('const answer = 42') && first.includes('plot.png') && !first.includes('![A plot]'))
      check(`${cols}: reader has all keys and measured row position`, first.includes('↑↓ scroll') && first.includes('pgup/pgdn') && first.includes('r read · ↵ attach · ← back') && /\d+[–-]\d+ of \d+/.test(first))
      check(`${cols}: looking has not attached or closed anything`, attached === '' && isFilesMenuOpen())
      check(`${cols}: the reader edge marker is outside the highlighted text`, /↓\s*│/.test(first))
      await snapshot(scene, 'files-reader-top', cols)
      scene.push(keys.pgdn)
      await settledFrame(scene, frame => frame !== first)
      const paged = scene.screen()
      check(`${cols}: PageDown scrolls within the reader`, !paged.includes('Reader heading') && /Paragraph/.test(paged))
      scene.push(keys.up)
      await settledFrame(scene, frame => frame !== paged)
      check(`${cols}: Up scrolls by a row`, scene.screen() !== paged)
      scene.push(keys.pgup)
      await settledFrame(scene, frame => frame.includes('Reader heading'))
      check(`${cols}: PageUp returns toward the top`, scene.screen().includes('Reader heading'))
      scene.push(keys.left)
      await settledFrame(scene, frame => frame.includes('❯ article.md') && !frame.includes('Reader heading'))
      check(`${cols}: Left restores the same selected file and filter`, scene.screen().includes('❯ article.md') && scene.screen().includes('/ article.md') && attached === '')
      scene.push('r')
      await settledFrame(scene, frame => frame.includes('Reader heading'))
      scene.push(keys.esc)
      await settledFrame(scene, frame => frame.includes('❯ article.md') && !frame.includes('Reader heading'))
      check(`${cols}: one Escape returns one level, not out of files`, isFilesMenuOpen())
      scene.push('r')
      await settledFrame(scene, frame => frame.includes('Reader heading'))
      scene.push(keys.enter)
      check(`${cols}: Enter in the reader attaches through FilesMenuSlot`, await waitFor(() => attached === '@article.md ' && !isFilesMenuOpen(), 2500))
      openFilesMenu()
      await settledFrame(scene, frame => frame.includes('folder'))
      await filter('plain.txt')
      scene.push('r')
      await settledFrame(scene)
      check(`${cols}: r on a non-Markdown file is a no-op with a hint`, scene.screen().includes('plain.txt') && !scene.screen().includes('↵ attach') && scene.screen().includes('.md'))
      scene.push(keys.esc)
      await settledFrame(scene, frame => frame.includes('folder'))
      await filter('ignored.md')
      scene.push('r')
      await settledFrame(scene, frame => frame.includes('Ignored heading'))
      check(`${cols}: a git-ignored Markdown file reads normally`, scene.screen().includes('Still readable locally.'))
      scene.push(keys.left)
      await settledFrame(scene, frame => !frame.includes('Ignored heading'))
      scene.push(keys.esc)
      await settledFrame(scene, frame => frame.includes('folder'))
      await filter('large.md')
      scene.push('r')
      await settledFrame(scene, frame => frame.includes('Large heading'))
      check(`${cols}: a large file names its first chunk`, /first .*KiB/i.test(scene.screen()) && !scene.screen().includes('BEYOND_FIRST_CHUNK'))
      await snapshot(scene, 'files-reader-large', cols)
      check(`${cols}: reading did not attach any additional file`, attached === '@article.md ')
    } catch (error) {
      check(`${cols}: drive completes`, false, String(error) + '\n' + scene.screen())
    } finally {
      scene.unmount()
      closeFilesMenu()
      setComposerInsert(null)
    }
  }
} finally {
  process.chdir(previousCwd)
  rmSync(root, { recursive: true, force: true })
}
console.log(`files-reader-drive: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)

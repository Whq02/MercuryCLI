#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'notepad-retired-'))
const home = join(scratch, 'home')
mkdirSync(home)
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_OPERATOR = 'op'
process.env.MERCURY_CHANNEL_ROOM = `notepad-retired-${process.pid}`
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.FORCE_COLOR = '3'
delete process.env.MERCURY_RECESS
const at = process.argv.indexOf('--frames')
const frames = at < 0 ? undefined : process.argv[at + 1]
if (frames) mkdirSync(frames, { recursive: true })

const React = await import('react')
const { default: Ink } = await import('../../src/ink/ink.tsx')
const { Text } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
const { enableConfigs, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_REPL_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { resetHelmFocusForTest } = await import('../../src/utils/cockpit/helmFocus.ts')
const { default: instances } = await import('../../src/ink/instances.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
const { builtinCommands } = await import('../../src/commands.ts')
const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')
let checks = 0
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)])
const modules = files(join(ROOT, 'src')).filter(file => /tabula/i.test(file.slice(ROOT.length + 1)))
check('no retired notepad module under src', modules.length === 0, modules.map(file => file.slice(ROOT.length + 1)).join(', '))
check('the command catalogue has no /note', !builtinCommands().some(command => command.name === 'note' || command.aliases?.includes('note')))
check('the registry has no retired notepad flag or directory override', !FLAG_REGISTRY.some(flag => /^MERCURY_TABULA(?:_|$)/.test(flag.env)))

class Output extends EventEmitter {
  isTTY = true
  constructor(public columns: number, public rows: number) { super() }
  write(): boolean { return true }
}
class Input extends EventEmitter {
  isTTY = true
  isRaw = false
  setEncoding(): this { return this }
  setRawMode(value: boolean): this { this.isRaw = value; return this }
  ref(): this { return this }
  unref(): this { return this }
  read(): null { return null }
}
const h = React.createElement
const deadline = setTimeout(() => { console.error('notepad-retired exceeded its deadline'); process.exit(1) }, 60_000)
deadline.unref()
try {
  for (const [cols, rows] of [[178, 51], [120, 40]] as const) {
    initializeSurfaceRoute(ROOT_REPL_ROUTE)
    resetChromeModeLatchForTests()
    resetHelmFocusForTest()
    const stdout = new Output(cols, rows)
    const ink = new Ink({ stdout: stdout as never, stdin: new Input() as never, stderr: new Output(cols, rows) as never, exitOnCtrlC: false, patchConsole: false })
    instances.set(stdout as never, ink)
    const scrollRef = React.createRef<import('../../src/ink/components/ScrollBox.tsx').ScrollBoxHandle>()
    ink.render(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined },
      h(KeybindingSetup, null, h(FullscreenLayout, { scrollRef, scrollable: h(Text, null, 'The project notepad has retired.'), bottom: h(Text, null, 'Type a prompt') }))))
    let frame = ''
    let stable = 0
    const until = Date.now() + 10_000
    while (Date.now() < until && stable < 10) {
      await new Promise<void>(resolve => setImmediate(resolve))
      const next = stripAnsi(ink.lastFrameText())
      stable = next === frame && next.includes('WORKBENCH') ? stable + 1 : 0
      frame = next
    }
    const name = `rail-${cols}x${rows}`
    if (frames) {
      writeFileSync(join(frames, `${name}.txt`), frame + '\n')
      writeFileSync(join(frames, `${name}.ansi`), ink.lastFrameText() + '\n')
    }
    check(`${cols}x${rows}: the real cockpit mounted`, frame.includes('SEAT') && frame.includes('WORKBENCH'))
    check(`${cols}x${rows}: no TABULA card or /note invitation`, !/TABULA|\/note\b/.test(frame))
    const lines = frame.split('\n')
    console.log(`MEASURE ${cols}x${rows}: workbench row ${lines.findIndex(line => line.includes('WORKBENCH')) + 1}; notepad row ${lines.findIndex(line => line.includes('TABULA')) + 1}; deep rows ${lines.filter(line => (line.match(/│/g) ?? []).length >= 6).length}`)
    ink.unmount()
    await ink.waitUntilExit()
    instances.delete(stdout as never)
  }
} finally {
  clearTimeout(deadline)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`notepad retirement: ${checks - failures}/${checks} passed; ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)

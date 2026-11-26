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
const { default: ScreenInstance } = await import('../../src/screen/renderer/screenInstance.tsx')
const { Text } = await import('../../src/screen/themedRenderer.ts')
const { App } = await import('../../src/boot/App.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/screen/fullscreen-layout/FullscreenLayout.tsx')
const { enableConfigs, saveCurrentProjectConfig } = await import('../../src/platform/settings/config.ts')
const { resetChromeModeLatchForTests } = await import('../../src/screen/fullscreen-layout/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/screen/routes/surfaceRoute.ts')
const { resetHelmFocusForTest } = await import('../../src/screen/cockpit/helmFocus.ts')
const { default: instances } = await import('../../src/screen/renderer/instances.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
const { builtinCommands } = await import('../../src/commands/catalogue/commands.ts')
const { FLAG_REGISTRY } = await import('../../src/platform/substrate/flagRegistry.ts')
const { COMMAND_DOMAINS } = await import('../../src/screen/help/commandDomains.ts')
let checks = 0
let failures = 0
const check = (label: string, ok: boolean, detail = '', hint = ''): void => {
  checks++
  if (!ok) failures++
  const shown = ok ? detail : [detail, hint].filter(Boolean).join(' | ')
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)])
const modules = files(join(ROOT, 'src')).filter(file => /tabula/i.test(file.slice(ROOT.length + 1)))
check('no retired notepad module under src', modules.length === 0, modules.map(file => file.slice(ROOT.length + 1)).join(', '), 'delete the listed file or rename it so its path has no tabula under src/')
check('the command catalogue has no /note', !builtinCommands().some(command => command.name === 'note' || command.aliases?.includes('note')), '', 'remove the note command or its alias from the list builtinCommands returns in src/commands/catalogue/commands.ts')
check('the help domains carry no dead note name', !COMMAND_DOMAINS.some(domain => domain.names.includes('note')), '', 'remove the note name from COMMAND_DOMAINS in src/screen/help/commandDomains.ts')
check('the registry has no retired notepad flag or directory override', !FLAG_REGISTRY.some(flag => /^MERCURY_TABULA(?:_|$)/.test(flag.env)), '', 'remove the MERCURY_TABULA flag entry from FLAG_REGISTRY')

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
    initializeSurfaceRoute(ROOT_CHAT_ROUTE)
    resetChromeModeLatchForTests()
    resetHelmFocusForTest()
    const stdout = new Output(cols, rows)
    const ink = new ScreenInstance({ stdout: stdout as never, stdin: new Input() as never, stderr: new Output(cols, rows) as never, exitOnCtrlC: false, patchConsole: false })
    instances.set(stdout as never, ink)
    const scrollRef = React.createRef<import('../../src/screen/renderer/elements/ScrollBox.tsx').ScrollBoxHandle>()
    ink.render(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined },
      h(KeybindingSetup, null, h(FullscreenLayout, { scrollRef, scrollable: h(Text, null, 'The project notepad has retired.'), bottom: h(Text, null, 'Type a prompt') }))))
    let frame = ''
    let stable = 0
    const until = Date.now() + 10_000
    while (Date.now() < until && stable < 10) {
      await new Promise<void>(resolve => setImmediate(resolve))
      const next = stripAnsi(ink.lastFrameText())
      stable = next === frame && next.includes('workbench') ? stable + 1 : 0
      frame = next
    }
    const name = `rail-${cols}x${rows}`
    if (frames) {
      writeFileSync(join(frames, `${name}.txt`), frame + '\n')
      writeFileSync(join(frames, `${name}.ansi`), ink.lastFrameText() + '\n')
    }
    check(`${cols}x${rows}: the real cockpit mounted`, frame.includes('lanes') && frame.includes('workbench'), '', 'the frame lacked the lanes rail or the WORKBENCH box; the box comes from workbenchSection in src/screen/cockpit-gauges/helm-lanes-model/sections.ts, so check that it is still added to the rail; rerun with --frames <dir> to read the rendered frame')
    check(`${cols}x${rows}: no TABULA card or /note invitation`, !/TABULA|\/note\b/.test(frame), '', 'the rendered rail still prints TABULA or /note; remove that card or invitation from the rail in src/screen/cockpit-gauges/helm-lanes-model')
    const lines = frame.split('\n')
    check(`${cols}x${rows}: WORKBENCH occupies the vacated card slot (the rail's first box since the SEAT box left)`, lines.findIndex(line => line.includes('workbench')) + 1 === (cols === 178 ? 3 : 2), '', 'WORKBENCH is not in the first rail box row; check the order of sections in src/screen/cockpit-gauges/helm-lanes-model (workbenchSection is in sections.ts) so no card sits before it')
    check(`${cols}x${rows}: deep-row density matches the card-free tier`, lines.filter(line => (line.match(/│/g) ?? []).length >= 6).length === (cols === 178 ? 4 : 0), '', 'the count of rail rows with six or more box edges changed; check the card heights and row density in src/screen/cockpit-gauges/helm-lanes-model')
    console.log(`MEASURE ${cols}x${rows}: workbench row ${lines.findIndex(line => line.includes('workbench')) + 1}; notepad row ${lines.findIndex(line => line.includes('TABULA')) + 1}; deep rows ${lines.filter(line => (line.match(/│/g) ?? []).length >= 6).length}`)
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

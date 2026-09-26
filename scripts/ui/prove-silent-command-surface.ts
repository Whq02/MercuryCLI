#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'silent-command-'))
Object.assign(process.env, {
  MERCURY_CONFIG_DIR: home,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_OPERATOR: 'operator',
  MERCURY_FULLSCREEN: '1',
  MERCURY_HELM_HOME: '1',
  MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_REDUCED_MOTION: '1',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_LIVE_CLOCK: '0',
  FORCE_COLOR: '3',
})
const React = await import('react')
const { default: Ink } = await import('../../src/ink/ink.tsx')
const { Box, Text, MotionParkContext, measureElement } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { initializeSurfaceRoute, ROOT_REPL_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
const { anyModalOverlayActive } = await import('../../src/context/overlayStack.ts')
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const h = React.createElement
const frameArg = process.argv.indexOf('--frames')
const frames = frameArg === -1 ? undefined : process.argv[frameArg + 1]
if (frames) mkdirSync(frames, { recursive: true })
let failures = 0
let checks = 0
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
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
  get readableLength(): number { return 0 }
}
async function settle(ink: InstanceType<typeof Ink>): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
  ink.onRender()
  await new Promise<void>(resolve => setImmediate(resolve))
}
for (const [columns, rows] of [[178, 51], [80, 21]] as const) {
  for (const recess of ['1', '0']) {
    process.env.MERCURY_RECESS = recess
    initializeSurfaceRoute(ROOT_REPL_ROUTE)
    resetChromeModeLatchForTests()
    const stdout = new Output(columns, rows)
    const ink = new Ink({ stdout: stdout as never, stdin: new Input() as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false })
    let mounts = 0
    let unmounts = 0
    let backgroundParked = false
    const ref = React.createRef<import('../../src/ink.ts').DOMElement>()
    function Command({ paints }: { paints: boolean }): React.ReactNode {
      React.useEffect(() => { mounts++; return () => { unmounts++ } }, [])
      return paints ? h(Text, null, 'visible command surface') : null
    }
    function Bottom(): React.ReactNode {
      backgroundParked = React.useContext(MotionParkContext)
      return h(Text, null, `composer ${backgroundParked ? 'parked' : 'live'}`)
    }
    function Harness({ paints }: { paints: boolean }): React.ReactNode {
      return h(KeybindingSetup, null, h(FullscreenLayout, {
        scrollable: h(Text, null, 'transcript stays mounted'),
        bottom: h(Bottom),
        modal: h(Box, { ref, width: '100%', flexDirection: 'column' }, h(Command, { paints })),
        modalActive: paints,
      }))
    }
    const render = async (paints: boolean): Promise<string> => {
      ink.render(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, h(Harness, { paints })))
      await settle(ink)
      return ink.lastFrameText().replace(/\x1b\[[0-9;]*m/g, '')
    }
    const tag = `${columns}x${rows}-recess-${recess}`
    try {
      const silent = await render(false)
      console.log(`${tag}: silent element measured ${ref.current ? measureElement(ref.current).height : 'absent'} rows`)
      check(`${tag}: a silent command draws no modal separator`, !silent.includes('▔'), silent)
      check(`${tag}: a silent command leaves the composer live and the transcript visible`, silent.includes('composer live') && silent.includes('transcript stays mounted'), silent)
      check(`${tag}: a silent command registers no modal keyboard claim`, !anyModalOverlayActive())
      const visible = await render(true)
      check(`${tag}: a painted command claims the pane and parks the background`, visible.includes('visible command surface') && visible.includes('▔') && backgroundParked, visible)
      check(`${tag}: a layered surface registers its modal keyboard claim`, recess === '0' || anyModalOverlayActive())
      const silentAgain = await render(false)
      check(`${tag}: clearing the surface releases its claim`, !silentAgain.includes('▔') && silentAgain.includes('composer live'), silentAgain)
      check(`${tag}: claiming and releasing never remounts the running command`, mounts === 1 && unmounts === 0, `${mounts} mounts, ${unmounts} unmounts`)
      if (frames) {
        writeFileSync(join(frames, `${tag}-silent.txt`), silent)
        writeFileSync(join(frames, `${tag}-visible.txt`), visible)
      }
    } finally {
      ink.unmount()
      await ink.waitUntilExit()
    }
  }
}
rmSync(home, { recursive: true, force: true })
console.log(`silent-command-surface: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)

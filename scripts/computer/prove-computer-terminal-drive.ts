import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, ROOT, scratchDir } from './computerProofKit.ts'
import { allowEverything, toolContext, toolResultTurn, toolUseTurn } from './computerToolKit.ts'
const option = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const windowHome = option('--window')
if (windowHome) {
  process.env.MERCURY_CONFIG_DIR = windowHome
  const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
  seedFirstRun(windowHome, [ROOT])
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  globalThis.fetch = (async () => { throw new Error('this terminal proof has no network') }) as typeof fetch
  const React = await import('react')
  const { default: Ink } = await import('../../src/ink/ink.tsx')
  const { default: instances } = await import('../../src/ink/instances.ts')
  const { Box } = await import('../../src/ink.ts')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
  const { llmHostPopupRequest } = await import('../../src/commands/llmhost/llmhost.tsx')
  const { openSettingsPopup } = await import('../../src/utils/cockpit/settingsPopup.ts')
  const { runHostedModel } = await import('../../src/services/host/index.ts')
  const ink = new Ink({ stdout: process.stdout, stdin: process.stdin, stderr: process.stderr, exitOnCtrlC: false, patchConsole: false })
  instances.set(process.stdout, ink)
  ink.setAltScreenActive(true, true)
  ink.render(React.createElement(AppStateProvider, {}, React.createElement(ThemeProvider, {}, React.createElement(Box, { flexDirection: 'column', width: 170, height: 48 }, React.createElement(SettingsPopupSlot)))))
  openSettingsPopup(llmHostPopupRequest((ask, emit, signal) => runHostedModel(question => {
    writeFileSync(join(windowHome, 'question.json'), JSON.stringify(question))
    return ask(question)
  }, emit, signal)))
  const timer = setInterval(() => {
    if (!existsSync(join(windowHome, 'stop'))) return
    clearInterval(timer)
    ink.unmount()
    process.exit(0)
  }, 100)
  setTimeout(() => { ink.unmount(); process.exit(1) }, 120_000).unref()
  await new Promise(() => {})
}
if (process.platform !== 'darwin' || !process.argv.includes('--live')) {
  console.log('SKIP: pass --live on macOS to open one proof-owned Terminal window')
  process.exit(0)
}
const applescript = (source: string) => execFileSync('/usr/bin/osascript', ['-e', source], { encoding: 'utf8', timeout: 20_000 }).trim()
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
if (!process.stdin.isTTY && !process.argv.includes('--terminal-runner')) {
  const runner = scratchDir('terminal-runner')
  const log = join(runner, 'output.log')
  const rc = join(runner, 'rc')
  const script = join(runner, 'run.sh')
  writeFileSync(script, `#!/bin/sh\nenv -i PATH=${quote(process.env.PATH ?? '/usr/bin:/bin')} HOME=${quote(runner)} TMPDIR=${quote(process.env.TMPDIR ?? runner)} MERCURY_CONFIG_DIR=${quote(runner)} MERCURY_CREDENTIAL_STORE=file BROWSER=/usr/bin/true TERM_PROGRAM=Apple_Terminal ${quote(process.execPath)} ${quote(import.meta.path)} ${process.argv.slice(2).map(quote).join(' ')} --terminal-runner >${quote(log)} 2>&1\nprintf '%s' "$?" >${quote(rc)}\n`)
  const id = applescript(`tell application id "com.apple.Terminal"\nset t to do script (${JSON.stringify('exec /bin/sh ' + quote(script))} & return)\nset custom title of t to "Mercury Computer proof runner"\nreturn id of first window whose selected tab is t\nend tell`)
  try {
    const deadline = Date.now() + 180_000
    while (!existsSync(rc) && Date.now() < deadline) await Bun.sleep(100)
    if (existsSync(log)) process.stdout.write(readFileSync(log))
    if (!existsSync(rc)) throw new Error('the proof-owned terminal runner did not finish')
    process.exitCode = Number(readFileSync(rc, 'utf8'))
  } finally {
    if (/^\d+$/.test(id)) try { applescript(`tell application id "com.apple.Terminal" to close window id ${id} saving no`) } catch {}
  }
  process.exit(process.exitCode ?? 1)
}
const scratch = scratchDir('terminal-drive')
const home = join(scratch, 'window-home')
mkdirSync(home, { recursive: true })
const command = `env -i PATH=${quote(process.env.PATH ?? '/usr/bin:/bin')} HOME=${quote(home)} TMPDIR=${quote(scratch)} MERCURY_CONFIG_DIR=${quote(home)} MERCURY_CREDENTIAL_STORE=file BROWSER=/usr/bin/true TERM=xterm-256color FORCE_COLOR=3 ${quote(process.execPath)} ${quote(import.meta.path)} --window ${quote(home)}; exit`
const launcher = join(scratch, 'window.sh')
writeFileSync(launcher, '#!/bin/sh\n' + command + '\n')
const launch = `tell application id "com.apple.Terminal"
  set proofTab to do script (${JSON.stringify('exec /bin/sh ' + quote(launcher))} & return)
  set custom title of proofTab to "Mercury Computer token proof"
  set proofWindow to first window whose selected tab is proofTab
  set zoomed of proofWindow to false
  set number of columns of proofTab to 170
  set number of rows of proofTab to 48
  set position of proofWindow to {20, 40}
  set frontmost of proofWindow to true
  activate
  return (id of proofWindow as text) & "," & (tty of proofTab)
end tell`
let windowId: string | undefined
try {
  const launched = applescript(launch).split(',')
  windowId = launched[0]
  if (!windowId || !/^\d+$/.test(windowId)) throw new Error('Terminal did not name the created window')
  delete process.env.MERCURY_DESKTOP_DRIVER
  const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
  resetDesktopDriverForTest()
  const resolved = resolveDesktopDriver()
  if (resolved.state !== 'ok') throw new Error(resolved.note)
  const driver = resolved.driver
  const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
  const { imageDimensionsFromHeader } = await import('../../src/tools/FileReadTool/imageProcessorJs.ts')
  const context = toolContext()
  let serial = 0
  const owned = async () => {
    const front = await driver.frontmostApplication()
    if (!front.ok || front.value.identity !== 'com.apple.Terminal' || front.value.windowId !== windowId) throw new Error('the proof window is no longer in front; no act or read of another window')
    return front.value
  }
  const call = async (input: Record<string, unknown>) => {
    await owned()
    const id = `terminal-${++serial}`
    const parent = toolUseTurn(id, 'Computer', input)
    const answer = await ComputerTool.call(input as never, context, allowEverything, parent as never)
    context.messages.push(parent, toolResultTurn(ComputerTool.mapToolResultToToolResultBlockParam(answer.data, id)))
    return answer.data
  }
  const deadline = Date.now() + 25_000
  let title = ''
  while (Date.now() < deadline) {
    if (existsSync(join(home, 'question.json'))) {
      title = String(JSON.parse(readFileSync(join(home, 'question.json'), 'utf8')).title)
      const contents = applescript(`tell application id "com.apple.Terminal" to get contents of selected tab of window id ${windowId}`)
      if (contents.includes(title)) break
    }
    await Bun.sleep(100)
  }
  if (!title) throw new Error('the product popup did not reach its first question: ' + applescript(`tell application id "com.apple.Terminal" to get contents of selected tab of window id ${windowId}`))
  await owned()
  applescript(`tell application id "com.apple.Terminal"\nset zoomed of window id ${windowId} to false\nset bounds of window id ${windowId} to {20, 40, 1248, 810}\nset number of columns of selected tab of window id ${windowId} to 170\nset number of rows of selected tab of window id ${windowId} to 48\nend tell`)
  let size = ''
  const resizeDeadline = Date.now() + 5000
  while (Date.now() < resizeDeadline) {
    size = applescript(`tell application id "com.apple.Terminal" to return (number of columns of selected tab of window id ${windowId} as text) & "," & (number of rows of selected tab of window id ${windowId} as text)`)
    if (size === '170,48') break
    const [cols, rows] = size.split(',').map(Number)
    const bounds = applescript(`tell application id "com.apple.Terminal" to get bounds of window id ${windowId}`).split(',').map(Number)
    if (cols && rows && bounds.length === 4) {
      const [left, top, right, bottom] = bounds as [number, number, number, number]
      const width = Math.round(right - left + (170 - cols) * (right - left) / cols)
      const height = Math.round(bottom - top + (48 - rows) * (bottom - top - 28) / rows)
      applescript(`tell application id "com.apple.Terminal" to set bounds of window id ${windowId} to {${left}, ${top}, ${left + width}, ${top + height}}`)
    }
    await Bun.sleep(100)
  }
  check('proof-owned Terminal is 170×48', size === '170,48', size)
  const before = await call({ action: 'screenshot', display: 0 })
  const text = await call({ action: 'screenshot' })
  const tree = await call({ action: 'tree' })
  const pixels = await call({ action: 'screenshot', pixels: true, scale: 0.5 })
  check('the real AX screenshot reads the actual llmhost popup without an image', text.outcome === 'succeeded' && !text.imagePath && text.result.includes(title) && text.result.includes('AXTextArea'), text.result)
  check('tree reads the same terminal popup as text', tree.outcome === 'succeeded' && !tree.imagePath && tree.result.includes(title), tree.result)
  const front = await owned()
  check('native crop keeps the proof window origin and width', pixels.screen?.originX === front.bounds?.x && pixels.screen?.originY === front.bounds?.y && pixels.screen?.pointWidth === front.bounds?.width, pixels.result)
  const bytes = (out: typeof before) => out.imagePath ? readFileSync(out.inlinePath ?? out.imagePath) : Buffer.alloc(0)
  const stats = (out: typeof before) => {
    const image = bytes(out)
    const header = imageDimensionsFromHeader(image)
    return { imageBytes: image.length, imageWidth: header?.width ?? 0, imageHeight: header?.height ?? 0, textChars: out.result.length, textTokenEstimate: Math.ceil(out.result.length / 4), imageAreaTokenEstimate: header ? Math.ceil(header.width * header.height / 750) : 0 }
  }
  check('pixel override produces a real window image', pixels.outcome === 'succeeded' && bytes(pixels).length > 0 && pixels.screen?.imageWidth === Math.round((pixels.imagePath ? imageDimensionsFromHeader(readFileSync(pixels.imagePath))?.width ?? 0 : 0) * 0.5), pixels.result)
  const report = { source: 'real Terminal, product llmhost popup, no network or keys', size, estimate: 'text chars/4; image width×height/750 for comparison only, not provider billing', beforeFullDisplay: stats(before), afterText: stats(text), explicitWindowPixels: stats(pixels) }
  writeFileSync(join(scratch, 'measurements.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (pixels.screen) {
    let succeeded = 0
    let imageBytes = 0
    let refusal = ''
    for (let n = 0; n < 32; n++) {
      const { operatorIsTyping } = await import('../../src/tools/ComputerTool/operatorPause.ts')
      const quietDeadline = Date.now() + 30_000
      while (await operatorIsTyping(driver)) {
        await owned()
        if (Date.now() >= quietDeadline) throw new Error('operator typing continued; the proof did not act')
        await Bun.sleep(100)
      }
      const act = await call({ action: 'move', x: 8 + n % 2, y: 8 })
      if (act.outcome !== 'succeeded') { refusal = act.result; break }
      const cursor = await driver.cursor()
      const expectedX = Math.round(pixels.screen.originX + (8 + n % 2) * pixels.screen.pointWidth / pixels.screen.imageWidth)
      const expectedY = Math.round(pixels.screen.originY + 8 * pixels.screen.pointHeight / pixels.screen.imageHeight)
      if (!cursor.ok || cursor.value.x !== expectedX || cursor.value.y !== expectedY) { refusal = 'the native cursor did not reach the cropped-image pixel'; break }
      if (!act.imagePath) succeeded++
      imageBytes += bytes(act).length
    }
    check('32 real moves stay in the proof window and return no image bytes', succeeded === 32 && imageBytes === 0, `${succeeded}/32, ${imageBytes} bytes; ${refusal}`)
    console.log(JSON.stringify({ moves: succeeded, imageBytesBeforeAtFullDisplayPerAct: bytes(before).length, imageBytesAfterPerAct: imageBytes / 32 }))
  }
} finally {
  writeFileSync(join(home, 'stop'), '')
  if (windowId) {
    try { applescript(`tell application id "com.apple.Terminal" to close window id ${windowId} saving no`) } catch {}
  }
}
finish('prove-computer-terminal-drive')

if (typeof Bun !== 'undefined') {
  const { runViewportProof } = await import('./run-viewport-proof.ts')
  process.exit(runViewportProof('console'))
}
if (!process.env.MERCURY_CONFIG_DIR || process.env.MERCURY_CREDENTIAL_STORE !== 'file') {
  throw new Error('Run this proof through its isolated Node launcher')
}
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0' }
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

const React = (await import('react')).default
const { Box, Text } = await import('../../src/ink.js')
const { TerminalSizeContext, LiveTerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { ENABLE_ALTERNATE_SCROLL } = await import('../../src/ink/termio/dec.js')
const { RESIZE_SETTLE_MS } = await import('../../src/ink/constants.js')
const { syncOutputCapabilityNow, upgradeSyncOutputSupport } = await import('../../src/ink/session/capabilities.js')
const { default: stripAnsi } = await import('strip-ansi')
const { runtime, checks } = await import('./viewportRuntime.ts')
const { check, finish } = checks()

function WindowRows(): React.ReactNode {
  const scoped = React.useContext(TerminalSizeContext)!
  const live = React.useContext(LiveTerminalSizeContext)!
  return React.createElement(Box, { flexDirection: 'column', width: scoped.columns, height: scoped.rows },
    ...Array.from({ length: scoped.rows }, (_, row) => React.createElement(Text, { key: row },
      row === 0 ? `RAIL TOP ${scoped.columns}x${scoped.rows}/${live.columns}x${live.rows}` :
        row === scoped.rows - 1 ? `COMPOSER ${scoped.columns}x${scoped.rows}` : `row ${row}`)))
}

function whole(label: string, frame: string[] | undefined, columns: number, rows: number): void {
  const text = frame ?? []
  check(`${label}: exactly ${rows} rows`, text.length === rows, `${text.length}`)
  check(`${label}: scoped and live context agree at the top`, text[0] === `RAIL TOP ${columns}x${rows}/${columns}x${rows}`, text[0])
  check(`${label}: composer reaches the last row`, text[rows - 1] === `COMPOSER ${columns}x${rows}`, text[rows - 1])
  check(`${label}: no blank band`, text.length === rows && text.every(line => line.trim() !== ''), text.join('|'))
}

function settledRoad(label: string, bytes: string, writes: string[], flickers: number, freshBuffer = false, gainedRows = false): void {
  const erases = bytes.match(/\x1b\[[0-3]?J/g) ?? []
  const wholeFrames = writes.filter(write => write.includes('\x1b[H\x1b[0m') && stripAnsi(write).includes('COMPOSER')).length
  if (freshBuffer && gainedRows) check(`${label}: the settled frame is written whole in place by one write, and the one erase is the hold's, of the rows the window gained under the frame it holds`, erases.length === 1 && /^\x1b\[0?J$/.test(erases[0]!) && wholeFrames === 1 && bytes.indexOf(erases[0]!) < bytes.indexOf('\x1b[?1049h'), `${erases.length} erases (${JSON.stringify(erases)}), ${wholeFrames} whole frames`)
  else check(`${label}: the settled frame is written whole in place by one write, and nothing erases the display`, erases.length === 0 && wholeFrames === 1, `${erases.length} erases, ${wholeFrames} whole frames`)
  check(`${label}: no scrollback erase`, !bytes.includes('\x1b[3J'))
  if (freshBuffer) check(`${label}: one fresh alternate buffer is taken for the window, and the alternate screen is never left`, (bytes.match(/\x1b\[\?1049h/g) ?? []).length === 1 && !/\x1b\[\?(?:47[hl]|1049l)/.test(bytes), `${(bytes.match(/\x1b\[\?1049h/g) ?? []).length} entries`)
  else check(`${label}: no alternate-screen switch`, !/\x1b\[\?(?:47|1049)[hl]/.test(bytes))
  check(`${label}: the modes are re-asserted as after a settled resize`, bytes.includes(ENABLE_ALTERNATE_SCROLL))
  check(`${label}: no writer full reset stood in for the settled repaint`, flickers === 0, `${flickers} full resets`)
}

async function afterTheSettle(frames: string[][], before: number): Promise<void> {
  for (let waited = 0; waited < 20 * RESIZE_SETTLE_MS && frames.length === before; waited += 10) await new Promise(resolve => setTimeout(resolve, 10))
  await new Promise(resolve => setTimeout(resolve, RESIZE_SETTLE_MS))
}

const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const consoles: Array<[platform: string, name: string, classic: boolean]> = [
  ['darwin', 'darwin', false],
  ['linux', 'linux', false],
  ['win32', 'win32 classic console', true],
  ['win32', 'win32', false],
]
for (const [platform, name, classic] of consoles) {
  if (platform === 'win32' && !classic) upgradeSyncOutputSupport()
  if (platform === 'win32') check(`${name}: the console ${classic ? 'draws nothing atomically, as the old Windows console' : 'draws atomically, as Windows Terminal'}`, syncOutputCapabilityNow() === !classic)
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
  const run = runtime(120, 40)
  const tree = React.createElement(WindowRows)
  try {
    run.ink.render(tree)
    run.ink.onRender()
    whole(`${name} mount`, run.frames.at(-1), 120, 40)
    let rowsBefore = 40
    for (const [columns, rows] of [[120, 46], [80, 24], [120, 40]]) {
      run.stdout.columns = columns
      run.stdout.rows = rows
      run.stdout.consoleSize = [columns, rows]
      const before = run.frames.length
      const events = run.stdout.resizeEvents
      const byteStart = run.stdout.bytes.length
      const writeStart = run.stdout.writes.length
      const eventStart = run.events.length
      run.ink.onRender()
      const atOnce = run.frames.length - before
      if (classic) await afterTheSettle(run.frames, before)
      const painted = run.frames.length
      await Promise.resolve()
      if (classic) check(`${name} ${columns}x${rows}: nothing is painted at the reported size before the resize settles`, atOnce === 0, `${atOnce} paints`)
      check(`${name} ${columns}x${rows}: the next paint occurred`, classic ? painted === before + 1 : painted > before, `${painted - before} paints`)
      check(`${name} ${columns}x${rows}: no resize event supplied the size`, run.stdout.resizeEvents === events)
      whole(`${name} first silent-size paint`, run.frames[before], columns, rows)
      settledRoad(`${name} ${columns}x${rows} silent-size paint`, run.stdout.bytes.slice(byteStart), run.stdout.writes.slice(writeStart), run.events.slice(eventStart).reduce((n, event) => n + event.flickers.length, 0), classic, rows > rowsBefore)
      rowsBefore = rows
    }
    if (platform === 'win32') {
      for (const [columns, rows] of [[120, 46], [80, 24], [120, 40]]) {
        run.stdout.consoleSize = [columns, rows]
        const before = run.frames.length
        const calls = run.stdout.refreshCalls
        const events = run.stdout.resizeEvents
        const byteStart = run.stdout.bytes.length
        const writeStart = run.stdout.writes.length
        const eventStart = run.events.length
        run.ink.onRender()
        const atOnce = run.frames.length - before
        if (classic) await afterTheSettle(run.frames, before)
        const painted = run.frames.length
        await Promise.resolve()
        if (classic) check(`${name} ${columns}x${rows}: nothing is painted at the console's new size before the resize settles`, atOnce === 0, `${atOnce} paints`)
        check(`${name} ${columns}x${rows}: the frame queried the console`, run.stdout.refreshCalls > calls)
        check(`${name} ${columns}x${rows}: the seam emitted its synchronous event`, run.stdout.resizeEvents === events + 1)
        check(`${name} ${columns}x${rows}: refresh caused no nested paint`, painted === before + 1, `${painted - before} paints`)
        whole(`${name} first console-size paint`, run.frames[before], columns, rows)
        settledRoad(`${name} ${columns}x${rows} console-size paint`, run.stdout.bytes.slice(byteStart), run.stdout.writes.slice(writeStart), run.events.slice(eventStart).reduce((n, event) => n + event.flickers.length, 0), classic, rows > rowsBefore)
        rowsBefore = rows
      }
      const before = run.stdout.refreshCalls
      run.ink.onRender()
      check(`${name} unchanged size is still queried every frame`, run.stdout.refreshCalls === before + 1)
    }
  } finally {
    run.dispose()
    Object.defineProperty(process, 'platform', descriptor)
  }
}
finish()

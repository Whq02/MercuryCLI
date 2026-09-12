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

function settledRoad(label: string, bytes: string, writes: string[], flickers: number): void {
  check(`${label}: one contained erase, inside the frame's own write`, bytes.split('\x1b[2J').length === 2 && writes.some(write => write.includes('\x1b[2J') && stripAnsi(write).includes('COMPOSER')), `${bytes.split('\x1b[2J').length - 1} erases`)
  check(`${label}: no scrollback erase`, !bytes.includes('\x1b[3J'))
  check(`${label}: no alternate-screen switch`, !/\x1b\[\?(?:47|1049)[hl]/.test(bytes))
  check(`${label}: the modes are re-asserted as after a settled resize`, bytes.includes(ENABLE_ALTERNATE_SCROLL))
  check(`${label}: no writer full reset stood in for the settled repaint`, flickers === 0, `${flickers} full resets`)
}

const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
for (const platform of ['darwin', 'linux', 'win32']) {
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
  const run = runtime(120, 40)
  const tree = React.createElement(WindowRows)
  try {
    run.ink.render(tree)
    run.ink.onRender()
    whole(`${platform} mount`, run.frames.at(-1), 120, 40)
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
      const painted = run.frames.length
      await Promise.resolve()
      check(`${platform} ${columns}x${rows}: the next paint occurred`, painted > before)
      check(`${platform} ${columns}x${rows}: no resize event supplied the size`, run.stdout.resizeEvents === events)
      whole(`${platform} first silent-size paint`, run.frames[before], columns, rows)
      settledRoad(`${platform} ${columns}x${rows} silent-size paint`, run.stdout.bytes.slice(byteStart), run.stdout.writes.slice(writeStart), run.events.slice(eventStart).reduce((n, event) => n + event.flickers.length, 0))
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
        const painted = run.frames.length
        await Promise.resolve()
        check(`win32 ${columns}x${rows}: the frame queried the console`, run.stdout.refreshCalls > calls)
        check(`win32 ${columns}x${rows}: the seam emitted its synchronous event`, run.stdout.resizeEvents === events + 1)
        check(`win32 ${columns}x${rows}: refresh caused no nested paint`, painted === before + 1, `${painted - before} paints`)
        whole('win32 first console-size paint', run.frames[before], columns, rows)
        settledRoad(`win32 ${columns}x${rows} console-size paint`, run.stdout.bytes.slice(byteStart), run.stdout.writes.slice(writeStart), run.events.slice(eventStart).reduce((n, event) => n + event.flickers.length, 0))
      }
      const before = run.stdout.refreshCalls
      run.ink.onRender()
      check('win32 unchanged size is still queried every frame', run.stdout.refreshCalls === before + 1)
    }
  } finally {
    run.dispose()
    Object.defineProperty(process, 'platform', descriptor)
  }
}
finish()

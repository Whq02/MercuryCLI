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
      run.ink.onRender()
      await Promise.resolve()
      check(`${platform} ${columns}x${rows}: the next paint occurred`, run.frames.length > before)
      check(`${platform} ${columns}x${rows}: no resize event supplied the size`, run.stdout.resizeEvents === events)
      whole(`${platform} first silent-size paint`, run.frames[before], columns, rows)
    }
    if (platform === 'win32') {
      for (const [columns, rows] of [[120, 46], [80, 24], [120, 40]]) {
        run.stdout.consoleSize = [columns, rows]
        const before = run.frames.length
        const calls = run.stdout.refreshCalls
        const events = run.stdout.resizeEvents
        run.ink.onRender()
        await Promise.resolve()
        check(`win32 ${columns}x${rows}: the frame queried the console`, run.stdout.refreshCalls > calls)
        check(`win32 ${columns}x${rows}: the seam emitted its synchronous event`, run.stdout.resizeEvents === events + 1)
        check(`win32 ${columns}x${rows}: refresh caused no nested paint`, run.frames.length === before + 1, `${run.frames.length - before} paints`)
        whole('win32 first console-size paint', run.frames[before], columns, rows)
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

if (typeof Bun !== 'undefined') {
  const { runViewportProof } = await import('./run-viewport-proof.ts')
  process.exit(runViewportProof('route'))
}
if (!process.env.MERCURY_CONFIG_DIR || process.env.MERCURY_CREDENTIAL_STORE !== 'file') {
  throw new Error('Run this proof through its isolated Node launcher')
}
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0' }
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

const React = (await import('react')).default
const { Box, Text } = await import('../../src/ink.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { AppStoreContext, getDefaultAppState } = await import('../../src/state/AppState.js')
const { createStore } = await import('../../src/state/store.js')
const { SurfaceRouter } = await import('../../src/components/SurfaceRouter.js')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.js')
const { ModalContext } = await import('../../src/context/modalContext.js')
const route = await import('../../src/context/surfaceRoute.js')
const { default: instances } = await import('../../src/ink/instances.js')
const { AnsiEmulator } = await import('../ink-runtime/ansiEmulator.js')
const { default: stripAnsi } = await import('strip-ansi')
const { runtime, plain, checks } = await import('./viewportRuntime.ts')
const { check, finish } = checks()
const store = createStore({ notifications: { current: null, queue: [] } })

function FixtureInput({ children }: { children: React.ReactNode }): React.ReactNode {
  const input = React.useContext(StdinContext)
  return React.createElement(StdinContext.Provider, { value: { ...input, setRawMode() {}, isRawModeSupported: true } }, children)
}

function Face({ name }: { name: string }): React.ReactNode {
  const { columns, rows } = React.useContext(TerminalSizeContext)!
  return React.createElement(Box, { width: columns, height: rows, flexDirection: 'column' },
    ...Array.from({ length: rows }, (_, i) => React.createElement(Text, { key: i }, i === rows - 1 ? 'shared status' : `${name} row ${i}`)))
}

for (const [columns, rows] of [[120, 40], [80, 24]]) {
  const run = runtime(columns, rows)
  instances.set(process.stdout, run.ink)
  route._resetSurfaceRouteForTesting()
  const registrations = [
    route.registerRouteSurface('boot-settings', { render: () => React.createElement(Face, { name: 'BOOT' }) }),
    route.registerRouteSurface('concourse', { render: () => React.createElement(Face, { name: 'CONCOURSE' }) }),
    route.registerRouteSurface('session', { render: r => React.createElement(Face, { name: r.kind === 'session' ? r.sessionId : 'SESSION' }) }),
  ]
  const tree = React.createElement(AppStoreContext.Provider, { value: store as never },
    React.createElement(FixtureInput, null,
      React.createElement(SurfaceRouter, null, React.createElement(Face, { name: 'CHAT' }))))
  try {
    route.initializeSurfaceRoute({ kind: 'boot-settings' })
    run.ink.render(tree)
    run.ink.onRender()
    const glass = new AnsiEmulator(columns, rows, true)
    glass.feed(run.stdout.bytes)
    const steps = [
      { name: 'Concourse entry', move: () => route.enterConcourse() },
      { name: 'Boot return', move: () => route.leaveCurrentSurface() },
      { name: 'session entry', move: () => route.enterSessionRepl('FIRST') },
      { name: 'same-kind session change', move: () => route.enterSessionRepl('SECOND') },
      { name: 'same-kind session return', move: () => route.leaveCurrentSurface() },
    ]
    for (const step of steps) {
      glass.feed(`\x1b[${rows};${columns - 8}HRESIDUE`)
      const start = run.stdout.bytes.length
      const writeStart = run.stdout.writes.length
      const before = run.frames.length
      const result = step.move()
      check(`${columns}x${rows} ${step.name}: route changed`, result.ok)
      run.ink.render(tree)
      run.ink.onRender()
      await Promise.resolve()
      const bytes = run.stdout.bytes.slice(start)
      glass.feed(bytes)
      const expected = plain(run.ink)
      check(`${columns}x${rows} ${step.name}: a paint followed the route`, run.frames.length > before)
      check(`${columns}x${rows} ${step.name}: all terminal cells equal the new model`, glass.lines().join('\n') === expected.join('\n'), glass.lines().slice(-2).join('|'))
      check(`${columns}x${rows} ${step.name}: stale cells unchanged in both models were erased`, !glass.lines().some(line => line.includes('RESIDUE')))
      const clearWrites = run.stdout.writes.slice(writeStart).filter(write => write.includes('\x1b[2J'))
      check(`${columns}x${rows} ${step.name}: one contained clear shares the frame write`, clearWrites.length === 1 && stripAnsi(clearWrites[0]!).includes('row'))
      check(`${columns}x${rows} ${step.name}: no scrollback clear or alternate-screen switch`, !/\x1b\[3J|\x1b\[\?(?:47|1049)[hl]/.test(bytes))
    }
  } finally {
    run.dispose()
    instances.delete(process.stdout)
    registrations.forEach(remove => remove())
    route._resetSurfaceRouteForTesting()
  }
}

function ModalBody(): React.ReactNode {
  const size = React.useContext(ModalContext)
  if (size === null) throw new Error('The modal must receive FullscreenLayout geometry')
  return React.createElement(Box, { width: size.columns, height: size.rows, flexDirection: 'column' },
    ...Array.from({ length: size.rows }, (_, row) => React.createElement(Text, { key: row }, `MODAL row ${row}`)))
}

for (const [columns, rows] of [[120, 40], [80, 24]]) {
  const run = runtime(columns, rows)
  instances.set(process.stdout, run.ink)
  const modalStore = createStore(getDefaultAppState())
  const layout = (open: boolean) => React.createElement(AppStoreContext.Provider, { value: modalStore },
    React.createElement(FixtureInput, null,
      React.createElement(FullscreenLayout, {
        scrollable: React.createElement(Text, null, 'CHAT row'),
        bottom: React.createElement(Text, null, 'COMPOSER row'),
        modal: open ? React.createElement(ModalBody) : null,
      })))
  try {
    run.ink.render(layout(false))
    run.ink.onRender()
    const glass = new AnsiEmulator(columns, rows, true)
    glass.feed(run.stdout.bytes)
    check(`${columns}x${rows} modal baseline: the real layout painted its composer`, plain(run.ink).some(line => line.includes('COMPOSER row')))
    for (const open of [true, false]) {
      const name = `FullscreenLayout modal ${open ? 'open' : 'close'}`
      glass.feed(`\x1b[${rows};${columns - 8}HRESIDUE`)
      const start = run.stdout.bytes.length
      const writeStart = run.stdout.writes.length
      const before = run.frames.length
      run.ink.render(layout(open))
      run.ink.onRender()
      await Promise.resolve()
      const bytes = run.stdout.bytes.slice(start)
      glass.feed(bytes)
      const expected = plain(run.ink)
      check(`${columns}x${rows} ${name}: the modal prop changed the actual layout`, expected.some(line => line.includes('MODAL row')) === open && (open || expected.some(line => line.includes('COMPOSER row'))))
      check(`${columns}x${rows} ${name}: a paint followed the prop change`, run.frames.length > before)
      check(`${columns}x${rows} ${name}: all terminal cells equal the new model`, glass.lines().join('\n') === expected.join('\n'), glass.lines().slice(-2).join('|'))
      check(`${columns}x${rows} ${name}: stale unchanged cells were erased`, !glass.lines().some(line => line.includes('RESIDUE')))
      const clearWrites = run.stdout.writes.slice(writeStart).filter(write => write.includes('\x1b[2J'))
      check(`${columns}x${rows} ${name}: one contained clear shares the frame write`, clearWrites.length === 1 && stripAnsi(clearWrites[0]!).includes('row'))
      check(`${columns}x${rows} ${name}: no scrollback clear or alternate-screen switch`, !/\x1b\[3J|\x1b\[\?(?:47|1049)[hl]/.test(bytes))
    }
  } finally {
    run.dispose()
    instances.delete(process.stdout)
  }
}
finish()

if (typeof Bun !== 'undefined') {
  const { runViewportProof } = await import('../ui/run-viewport-proof.ts')
  process.exit(runViewportProof('clamp'))
}
if (!process.env.MERCURY_CONFIG_DIR || process.env.MERCURY_CREDENTIAL_STORE !== 'file') {
  throw new Error('Run this proof through its isolated Node launcher')
}
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0' }
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

const React = (await import('react')).default
const { Box, Text } = await import('../../src/ink.js')
const { AppStoreContext } = await import('../../src/state/AppState.js')
const { createStore } = await import('../../src/state/store.js')
const { PermissionRuleExplanation } = await import('../../src/components/permissions/PermissionRuleExplanation.js')
const { PermissionDecisionDebugInfo } = await import('../../src/components/permissions/PermissionDecisionDebugInfo.js')
const { composeScene, makeContext, screenLines } = await import('./frameHarness.js')
const { FrameWriter } = await import('../../src/ink/frame-writer.js')
const { writeDiffToTerminal } = await import('../../src/ink/session/delivery.js')
const { optimizePatches } = await import('../../src/ink/patch-stream.js')
const { AnsiEmulator } = await import('./ansiEmulator.js')
const { runtime, plain, checks } = await import('../ui/viewportRuntime.ts')
const { check, finish } = checks()

const store = createStore({ toolPermissionContext: {
  mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {},
  alwaysDenyRules: {}, alwaysAskRules: {}, isBypassPermissionsModeAvailable: false,
} })
const longPath = 'C:\\projects\\orchard\\' + 'source-directory\\'.repeat(24) + '.mercury\\NEXT-SESSION.md'
const longNotice = `${longPath}, which is a sensitive file.`
const shortNotice = 'This is a sensitive file.'

for (const [cols, rows] of [[120, 40], [80, 24]]) {
  for (const message of [shortNotice, longNotice]) {
    const long = message === longNotice
    const decision = { behavior: 'ask' as const, message, decisionReason: { type: 'other' as const, reason: message } }
    const variants = [
      { name: 'explanation', height: 1, rowsWithMessage: 1, node: React.createElement(PermissionRuleExplanation, { permissionResult: decision, toolType: 'edit' }) },
      { name: 'debug message and reason', height: 4, rowsWithMessage: 2, node: React.createElement(PermissionDecisionDebugInfo, { permissionResult: decision }) },
    ]
    for (const variant of variants) {
      const run = runtime(cols, rows)
      try {
        const body = [React.createElement(Text, { key: 'top' }, 'RAIL TOP'),
          ...Array.from({ length: rows - variant.height - 2 }, (_, i) => React.createElement(Text, { key: i }, `rail row ${i}`)),
          React.createElement(React.Fragment, { key: 'notice' }, variant.node),
          React.createElement(Text, { key: 'bottom' }, 'COMPOSER')]
        run.ink.render(React.createElement(AppStoreContext.Provider, { value: store as never },
          React.createElement(Box, { width: cols, flexDirection: 'column' }, ...body)))
        run.ink.onRender()
        const lines = plain(run.ink)
        const label = `${cols}x${rows} ${variant.name} ${long ? 'long' : 'short'}`
        check(`${label}: the top remains visible`, lines[0] === 'RAIL TOP', lines[0])
        check(`${label}: the compositor reports exactly the viewport`, lines.length === rows, `${lines.length}`)
        check(`${label}: the notice did not push out the composer`, lines[rows - 1] === 'COMPOSER', lines.slice(-5).join('|'))
        const noticeRows = lines.filter(line => line.includes('sensitive file.'))
        check(`${label}: each message occupies its budgeted row`, noticeRows.length === variant.rowsWithMessage, lines.join('|'))
        check(`${label}: important tail retained and middle shortened only when needed`, noticeRows.length === variant.rowsWithMessage && noticeRows.every(line => long ? line.includes('\u2026') : line.includes(shortNotice) && !line.includes('\u2026')), noticeRows.join('|'))
      } finally { run.dispose() }
    }
  }

  const ctx = makeContext()
  const rawOverflow = composeScene({
    name: 'one extra row', cols, rows,
    root: { kind: 'box', style: { width: cols, flexDirection: 'column' }, children: [
      { kind: 'text', text: 'RAIL TOP' },
      ...Array.from({ length: rows - 3 }, (_, i) => ({ kind: 'text' as const, text: `body ${i}` })),
      { kind: 'text', text: 'x'.repeat(cols + 1) },
      { kind: 'text', text: 'OUTSIDE' },
    ] },
  }, ctx, undefined, { altScreen: true, contentHeight: true })
  check(`${cols}x${rows}: unbudgeted wrap is clipped, not scrolled`, rawOverflow.screen.height === rows && screenLines(rawOverflow.screen)[0] === 'RAIL TOP' && !screenLines(rawOverflow.screen).some(line => line.includes('OUTSIDE')))
  check(`${cols}x${rows}: frame viewport has no extra cursor row`, rawOverflow.viewport.height === rows, `${rawOverflow.viewport.height}`)

  const frame = (height: number, viewportRows: number, top = 'RAIL TOP') => {
    const composed = composeScene({ name: 'writer boundary', cols, rows: height,
      root: { kind: 'box', style: { width: cols, flexDirection: 'column' }, children:
        Array.from({ length: height }, (_, y) => ({ kind: 'text' as const, text: y === 0 ? top : y === rows ? 'OUTSIDE' : `row ${y}` })) },
    }, ctx, undefined, { altScreen: false, contentHeight: true, viewportRows })
    return { ...composed, viewport: { width: cols, height: viewportRows }, cursor: { x: 0, y: 0, visible: false } }
  }
  const bytesOf = (patches: Parameters<typeof optimizePatches>[0]) => {
    let bytes = ''
    writeDiffToTerminal({ stdout: { isTTY: false, write(s: string) { bytes += s; return true } } } as never, optimizePatches(patches), true)
    return bytes
  }
  const legal = frame(rows, rows)
  const overflow = frame(rows + 1, rows)
  check(`${cols}x${rows}: adversarial writer input really exceeds one row`, overflow.screen.height === rows + 1)
  for (const arm of ['growth', 'diff', 'resize']) {
    const writer = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
    const prev = arm === 'diff' ? overflow : arm === 'resize' ? frame(rows, rows - 1) : legal
    const next = arm === 'diff' ? frame(rows + 1, rows, 'RAIL NEW') : overflow
    const patches = writer.render(prev, next, true)
    const bytes = bytesOf(patches)
    const glass = new AnsiEmulator(cols, rows, true)
    glass.feed(bytesOf(new FrameWriter({ isTTY: true, stylePool: ctx.stylePool }).render(frame(0, rows), legal, true)))
    glass.feed('\x1b[H' + bytes)
    const addresses = [...bytes.matchAll(/\x1b\[(\d+)(?:;\d+)?[Hf]/g)].map(m => Number(m[1]))
    check(`${cols}x${rows} ${arm}: every cursor row is in the viewport`, addresses.every(y => y >= 1 && y <= rows), addresses.join(','))
    check(`${cols}x${rows} ${arm}: no outside row reaches the terminal`, !glass.lines().some(line => line.includes('OUTSIDE')), glass.lines().slice(-2).join('|'))
    check(`${cols}x${rows} ${arm}: top row remains addressable`, glass.rowText(0) === (arm === 'diff' ? 'RAIL NEW' : 'RAIL TOP'), glass.rowText(0))
    check(`${cols}x${rows} ${arm}: alternate paint never advances by newline`, !bytes.includes('\n'))
  }
  const writer = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
  for (const [beforeRows, afterRows] of [[24, 40], [40, 24], [24, 40]]) {
    const before = frame(beforeRows, beforeRows)
    const after = frame(afterRows, afterRows)
    const patches = writer.render(before, after, true)
    const glass = new AnsiEmulator(cols, afterRows, true)
    glass.feed(`\x1b[1;${cols}H!`)
    glass.feed(bytesOf(patches))
    check(`${cols} ${beforeRows}->${afterRows}: resize uses the contained repaint`, patches.some(p => p.type === 'clearTerminal' && p.reason === 'resize'))
    check(`${cols} ${beforeRows}->${afterRows}: no unchanged stale cell survives`, glass.lines().join('\n') === screenLines(after.screen).join('\n'))
  }
}
finish()

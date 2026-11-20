#!/usr/bin/env bun
import { join } from 'node:path'
import { armScratch, check, cleanup, FAKE_SERVER, finish, fixtureServer, openToolDoor, section, writeProject } from '../lsp/lspProofDoor.ts'

const scratch = armScratch('deadlines-d05')
const project = writeProject(scratch, 'esc-lsp', {
  'pyproject.toml': '[project]\nname = "esc-lsp"\n',
  'a.py': 'def alpha():\n    return 1\n',
})

try {
  section('§1 Esc while a language server never initializes (slow-init)')
  process.env.MERCURY_LSP_SERVERS = JSON.stringify(
    fixtureServer('py', FAKE_SERVER, { FAKE_LSP_MODE: 'slow-init', FAKE_LSP_INIT_DELAY_MS: '600000' }, '.py', 'python', { startupTimeout: 30_000, shutdownTimeout: 200 }),
  )
  for (const [label, input] of [
    ['workspaceSymbol', { operation: 'workspaceSymbol', query: 'alpha' }],
    ['documentSymbol', { operation: 'documentSymbol', filePath: join(project, 'a.py') }],
  ] as const) {
    const opened = await openToolDoor(project)
    try {
      const abortAtMs = 200
      opened.abortAfter(abortAtMs)
      const started = performance.now()
      const out = await opened.drive(input as Record<string, unknown>)
      const fromEsc = Math.round(performance.now() - started - abortAtMs)
      check(`${label}: settles within 400 ms of Esc (${fromEsc} ms)`, fromEsc < 400, `took ${fromEsc} ms`)
      check(`${label}: returns the executor's interrupted words`, out.isError && out.text.includes('Interrupted by user: the operator stopped this LspRead call on purpose'), out.text)
    } finally {
      await opened.close()
    }
  }

  section('§2 Esc during a request to a running wedged server keeps request abort words')
  process.env.MERCURY_LSP_SERVERS = JSON.stringify(
    fixtureServer('py-wedged', FAKE_SERVER, { FAKE_LSP_MODE: 'wedged' }, '.py', 'python', { startupTimeout: 8_000, requestTimeout: 30_000, shutdownTimeout: 200 }),
  )
  const wedged = await openToolDoor(project)
  try {
    await wedged.manager()!.ensureServerStarted(join(project, 'a.py'))
    const abortAtMs = 200
    wedged.abortAfter(abortAtMs)
    const started = performance.now()
    const out = await wedged.drive({ operation: 'documentSymbol', filePath: join(project, 'a.py') })
    const fromEsc = Math.round(performance.now() - started - abortAtMs)
    check(`wedged documentSymbol: settles within 400 ms of Esc (${fromEsc} ms)`, fromEsc < 400, `took ${fromEsc} ms`)
    check(
      'wedged documentSymbol: keeps request interrupted words',
      out.text.includes('LSP request textDocument/documentSymbol to server env:py-wedged was interrupted before it finished.'),
      out.text,
    )
  } finally {
    await wedged.close()
  }
} finally {
  cleanup(scratch)
}

finish('DEADLINES-D05')

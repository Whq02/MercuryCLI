#!/usr/bin/env bun
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'mcp-win32-not-found-'))
const HOST_PLATFORM = process.platform
const ORIG_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
const ORIG_COMSPEC = process.env.comspec
const ORIG_COMSPEC_UPPER = process.env.COMSPEC

process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
process.env.MERCURY_MCP_TIMEOUT_MS = '3000'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const comspecHitFile = join(SCRATCH, 'comspec-was-invoked')
if (HOST_PLATFORM !== 'win32') {
  const fakeComspec = join(SCRATCH, 'fake-cmd.sh')
  writeFileSync(
    fakeComspec,
    `#!/bin/sh\necho hit > "${comspecHitFile}"\necho "The system cannot find the path specified." >&2\nexit 1\n`,
  )
  chmodSync(fakeComspec, 0o755)
  process.env.comspec = fakeComspec
  process.env.COMSPEC = fakeComspec
  Object.defineProperty(process, 'platform', { ...ORIG_PLATFORM, value: 'win32' })
}

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — prove-stdio-command-not-found exceeded 60s')
  process.exit(1)
}, 60_000)
watchdog.unref?.()

try {
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const bootstrap = await import('../../src/bootstrap/state.ts')
  bootstrap.setIsInteractive(false)
  const mcp = await import('../../src/services/mcp/client.ts')

  console.log('============================================================')
  console.log(' MCP stdio command-not-found on Windows (SUBMIT 279)')
  console.log('============================================================')

  const connectFailed = async (name: string, config: Record<string, unknown>): Promise<string> => {
    const { client } = await mcp.reconnectMcpServerImpl(name, { ...config, scope: 'local' } as never)
    check(`${name}: settles failed`, client.type === 'failed', `type=${String(client.type)}`)
    return client.type === 'failed' ? String(client.error ?? '') : ''
  }

  const missingExplicit = '/nonexistent/bin/mcp-server-submit-279'
  const explicitReason = await connectFailed('missing-explicit-win32', {
    type: 'stdio',
    command: missingExplicit,
    args: ['--flag'],
    env: {},
  })
  check(
    'explicit missing command reads "command not found" on win32',
    explicitReason.startsWith(`command not found: ${missingExplicit}`) && explicitReason.includes('retry from /mcp'),
    explicitReason,
  )
  check(
    'explicit missing command never surfaces cmd.exe stderr',
    !explicitReason.includes('Connection closed') && !explicitReason.includes('cannot find the path'),
    explicitReason,
  )

  const missingBare = 'definitely-missing-mcp-cmd-submit-279'
  const bareReason = await connectFailed('missing-bare-win32', {
    type: 'stdio',
    command: missingBare,
    args: [],
    env: {},
  })
  check(
    'bare missing command reads "command not found" on win32',
    bareReason.startsWith(`command not found: ${missingBare}`) && bareReason.includes('retry from /mcp'),
    bareReason,
  )
  if (HOST_PLATFORM !== 'win32') {
    check('cmd.exe was never spawned for missing commands', !existsSync(comspecHitFile))
  }

  const realBin = HOST_PLATFORM === 'win32' ? process.execPath : join(SCRATCH, 'real-runner.exe')
  if (HOST_PLATFORM !== 'win32') {
    copyFileSync(process.execPath, realBin)
    chmodSync(realBin, 0o755)
  }
  const loudReason = await connectFailed('existing-binary-exits-loudly', {
    type: 'stdio',
    command: realBin,
    args: ['-e', "process.stderr.write('boot failed: bad key\\n'); process.exit(2)"],
    env: {},
  })
  check(
    'existing command passes preflight and still reports server stderr',
    loudReason.includes('server stderr: boot failed: bad key') && !loudReason.startsWith('command not found:'),
    loudReason,
  )
} finally {
  Object.defineProperty(process, 'platform', ORIG_PLATFORM)
  if (ORIG_COMSPEC === undefined) delete process.env.comspec
  else process.env.comspec = ORIG_COMSPEC
  if (ORIG_COMSPEC_UPPER === undefined) delete process.env.COMSPEC
  else process.env.COMSPEC = ORIG_COMSPEC_UPPER
  try {
    rmSync(SCRATCH, { recursive: true, force: true })
  } catch {
  }
}

console.log(failures === 0 ? '\nPASS prove-stdio-command-not-found' : `\nFAIL prove-stdio-command-not-found (${failures})`)
process.exit(failures === 0 ? 0 : 1)

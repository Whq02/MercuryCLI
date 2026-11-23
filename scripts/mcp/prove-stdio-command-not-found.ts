#!/usr/bin/env bun
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)

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
  console.log('\nTIMEOUT — prove-stdio-command-not-found exceeded 60s; a connect in reconnectMcpServerImpl (src/integrations/mcp/client.ts) did not settle, look at the PASS or FAIL line printed last above')
  process.exit(1)
}, 60_000)
watchdog.unref?.()
let lockedAliasDir: string | null = null

try {
  const mcp = await import('../../src/integrations/mcp/client.ts')

  console.log('============================================================')
  console.log(' MCP stdio command-not-found on Windows (SUBMIT 279)')
  console.log('============================================================')

  const connectFailed = async (name: string, config: Record<string, unknown>): Promise<string> => {
    const { client } = await mcp.reconnectMcpServerImpl(name, { ...config, scope: 'local' } as never)
    check(`${name}: settles failed`, client.type === 'failed', `the connect must settle as failed (reconnectMcpServerImpl in src/integrations/mcp/client.ts); type=${String(client.type)}`)
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
    `describeMcpConnectFailure (src/integrations/mcp/utils.ts) must word an ENOENT as command not found, and missingSpawnCommandError (src/platform/host-os/programs.ts) must report the missing command before cmd.exe runs; got: ${explicitReason}`,
  )
  check(
    'explicit missing command never surfaces cmd.exe stderr',
    !explicitReason.includes('Connection closed') && !explicitReason.includes('cannot find the path'),
    `the stdio transport (src/integrations/mcp/client/transports.ts) must check the command with missingSpawnCommandError before it spawns, so cmd.exe stderr never reaches the reason; got: ${explicitReason}`,
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
    `missingSpawnCommandError (src/platform/host-os/programs.ts) must find a bare missing command on PATH and describeMcpConnectFailure (src/integrations/mcp/utils.ts) must word it as command not found; got: ${bareReason}`,
  )
  if (HOST_PLATFORM !== 'win32') {
    check('cmd.exe was never spawned for missing commands', !existsSync(comspecHitFile), 'the stdio transport (src/integrations/mcp/client/transports.ts) must refuse a missing command through missingSpawnCommandError before it spawns cmd.exe')
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
    `missingSpawnCommandError (src/platform/host-os/programs.ts) must accept an existing command, and describeMcpConnectFailure (src/integrations/mcp/utils.ts) must append the server stderr tail; got: ${loudReason}`,
  )

  if (HOST_PLATFORM !== 'win32') {
    const locked = join(SCRATCH, 'locked-apps')
    const aliasDir = join(SCRATCH, 'windows-apps')
    mkdirSync(locked)
    mkdirSync(aliasDir)
    const target = join(locked, 'alias-server.exe')
    writeFileSync(target, 'mz')
    chmodSync(locked, 0o000)
    lockedAliasDir = locked
    const aliasFull = join(aliasDir, 'alias-server.exe')
    symlinkSync(target, aliasFull)
    symlinkSync(join(SCRATCH, 'no-such-target.exe'), join(aliasDir, 'dangling-server.exe'))

    const bareAliasReason = await connectFailed('alias-bare-win32', {
      type: 'stdio',
      command: 'alias-server',
      args: [],
      env: { PATH: aliasDir },
    })
    check(
      'app execution alias (bare) is not refused as "command not found" on win32',
      !bareAliasReason.startsWith('command not found:'),
      `missingSpawnCommandError (src/platform/host-os/programs.ts) must not refuse a path entry that exists as a link even when its target cannot be read; got: ${bareAliasReason}`,
    )

    const fullAliasReason = await connectFailed('alias-full-win32', {
      type: 'stdio',
      command: aliasFull,
      args: [],
      env: {},
    })
    check(
      'app execution alias (full path) is not refused as "command not found" on win32',
      !fullAliasReason.startsWith('command not found:'),
      `missingSpawnCommandError (src/platform/host-os/programs.ts) must not refuse a full path that exists as a link even when its target cannot be read; got: ${fullAliasReason}`,
    )

    const danglingReason = await connectFailed('dangling-link-win32', {
      type: 'stdio',
      command: 'dangling-server',
      args: [],
      env: { PATH: aliasDir },
    })
    check(
      'dangling link still reads "command not found" on win32',
      danglingReason.startsWith('command not found: dangling-server') && danglingReason.includes('retry from /mcp'),
      `missingSpawnCommandError (src/platform/host-os/programs.ts) must still report a link whose target is missing as command not found; got: ${danglingReason}`,
    )
  } else {
    const winApps = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps')
    let foundAlias: { file: string; bare: string } | null = null
    try {
      const entries = readdirSync(winApps)
      const ordered = entries.filter(e => e.toLowerCase() === 'winget.exe').concat(entries.filter(e => e.toLowerCase().endsWith('.exe') && e.toLowerCase() !== 'winget.exe'))
      for (const entry of ordered) {
        const file = join(winApps, entry)
        try {
          statSync(file)
          continue
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        }
        try {
          lstatSync(file)
          foundAlias = { file, bare: entry.slice(0, -4) }
          break
        } catch {
        }
      }
    } catch {
    }
    if (foundAlias === null) {
      console.log('not read on Windows: no App Execution Alias here')
    } else if (foundAlias.bare.toLowerCase() === 'winget') {
      const bareAliasReason = await connectFailed('alias-bare-win32', {
        type: 'stdio',
        command: foundAlias.bare,
        args: ['--version'],
        env: {},
      })
      check(
        'app execution alias (bare) is not refused as "command not found" on win32',
        !bareAliasReason.startsWith('command not found:'),
        `missingSpawnCommandError (src/platform/host-os/programs.ts) must accept a bare app execution alias; got: ${bareAliasReason}`,
      )
      const fullAliasReason = await connectFailed('alias-full-win32', {
        type: 'stdio',
        command: foundAlias.file,
        args: ['--version'],
        env: {},
      })
      check(
        'app execution alias (full path) is not refused as "command not found" on win32',
        !fullAliasReason.startsWith('command not found:'),
        `missingSpawnCommandError (src/platform/host-os/programs.ts) must accept a full-path app execution alias; got: ${fullAliasReason}`,
      )
    } else {
      const { missingSpawnCommandError } = await import('../../src/platform/host-os/programs.ts')
      check(
        'app execution alias passes missingSpawnCommandError on win32',
        missingSpawnCommandError(foundAlias.bare) === null && missingSpawnCommandError(foundAlias.file) === null,
        `missingSpawnCommandError (src/platform/host-os/programs.ts) must return null for an app execution alias; alias file: ${foundAlias.file}`,
      )
    }
  }
} finally {
  Object.defineProperty(process, 'platform', ORIG_PLATFORM)
  if (ORIG_COMSPEC === undefined) delete process.env.comspec
  else process.env.comspec = ORIG_COMSPEC
  if (ORIG_COMSPEC_UPPER === undefined) delete process.env.COMSPEC
  else process.env.COMSPEC = ORIG_COMSPEC_UPPER
  if (lockedAliasDir !== null) {
    try {
      chmodSync(lockedAliasDir, 0o755)
    } catch {
    }
  }
  try {
    rmSync(SCRATCH, { recursive: true, force: true })
  } catch {
  }
}

console.log(failures === 0 ? '\nPASS prove-stdio-command-not-found' : `\nFAIL prove-stdio-command-not-found (${failures})`)
process.exit(failures === 0 ? 0 : 1)

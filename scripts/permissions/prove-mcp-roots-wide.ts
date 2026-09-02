#!/usr/bin/env bun
// ============================================================================
//  prove-mcp-roots-wide — the MCP roots advertisement covers real targets.
//
//  Operator repro: chrome-devtools take_screenshot to
//  /tmp/….png → "Access denied: path … is not within any of the configured
//  workspace roots". Path-validating MCP servers trust OUR ListRoots answer;
//  advertising only the boot cwd denied the OS temp dir, a live cd/worktree
//  cwd — every file-emitting tool aimed anywhere sane. The fix widens the
//  fork's advertised set (boot cwd · live cwd · tmpdir · /tmp · /private/tmp)
//  behind MERCURY_MCP_ROOTS_WIDE.
//
//  client.ts is not bun-loadable in isolation — pin the contract structurally
//  (the handler's shape is small and load-bearing).
// ============================================================================
import { readFileSync } from 'node:fs'

let failures = 0
const t = (name: string, ok: boolean): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures = 1
}

const client = readFileSync('src/services/mcp/client.ts', 'utf8')
const handler = client.slice(
  client.indexOf('client.setRequestHandler(ListRootsRequestSchema'),
  client.indexOf('client.setRequestHandler(ListRootsRequestSchema') + 2200,
)

//  (WP-3): the OLD pin froze the defective `file://${...}`
// template — repinned to the pathToFileURL form (win32 drives + percent
// encoding correct by construction).
t('boot cwd stays the first root (pathToFileURL form)', handler.includes('const roots = [pathToFileURL(getOriginalCwd()).href]'))
t('added roots go through pathToFileURL too', handler.includes('pathToFileURL(stripped || p).href'))
t('the defective file:// concat template is GONE', !handler.includes('`file://${'))
t('widening honors the =0 opt-out ', handler.includes("flagEnv('MERCURY_MCP_ROOTS_WIDE') !== '0'"))
t('opt-out honored (alias read)', handler.includes("flagEnv('MERCURY_MCP_ROOTS_WIDE') !== '0'"))
t('LIVE cwd advertised (cd/worktree covered per-request)', handler.includes('add(getCwd())'))
t('OS temp dir advertised', handler.includes('add(tmpdir())'))
t('/tmp + /private/tmp advertised on POSIX', handler.includes("add('/tmp')") && handler.includes("add('/private/tmp')"))
t('win32 skips the POSIX tmp literals', handler.includes("process.platform !== 'win32'"))
t('dedupe guard present', handler.includes('if (!roots.includes(uri)) roots.push(uri)'))

const reg = readFileSync('src/substrate/flagRegistry.ts', 'utf8')
t('flag registered', reg.includes("env: 'MERCURY_MCP_ROOTS_WIDE'"))

console.log(failures ? '\n❌ MCP-ROOTS-WIDE RED' : '\n✅ MCP-ROOTS-WIDE GREEN')
process.exit(failures)

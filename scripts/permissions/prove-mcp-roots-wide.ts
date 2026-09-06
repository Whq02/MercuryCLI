#!/usr/bin/env bun
import { readFileSync } from 'node:fs'

let failures = 0
const t = (name: string, ok: boolean): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures = 1
}

const client = readFileSync('src/services/mcp/client.ts', 'utf8')
const handler = client.slice(
  client.indexOf("client.setRequestHandler('roots/list'"),
  client.indexOf("client.setRequestHandler('roots/list'") + 2200,
)

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

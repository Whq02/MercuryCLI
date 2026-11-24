#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-telemetry-absence-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' Telemetry absence (SM-J-P5) — structural proof')
console.log('============================================================')

console.log('\n§2 no OpenTelemetry dependency or import anywhere in the product')
const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8')
check('zero @opentelemetry deps in package.json', !pkg.includes('@opentelemetry'))

console.log('\n§3 error classes carry no telemetry wrapper or properties')
try {
  const errorsMod: Record<string, unknown> = await import('../../src/platform/errors/errors.ts')
  const badErrorExports = Object.keys(errorsMod).filter(k => /telemetry|i_verified/i.test(k))
  check(
    'src/platform/errors/errors.ts exports no telemetry error class',
    badErrorExports.length === 0,
    badErrorExports.length === 0 ? '' : `found ${badErrorExports.join(', ')} — remove TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS from src/platform/errors/errors.ts`,
  )

  const mcpErrorsMod: Record<string, unknown> = await import('../../src/integrations/mcp/client/errors.ts')
  const mcpClientMod: Record<string, unknown> = await import('../../src/integrations/mcp/client.ts')
  const badMcpExports = [
    ...Object.keys(mcpErrorsMod).filter(k => /telemetry|i_verified/i.test(k)),
    ...Object.keys(mcpClientMod).filter(k => /telemetry|i_verified/i.test(k)),
  ]
  check(
    'MCP error modules export no telemetry-suffixed class',
    badMcpExports.length === 0,
    badMcpExports.length === 0 ? '' : `found ${badMcpExports.join(', ')} — rename to McpToolCallError in src/integrations/mcp/client/errors.ts and src/integrations/mcp/client.ts`,
  )

  const McpToolCallErrorCtor = mcpClientMod.McpToolCallError
  const hasMcpToolCallError = typeof McpToolCallErrorCtor === 'function' && mcpErrorsMod.McpToolCallError === McpToolCallErrorCtor
  check(
    'McpToolCallError is exported from client/errors.ts and client.ts',
    hasMcpToolCallError,
    hasMcpToolCallError ? '' : 'export McpToolCallError from src/integrations/mcp/client/errors.ts and re-export it from src/integrations/mcp/client.ts',
  )
  if (typeof McpToolCallErrorCtor === 'function') {
    const toolErr = Reflect.construct(McpToolCallErrorCtor, ['boom', { tag: 1 }]) as Error & { mcpMeta?: Record<string, unknown> }
    check(
      'McpToolCallError carries mcpMeta without telemetry properties',
      toolErr instanceof Error &&
        toolErr.name === 'McpToolCallError' &&
        toolErr.mcpMeta?.tag === 1 &&
        !('telemetryMessage' in toolErr) &&
        !('telemetrySafeMessage' in toolErr),
      `name=${toolErr.name} keys=${Object.keys(toolErr).join(',')} — make McpToolCallError extend Error with (message, mcpMeta?) in src/integrations/mcp/client/errors.ts`,
    )
  }

  const mcpUtilsMod = await import('../../src/integrations/mcp/utils.ts')
  const badUtilsExports = Object.keys(mcpUtilsMod).filter(k => /telemetry/i.test(k))
  check(
    'src/integrations/mcp/utils.ts exports no telemetry constant',
    badUtilsExports.length === 0,
    badUtilsExports.length === 0 ? '' : `found ${badUtilsExports.join(', ')} — replace MCP_CONNECT_TIMEOUT_TELEMETRY with McpConnectTimeoutError in src/integrations/mcp/utils.ts`,
  )
  const McpConnectTimeoutErrorCtor = (mcpUtilsMod as Record<string, unknown>).McpConnectTimeoutError
  if (typeof McpConnectTimeoutErrorCtor === 'function') {
    const deadline = Reflect.construct(McpConnectTimeoutErrorCtor, [
      'MCP server "x" (stdio) did not answer in 1.5s — retry from /mcp',
    ]) as Error
    const reason = mcpUtilsMod.describeMcpConnectFailure(deadline, { transport: 'stdio', command: 'node', stderrTail: '' })
    check(
      'McpConnectTimeoutError keeps its sentence in describeMcpConnectFailure without telemetryMessage',
      deadline instanceof Error &&
        deadline.name === 'McpConnectTimeoutError' &&
        !('telemetryMessage' in deadline) &&
        reason === deadline.message,
      `reason=${reason} — check instanceof McpConnectTimeoutError in describeMcpConnectFailure (src/integrations/mcp/utils.ts)`,
    )
  } else {
    check(
      'McpConnectTimeoutError is exported from src/integrations/mcp/utils.ts',
      false,
      'export McpConnectTimeoutError from src/integrations/mcp/utils.ts',
    )
  }

  const mcpResultsMod = await import('../../src/integrations/mcp/client/results.ts')
  let resultErr: unknown = null
  try {
    await mcpResultsMod.transformMCPResult({}, 'ping', 'srv')
  } catch (err) {
    resultErr = err
  }
  check(
    'transformMCPResult throws a plain Error without telemetryMessage',
    resultErr instanceof Error &&
      resultErr.constructor === Error &&
      resultErr.name === 'Error' &&
      !('telemetryMessage' in resultErr),
    resultErr instanceof Error
      ? `name=${resultErr.name} keys=${Object.keys(resultErr).join(',')} — throw new Error in transformMCPResult (src/integrations/mcp/client/results.ts)`
      : 'did not throw — transformMCPResult in src/integrations/mcp/client/results.ts must throw on unexpected format',
  )

  const structuredMod = await import('../../src/tools/structured-output/StructuredOutputTool.ts')
  const bound = structuredMod.getSchemaBoundStructuredOutputTool({ type: 'object', required: ['ok'] })
  let schemaErr: unknown = null
  if (bound.ok) {
    const callFn = bound.tool.call as (input: unknown) => Promise<unknown>
    try {
      await callFn({})
    } catch (err) {
      schemaErr = err
    }
  }
  check(
    'SchemaMismatchError extends Error without telemetry properties',
    schemaErr instanceof structuredMod.SchemaMismatchError &&
      schemaErr.name === 'SchemaMismatchError' &&
      !('telemetryMessage' in schemaErr) &&
      !('telemetrySafeMessage' in schemaErr),
    schemaErr instanceof Error
      ? `name=${schemaErr.name} keys=${Object.keys(schemaErr).join(',')} — make SchemaMismatchError extend Error without telemetrySafeMessage in src/tools/structured-output/StructuredOutputTool.ts`
      : 'did not throw SchemaMismatchError — check getSchemaBoundStructuredOutputTool in src/tools/structured-output/StructuredOutputTool.ts',
  )
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n ✅ TELEMETRY ABSENCE GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

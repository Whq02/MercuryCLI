#!/usr/bin/env bun
// prove-pool-assembly-denies — every tool-pool assembly site enforces deny
// rules and the blocked ceiling (field card FC-026, folding W3 serve +
// E008 91). Two sites bypassed the permission-aware assembler: `mercury mcp
// serve` built its pool from an EMPTY permission context (advertising and
// executing a denied tool), and the headless -p/SDK path concatenated MCP
// tools raw — no deny filtering, no blocked ceiling, which has no other
// enforcement site.
//
//   §1 the law itself: filterToolsByDenyRules + the blocked ceiling.
//   §2 the -p assembly rides the law (call-shaped pin on print.ts).
//   §3 the serve handlers build a DISK-RULES context, never the empty one.
//   §4 the serve surface live: a settings deny is absent from tools/list
//      (drives the built artifact over stdio).
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'pool-denies-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const ROOT = join(import.meta.dir, '..', '..')

section('§1 THE LAW')
{
  const { filterToolsByDenyRules } = await import('../../src/tools.ts')
  const ctx = {
    mode: 'default',
    alwaysDenyRules: { userSettings: ['mcp__srv__alpha'] },
    alwaysAllowRules: {},
    alwaysAskRules: {},
  } as never
  const tools = [
    { name: 'mcp__srv__alpha', mcpInfo: { serverName: 'srv', toolName: 'alpha' } },
    { name: 'mcp__srv__beta', mcpInfo: { serverName: 'srv', toolName: 'beta' } },
  ] as never[]
  const filtered = filterToolsByDenyRules(tools as never, ctx) as Array<{ name: string }>
  check(
    'a denied MCP tool leaves the filtered pool',
    !filtered.some(t => t.name === 'mcp__srv__alpha') && filtered.some(t => t.name === 'mcp__srv__beta'),
    JSON.stringify(filtered.map(t => t.name)),
  )
}

section('§2 THE -p ASSEMBLY')
{
  const print = readFileSync(join(ROOT, 'src/cli/print.ts'), 'utf8')
  const seamAt = print.indexOf('const assembleTools')
  const seam = print.slice(seamAt, seamAt + 1400)
  check('the -p per-turn assembly exists', seamAt !== -1)
  check(
    'the MCP partitions ride filterToolsByDenyRules (FC-026, call-shaped)',
    /filterToolsByDenyRules\(/.test(seam),
    seam.slice(0, 120).replace(/\s+/g, ' '),
  )
  check(
    "and the blocked ceiling is enforced (effectiveMaxPermission !== 'blocked')",
    /effectiveMaxPermission\s*!==\s*'blocked'/.test(seam),
  )
}

section('§3 THE SERVE CONTEXT')
{
  const serve = readFileSync(join(ROOT, 'src/entrypoints/mcp.ts'), 'utf8')
  const listAt = serve.indexOf('setRequestHandler(ListToolsRequestSchema')
  const callAt = serve.indexOf('setRequestHandler(CallToolRequestSchema')
  const listSlice = serve.slice(listAt, listAt + 600)
  const callSlice = serve.slice(callAt, callAt + 600)
  check(
    'the ListTools handler builds a DISK-RULES context (never the empty one)',
    !/getEmptyToolPermissionContext\(\)/.test(listSlice) && /ermissionContext/.test(listSlice),
    listSlice.slice(0, 140).replace(/\s+/g, ' '),
  )
  check(
    'the CallTool handler does too',
    !/getEmptyToolPermissionContext\(\)/.test(callSlice),
    callSlice.slice(0, 140).replace(/\s+/g, ' '),
  )
  check(
    'the CallTool handler enforces the ladder per call (refuse-on-non-allow)',
    /hasPermissionsToUseTool\(\s*\n?\s*tool,/.test(serve) &&
      /behavior !== 'allow'/.test(serve) &&
      /PermissionRefused/.test(serve),
  )
  check(
    "the handler's app state carries the SERVE context, not the default",
    /toolPermissionContext: permissionContext/.test(serve),
  )
}

section('§4 THE SERVE SURFACE LIVE')
{
  const DIST = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(DIST)) {
    check('dist/mercury.mjs exists (build first — this leg drives the artifact)', false)
  } else {
    const projDir = realpathSync(mkdtempSync(join(tmpdir(), 'pool-denies-proj-')))
    mkdirSync(join(projDir, '.mercury'), { recursive: true })
    writeFileSync(join(projDir, '.mercury', 'settings.json'), JSON.stringify({ permissions: { deny: ['Write'] } }))
    const child = spawn('node', [DIST, 'mcp', 'serve'], {
      cwd: projDir,
      env: { ...process.env, MERCURY_CONFIG_DIR: HOME },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const lines: string[] = []
    let buffer = ''
    child.stdout.on('data', d => {
      buffer += String(d)
      let idx
      while ((idx = buffer.indexOf('\n')) !== -1) {
        lines.push(buffer.slice(0, idx))
        buffer = buffer.slice(idx + 1)
      }
    })
    const send = (msg: unknown): void => void child.stdin.write(JSON.stringify(msg) + '\n')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const deadline = Date.now() + 30000
    let toolNames: string[] | null = null
    while (Date.now() < deadline && toolNames === null) {
      await new Promise(resolve => setTimeout(resolve, 200))
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } }
          if (parsed.id === 2 && parsed.result?.tools) toolNames = parsed.result.tools.map(t => t.name)
        } catch {
          /* not JSON */
        }
      }
    }
    child.kill()
    check('the serve surface answered tools/list', toolNames !== null, `${lines.length} lines`)
    if (toolNames) {
      check(
        'a settings-denied tool is NOT advertised (FC-026 live)',
        !toolNames.includes('Write'),
        JSON.stringify(toolNames.filter(n => /^(Write|Read|Edit)$/.test(n))),
      )
      check('undenied siblings still are', toolNames.includes('Read'))
    }
    rmSync(projDir, { recursive: true, force: true })
  }
}

section('§5 CALL-TIME ENFORCEMENT LIVE (the second symptom: containment)')
{
  const DIST = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(DIST)) {
    check('dist/mercury.mjs exists (build first — this leg drives the artifact)', false)
  } else {
    const projDir = realpathSync(mkdtempSync(join(tmpdir(), 'pool-denies-serve-')))
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'pool-denies-outside-')))
    writeFileSync(join(projDir, 'inside.txt'), 'INSIDE-SENTINEL-TEXT\n')
    writeFileSync(join(outsideDir, 'outside.txt'), 'OUTSIDE-SECRET-TEXT\n')
    const child = spawn('node', [DIST, 'mcp', 'serve'], {
      cwd: projDir,
      env: { ...process.env, MERCURY_CONFIG_DIR: HOME },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const lines: string[] = []
    let buffer = ''
    child.stdout.on('data', d => {
      buffer += String(d)
      let idx
      while ((idx = buffer.indexOf('\n')) !== -1) {
        lines.push(buffer.slice(0, idx))
        buffer = buffer.slice(idx + 1)
      }
    })
    const send = (msg: unknown): void => void child.stdin.write(JSON.stringify(msg) + '\n')
    const awaitResult = async (id: number): Promise<{ text: string; isError: boolean } | null> => {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as {
              id?: number
              result?: { content?: Array<{ text?: string }>; isError?: boolean }
            }
            if (parsed.id === id && parsed.result) {
              return {
                text: (parsed.result.content ?? []).map(c => c.text ?? '').join('\n'),
                isError: parsed.result.isError === true,
              }
            }
          } catch {
            /* not JSON */
          }
        }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      return null
    }
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })

    send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'Read', arguments: { file_path: join(projDir, 'inside.txt') } } })
    const inside = await awaitResult(10)
    check(
      'a Read INSIDE the served directory still answers',
      inside !== null && !inside.isError && inside.text.includes('INSIDE-SENTINEL-TEXT'),
      inside === null ? 'no response' : inside.text.slice(0, 100).replace(/\s+/g, ' '),
    )

    send({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'Read', arguments: { file_path: join(outsideDir, 'outside.txt') } } })
    const outside = await awaitResult(11)
    check(
      'a Read OUTSIDE the served directory refuses (FC-026 second symptom)',
      outside !== null && outside.isError && !outside.text.includes('OUTSIDE-SECRET-TEXT'),
      outside === null ? 'no response' : outside.text.slice(0, 120).replace(/\s+/g, ' '),
    )

    send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'Bash', arguments: { command: 'echo serve-bash-probe > bash-marker.txt' } } })
    const bash = await awaitResult(12)
    check(
      'an ask-band tool refuses on this unattended surface (named refusal)',
      bash !== null && bash.isError && /PermissionRefused/.test(bash.text),
      bash === null ? 'no response' : bash.text.slice(0, 120).replace(/\s+/g, ' '),
    )
    check(
      'and its side effect never landed',
      !existsSync(join(projDir, 'bash-marker.txt')),
    )

    child.kill()
    rmSync(projDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  }
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-pool-assembly-denies: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-pool-assembly-denies: all green')

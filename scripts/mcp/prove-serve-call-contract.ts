#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'serve-contract-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_PROOF_DIST ?? join(ROOT, 'dist', 'mercury.mjs')

console.log('mercury mcp serve: an unknown tool and bad arguments answer as -32602 with the field named; a failure reply carries no stack trace')

console.log('\n[1] the handler by reading')
{
  const serve = readFileSync(join(ROOT, 'src/entrypoints/mcp.ts'), 'utf8')
  const describeAt = serve.indexOf('function describeToolError')
  const describe = serve.slice(describeAt, serve.indexOf('\n}\n', describeAt))
  check('the failure words never carry error.stack', describeAt !== -1 && !describe.includes('.stack'))
  check('an unknown tool is a protocol error with InvalidParams', /ProtocolError\(ProtocolErrorCode\.InvalidParams, `Tool \$\{request\.params\.name\} not found`\)/.test(serve))
  check('arguments are parsed against the tool schema before anything runs', /inputSchema\.safeParse\(repairToolInput\(tool,/.test(serve) && /formatZodValidationError\(tool\.name, parsed\.error/.test(serve))
}

console.log('\n[2] the served surface live')
if (!existsSync(DIST)) {
  check('the built artifact exists (build first — this leg drives it)', false, DIST)
} else {
  const projDir = realpathSync(mkdtempSync(join(tmpdir(), 'serve-contract-proj-')))
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'serve-contract-outside-')))
  writeFileSync(join(projDir, 'inside.txt'), 'INSIDE-SENTINEL-TEXT\n')
  writeFileSync(join(outsideDir, 'outside.txt'), 'OUTSIDE-TEXT\n')
  const child = spawn('node', [DIST, 'mcp', 'serve'], { cwd: projDir, env: { ...process.env, MERCURY_CONFIG_DIR: HOME }, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
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
  type Reply = { id?: number; result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { code: number; message: string } }
  const send = (msg: unknown): void => void child.stdin.write(JSON.stringify(msg) + '\n')
  const awaitReply = async (id: number): Promise<Reply | null> => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as Reply
          if (parsed.id === id && (parsed.result !== undefined || parsed.error !== undefined)) return parsed
        } catch {
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return null
  }
  const textOf = (reply: Reply | null): string => (reply?.result?.content ?? []).map(c => c.text ?? '').join('\n')
  const hasStack = (text: string): boolean => /\n\s+at /.test(text) || text.includes('mercury.mjs') || text.includes('file://')
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const init = await awaitReply(1)
  check('the handshake answers', init?.result !== undefined)

  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } })
  const unknown = await awaitReply(2)
  check('an unknown tool answers the JSON-RPC error -32602 naming the tool', unknown?.error?.code === -32602 && unknown.error.message.includes('no_such_tool'), JSON.stringify(unknown))

  const bad: Array<[string, Record<string, unknown>, string]> = [
    ['Read with file_path of the wrong type', { name: 'Read', arguments: { file_path: 123 } }, 'file_path'],
    ['Read with the required parameter missing', { name: 'Read', arguments: {} }, 'file_path'],
    ['Read with no arguments key at all', { name: 'Read' }, 'file_path'],
    ['Edit with empty arguments', { name: 'Edit', arguments: {} }, 'file_path'],
    ['Bash with empty arguments', { name: 'Bash', arguments: {} }, 'command'],
  ]
  let id = 10
  for (const [label, params, field] of bad) {
    send({ jsonrpc: '2.0', id, method: 'tools/call', params })
    const reply = await awaitReply(id)
    check(`${label}: -32602 naming \`${field}\``, reply?.error?.code === -32602 && reply.error.message.includes(`\`${field}\``), JSON.stringify(reply)?.slice(0, 200))
    check(`${label}: no stack trace, no build path, no TypeError`, reply?.error !== undefined && !hasStack(reply.error.message) && !reply.error.message.includes('TypeError'), reply?.error?.message.slice(0, 200))
    id++
  }

  send({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'Read', arguments: { file_path: join(outsideDir, 'outside.txt') } } })
  const refused = await awaitReply(30)
  check('a refused call is a tool result with isError and plain words', refused?.result?.isError === true && textOf(refused).includes('PermissionRefused'), JSON.stringify(refused)?.slice(0, 200))
  check('…and no stack trace in it', refused?.result !== undefined && !hasStack(textOf(refused)), textOf(refused).slice(0, 200))

  send({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'Read', arguments: { file_path: join(projDir, 'inside.txt'), limit: null } } })
  const inside = await awaitReply(31)
  check('a valid call (a null optional included) still answers', inside?.result !== undefined && inside.result.isError !== true && textOf(inside).includes('INSIDE-SENTINEL-TEXT'), JSON.stringify(inside)?.slice(0, 200))

  child.kill()
  await Promise.race([closed, new Promise<void>(resolve => setTimeout(resolve, 5_000))])
  removeScratch(projDir)
  removeScratch(outsideDir)
}
removeScratch(HOME)

console.log(failures === 0 ? '\nPASS prove-serve-call-contract' : `\nFAIL prove-serve-call-contract (${failures})`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env node
// Probe a stdio MCP server with no SDK: initialize, list tools, optionally call one.
//
//   mcp_probe.mjs [--call <tool> '<json-args>'] [--timeout-ms 15000] -- <command> [args...]
//   mcp_probe.mjs --self-test
//
// Exit 0 when the handshake and listing succeed (and the call, if any, returns a
// non-error result); 1 on any protocol failure; 2 on usage errors.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PROTOCOL_VERSION = '2026-07-28'

function parseArgs(argv) {
  const out = { call: null, callArgs: {}, timeoutMs: 15000, cmd: [] }
  const sep = argv.indexOf('--')
  const head = sep === -1 ? argv : argv.slice(0, sep)
  out.cmd = sep === -1 ? [] : argv.slice(sep + 1)
  for (let i = 0; i < head.length; i++) {
    const a = head[i]
    if (a === '--call') {
      out.call = head[++i]
      const raw = head[i + 1]
      if (raw && !raw.startsWith('--')) {
        out.callArgs = JSON.parse(raw)
        i++
      }
    } else if (a === '--timeout-ms') out.timeoutMs = Number(head[++i])
    else if (a === '--self-test') out.selfTest = true
    else throw new Error(`unknown option ${a}`)
  }
  return out
}

/** Drive one server process through initialize → tools/list → optional tools/call. */
export function probe(cmd, { call = null, callArgs = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    const pending = new Map()
    let nextId = 1
    let buffer = ''
    const stderr = []
    const timer = setTimeout(() => fail(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs)

    function fail(err) {
      clearTimeout(timer)
      child.kill()
      reject(Object.assign(err, { stderr: stderr.join('') }))
    }
    function send(method, params) {
      const id = nextId++
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      return new Promise((res, rej) => pending.set(id, { res, rej }))
    }
    function notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    }

    child.stderr.on('data', d => stderr.push(String(d)))
    child.on('error', fail)
    child.on('exit', code => {
      if (pending.size > 0) fail(new Error(`server exited with code ${code} before answering`))
    })
    child.stdout.on('data', chunk => {
      buffer += String(chunk)
      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          return fail(new Error(`non-JSON line on stdout (log to stderr instead): ${line.slice(0, 120)}`))
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { res, rej } = pending.get(msg.id)
          pending.delete(msg.id)
          if (msg.error) rej(new Error(`${msg.error.code}: ${msg.error.message}`))
          else res(msg.result)
        }
      }
    })

    ;(async () => {
      const init = await send('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'mcp-probe', version: '1.0.0' },
      })
      notify('notifications/initialized', {})
      const { tools = [] } = await send('tools/list', {})
      let callResult = null
      if (call) callResult = await send('tools/call', { name: call, arguments: callArgs })
      clearTimeout(timer)
      child.kill()
      resolve({ server: init.serverInfo, protocolVersion: init.protocolVersion, tools, callResult })
    })().catch(fail)
  })
}

function report(result, call) {
  console.log(`server: ${result.server?.name ?? '?'} ${result.server?.version ?? ''} (protocol ${result.protocolVersion})`)
  console.log(`tools: ${result.tools.length}`)
  for (const t of result.tools) {
    const props = Object.keys(t.inputSchema?.properties ?? {})
    console.log(`  - ${t.name}(${props.join(', ')})${t.description ? ` — ${t.description}` : ''}`)
  }
  if (call) {
    const r = result.callResult
    console.log(`call ${call}: ${r.isError ? 'ERROR' : 'ok'}`)
    for (const block of r.content ?? []) if (block.type === 'text') console.log(`  ${block.text}`)
    if (r.structuredContent) console.log(`  structured: ${JSON.stringify(r.structuredContent)}`)
    if (r.isError) return 1
  }
  return 0
}

// A minimal in-process MCP server used by --self-test: one tool, protocol-correct.
const SELF_TEST_SERVER = `
const lines = [];
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\\n')) !== -1) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) handle(JSON.parse(l)); } });
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
function handle(msg) {
  if (msg.method === 'initialize') reply(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'self-test', version: '0.0.1' } });
  else if (msg.method === 'tools/list') reply(msg.id, { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
  else if (msg.method === 'tools/call') { const t = msg.params.arguments?.text; if (typeof t !== 'string') reply(msg.id, { isError: true, content: [{ type: 'text', text: 'text required' }] }); else reply(msg.id, { content: [{ type: 'text', text: t }], structuredContent: { text: t } }); }
  else if (msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } }) + '\\n');
}
console.error('self-test server ready');
`

async function selfTest() {
  const cmd = [process.execPath, '-e', SELF_TEST_SERVER]
  const ok = await probe(cmd, { call: 'echo', callArgs: { text: 'hi' } })
  const bad = await probe(cmd, { call: 'echo', callArgs: {} })
  const pass =
    ok.server?.name === 'self-test' &&
    ok.tools.length === 1 &&
    ok.tools[0].name === 'echo' &&
    ok.callResult?.content?.[0]?.text === 'hi' &&
    bad.callResult?.isError === true
  console.log(`self-test: ${pass ? 'PASS' : 'FAIL'}`)
  return pass ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(String(e.message))
    process.exit(2)
  }
  if (opts.selfTest) process.exit(await selfTest())
  if (opts.cmd.length === 0) {
    console.error('usage: mcp_probe.mjs [--call <tool> <json>] -- <command> [args...]')
    process.exit(2)
  }
  try {
    const result = await probe(opts.cmd, opts)
    process.exit(report(result, opts.call))
  } catch (e) {
    console.error(`probe failed: ${e.message}`)
    if (e.stderr) console.error(`server stderr:\n${e.stderr}`)
    process.exit(1)
  }
}

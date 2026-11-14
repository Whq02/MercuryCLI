import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

export async function readViewMcp(home: string, deny: string[] = []) {
  const dist = process.env.MERCURY_PROOF_DIST ?? join(import.meta.dir, '../../dist/mercury.mjs')
  const node = join(dirname(dist), 'vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
  const config = join(home, '.mercury')
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ guardrails: { allow: ['Read', 'Write'], deny } }))
  const child = spawn(node, [dist, 'mcp', 'serve'], { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, MERCURY_CONFIG_DIR: config, MERCURY_TMPDIR: join(home, 'tmp'), MERCURY_BARE: '1', MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none' }, stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map<number, (reply: any) => void>()
  let buffer = '', errors = '', id = 0
  const ended = new Promise<void>(resolve => child.once('close', () => { for (const accept of waiting.values()) accept({ error: { message: errors || 'server closed' } }); waiting.clear(); resolve() }))
  child.stderr.on('data', data => { errors += String(data) })
  child.stdout.on('data', data => {
    buffer += String(data)
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      try { const reply = JSON.parse(line); const accept = waiting.get(reply.id); if (accept) { waiting.delete(reply.id); accept(reply) } } catch {}
    }
  })
  const send = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const key = ++id
    const timer = setTimeout(() => { waiting.delete(key); reject(new Error(`MCP ${method} timed out: ${errors}`)) }, 30000)
    waiting.set(key, reply => { clearTimeout(timer); resolve(reply) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n')
  })
  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'read-view-proof', version: '1' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  return {
    async call(name: string, args: Record<string, unknown>): Promise<string> {
      const reply = await send('tools/call', { name, arguments: args })
      const text = reply.error?.message ?? (reply.result?.content ?? []).map((part: { text?: string }) => part.text ?? '').join('\n')
      try {
        const data = JSON.parse(text)
        if (data.type === 'text' && data.file) return data.file.content + (data.file.anchor ? `\n(anchor: ${data.file.anchor})` : '')
      } catch {}
      return text
    },
    async close() { child.stdin.end(); child.kill(); await ended },
  }
}

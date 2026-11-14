import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export function gitFixture(label: string) {
  const scratch = realpathSync(mkdtempSync(join(process.env.MERCURY_TMPDIR ?? tmpdir(), label)))
  const root = join(scratch, 'repo')
  const home = join(scratch, 'home')
  mkdirSync(root)
  mkdirSync(home)
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@example.invalid',
    GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@example.invalid',
    MERCURY_CONFIG_DIR: home,
  }
  const git = (args: string[], input?: string): string => execFileSync('git', args, {
    cwd: root, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }),
  })
  const put = (file: string, text: string): void => writeFileSync(join(root, file), text)
  const get = (file: string): string => readFileSync(join(root, file), 'utf8')
  git(['init', '--quiet', '--initial-branch=main'])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ guardrails: { allow: ['Git', 'Read', 'Inspect'] } }))
  writeFileSync(join(home, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', projects: { [root]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
  return { scratch, root, home, env, git, put, get, dispose: () => rmSync(scratch, { recursive: true, force: true }) }
}

type Reply = { result?: { tools?: Array<{ name: string; description: string; inputSchema: unknown }>; content?: Array<{ text?: string }> }; error?: { message: string } }

export async function gitClient(world: ReturnType<typeof gitFixture>) {
  const dist = process.env.MERCURY_PROOF_DIST ?? resolve(import.meta.dir, '../../dist/mercury.mjs')
  const reportedHome = execFileSync('node', ['-p', "require('node:os').homedir()"], { env: world.env, encoding: 'utf8' }).trim()
  if (reportedHome !== world.home) throw new Error(`wrong proof home: ${reportedHome}`)
  const child = spawn('node', [dist, 'mcp', 'serve'], { cwd: world.root, env: { ...world.env, MERCURY_LOCAL_PROBE_TARGETS: 'none' }, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  let serial = 0
  let buffer = ''
  let stderr = ''
  const pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  child.stdout.on('data', chunk => {
    buffer += String(chunk)
    let end: number
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      try {
        const reply = JSON.parse(line) as Reply & { id?: number }
        const waiting = reply.id === undefined ? undefined : pending.get(reply.id)
        if (waiting) {
          clearTimeout(waiting.timer)
          pending.delete(reply.id!)
          waiting.resolve(reply)
        }
      } catch {}
    }
  })
  child.once('exit', code => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`MCP exit ${code}: ${stderr}`)) }
    pending.clear()
  })
  const request = (method: string, params: unknown): Promise<Reply> => new Promise((resolve, reject) => {
    const id = ++serial
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout ${method}: ${stderr}`)) }, 60_000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'git-proof', version: '1' } })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const reply = await request('tools/call', { name, arguments: args })
    const text = reply.error?.message ?? reply.result?.content?.map(c => c.text ?? '').join('\n') ?? ''
    try { const data = JSON.parse(text); if (typeof data.result === 'string') return data.result } catch {}
    return text
  }
  return { request, call, close: async () => { child.kill(); await closed } }
}

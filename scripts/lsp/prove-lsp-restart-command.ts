import { mock } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

type FakeServer = {
  name: string
  state: string
  generation: number
  restartCount: number
  lastError: Error | undefined
  capabilities: Record<string, unknown> | undefined
  config: Record<string, unknown>
  restarts: number
  failWith: string | null
  restart(): Promise<void>
}
function fakeServer(name: string, state: string, lastError?: string): FakeServer {
  const server: FakeServer = {
    name,
    state,
    generation: 1,
    restartCount: 0,
    lastError: lastError === undefined ? undefined : new Error(lastError),
    capabilities: state === 'running' ? { renameProvider: true } : undefined,
    config: {},
    restarts: 0,
    failWith: null,
    async restart() {
      server.restarts++
      if (server.failWith !== null) {
        server.state = 'error'
        throw new Error(server.failWith)
      }
      server.state = 'running'
      server.generation++
      server.restartCount++
      server.lastError = undefined
      server.capabilities = { renameProvider: true }
    },
  }
  return server
}
const ts = fakeServer('mercury-ts', 'running')
const pyright = fakeServer('mercury-pyright', 'error', 'spawn pyright-langserver ENOENT')
const servers = new Map<string, FakeServer>([
  [ts.name, ts],
  [pyright.name, pyright],
])
const fakeManager = { getAllServers: () => servers, getServerForFile: () => undefined, getServersForFile: () => [] }
const world = {
  manager: fakeManager as typeof fakeManager | undefined,
  status: { status: 'success' } as { status: string; error?: Error },
  reinitialized: 0,
  waited: 0,
}
const managerPath = new URL('../../src/services/lsp/manager.ts', import.meta.url).pathname
const realManager = await import(managerPath)
mock.module(managerPath, () => ({
  ...realManager,
  getLspServerManager: () => world.manager,
  getInitializationStatus: () => world.status,
  reinitializeLspServerManager: () => {
    world.reinitialized++
  },
  waitForInitialization: async () => {
    world.waited++
  },
}))

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const commandFile = join(ROOT, 'src/commands/lsp/lsp.ts')
const commandModule = existsSync(commandFile) ? await import(commandFile) : null
const say = async (args: string): Promise<string> => {
  if (commandModule === null) return '(no /lsp command in this tree)'
  const result = await commandModule.call(args, {} as never)
  return result.type === 'text' ? result.value : `(${result.type})`
}

section('/lsp status is the serverStatus answer as a screen line')
const status = await say('status')
const ops = (await import('../../src/tools/LSPTool/mercuryOps.ts')) as { serverStatusLines?: (manager: unknown) => string[] }
const opLines = typeof ops.serverStatusLines === 'function' ? ops.serverStatusLines(fakeManager).join('\n') : '(the serverStatus op shares no lines in this tree)'
check('the status lines are byte-identical to the LspRead serverStatus op\'s lines', status === opLines, status)
check('each server reads with its state, generation and restarts', status.includes('mercury-ts — running (gen 1, restarts 0)') && status.includes('mercury-pyright — error (gen 1, restarts 0)') && status.includes('lastError: spawn pyright-langserver ENOENT'), status)

section('/lsp restart <server> restarts that one server and says what it did')
const one = await say('restart mercury-pyright')
check('the named server was restarted once and nothing else', pyright.restarts === 1 && ts.restarts === 0)
check('the answer names the server, its new state, generation and restart count', one === 'Restarted mercury-pyright — running (gen 2, restarts 1).', one)
pyright.failWith = 'spawn pyright-langserver ENOENT'
const failed = await say('restart mercury-pyright')
check('a restart that fails says so with the cause and the state it left', failed.startsWith('mercury-pyright did not come back: spawn pyright-langserver ENOENT') && failed.includes('now error'), failed)
pyright.failWith = null

section('/lsp restart restarts the whole language service and says what it did')
const all = await say('restart')
check('the manager was re-initialised once and awaited', world.reinitialized === 1 && world.waited === 1)
check('the answer names the count and the roster', all === 'Restarted the language servers of this workspace: 2 configured — mercury-ts, mercury-pyright — each starts on the first file it claims.', all)
check('a whole restart restarts no single server by hand', pyright.restarts === 2 && ts.restarts === 0)

section('refusals: an unknown server is refused with the roster, and no other verb exists')
const unknown = await say('restart nope')
check('an unknown name is refused with the roster', unknown === 'No language server named `nope` in this workspace — the roster: mercury-ts, mercury-pyright.', unknown)
check('the refusal restarted nothing', pyright.restarts === 2 && ts.restarts === 0 && world.reinitialized === 1)
const usage = await say('')
check('a bare /lsp prints the two verbs', usage.startsWith('Usage: `/lsp status`') && usage.includes('`/lsp restart [<server>]`'), usage)
for (const bad of ['stop', 'status mercury-ts', 'restart mercury-ts now', 'install pyright', 'list']) {
  const answer = await say(bad)
  check(`\`/lsp ${bad}\` is not a verb`, answer.startsWith(`\`/lsp ${bad}\` is not a verb here.`) && answer.includes('Usage:'), answer)
}
check('the refused spellings restarted nothing', pyright.restarts === 2 && ts.restarts === 0 && world.reinitialized === 1)
const traversal = await say('restart ../../etc/passwd')
check('a path-shaped name is only an unknown server', traversal.startsWith('No language server named `../../etc/passwd`'), traversal)

section('refusals: a session without language servers is told so and starts none')
world.manager = undefined
world.status = { status: 'not-started' }
check('status without a manager', (await say('status')) === 'The language servers are not running in this session.')
check('restart without a manager starts nothing', (await say('restart')) === 'The language servers are not running in this session.' && world.reinitialized === 1)
check('a named restart without a manager starts nothing', (await say('restart mercury-ts')) === 'The language servers are not running in this session.' && ts.restarts === 0)
world.status = { status: 'failed', error: new Error('no servers could be configured') }
check('a failed start is reported with its cause', (await say('status')) === 'The language servers did not start in this session: no servers could be configured')
world.status = { status: 'pending' }
check('a start still in flight is reported as such', (await say('restart')) === 'The language servers are still starting — ask again in a moment.' && world.reinitialized === 1)
world.manager = fakeManager
world.status = { status: 'success' }
servers.clear()
check('a workspace with no configured server says so on status', (await say('status')) === 'No LSP servers are configured for this workspace.')
check('a named restart with no configured server says none is configured', (await say('restart mercury-ts')) === 'No language server named `mercury-ts` in this workspace — none is configured.')

section('the command is listed where every slash command is listed')
const commands = readFileSync(join(ROOT, 'src/commands.ts'), 'utf8')
const domains = readFileSync(join(ROOT, 'src/components/HelpV2/commandDomains.ts'), 'utf8')
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
const index = existsSync(join(ROOT, 'src/commands/lsp/index.ts')) ? readFileSync(join(ROOT, 'src/commands/lsp/index.ts'), 'utf8') : ''
check('src/commands.ts imports and lists it', commands.includes("import lsp from './commands/lsp/index.js'") && /\n  lsp,\n/.test(commands))
check('the help domain health & introspection names it', /'capabilities', 'lsp',/.test(domains))
check('the README roster carries it beside /capabilities', readme.includes('`/capabilities` `/lsp` |'))
check('the command is interactive-only with the two verbs as its hint', index.includes("argumentHint: 'status | restart [<server>]'") && index.includes('supportsNonInteractive: false'))
const instance = readFileSync(join(ROOT, 'src/services/lsp/LSPServerInstance.ts'), 'utf8')
check('an explicit restart carries no per-session cap (the crash-restart cap stays)', !instance.includes('exceeded the restart cap') && instance.includes('exceeded the crash-restart cap'))

if (failures > 0) {
  console.error(`\nprove-lsp-restart-command: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-lsp-restart-command: GREEN')

import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { armScratch, check, cleanup, FAILING_SERVER, FAKE_SERVER, finish, fixtureServer, openToolDoor, REPO, TS_PROBE_FILES, TS_SIDECAR_ENTRY, writeProject } from './lspProofDoor.ts'

const scratch = armScratch('lsp-first-call')
process.env.MERCURY_LSP_SIDECAR_ENTRY = TS_SIDECAR_ENTRY

const PLAIN_JS: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'plain-js', private: true, type: 'module' }),
  'src/math.js': 'export function add(a, b) {\n  return a + b\n}\nexport function sub(a, b) {\n  return a - b\n}\n',
  'src/report.js': "import { add, sub } from './math.js'\nexport function buildTotalReport(items) {\n  return items.reduce((t, i) => add(t, i), 0) - sub(1, 1)\n}\n",
  'src/format.js': 'export function format(n) {\n  return `total: ${n}`\n}\n',
}
const SOLUTION: Record<string, string> = {
  'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './packages/a' }, { path: './packages/b' }] }),
  'packages/a/tsconfig.json': JSON.stringify({ compilerOptions: { composite: true, strict: true, skipLibCheck: true }, include: ['*.ts'] }),
  'packages/a/alpha.ts': 'export const alphaBudget = 1\n',
  'packages/b/tsconfig.json': JSON.stringify({ compilerOptions: { composite: true, strict: true, skipLibCheck: true }, include: ['*.ts'] }),
  'packages/b/beta.ts': 'export function betaTally(): number {\n  return 2\n}\n',
}
const MOSTLY_PY: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'mostly-py', private: true }),
  'tool/one.py': 'def one():\n    return 1\n',
  'tool/two.py': 'def two():\n    return 2\n',
  'tool/three.py': 'def three():\n    return 3\n',
  'scripts/helper.js': 'export const helper = 1\n',
}
const states = (door: Awaited<ReturnType<typeof openToolDoor>>): Record<string, string> => Object.fromEntries([...(door.manager()?.getAllServers() ?? new Map()).entries()].map(([name, server]) => [name, (server as { state: string }).state]))
const running = (door: Awaited<ReturnType<typeof openToolDoor>>): string[] => Object.entries(states(door)).filter(([, state]) => state === 'running').map(([name]) => name).sort()
const pyServer = (name: string, env: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify(fixtureServer(name, FAKE_SERVER, env, '.py', 'python', extra))

console.log('§1 a plain-JS project, no config: the first workspaceSymbol call starts the server and answers')
let door = await openToolDoor(writeProject(scratch, 'plain-js', PLAIN_JS))
try {
  check('no server is running before the first call', running(door).length === 0, JSON.stringify(states(door)))
  const first = await door.drive({ operation: 'workspaceSymbol', query: 'buildTotalReport' })
  check('the first call answers with the symbol and its file', !first.isError && /buildTotalReport/.test(first.text) && /src\/report\.js/.test(first.text) && first.data?.resultCount === 1, first.text)
  check('the TypeScript server is running after it', JSON.stringify(running(door)) === JSON.stringify(['mercury-ts']), JSON.stringify(states(door)))
  const second = await door.drive({ operation: 'workspaceSymbol', query: 'format' })
  check('the next call answers from the running server', !second.isError && /src\/format\.js/.test(second.text), second.text)
  check("the workspace's own format is the answer; TypeScript's standard library is not listed", second.data?.resultCount === 1 && !/lib\.[\w.]*d\.ts/.test(second.text), second.text)
} finally {
  await door.close()
}

console.log('§2 a tsconfig project: the first call answers from the configured project')
const configured = writeProject(scratch, 'configured', TS_PROBE_FILES)
symlinkSync(join(REPO, 'node_modules'), join(configured, 'node_modules'), 'dir')
door = await openToolDoor(configured)
try {
  const first = await door.drive({ operation: 'workspaceSymbol', query: 'budget' })
  check('budget is found in lib.ts on the first call', !first.isError && /lib\.ts/.test(first.text) && /budget/.test(first.text), first.text)
} finally {
  await door.close()
}

console.log('§3 a solution-style tsconfig: the first call searches the referenced projects')
door = await openToolDoor(writeProject(scratch, 'solution', SOLUTION))
try {
  const first = await door.drive({ operation: 'workspaceSymbol', query: 'betaTally' })
  check('betaTally is found in packages/b on the first call', !first.isError && /packages\/b\/beta\.ts/.test(first.text), first.text)
} finally {
  await door.close()
}

console.log('§4 the query implies a file type: that language server starts, not the first configured one')
process.env.MERCURY_LSP_SERVERS = pyServer('py', { FAKE_LSP_MODE: 'normal' })
door = await openToolDoor(writeProject(scratch, 'implied', PLAIN_JS))
try {
  const first = await door.drive({ operation: 'workspaceSymbol', query: 'tally.py' })
  check('the call answers (the fixture server has no symbols)', !first.isError && /No symbols found/.test(first.text), first.text)
  check('the Python server started and the TypeScript server did not', JSON.stringify(running(door)) === JSON.stringify(['env:py']), JSON.stringify(states(door)))
} finally {
  await door.close()
}

console.log("§5 nothing implied: the project's main language picks the server")
door = await openToolDoor(writeProject(scratch, 'mostly-py', MOSTLY_PY))
try {
  const first = await door.drive({ operation: 'workspaceSymbol', query: 'anything' })
  check('the call answers', !first.isError, first.text)
  check('three .py files against one .js file: the Python server is the one started', JSON.stringify(running(door)) === JSON.stringify(['env:py']), JSON.stringify(states(door)))
} finally {
  await door.close()
}

console.log('§6 a start slower than the call can wait: the answer says the server is starting; the next call answers')
process.env.MERCURY_LSP_SERVERS = pyServer('slow', { FAKE_LSP_MODE: 'slow-init', FAKE_LSP_INIT_DELAY_MS: '23000' }, { startupTimeout: 30000 })
door = await openToolDoor(writeProject(scratch, 'slow', MOSTLY_PY))
try {
  const began = Date.now()
  const first = await door.drive({ operation: 'workspaceSymbol', query: 'anything' })
  const waited = Date.now() - began
  check('the answer names the server, the wait and the retry, and is not an error', !first.isError && /the Python language server \(env:slow\) is starting for this workspace and was not ready after 20 s/.test(first.text) && /Send the same call again/.test(first.text) && first.data?.outcome === 'indeterminate', first.text)
  check('the call waited through the start window and its one retry (10 s each) before answering', waited >= 19_000, `${waited} ms`)
  check('the start is still in flight, not failed', states(door)['env:slow'] === 'starting', JSON.stringify(states(door)))
  const second = await door.drive({ operation: 'workspaceSymbol', query: 'anything' })
  check('the next call joins the start and answers once the server is up', !second.isError && /No symbols found/.test(second.text) && states(door)['env:slow'] === 'running', second.text)
} finally {
  await door.close()
}

console.log('§7 a server that fails to start: the first call reports the failure in the start-failure words')
process.env.MERCURY_LSP_SERVERS = JSON.stringify(fixtureServer('broken', FAILING_SERVER, { FAILING_LSP_MODE: 'exit-before-initialize' }, '.py', 'python'))
door = await openToolDoor(writeProject(scratch, 'broken', MOSTLY_PY))
try {
  const first = await door.drive({ operation: 'workspaceSymbol', query: 'anything' })
  check('the failure names the server and the cause, never the old running-yet sentence', first.isError && /the Python language server \(env:broken\) did not start/.test(first.text) && !/No language server is running/.test(first.text), first.text)
} finally {
  await door.close()
  cleanup(scratch)
}
finish('prove-lsp-first-call')

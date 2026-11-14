import { mock } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { enterWorld, localTransportUnavailable, remoteWorld, underScratchHome } from '../remote-files/remoteKit.ts'

const home = underScratchHome(import.meta.path)
process.env.MERCURY_CONFIG_DIR = join(home, '.mercury')
process.env.MERCURY_TMPDIR = join(home, 'tmp')
process.env.MERCURY_BARE = '1'
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
let passed = 0, failed = 0
const check = (name: string, ok: boolean, detail = '') => { ok ? passed++ : failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` ${detail.slice(0, 800)}`}`) }
const unavailable = localTransportUnavailable()
if (unavailable) console.log(`SKIP fake remote POSIX transport: ${unavailable}; the local query engine is covered separately on this platform`)
else {
  const world = await remoteWorld('local', 0, { clientHome: home })
  const leave = enterWorld(world)
  const connection = await import('../../src/services/remoteFiles/connection.ts')
  const scripts: string[] = []
  const remoteRun = connection.remoteRun
  mock.module('../../src/services/remoteFiles/connection.js', () => ({ ...connection, remoteRun: async (authority: unknown, request: { script: string }) => { scripts.push(request.script); return remoteRun(authority as never, request) } }))
  const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
  const { setCwdState, setOriginalCwd } = await import('../../src/bootstrap/state.ts')
  setCwdState(world.data); setOriginalCwd(world.data)
  const context = (denies: string[] = []) => ({ messages: [], abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(100), getAppState: () => ({ toolPermissionContext: { ...getEmptyToolPermissionContext(), alwaysDenyRules: { session: denies } } }) })
  const read = async (path: string, ctx = context()) => {
    try {
      const valid = await FileReadTool.validateInput!({ file_path: path }, ctx as never)
      if (!valid.result) return { text: valid.message, ctx }
      const permission = await FileReadTool.checkPermissions!({ file_path: path }, ctx as never)
      if (permission.behavior === 'deny') return { text: permission.message, ctx }
      const result = await FileReadTool.call({ file_path: path }, ctx as never)
      return { text: String(FileReadTool.mapToolResultToToolResultBlockParam(result.data, 'remote-query').content), ctx }
    } catch (error) { return { text: String(error), ctx } }
  }
  try {
    const path = join(world.data, 'large.jsonl')
    const source = `ssh://box${path}`
    writeFileSync(path, Array.from({ length: 30000 }, (_, n) => JSON.stringify({ n, padding: 'a'.repeat(80) })).join('\n'))
    const query = 'select(.n >= 29997) | {n, text:"REMOTE_FILTER_WITNESS & % + # ?"}'
    const first = await read(`${source}#read?compact=1&limit=2&q=${query}`)
    check('M10 a remote JSONL larger than a megabyte is queried locally', first.text.includes('"n":29997') && first.text.includes('"n":29998') && first.text.includes(`source: ${source}`), first.text)
    check('M10 query/filter punctuation never enters the remote scripts', scripts.length > 0 && scripts.every(script => !script.includes('REMOTE_FILTER_WITNESS') && !script.includes('#read?')), scripts.join('\n'))
    const authority = await read(`SSH://box.zip:27270${path}#read?limit=1&q=.n`)
    check('M10 an uppercase remote scheme and archive-looking authority keep the file path', authority.text.includes('\n0\n') && authority.text.includes(`source: SSH://box.zip:27270${path}`), authority.text)
    check('M09 remote generated output gives neither source coverage nor an anchor', !first.ctx.readFileState.has(source) && !first.text.includes('(anchor:'))
    const match = /Read\(file_path: ("(?:\\.|[^"\\])*")\) continues from there/.exec(first.text)
    if (match) {
      const next = await read(JSON.parse(match[1]!))
      check('M04 remote continuation follows the same complete values', next.text.includes('"n":29999') && next.text.includes('state: complete'), next.text)
    } else check('M04 remote page has its continuation', false, first.text)
    const denied = await read(`${source}#read?q=.n`, context([`Read(${source})`]))
    check('M11 existing remote deny rule applies to the underlying source', !denied.text.includes('target: JSON query') && /den/.test(denied.text), denied.text)
    const literalName = 'literal#read?q=.n'
    writeFileSync(join(world.data, literalName), 'literal remote file\n')
    const literal = await read(`ssh://box${world.data}/${encodeURIComponent(literalName)}`)
    check('M03 encoded remote punctuation stays literal', literal.text.includes('literal remote file') && !literal.text.includes('target: JSON query'), literal.text)
    const invalid = join(world.data, 'broken.jsonl')
    writeFileSync(invalid, '{}\n{bad}')
    const error = await read(`ssh://box${invalid}#read?q=.`)
    check('M07 remote parse failure names the public source and no temporary input', error.text.includes('partial-error') && error.text.includes(`source: ssh://box${invalid}`) && !error.text.includes('/copy-'), error.text)
    const abortContext = context()
    const timer = setTimeout(() => abortContext.abortController.abort(new Error('remote query cancelled')), 350)
    const cancelled = await read(`ssh://box${invalid}#read?q=until(false; .)`, abortContext)
    clearTimeout(timer)
    check('M11 cancellation is not an empty remote-query success', cancelled.text.includes('remote query cancelled') && !cancelled.text.includes('state: complete'), cancelled.text)
    for (const folder of ['json-queries', 'remote-files']) {
      const target = join(process.env.MERCURY_TMPDIR!, folder)
      check(`M11 owned ${folder} copies are removed`, !existsSync(target) || readdirSync(target).length === 0)
    }
  } finally {
    await connection.closeRemoteConnections()
    leave()
    await world.stop()
  }
}
console.log(`${passed}/${passed + failed} checks`)
process.exitCode = failed ? 1 : 0

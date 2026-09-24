#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { check, cleanup, finish, loadEval, section, setup, within } from './lib.js'

const { work } = setup()
const ROOT = resolve(import.meta.dir, '..', '..')
const { evalKernelManager } = await loadEval()
const { splitTopLevelSegments, transformJsCell } = await import('../../src/services/eval/jsCellTransform.ts')
const { buildEvalPrompt } = await import('../../src/tools/EvalTool/prompt.ts')

const bridge: import('../../src/services/eval/kernelManager.js').BridgeServer = async () => ({ ok: false, error: 'no bridge in this proof' })
const run = (owner: string, language: 'js' | 'py', code: string) =>
  within(
    `${language} cell`,
    60_000,
    evalKernelManager.runCell({ owner, cwd: work, input: { language, code }, abortSignal: new AbortController().signal, serveBridge: bridge }),
  )
const MODULE_WORDS = 'ES module'
const IMPORT_FIX = "import { readFileSync } from 'node:fs'"
const DYNAMIC_FIX = "await import('node:fs')"
const CRYPTO_WORDS = 'Web Crypto'
const CRYPTO_FIX = "import { createHash } from 'node:crypto'"
const DIGEST = '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881'
const notes = (outcome: { annotations: string[] }): string => outcome.annotations.join('\n')

try {
  section('§1 the description states the environment')
  const prompt = await buildEvalPrompt()
  const dialect = prompt.slice(prompt.indexOf('## Dialect notes'))
  check('the prompt says the JS kernel is an ES module without require', dialect.includes(MODULE_WORDS) && dialect.includes('`require`'), dialect.slice(0, 400))
  check('…names the import forms that work', dialect.includes(IMPORT_FIX) && dialect.includes(DYNAMIC_FIX), dialect.slice(0, 400))
  check("…says the global crypto is the Web Crypto API and where Node's is", dialect.includes(CRYPTO_WORDS) && dialect.includes(CRYPTO_FIX), dialect.slice(0, 600))
  check('…and how long an idle kernel is kept before its state is gone', /idle for \d+ minutes/.test(prompt), prompt.slice(prompt.indexOf('## Persistence'), prompt.indexOf('## Persistence') + 500))

  section("§2 the kernel: what a failed cell of the record's shapes says")
  const r1 = await run('owner-esm', 'js', "const fs = require('node:fs')\nconst n = 1")
  check('require fails as a ReferenceError', r1.status === 'error' && r1.error?.name === 'ReferenceError' && r1.error.value === 'require is not defined', JSON.stringify(r1.error))
  check('…and the note names the ES module fact and both import forms', notes(r1).includes(MODULE_WORDS) && notes(r1).includes(IMPORT_FIX) && notes(r1).includes(DYNAMIC_FIX), notes(r1))
  for (const [code, name] of [
    ['module.exports = 1', 'module'],
    ['exports.x = 1', 'exports'],
    ['__dirname', '__dirname'],
    ['__filename', '__filename'],
  ] as const) {
    const r = await run('owner-esm', 'js', code)
    check(`${name} fails with the same note`, r.status === 'error' && (r.error?.value ?? '') === `${name} is not defined` && notes(r).includes(MODULE_WORDS), `${JSON.stringify(r.error)} ${notes(r)}`)
  }
  const c1 = await run('owner-crypto', 'js', "crypto.createHash('sha256').update('x').digest('hex')")
  check('crypto.createHash fails as a TypeError', c1.status === 'error' && c1.error?.name === 'TypeError' && c1.error.value === 'crypto.createHash is not a function', JSON.stringify(c1.error))
  check('…and the note names the Web Crypto fact and the node:crypto import', notes(c1).includes(CRYPTO_WORDS) && notes(c1).includes(CRYPTO_FIX), notes(c1))
  const c2 = await run('owner-crypto', 'js', 'crypto.randomBytes(4)')
  check('any Node crypto method called on the global gets the same note', c2.status === 'error' && notes(c2).includes(CRYPTO_WORDS), `${JSON.stringify(c2.error)} ${notes(c2)}`)
  const c3 = await run('owner-crypto', 'js', "import { createHash } from 'node:crypto'\ncreateHash('sha256').update('x').digest('hex')")
  check('the named fix works: a top-level import of node:crypto', c3.status === 'ok' && c3.resultRepr === `'${DIGEST}'`, JSON.stringify(c3.error ?? c3.resultRepr))
  const c4 = await run('owner-crypto', 'js', "const { createHmac } = await import('node:crypto')\ntypeof createHmac")
  check('…and the dynamic form', c4.status === 'ok' && c4.resultRepr === "'function'", JSON.stringify(c4.error ?? c4.resultRepr))
  const c5 = await run('owner-crypto', 'js', "typeof crypto.subtle + '/' + typeof crypto.randomUUID()")
  check('the Web Crypto members are there as the note says', c5.status === 'ok' && c5.resultRepr === "'object/string'", JSON.stringify(c5.error ?? c5.resultRepr))
  const u1 = await run('owner-other', 'js', 'zzzUndefinedName')
  check('an unrelated ReferenceError carries no environment note', u1.status === 'error' && !notes(u1).includes(MODULE_WORDS) && !notes(u1).includes(CRYPTO_WORDS), notes(u1))
  const u2 = await run('owner-other', 'js', 'const o = {}\no.missing()')
  check('an unrelated TypeError carries no environment note', u2.status === 'error' && !notes(u2).includes(CRYPTO_WORDS), notes(u2))
  const p1 = await run('owner-py', 'py', 'require')
  check('a Python NameError carries no JavaScript note', p1.status === 'error' && !notes(p1).includes(MODULE_WORDS), notes(p1))

  section('§3 a failed cell names only the bindings that initialised')
  const v1 = await run('owner-var', 'js', "var fs = require('node:fs'); var path = require('node:path'); var crypto = require('node:crypto'); var repo = '/x'")
  check('the var cell failed at its first statement', v1.status === 'error' && v1.error?.value === 'require is not defined', JSON.stringify(v1.error))
  const survived = v1.annotations.find(a => a.startsWith('bindings that survived') || a.startsWith('no top-level binding'))
  check('nothing is reported as survived', survived !== undefined && survived.startsWith('no top-level binding of this cell survived'), survived ?? notes(v1))
  check('…and the four names are reported as never bound', survived !== undefined && /never bound[^:]*: fs, path, crypto, repo/.test(survived), survived ?? '')
  const v2 = await run('owner-var', 'js', "JSON.stringify(['fs' in globalThis, 'path' in globalThis, 'repo' in globalThis, typeof crypto, typeof crypto.subtle])")
  check('the next cell finds no undefined globals written for them and the real crypto intact', v2.status === 'ok' && v2.resultRepr === "'[false,false,false,\"object\",\"object\"]'", JSON.stringify(v2.error ?? v2.resultRepr))
  const v3 = await run('owner-var', 'js', "var a = 1, b = (() => { throw new Error('stop') })(), c = 3")
  const v3note = v3.annotations.find(n => n.startsWith('bindings that survived')) ?? ''
  check('a var initialised before a later declarator threw still survives', /survived this failed cell: a;/.test(v3note) && /never bound[^:]*: b, c/.test(v3note), notes(v3))
  const ok1 = await run('owner-var', 'js', 'var kept; let alsoKept; const set = 2')
  const ok2 = await run('owner-var', 'js', "JSON.stringify(['kept' in globalThis, 'alsoKept' in globalThis, set])")
  check('a clean cell still persists its uninitialised declarations', ok1.status === 'ok' && ok2.resultRepr === "'[true,true,2]'", JSON.stringify(ok2.error ?? ok2.resultRepr))

  section("§4 a declaration after a block's closing brace on the same line persists")
  const d1 = await run('owner-dense', 'js', 'var a=0;var b=[];for(var c of [1,2]){a+=c;b.push(c)}var d=a*2;for(var e of b){d+=e}var f=1;if(f){f=2}const g=f+1')
  check('the dense cell ran', d1.status === 'ok', JSON.stringify(d1.error))
  const d2 = await run('owner-dense', 'js', 'JSON.stringify([a, b, d, f, g])')
  check('every top-level declaration persisted, the ones written after a } included', d2.status === 'ok' && d2.resultRepr === "'[3,[1,2],9,2,3]'", JSON.stringify(d2.error ?? d2.resultRepr))
  const mixed = "for(const q of [1]){}var afterFor=1\nconst o = {\n  a: 1,\n}\nconst y = [1, 2, 3]\n  .map(v => v * 2)\nclass K {}var afterClass=2;function h(){}let afterFn=3"
  const t = transformJsCell(mixed)
  check('the transform reads the declarations after a block, a class body and a function body', ['afterFor', 'o', 'y', 'K', 'afterClass', 'h', 'afterFn'].every(n => t.persistedNames.includes(n)), JSON.stringify(t.persistedNames))
  check('…and leaves a multi-line object literal and a leading-dot chain whole', t.code.includes('const o = {\n  a: 1,\n}') && t.code.includes('const y = [1, 2, 3]\n  .map(v => v * 2)'), t.code)
  check('the segments still join back to the source byte for byte', splitTopLevelSegments(mixed).map(s => s.text).join('') === mixed)
  const dense = 'for(var p of [1]){for(var r of [2]){}}var hookCount=0;var cohort=[];for(var cp of [1]){var parts=1}var trims=[]'
  const t2 = transformJsCell(dense)
  check("the record's shape: a var after a nested loop's braces is read, a var inside a loop is not", t2.persistedNames.includes('hookCount') && t2.persistedNames.includes('cohort') && t2.persistedNames.includes('trims') && !t2.persistedNames.includes('parts'), JSON.stringify(t2.persistedNames))
  const t3 = transformJsCell('const s = `a${1}b`\nconst tpl = `${[1].map(v => `${v}`)}`var notSplit = 1')
  check('a brace closing a template interpolation never ends a segment', t3.code.includes('`${[1].map(v => `${v}`)}`var notSplit') , t3.code)

  section('§5 the built product: the Eval tool in print mode, the results read off the wire')
  const distAt = process.argv.indexOf('--dist')
  const DIST = distAt < 0 ? join(ROOT, 'dist', 'mercury.mjs') : resolve(process.argv[distAt + 1]!)
  const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', 'bin', 'node')
  const nodeBin = existsSync(vendoredNode) ? vendoredNode : Bun.which('node')
  if (!existsSync(DIST) || !nodeBin) {
    check('dist/mercury.mjs and a node binary present (the pooled gate prebuilds the dist)', false, DIST)
  } else {
    const { FIXTURE_API_KEY, seedFirstRun } = await import('../lib/firstRunSeed.ts')
    const { startFixtureApi } = await import('../lib/fixtureApi.ts')
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'js-kernel-words-home-')))
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'js-kernel-words-cwd-')))
    const configDir = join(home, '.mercury')
    seedFirstRun(configDir, [cwd])
    const MODEL = 'claude-opus-4-8'
    const pythonForChild = ((): string | null => {
      const seen = new Set<string>()
      for (const dir of (process.env.PATH ?? '').split(':')) {
        const candidate = join(dir, 'python3')
        if (dir === '' || seen.has(candidate) || !existsSync(candidate)) continue
        seen.add(candidate)
        const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
        const version = /Python\s+(\d+)\.(\d+)/.exec(`${probe.stdout ?? ''}${probe.stderr ?? ''}`)
        if (version && (Number(version[1]) > 3 || (Number(version[1]) === 3 && Number(version[2]) >= 10))) return candidate
      }
      return null
    })()
    console.log(`        note: Python kernel for the print seat: ${pythonForChild ?? 'none of 3.10 or newer on this PATH — the Python value-shape leg is skipped here (the pure §B leg of prove-cell-failure-state.ts carries it)'}`)
    const fixture = await startFixtureApi([
      { kind: 'tool_use', name: 'Eval', input: { language: 'js', code: "var fs = require('node:fs'); var repo = '/x'", title: "the record's require cell" }, whenModel: MODEL },
      { kind: 'tool_use', name: 'Eval', input: { language: 'js', code: "crypto.createHash('sha256').update('x').digest('hex')", title: "the record's createHash cell" }, whenModel: MODEL },
      { kind: 'tool_use', name: 'Eval', input: { language: 'js', code: "import { createHash } from 'node:crypto'\ncreateHash('sha256').update('x').digest('hex')", title: 'the fix' }, whenModel: MODEL },
      ...[
        '// setup\nconst a = 1\nconst b = 2',
        'JSON.stringify([typeof a, typeof b])',
        'const c = 3 // note\nconst d = 4',
        'JSON.stringify([typeof c, typeof d])',
        'const splitter = /,\\s*in\\s+/, n = 1',
        'JSON.stringify([typeof splitter, typeof n])',
      ].map(code => ({ kind: 'tool_use' as const, name: 'Eval', input: { language: 'js', code, title: 'declaration boundaries' }, whenModel: MODEL })),
      { kind: 'tool_use', name: 'Eval', input: { language: 'js', code: "const r = await tool.Bash({ command: 'echo boom; exit 1' })\nJSON.stringify([r.code, r.stdout.includes('boom'), r.stderr])", title: 'a shell exit as a value' }, whenModel: MODEL },
      { kind: 'tool_use', name: 'Eval', input: { language: 'js', code: "const a = await tool.attempt.Bash({ command: 'echo boom; exit 1' })\nconst w = await tool.attempt.Bash({ command: 'nohup sleep 1 &' })\nJSON.stringify([a.ok, a.value && a.value.code, w.ok, String(w.error).includes(\"Ward 'self-daemonize' blocked this Bash call\"), String(w.error).includes('<tool_use_error>')])", title: 'attempt: an exit is a value, a ward refusal an error' }, whenModel: MODEL },
      ...(pythonForChild !== null
        ? [{ kind: 'tool_use' as const, name: 'Eval', input: { language: 'py', code: "r = tool.Bash(command='echo boom; exit 1')\n[r['code'], 'boom' in r['stdout'], r['stderr']]", title: 'py: a shell exit as a value' }, whenModel: MODEL }]
        : []),
      { kind: 'text', text: 'kernel-words-probe: done', whenModel: MODEL },
      { kind: 'text', text: 'kernel-words-probe: done', whenModel: MODEL },
    ])
    const env = {
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'dumb',
      SHELL: '/bin/bash',
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_TEAMS_DIR: join(home, 'teams'),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_OPERATOR: 'sam',
      MERCURY_VERIFY_EVIDENCE: '0',
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: FIXTURE_API_KEY,
      ...(pythonForChild !== null ? { MERCURY_EVAL_PYTHON: pythonForChild } : {}),
    }
    const startedAt = Date.now()
    const outcome = await new Promise<{ exit: number | null; stdout: string; stderr: string; ms: number }>(resolveRun => {
      const child = spawn(nodeBin, [DIST, '-p', 'kernel-words-probe: run the three', '--model', MODEL, '--dangerously-bypass-permissions'], { cwd, env, detached: true })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', d => (stdout += d))
      child.stderr.on('data', d => (stderr += d))
      const deadline = setTimeout(() => {
        try {
          process.kill(-(child.pid as number), 'SIGKILL')
        } catch {
          void 0
        }
      }, 120_000)
      child.on('close', exit => {
        clearTimeout(deadline)
        resolveRun({ exit, stdout, stderr, ms: Date.now() - startedAt })
      })
    })
    await fixture.close()
    const requests = fixture.messageRequests()
    const last = requests[requests.length - 1]
    const results: { text: string; isError: boolean }[] = []
    for (const message of ((last?.body as { messages?: Array<{ role?: string; content?: unknown }> })?.messages ?? [])) {
      if (message.role !== 'user' || !Array.isArray(message.content)) continue
      for (const block of message.content as Array<{ type?: string; content?: unknown; is_error?: boolean }>) {
        if (block.type !== 'tool_result') continue
        const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? (block.content as Array<{ text?: string }>).map(b => b.text ?? '').join('') : ''
        results.push({ text, isError: block.is_error === true })
      }
    }
    const bundleFacts = ((): string => {
      try {
        const manifest = JSON.parse(readFileSync(join(dirname(DIST), 'manifest.json'), 'utf8')) as { version?: string; buildTree?: string }
        return `${manifest.version ?? 'version unknown'} · buildTree ${manifest.buildTree ?? 'unknown'}`
      } catch {
        return 'no manifest beside the bundle'
      }
    })()
    console.log(`        note: bundle under proof ${DIST} (${bundleFacts})`)
    console.log(`        note: print mode exit ${outcome.exit} after ${outcome.ms}ms; ${requests.length} model requests`)
    for (const [i, r] of results.entries()) console.log(`        note: result ${i + 1}${r.isError ? ' (error)' : ''}: ${JSON.stringify(r.text.slice(0, i >= 9 ? 400 : 160))}`)
    check('the artifact ran the cells and closed the turn', outcome.exit === 0 && /kernel-words-probe: done/.test(outcome.stdout), `exit ${outcome.exit} ${JSON.stringify(outcome.stderr.slice(-300))}`)
    const expectedResults = pythonForChild !== null ? 12 : 11
    check(`all ${expectedResults} results reached the model`, results.length === expectedResults, String(results.length))
    check('artifact: a leading comment preserves both declarations', results[4]?.text.includes('["number","number"]') === true, JSON.stringify(results[4]))
    check('artifact: a trailing comment preserves both declarations', results[6]?.text.includes('["number","number"]') === true, JSON.stringify(results[6]))
    check('artifact: the regex initializer runs and preserves its bindings', results[7] !== undefined && !results[7].isError && results[8]?.text.includes('["object","number"]') === true, JSON.stringify(results.slice(7)))
    const [req, hash, fix] = results
    check('artifact: the require cell is an error whose words name the ES module fact and the import fix', req !== undefined && req.isError && req.text.includes('require is not defined') && req.text.includes(MODULE_WORDS) && req.text.includes(IMPORT_FIX), JSON.stringify(req))
    check('artifact: …and reports fs and repo as never bound, not as survivors', req !== undefined && /never bound[^:]*: fs, repo/.test(req.text) && !/survived this failed cell: fs/.test(req.text), JSON.stringify(req))
    check('artifact: the createHash cell names the Web Crypto fact and the node:crypto import', hash !== undefined && hash.isError && hash.text.includes('crypto.createHash is not a function') && hash.text.includes(CRYPTO_WORDS) && hash.text.includes(CRYPTO_FIX), JSON.stringify(hash))
    check('artifact: the fix cell returns the digest', fix !== undefined && !fix.isError && fix.text.includes(DIGEST), JSON.stringify(fix))
    const [shellExit, attempts, pyExit] = results.slice(9)
    console.log(`        record (${bundleFacts}) · the shell-exit cell: is_error=${String(shellExit?.isError)} · "Shell command failed"=${shellExit?.text.includes('Shell command failed') ?? false} · boom in the result=${shellExit?.text.includes('boom') ?? false} · wrapped=${shellExit?.text.includes('<tool_use_error>') ?? false}`)
    check('artifact: a bridged Bash call whose command exited 1 returns { code: 1, stdout, stderr: "" } and the JS cell runs on', shellExit !== undefined && !shellExit.isError && shellExit.text.includes(`⇒ '[1,true,""]'`), JSON.stringify(shellExit))
    check('artifact: tool.attempt.Bash answers { ok: true, value: { code: 1 } } for an exit and { ok: false, error } with the ward\'s bare words for a refusal', attempts !== undefined && !attempts.isError && attempts.text.includes(`⇒ '[true,1,false,true,false]'`), JSON.stringify(attempts))
    if (pythonForChild !== null) check('artifact: the Python kernel reads the same value shape', pyExit !== undefined && !pyExit.isError && pyExit.text.includes(`⇒ [1, True, '']`), JSON.stringify(pyExit))
    else console.log('        note: the Python value-shape check is skipped in this print seat (no python3 of 3.10 or newer on PATH); prove-cell-failure-state.ts §B B6 carries it through the real bridge')
    const leftovers = spawnSync('pgrep', ['-f', `${configDir}/eval/runner-`], { encoding: 'utf8' }).stdout.trim()
    if (leftovers !== '') {
      for (const pid of leftovers.split('\n')) {
        try {
          process.kill(Number(pid), 'SIGKILL')
        } catch {
          void 0
        }
      }
    }
    check('no kernel of this run left behind', leftovers === '', leftovers)
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
} finally {
  await evalKernelManager.disposeAll()
  check('no kernel left behind', evalKernelManager.kernelCount() === 0)
  cleanup()
}
finish('JS-KERNEL-WORDS')

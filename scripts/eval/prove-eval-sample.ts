import { check, cleanup, finish, loadEval, makeContext, setup, within } from './lib.js'

const { work } = setup()
process.env.MERCURY_SAMPLES = '1'
const { evalKernelManager } = await loadEval()
const { makeEvalBridgeServer } = await import('../../src/services/eval/evalBridge.js')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
const { closeSampleListener } = await import('../../src/services/samples/listener.js')
const { handleSampleCall } = await import('../../src/services/samples/bridge.js')
const { SAMPLE_HTML_CAP_BYTES } = await import('../../src/services/samples/contracts.js')
const { EvalTool } = await import('../../src/tools/EvalTool/EvalTool.js')
const owner = makeOwnerKey({ workspace: work, sessionId: 'eval-sample-proof', lane: 'main' })
const context = await makeContext()
const cellAbort = new AbortController()
const serveBridge = makeEvalBridgeServer({ owner, context, cellAbort, canUseTool: (async (_tool, input) => ({ behavior: 'allow', updatedInput: input })) as never })
const run = (language: 'py' | 'js', code: string) => within('sample cell', 60_000, evalKernelManager.runCell({ owner, cwd: work, input: { language, code }, abortSignal: cellAbort.signal, serveBridge }))
const text = (out: Awaited<ReturnType<typeof run>>, language: 'py' | 'js') => String(EvalTool.mapToolResultToToolResultBlockParam({ ...out, language }, 'sample-proof').content)

try {
  const py = await run('py', 'r1 = sample({"name": "p", "html": "<p>1</p>"}); r2 = sample(name="p", html="<p>2</p>", ask="show me the table"); (r1["version"], r2["version"])')
  check('Python positional and keyword sample calls keep versions', py.status === 'ok' && py.resultRepr === '(1, 2)', text(py, 'py'))
  check('result lists both samples and the request', py.samples?.length === 2 && text(py, 'py').includes('[sample] p v2 → ') && text(py, 'py').includes(' · asked: show me the table'))
  if (py.samples?.[0]) {
    const page = new URL(py.samples[0].url)
    page.pathname += '/v/2.html'
    const response = await fetch(page)
    check('sample listener serves the published page', response.ok && await response.text() === '<p>2</p>')
  }
  const js = await run('js', "const saved = await sample({name: 'q', html: '<p>x</p>'}); saved.version")
  check('JavaScript sample returns the same contract', js.status === 'ok' && js.resultRepr === '1' && js.samples?.[0]?.title === 'q', text(js, 'js'))
  const invalid = await run('py', 'sample({"name": "p"})')
  check('sample errors raise into Python', invalid.status === 'error' && text(invalid, 'py').includes('RuntimeError: sample() needs the page as html'), text(invalid, 'py'))
  check('nested ledger names a failed sample', invalid.annotations.some(note => note.includes('1 sample failed (sample() needs the page as html)')))
  const errors: Array<[unknown, string]> = [
    [null, 'sample() takes one object: { name, title?, html, ask? }'],
    [{ html: '<p>x</p>' }, 'sample() needs a name (the same name publishes the next version)'],
    [{ name: 'x' }, 'sample() needs the page as html'],
    [{ name: 'x', html: 'x'.repeat(SAMPLE_HTML_CAP_BYTES + 1) }, 'sample() keeps at most 8 MB of html per version'],
    [{ name: 'x', html: 'x', title: 1 }, 'sample(): title must be a string'],
    [{ name: 'x', html: 'x', ask: 1 }, 'sample(): ask must be a string'],
  ]
  for (const [payload, expected] of errors) {
    let actual = ''
    try { await handleSampleCall(owner, payload) } catch (error) { actual = error instanceof Error ? error.message : String(error) }
    check(expected, actual === expected, actual)
  }
  const noSamples = await run('py', '7')
  check('samples belong only to their cell', noSamples.samples === undefined)
  process.env.MERCURY_SAMPLES = '0'
  for (const language of ['py', 'js'] as const) {
    const off = await run(language, language === 'py' ? 'sample(name="off", html="x")' : 'await sample({name: "off", html: "x"})')
    check(`${language} sample honors the gate`, off.status === 'error' && text(off, language).includes('samples are off in this session (MERCURY_SAMPLES=0)'), text(off, language))
  }
} finally {
  cellAbort.abort()
  await evalKernelManager.disposeAll()
  await closeSampleListener()
  cleanup()
}
finish('EVAL SAMPLE')

#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const HERE = dirname(fileURLToPath(import.meta.url))
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
void POSIX_MODES

function runCase(body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn02-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  for (const dir of [home, project]) mkdirSync(dir, { recursive: true })
  try {
    const src = `
      process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
      process.env.MERCURY_CREDENTIAL_STORE = 'file'
      process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
      process.env.NODE_ENV = 'test'
      delete process.env.MERCURY_HOME
      globalThis.MACRO = { VERSION: '1.0.0' }
      process.chdir(${JSON.stringify(project)})
      const fs = await import('node:fs')
      const path = await import('node:path')
      const SRC = ${JSON.stringify(SRC)}
      const HOME = ${JSON.stringify(home)}
      const PROJECT = ${JSON.stringify(project)}
      const out = {}
      ${body}
      process.stdout.write('\\n' + JSON.stringify(out))
      process.exit(0)
    `
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '', MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none' },
    })
    if (res.status !== 0) throw new Error(`scenario failed (${res.status}): ${res.stderr.slice(-1500)}`)
    return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\npersistModelChoice — failed compat endpoint lookup refuses instead of saving as default')
{
  const r = runCase(`
    const settingsPath = path.join(HOME, 'settings.json')
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2) + '\\n')
    process.env.MERCURY_COMPAT_BASE_URL = 'ftp://bad-url'
    const { persistModelChoice } = await import(path.join(SRC, 'commands/model/persistModelChoice.ts'))
    const result = persistModelChoice('compat/pod-1/llama')
    out.outcome = result.outcome
    out.sentence = result.sentence
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    out.savedModel = after.engine?.model ?? null
    delete process.env.MERCURY_COMPAT_BASE_URL
    const control = persistModelChoice('claude-sonnet-4-6')
    out.controlOutcome = control.outcome
    const afterControl = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    out.controlSaved = afterControl.engine?.model ?? null
  `)
  check('persistModelChoice refuses when compatModelEndpoint throws', r.outcome === 'refused', `got outcome=${String(r.outcome)} sentence=${String(r.sentence)}`)
  check('persistModelChoice does not write engine.model to userSettings on lookup failure', r.savedModel === null, `savedModel=${String(r.savedModel)}`)
  check('persistModelChoice refusal uses refusedSentence wording', typeof r.sentence === 'string' && r.sentence.includes('not saved as your default'), `sentence=${String(r.sentence)}`)
  check('control: normal model still saves to userSettings', r.controlOutcome === 'saved' && r.controlSaved === 'claude-sonnet-4-6', `got ${String(r.controlOutcome)} / ${String(r.controlSaved)}`)
}

console.log('\nmercuryModel — failed TensorFold pairing surfaces the error notice instead of swallowing it')
{
  const r = runCase(`
    const mod = await import(path.join(SRC, 'commands/model/mercuryModel.tsx'))
    if (typeof mod.runModelTensorFoldPair !== 'function') {
      out.missing = true
    } else {
      const notices = []
      let readCalls = 0
      await mod.runModelTensorFoldPair(
        { kind: 'pair', host: { name: 'studio', baseUrl: 'http://127.0.0.1:9999', origin: 'lan' }, code: '123456' },
        {
          pair: async () => { throw new Error('pair handshake refused') },
          read: async () => { readCalls++ },
          setNotice: w => notices.push(w),
          isOpen: () => true,
        },
      )
      out.notices = notices
      out.readCalls = readCalls
      const closedNotices = []
      await mod.runModelTensorFoldPair(
        { kind: 'pair', host: { name: 'studio', baseUrl: 'http://127.0.0.1:9999', origin: 'lan' }, code: '123456' },
        {
          pair: async () => { throw new Error('should not publish after close') },
          read: async () => {},
          setNotice: w => closedNotices.push(w),
          isOpen: () => false,
        },
      )
      out.closedNotices = closedNotices
    }
  `)
  check('pair failure sets the notice to the error message', Array.isArray(r.notices) && r.notices[0] === 'pair handshake refused', JSON.stringify(r))
  check('pair failure does not publish notice after picker closes', Array.isArray(r.closedNotices) && r.closedNotices.length === 0, JSON.stringify(r))
}

console.log('\npicker/select — catalogue refresh rejections keep the error detail in the notice')
{
  const r = runCase(`
    const { mock } = await import('bun:test')
    const nousPath = path.join(SRC, 'services/providers/nous/nousCatalogue.ts')
    const openaiCatPath = path.join(SRC, 'services/providers/openai/openaiCatalogue.ts')
    const openaiAcctPath = path.join(SRC, 'services/providers/openai/openaiAccounts.ts')
    const orCatPath = path.join(SRC, 'services/providers/openrouter/openrouterCatalogue.ts')
    const orAcctPath = path.join(SRC, 'services/providers/openrouter/openrouterAccounts.ts')
    const gemCatPath = path.join(SRC, 'services/providers/gemini/geminiCatalogue.ts')
    const gemAcctPath = path.join(SRC, 'services/providers/gemini/geminiAccounts.ts')
    const hfCatPath = path.join(SRC, 'services/providers/huggingface/huggingfaceCatalogue.ts')
    const moonAcctPath = path.join(SRC, 'services/providers/moonshot/moonshotAccounts.ts')
    const moonCatPath = path.join(SRC, 'services/providers/moonshot/moonshotCatalogue.ts')
    const optsPath = path.join(SRC, 'utils/model/modelOptions.ts')
    const [realNous, realOaiCat, realOaiAcct, realOrCat, realOrAcct, realGemCat, realGemAcct, realHfCat, realMoonAcct, realMoonCat, realOpts] = await Promise.all([
      import(nousPath), import(openaiCatPath), import(openaiAcctPath), import(orCatPath), import(orAcctPath),
      import(gemCatPath), import(gemAcctPath), import(hfCatPath), import(moonAcctPath), import(moonCatPath), import(optsPath),
    ])
    mock.module(optsPath, () => ({ ...realOpts, getGptSeatAvailability: () => ({ state: 'disabled', why: 'catalogue-error' }) }))
    mock.module(openaiAcctPath, () => ({ ...realOaiAcct, resolveOpenaiAccount: () => ({ kind: 'api-key', label: 'OpenAI key' }) }))
    mock.module(openaiCatPath, () => ({ ...realOaiCat, refreshOpenaiCatalogue: async () => { throw new Error('openai tls failed') } }))
    mock.module(orCatPath, () => ({ ...realOrCat, getOpenrouterAvailability: () => ({ state: 'ready' }), refreshOpenrouterCatalogue: async () => { throw new Error('openrouter dns failed') } }))
    mock.module(orAcctPath, () => ({ ...realOrAcct, resolveOpenrouterRequestAuth: () => ({ account: { keySource: 'stored' } }) }))
    mock.module(nousPath, () => ({ ...realNous, getNousAvailability: () => ({ state: 'ready' }), refreshNousCatalogue: async () => { throw new Error('nous tls failed') } }))
    mock.module(gemCatPath, () => ({ ...realGemCat, getGeminiAvailability: () => ({ state: 'ready' }), refreshGeminiCatalogue: async () => { throw new Error('gemini timeout') } }))
    mock.module(gemAcctPath, () => ({ ...realGemAcct, resolveGeminiAccount: () => ({ kind: 'api-key' }) }))
    mock.module(hfCatPath, () => ({ ...realHfCat, getHuggingfaceAvailability: () => ({ state: 'ready' }), refreshHuggingfaceCatalogue: async () => { throw new Error('hf 503') } }))
    mock.module(moonAcctPath, () => ({ ...realMoonAcct, resolveMoonshotAccount: () => ({ label: 'Kimi key' }) }))
    mock.module(moonCatPath, () => ({ ...realMoonCat, refreshMoonshotCatalogue: async () => { throw new Error('moonshot socket reset') }, moonshotCatalogueRows: () => ({ source: { kind: 'unread' }, rows: [] }) }))
    const { connectGpt, connectOpenrouter, connectNous, connectGemini, connectHuggingface, selectKeyLane } = await import(path.join(SRC, 'commands/model/picker/select.ts'))
    const cap = () => { const a = []; return { a, ctx: { setNotice: v => a.push(v), onDone: () => {} } } }
    const g = cap(); connectGpt(g.ctx)
    const o = cap(); connectOpenrouter(o.ctx)
    const n = cap(); connectNous(n.ctx)
    const gm = cap(); connectGemini(gm.ctx)
    const h = cap(); connectHuggingface(h.ctx)
    const m = cap(); selectKeyLane(m.ctx, '__mercury_connect__:moonshot', 'moonshot')
    await new Promise(resolve => setTimeout(resolve, 60))
    out.gpt = g.a.at(-1) ?? null
    out.or = o.a.at(-1) ?? null
    out.nous = n.a.at(-1) ?? null
    out.gem = gm.a.at(-1) ?? null
    out.hf = h.a.at(-1) ?? null
    out.moon = m.a.at(-1) ?? null
  `)
  check('connectGpt surfaces refresh rejection detail', typeof r.gpt === 'string' && r.gpt.includes('(openai tls failed)'), `got ${String(r.gpt)}`)
  check('connectOpenrouter surfaces refresh rejection detail', typeof r.or === 'string' && r.or.includes('(openrouter dns failed)'), `got ${String(r.or)}`)
  check('connectNous surfaces refresh rejection detail', typeof r.nous === 'string' && r.nous.includes('(nous tls failed)'), `got ${String(r.nous)}`)
  check('connectGemini surfaces refresh rejection detail', typeof r.gem === 'string' && r.gem.includes('(gemini timeout)'), `got ${String(r.gem)}`)
  check('connectHuggingface surfaces refresh rejection detail', typeof r.hf === 'string' && r.hf.includes('(hf 503)'), `got ${String(r.hf)}`)
  check('moonshot selectKeyLane surfaces refresh rejection detail', typeof r.moon === 'string' && r.moon.includes('(moonshot socket reset)'), `got ${String(r.moon)}`)
}

console.log('\nsessions — failed clipboard copy omits the false copied-to-clipboard line')
{
  const r = runCase(`
    const mod = await import(path.join(SRC, 'commands/sessions/sessions.tsx'))
    if (typeof mod.crossProjectResumeNotice !== 'function') {
      out.missing = true
    } else {
      out.failed = await mod.crossProjectResumeNotice('cd /other && mercury --resume abc', async () => { throw new Error('pbcopy failed') })
      out.ok = await mod.crossProjectResumeNotice('cd /other && mercury --resume abc', async () => '')
    }
  `)
  check('failed clipboard copy omits (copied to the clipboard)', typeof r.failed === 'string' && !r.failed.includes('(copied to the clipboard)') && r.failed.includes('cd /other && mercury --resume abc'), JSON.stringify(r))
  check('control: succeeding clipboard copy keeps (copied to the clipboard)', typeof r.ok === 'string' && r.ok.includes('(copied to the clipboard)'), JSON.stringify(r))
}

console.log('\nBootSaturnScreen — model/preset/project listing failures surface in formNote instead of empty pickers')
{
  const r = runCase(`
    const { mock } = await import('bun:test')
    const optsPath = path.join(SRC, 'utils/model/modelOptions.ts')
    const presetPath = path.join(SRC, 'services/mcp/presetStore.ts')
    const factsPath = path.join(SRC, 'utils/bootCardFacts.ts')
    const [realOpts, realPresets, realFacts] = await Promise.all([import(optsPath), import(presetPath), import(factsPath)])
    mock.module(optsPath, () => ({ ...realOpts, getModelOptions: () => { throw new Error('model options unreadable') } }))
    mock.module(presetPath, () => ({ ...realPresets, listKitPresets: () => { throw new Error('presets config unreadable') } }))
    mock.module(factsPath, () => ({ ...realFacts, workedInProjects: () => { throw new Error('projects dir EACCES') } }))
    const screen = await import(path.join(SRC, 'components/BootSaturnScreen.tsx'))
    const actions = await import(path.join(SRC, 'components/bootSaturn/actions.ts'))
    if (typeof screen.runSaturnFormRowEdit !== 'function' || typeof screen.liveModelOptions !== 'function') {
      out.missing = true
    } else {
      const form = screen.freshSaturnForm({ modelKey: 'claude-sonnet-4-6', workspaceDir: PROJECT })
      const probe = field => {
        const notes = []
        const picks = []
        screen.runSaturnFormRowEdit(
          () => actions.editFormRowOf({
            form,
            setFormNote: n => notes.push(n),
            setFormPrompt: () => {},
            setFormPick: p => picks.push(p),
            modelOptionsOf: undefined,
            liveModelOptions: screen.liveModelOptions,
            saturnWorkspacePickOptions: screen.saturnWorkspacePickOptions,
            projectsOf: undefined,
            liveProjectDirs: screen.liveProjectDirs,
            setForm: () => {},
            presetsOf: undefined,
            livePresets: screen.livePresets,
            saturnOpeningPickOptions: screen.saturnOpeningPickOptions,
          }, field),
          n => notes.push(n),
        )
        return { note: notes.at(-1) ?? null, picks: picks.length }
      }
      out.model = probe('model')
      out.kit = probe('kit')
      out.workspace = probe('workspace')
    }
  `)
  check('model listing throw sets formNote and opens no empty picker', (r.model as { note?: string; picks?: number } | undefined)?.note === 'model options unreadable' && (r.model as { picks?: number } | undefined)?.picks === 0, JSON.stringify(r.model ?? r))
  check('preset listing throw sets formNote and opens no empty picker', (r.kit as { note?: string; picks?: number } | undefined)?.note === 'presets config unreadable' && (r.kit as { picks?: number } | undefined)?.picks === 0, JSON.stringify(r.kit ?? r))
  check('project listing throw sets formNote and opens no empty picker', (r.workspace as { note?: string; picks?: number } | undefined)?.note === 'projects dir EACCES' && (r.workspace as { picks?: number } | undefined)?.picks === 0, JSON.stringify(r.workspace ?? r))
}

console.log('\nBootSettingsScreen — failed liveCount returns null (not 0) and failed daemonControlRpc settles receipt as refused')
{
  const r = runCase(`
    const mod = await import(path.join(SRC, 'components/BootSettingsScreen.tsx'))
    if (typeof mod.readLiveSessionCount !== 'function' || typeof mod.deliverSpawnSwitchReceipt !== 'function') {
      out.missing = true
    } else {
      out.failedCount = await mod.readLiveSessionCount(async () => { throw new Error('workers file EACCES') })
      out.okCount = await mod.readLiveSessionCount(async () => 3)
      let state = {
        phase: 'ready',
        workers: [{
          runnerId: 'r1',
          sessionId: 'sess-1234',
          snapshotRevision: 1,
          receipts: [{ env: 'MERCURY_SUBAGENTS', label: 'Subagents', target: '0', outcome: 'queued', reason: 'queued for next turn' }],
        }],
      }
      await mod.deliverSpawnSwitchReceipt(
        'sess-1234',
        state.workers[0].receipts[0],
        'subagents',
        {
          rpc: async () => { throw new Error('daemon socket ECONNREFUSED') },
          isCancelled: () => false,
          setApply: updater => { state = updater(state) },
        },
      )
      out.settled = state.workers[0].receipts[0]
    }
  `)
  check('failed countLiveConcourseWorkers resolves to null instead of 0', r.failedCount === null && r.okCount === 3, JSON.stringify(r))
  const settled = r.settled as { outcome?: string; reason?: string } | undefined
  check('rejected daemonControlRpc marks receipt refused with error message instead of queued', settled?.outcome === 'refused' && settled?.reason === 'daemon socket ECONNREFUSED', JSON.stringify(settled ?? r))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

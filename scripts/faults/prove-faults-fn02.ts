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
    const { persistModelChoice } = await import(${JSON.stringify(join(SRC, 'commands/model/persistModelChoice.ts'))})
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
    const mod = await import(${JSON.stringify(join(SRC, 'commands/model/mercuryModel.tsx'))})
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
    const nousPath = path.join(SRC, 'models/roads/nous/nousCatalogue.ts')
    const openaiCatPath = path.join(SRC, 'models/roads/openai/openaiCatalogue.ts')
    const openaiAcctPath = path.join(SRC, 'models/roads/openai/openaiAccounts.ts')
    const orCatPath = path.join(SRC, 'models/roads/openrouter/openrouterCatalogue.ts')
    const orAcctPath = path.join(SRC, 'models/roads/openrouter/openrouterAccounts.ts')
    const gemCatPath = path.join(SRC, 'models/roads/gemini/geminiCatalogue.ts')
    const gemAcctPath = path.join(SRC, 'models/roads/gemini/geminiAccounts.ts')
    const hfCatPath = path.join(SRC, 'models/roads/huggingface/huggingfaceCatalogue.ts')
    const moonAcctPath = path.join(SRC, 'models/roads/moonshot/moonshotAccounts.ts')
    const moonCatPath = path.join(SRC, 'models/roads/moonshot/moonshotCatalogue.ts')
    const optsPath = path.join(SRC, 'models/catalogue/modelOptions.ts')
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
    const { connectGpt, connectOpenrouter, connectNous, connectGemini, connectHuggingface, selectKeyLane } = await import(${JSON.stringify(join(SRC, 'commands/model/picker/select.ts'))})
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
    const mod = await import(${JSON.stringify(join(SRC, 'commands/sessions/sessions.tsx'))})
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
    const optsPath = path.join(SRC, 'models/catalogue/modelOptions.ts')
    const presetPath = path.join(SRC, 'integrations/mcp/presetStore.ts')
    const factsPath = path.join(SRC, 'screen/boot-face/bootCardFacts.ts')
    const [realOpts, realPresets, realFacts] = await Promise.all([import(optsPath), import(presetPath), import(factsPath)])
    mock.module(optsPath, () => ({ ...realOpts, getModelOptions: () => { throw new Error('model options unreadable') } }))
    mock.module(presetPath, () => ({ ...realPresets, listKitPresets: () => { throw new Error('presets config unreadable') } }))
    mock.module(factsPath, () => ({ ...realFacts, workedInProjects: () => { throw new Error('projects dir EACCES') } }))
    const screen = await import(${JSON.stringify(join(SRC, 'screen/boot-face/BootSaturnScreen.tsx'))})
    const actions = await import(${JSON.stringify(join(SRC, 'screen/boot-face/saturn/actions.ts'))})
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
    const mod = await import(${JSON.stringify(join(SRC, 'screen/boot-face/BootSettingsScreen.tsx'))})
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

console.log('\nFeedback — failed getIsGit records undefined + error instead of false, and unreadable transcript records error')
{
  const r = runCase(`
    const { mock } = await import('bun:test')
    const gitPath = path.join(SRC, 'platform/git/git.ts')
    const storagePath = path.join(SRC, 'sessions/transcripts/sessionStorage.ts')
    const [realGit, realStorage] = await Promise.all([import(gitPath), import(storagePath)])
    const transcriptFile = path.join(HOME, 'unreadable-transcript.jsonl')
    fs.writeFileSync(transcriptFile, '{"type":"user"}\\n', { mode: 0o600 })
    const posix = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
    if (posix) fs.chmodSync(transcriptFile, 0o200)
    mock.module(gitPath, () => ({ ...realGit, getIsGit: async () => { throw new Error('git binary missing') } }))
    mock.module(storagePath, () => ({
      ...realStorage,
      getTranscriptPathForSession: () => transcriptFile,
      loadAllCrewmateTranscriptsFromDisk: async () => ({}),
    }))
    const mod = await import(${JSON.stringify(join(SRC, 'commands/feedback/BugReport.tsx'))})
    if (typeof mod.gatherReport !== 'function') {
      out.missing = true
    } else {
      const gathered = await mod.gatherReport('bug desc', [], {})
      out.isGit = gathered.report.is_git === undefined ? 'UNDEFINED' : gathered.report.is_git
      out.errors = gathered.errors.map(e => e.error)
      out.posix = posix
      if (posix) fs.chmodSync(transcriptFile, 0o600)
      fs.unlinkSync(transcriptFile)
      const absent = await mod.gatherReport('bug desc', [], {})
      out.absentHasTranscriptErr = absent.errors.some(e => e.error.includes('session transcript'))
    }
  `)
  check('failed getIsGit does not report is_git as false', r.isGit === 'UNDEFINED', JSON.stringify(r))
  const errs = Array.isArray(r.errors) ? (r.errors as string[]) : []
  check('failed getIsGit appends git probe error to report errors', errs.some(e => e.includes('git binary missing')), JSON.stringify(errs))
  if (r.posix === true) {
    check('unreadable transcript appends transcript read error to report errors', errs.some(e => e.includes('session transcript could not be read')), JSON.stringify(errs))
    check('control: absent transcript (ENOENT) does not record a transcript read error', r.absentHasTranscriptErr === false, JSON.stringify(r))
  }
}

console.log('\nFeedback — gatherReport reads sealed pre-fold history through the history door')
{
  const r = runCase(`
    process.env.NODE_ENV = 'development'
    const { randomUUID } = await import('node:crypto')
    const { enableConfigs } = await import(${JSON.stringify(join(SRC, 'platform/settings/config.ts'))})
    enableConfigs()
    const { setOriginalCwd, setProjectRoot, getSessionId } = await import(${JSON.stringify(join(SRC, 'boot/process-state/processState.ts'))})
    setOriginalCwd(PROJECT)
    setProjectRoot(PROJECT)
    const { getTranscriptPathForSession, recordTranscript, flushSessionStorage } = await import(${JSON.stringify(join(SRC, 'sessions/transcripts/sessionStorage.ts'))})
    const { historyHead, historyLines } = await import(${JSON.stringify(join(SRC, 'sessions/transcripts/historyParts.ts'))})
    const { createUserMessage } = await import(${JSON.stringify(join(SRC, 'engine/messages/messages.ts'))})
    const beforeMsg = createUserMessage({ content: 'FEEDBACK_BEFORE_FOLD_NEEDLE' })
    const boundaryMsg = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      content: 'Conversation compacted',
      level: 'info',
      isMeta: false,
      compactMetadata: { trigger: 'manual', preTokens: 10000 },
    }
    const afterMsg = createUserMessage({ content: 'FEEDBACK_AFTER_FOLD_NEEDLE' })
    await recordTranscript([beforeMsg])
    await flushSessionStorage()
    await recordTranscript([beforeMsg, boundaryMsg, afterMsg])
    await flushSessionStorage()
    const transcriptFile = getTranscriptPathForSession(getSessionId())
    const partHead = historyHead(transcriptFile)
    const liveRaw = fs.readFileSync(transcriptFile, 'utf8')
    const logical = Buffer.concat([...historyLines(transcriptFile)]).toString('utf8')
    const { gatherReport } = await import(${JSON.stringify(join(SRC, 'commands/feedback/BugReport.tsx'))})
    const gathered = await gatherReport('sealed transcript bug', [], {})
    const raw = typeof gathered.report.raw_transcript === 'string' ? gathered.report.raw_transcript : ''
    out.sealedBefore = partHead.before
    out.liveHasBefore = liveRaw.includes('FEEDBACK_BEFORE_FOLD_NEEDLE')
    out.rawHasBefore = raw.includes('FEEDBACK_BEFORE_FOLD_NEEDLE')
    out.rawHasAfter = raw.includes('FEEDBACK_AFTER_FOLD_NEEDLE')
    out.rawMatchesLogical = raw === logical
    out.hasTranscriptErr = gathered.errors.some(e => e.error.includes('session transcript'))
  `)
  check('product writer sealed the pre-fold row out of the live head', typeof r.sealedBefore === 'number' && r.sealedBefore > 0 && r.liveHasBefore === false, JSON.stringify(r))
  check('gatherReport raw_transcript includes sealed pre-fold and live post-fold rows identically to historyLines', r.rawHasBefore === true && r.rawHasAfter === true && r.rawMatchesLogical === true && r.hasTranscriptErr === false, JSON.stringify(r))
}

console.log('\nFileEditToolDiff — colliding remote multi-edits fall back to per-edit hunks instead of empty no-visible-change')
{
  const r = runCase(`
    const mod = await import(${JSON.stringify(join(SRC, 'tools/edit/EditDiff.tsx'))})
    if (typeof mod.loadDiff !== 'function') {
      out.missing = true
    } else {
      const remote = 'ssh://host/tmp/demo.txt'
      const shown = await mod.loadDiff(remote, [
        { old_string: 'alpha', new_string: 'beta' },
        { old_string: 'beta', new_string: 'gamma' },
      ])
      out.hunkCount = shown.hunks.length
      const noop = await mod.loadDiff(remote, [{ old_string: 'same', new_string: 'same' }])
      out.noopHunkCount = noop.hunks.length
    }
  `)
  check('colliding remote multi-edits still render diff hunks instead of empty', typeof r.hunkCount === 'number' && r.hunkCount >= 2, JSON.stringify(r))
  check('control: genuinely byte-identical remote edit still yields 0 hunks', r.noopHunkCount === 0, JSON.stringify(r))
}

console.log('\nKitMenuScreen — failed liveCount returns null instead of falsely reporting 0 established sessions')
{
  const r = runCase(`
    const mod = await import(${JSON.stringify(join(SRC, 'screen/boot-face/KitMenuScreen.tsx'))})
    if (typeof mod.readKitLiveSessionCount !== 'function') {
      out.missing = true
    } else {
      out.failedCount = await mod.readKitLiveSessionCount(async () => { throw new Error('workers file EACCES') })
      out.okCount = await mod.readKitLiveSessionCount(async () => 2)
    }
  `)
  check('failed countLiveConcourseWorkers resolves to null instead of 0', r.failedCount === null && r.okCount === 2, JSON.stringify(r))
}

console.log('\npicker/headings — failed slot derivation reports unread account status instead of not connected')
{
  const r = runCase(`
    const { mock } = await import('bun:test')
    const slotsPath = path.join(SRC, 'models/roads/accountSlots.ts')
    const usabilityPath = path.join(SRC, 'models/roads/providerUsability.ts')
    const [realSlots, realUsability] = await Promise.all([import(slotsPath), import(usabilityPath)])
    const baseUsability = realUsability.resolveProviderUsability()
    mock.module(slotsPath, () => ({ ...realSlots, deriveFamilySlotGroups: () => { throw new Error('auth file EACCES') } }))
    mock.module(usabilityPath, () => ({
      ...realUsability,
      resolveProviderUsability: () => ({
        ...baseUsability,
        deepseek: { ...baseUsability.deepseek, credential: 'api-key', blockers: [] },
      }),
    }))
    const { providerHeadingsOf } = await import(${JSON.stringify(join(SRC, 'commands/model/picker/headings.ts'))})
    const { DEEPSEEK_MODEL_GROUP } = await import(${JSON.stringify(join(SRC, 'models/catalogue/modelOptions.ts'))})
    const headings = providerHeadingsOf(999)
    out.deepseek = headings[DEEPSEEK_MODEL_GROUP]
  `)
  const ds = r.deepseek as { reason?: string } | undefined
  check('credentialed key lane reports unreadable account status instead of not connected', ds?.reason === 'account status could not be read (auth file EACCES) — run /logins to check', JSON.stringify(ds ?? r))
}

console.log('\nrename — failed name generation reports the failure instead of saying no conversation context')
{
  const r = runCase(`
    const { mock } = await import('bun:test')
    const streamPath = path.join(SRC, 'models/roads/anthropic/streamCore.ts')
    const realStream = await import(streamPath)
    mock.module(streamPath, () => ({
      ...realStream,
      callUtilityModel: async () => { throw new Error('rate limited') },
    }))
    const { generateSessionName } = await import(${JSON.stringify(join(SRC, 'commands/rename/generateSessionName.ts'))})
    const { call } = await import(${JSON.stringify(join(SRC, 'commands/rename/rename.ts'))})
    const userMsg = { type: 'user', message: { role: 'user', content: 'Fix the billing webhook retries' } }
    let threwMsg = null
    try {
      await generateSessionName([userMsg], new AbortController().signal)
    } catch (e) {
      threwMsg = e instanceof Error ? e.message : String(e)
    }
    out.threwMsg = threwMsg
    let doneText = null
    await call(
      text => { doneText = text },
      { messages: [userMsg], abortController: new AbortController(), setAppState: () => {} },
      '',
    )
    out.doneText = doneText
    let emptyText = null
    await call(
      text => { emptyText = text },
      { messages: [], abortController: new AbortController(), setAppState: () => {} },
      '',
    )
    out.emptyText = emptyText
  `)
  check('generateSessionName rethrows queryUtility errors', r.threwMsg === 'rate limited', JSON.stringify(r))
  check('rename surfaces failure sentence instead of no conversation context', r.doneText === 'Could not generate a session name (rate limited). Use /rename <name> to name the session directly.', JSON.stringify(r))
  check('control: empty conversation still says no conversation context', typeof r.emptyText === 'string' && r.emptyText.startsWith('No conversation context'), JSON.stringify(r))
}

console.log('\nBootSaturnScreen — unreadable receipt file surfaces fire-history error line in detail pane')
{
  const r = runCase(`
    const { mock } = await import('bun:test')
    const receiptsPath = path.join(SRC, 'daemon/switchboard/sessionReceipts.ts')
    const realReceipts = await import(receiptsPath)
    mock.module(receiptsPath, () => ({
      ...realReceipts,
      readSessionReceipts: () => { throw new Error('receipts EACCES') },
    }))
    const screen = await import(${JSON.stringify(join(SRC, 'screen/boot-face/BootSaturnScreen.tsx'))})
    if (typeof screen.liveReceiptsOf !== 'function') {
      out.missing = true
    } else {
      const row = {
        sessionTitle: 'demo',
        sessionId: 'sess-1',
        workspaceId: PROJECT,
        parked: false,
        facts: { id: 'sched-1', kind: 'fire', when: 'every hour', nextFireMs: Date.now() + 60_000 },
        schedule: {
          id: 'sched-1',
          when: { kind: 'cron', cron: '0 * * * *' },
          modelKey: 'claude-sonnet-4-6',
          account: { family: 'anthropic', source: 'oauth' },
          action: { kind: 'fire', prompt: 'hi' },
        },
        held: [],
      }
      const receipts = screen.liveReceiptsOf(row)
      out.lines = screen.saturnDetailLines(row, Date.now(), receipts).join(' ')
    }
  `)
  check('unreadable receipts show fire history error sentence in saturnDetailLines', typeof r.lines === 'string' && r.lines.includes('fire history could not be read (receipts EACCES) — press r to retry'), JSON.stringify(r))
}

console.log('\nSelectInputOption — failed clipboard image paste reports the failure sentence instead of swallowing it')
{
  const r = runCase(`
    const mod = await import(${JSON.stringify(join(SRC, 'screen/select/SelectInputOption.tsx'))})
    if (typeof mod.runSelectImagePaste !== 'function') {
      out.missing = true
    } else {
      const errors = []
      await mod.runSelectImagePaste({
        read: async () => { throw new Error('clipboard unavailable') },
        onImagePaste: () => {},
        onError: msg => errors.push(msg),
      })
      out.error = errors.at(-1) ?? null
    }
  `)
  check('clipboard paste rejection produces the error sentence', r.error === 'Could not paste image from clipboard (clipboard unavailable) — copy the image again and retry', JSON.stringify(r))
}

console.log('\nLogSelector — failed session rename reports the failure sentence instead of closing silently')
{
  const r = runCase(`
    const mod = await import(${JSON.stringify(join(SRC, 'screen/session-chooser/SessionBrowser.tsx'))})
    if (typeof mod.commitListingRename !== 'function') {
      out.missing = true
    } else {
      const errors = []
      let renamed = 0
      await mod.commitListingRename(
        { sessionId: '11111111-1111-4111-8111-111111111111', fullPath: '/tmp/session.jsonl' },
        'my-name',
        {
          save: async () => { throw new Error('disk full') },
          onRenamed: () => { renamed++ },
          onError: msg => errors.push(msg),
        },
      )
      out.error = errors.at(-1) ?? null
      out.renamed = renamed
    }
  `)
  check('rename failure produces the error sentence and does not call onRenamed', r.error === 'Could not rename session (disk full) — press ctrl+r to try again' && r.renamed === 0, JSON.stringify(r))
}

console.log('\nMercuryContentSearch — non-abort search failure returns failure sentence instead of 0 hits')
{
  const r = runCase(`
    const mod = await import(${JSON.stringify(join(SRC, 'screen/composer/MercuryContentSearch.tsx'))})
    if (typeof mod.runContentSearch !== 'function') {
      out.missing = true
    } else {
      const ac1 = new AbortController()
      out.failed = await mod.runContentSearch('needle', ac1.signal, async () => { throw new Error('rg EACCES') })
      const ac2 = new AbortController()
      ac2.abort()
      out.aborted = await mod.runContentSearch('needle', ac2.signal, async () => { throw new Error('aborted') })
    }
  `)
  const failed = r.failed as { matches?: unknown[]; error?: string | null } | undefined
  check('non-abort loadMatches failure returns the failure sentence', failed?.error === 'search could not run (rg EACCES) — edit the query or retry', JSON.stringify(failed ?? r))
  check('aborted loadMatches returns null without surfacing an error', r.aborted === null, JSON.stringify(r))
}

console.log('\nMercuryFileOpen — failed file listing returns failure sentence instead of 0 files')
{
  const r = runCase(`
    const mod = await import(${JSON.stringify(join(SRC, 'screen/composer/MercuryFileOpen.tsx'))})
    if (typeof mod.runFileOpenLoad !== 'function') {
      out.missing = true
    } else {
      out.failed = await mod.runFileOpenLoad('src', async () => { throw new Error('readdir EACCES') })
      out.ok = await mod.runFileOpenLoad('src', async () => [{ id: 'a', displayText: 'a.ts' }])
    }
  `)
  const failed = r.failed as { results?: unknown[]; error?: string | null } | undefined
  const ok = r.ok as { results?: unknown[]; error?: string | null } | undefined
  check('loadFiles rejection returns failure sentence', failed?.error === 'could not list files (readdir EACCES) — edit the filter or retry', JSON.stringify(failed ?? r))
  check('control: succeeding loadFiles returns results with null error', ok?.error === null && ok?.results?.length === 1, JSON.stringify(ok ?? r))
}

console.log('\nMercuryFilesMenu — unreadable folder returns a warning row with advice visible at panel width')
{
  const r = runCase(`
    const mod = await import(${JSON.stringify(join(SRC, 'screen/fullscreen-layout/MercuryFilesMenu.tsx'))})
    const React = await import('react')
    const { ThemeProvider } = await import(${JSON.stringify(join(SRC, 'screen/theme/ThemeProvider.tsx'))})
    const { mountOffscreen, settle } = await import(${JSON.stringify(join(HERE, '../lib/settingsPopupHarness.ts'))})
    const posix = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
    out.posix = posix
    if (typeof mod.readFolder !== 'function') {
      out.missing = true
    } else {
      const locked = path.join(PROJECT, 'some-long-project-folder', 'nested-subpath', 'locked')
      fs.mkdirSync(locked, { recursive: true })
      fs.writeFileSync(path.join(locked, 'secret.txt'), 'hi\\n')
      if (posix) fs.chmodSync(locked, 0o000)
      try {
        out.locked = mod.readFolder(PROJECT, path.join('some-long-project-folder', 'nested-subpath', 'locked'))
        out.absent = mod.readFolder(PROJECT, 'does-not-exist')
        const m = await mountOffscreen(
          React.createElement(
            ThemeProvider,
            {},
            React.createElement(mod.MercuryFilesMenu, {
              root: locked,
              width: mod.FILES_MENU_WIDTH,
              rowBudget: 8,
              onClose: () => {},
              onPick: () => {},
            }),
          ),
          mod.FILES_MENU_WIDTH + 4,
          20,
        )
        await settle(80)
        out.painted = m.screen()
        m.unmount()
      } finally {
        if (posix) fs.chmodSync(locked, 0o700)
      }
    }
  `)
  if (r.posix === true) {
    const locked = Array.isArray(r.locked) ? (r.locked as Array<{ name?: string; path?: string }>) : []
    const painted = String(r.painted ?? '')
    check('unreadable folder produces warning entry with advice before error', locked.length === 1 && typeof locked[0]?.name === 'string' && locked[0].name.startsWith('folder could not be read — check permissions (') && locked[0].name.endsWith(')'), JSON.stringify(locked))
    check('unreadable folder advice is visible on screen at FILES_MENU_WIDTH', painted.includes('folder could not be read — check permissions'), painted.slice(0, 400))
    check('control: absent folder (ENOENT) still returns empty array', Array.isArray(r.absent) && (r.absent as unknown[]).length === 0, JSON.stringify(r.absent))
  }
}

console.log('\nOnboarding — failed terminal setup shows failure sentence instead of advancing silently')
{
  const r = runCase(`
    const mod = await import(${JSON.stringify(join(SRC, 'boot/first-run/Onboarding.tsx'))})
    if (typeof mod.runOnboardingTerminalSetup !== 'function') {
      out.missing = true
    } else {
      let doneOnFail = 0
      let errMsg = null
      await mod.runOnboardingTerminalSetup(
        async () => { throw new Error('permission denied') },
        () => { doneOnFail++ },
        msg => { errMsg = msg },
      )
      let doneOnOk = 0
      let errOnOk = null
      await mod.runOnboardingTerminalSetup(
        async () => {},
        () => { doneOnOk++ },
        msg => { errOnOk = msg },
      )
      out.doneOnFail = doneOnFail
      out.errMsg = errMsg
      out.doneOnOk = doneOnOk
      out.errOnOk = errOnOk
    }
  `)
  check('failed setupTerminal holds the step and surfaces the failure sentence', r.doneOnFail === 0 && r.errMsg === 'Terminal setup failed (permission denied) — run /keysetup later; press Enter to continue', JSON.stringify(r))
  check('control: succeeding setupTerminal calls onDone without error', r.doneOnOk === 1 && r.errOnOk === null, JSON.stringify(r))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

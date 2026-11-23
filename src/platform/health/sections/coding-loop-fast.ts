import { errorMessage, isENOENT } from '../../errors/errors.js'
import { whichSync } from '../../processes/which.js'
import { flagAsSet, type CheckSpec } from '../healthReport.js'

async function settleToolList(): Promise<void> {
  await import('../../../tools/kit/toolList.js')
}

export function idePlaneFastCheck(devToolsSecurity?: () => string | null): CheckSpec {
  return {
    id: 'ide-plane-fast',
    label: 'IDE plane',
    run: async () => {
      const { selectPythonInterpreter } = await import('../../../integrations/ide/pythonProject.js')
      const { probeBuiltinPyright } = await import('../../../integrations/lsp/pyrightLane.js')
      const { probeRuff } = await import('../../../integrations/lsp/ruffLane.js')
      const { projectPythonDebuggerProvenance } = await import('../../../integrations/ide/pythonProject.js')
      const { probeBuiltinClangd, probeCompileDb } = await import('../../../integrations/lsp/clangdLane.js')
      const { mercuryGodotEnabled } = await import('../../../integrations/lsp/godotLane.js')
      const { vulcanEnabled } = await import('../../../integrations/vulcan/vulcanGates.js')
      const { latestTransaction } = await import('../../../integrations/ide/ideTransaction.js')
      const { latestRun } = await import('../../../integrations/ide/pythonTests.js')
      const { darwinDebuggerAuthorisationHint } = await import('../../../integrations/debugger/dapClient.js')

      const py = selectPythonInterpreter()
      const pyright = probeBuiltinPyright()
      const ruff = probeRuff()
      const debugpy = projectPythonDebuggerProvenance()
      const clangd = probeBuiltinClangd()
      const db = probeCompileDb()
      const tx = latestTransaction()
      const test = latestRun()
      const debugAuth = darwinDebuggerAuthorisationHint(devToolsSecurity)

      const pyLine =
        py.state === 'ok'
          ? `python ${py.version} (${py.envKind}) · pyright ${pyright.available ? `${pyright.source}${pyright.version ? ` ${pyright.version}` : ''}` : 'ABSENT'} · ruff ${ruff.available ? (ruff.version ?? 'ok') : 'ABSENT'} · debugpy ${debugpy.adapterSource}`
          : `python UNAVAILABLE (${py.detail.slice(0, 80)})`
      const cppLine =
        (clangd.available
          ? `clangd ${clangd.clangdPath} · compile DB ${db.compileDb ?? 'ABSENT'}`
          : `clangd ABSENT (${clangd.reason?.slice(0, 60)})`) +
        (debugAuth ? ` · native debug: ${debugAuth}` : '')
      const godotLine = `godot lanes ${mercuryGodotEnabled() ? 'armed' : 'disarmed'} · vulcan ${vulcanEnabled() ? 'armed' : 'disarmed'}`
      const planeLine = `latest transaction ${tx ? `${tx.id} [${tx.verdict}]` : '—'} · latest test run ${test ? `${test.id} (${test.counts.failed === 0 ? 'green' : `${test.counts.failed} failing`})` : '—'}`
      const healthy = py.state === 'ok' || clangd.available
      return {
        status: healthy && debugAuth === null ? ('ok' as const) : ('warn' as const),
        evidence: debugAuth ? `${pyLine} · native debug authorisation OFF` : pyLine,
        detail: [cppLine, godotLine, planeLine].join('\n'),
        ...(py.state !== 'ok'
          ? { fix: 'Install Python 3, or point MERCURY_PYTHON at one.' }
          : debugAuth
            ? { fix: 'sudo DevToolsSecurity -enable (macOS debugger authorisation; durable across reboots).' }
            : {}),
      }
    },
  }
}

export function codingLoopFastChecks(): CheckSpec[] {
  return [
    {
      id: 'change-receipts-fast',
      label: 'Change receipts',
      run: async () => {
        const { changeTransactionEnabled } = await import(
          '../../../tools/engines/change-transaction/contracts.js'
        )
        if (!changeTransactionEnabled()) {
          return { status: 'off' as const, evidence: flagAsSet('MERCURY_CHANGE_RECEIPTS') }
        }
        await settleToolList()
        const { _toolTerminalSubscriberCountForTesting } = await import(
          '../../../engine/run-owner/effectObserver.js'
        )
        const subs = _toolTerminalSubscriberCountForTesting()
        return {
          status: 'ok' as const,
          evidence: `anchors + receipt ring armed (${subs} observer subscription(s) on the effect seam)`,
        }
      },
    },
    {
      id: 'resource-plane-fast',
      label: 'Resource plane',
      run: async () => {
        const { mercuryRefsEnabled } = await import('../../../integrations/resources/contracts.js')
        if (!mercuryRefsEnabled()) {
          return { status: 'off' as const, evidence: flagAsSet('MERCURY_REFS') }
        }
        const { resourceAdapterKinds } = await import('../../../integrations/resources/registry.js')
        const kinds = await resourceAdapterKinds()
        return {
          status: kinds.length >= 10 ? ('ok' as const) : ('warn' as const),
          evidence: `${kinds.length} adapter kind(s): ${kinds.map(k => k.kind).join(' ')}`,
          ...(kinds.length < 10
            ? { fix: 'Built-in resource adapters failed to register — rebuild; report it if it persists.' }
            : {}),
        }
      },
    },
    idePlaneFastCheck(),
    {
      id: 'anvil-workbench-fast',
      label: 'Utility workbench',
      run: async () => {
        const { discoverRunnerProfiles } = await import('../../../integrations/ide/projectRunners.js')
        const { repoHostEnabled } = await import('../../repo-host/repoHost.js')
        const { openTransactionIdFor } = await import('../../../integrations/ide/ideTransaction.js')
        const { profiles, manifestError } = discoverRunnerProfiles()
        const byRunner = new Map<string, { ok: number; total: number }>()
        for (const p of profiles) {
          const e = byRunner.get(p.runner) ?? { ok: 0, total: 0 }
          e.total += 1
          if (p.availability.state === 'ok') e.ok += 1
          byRunner.set(p.runner, e)
        }
        const runnersLine = profiles.length
          ? [...byRunner].map(([r, c]) => `${r} ${c.ok}/${c.total}`).join(' · ') + (manifestError !== undefined ? ` · ${manifestError}` : '')
          : manifestError ?? 'no runner manifests in this project'
        const ghOnPath = whichSync('gh') !== null
        const repoLine = repoHostEnabled()
          ? `repo host: ${ghOnPath ? 'gh on PATH (mercury://repo live)' : 'gh ABSENT — context unavailable (remedy: install gh + gh auth login)'}`
          : `repo host: OFF (${flagAsSet('MERCURY_REPO_HOST')})`
        const { structureEnabled, structurePolyglotEnabled } = await import('../../../tools/engines/structure/contracts.js')
        const { resolveGrammarEngineDir, POLYGLOT_LANGUAGES } = await import('../../grammars/grammarFacility.js')
        let engineLine: string
        if (!structurePolyglotEnabled()) {
          engineLine = `AstSearch and AstEdit: OFF (${flagAsSet(structureEnabled() ? 'MERCURY_STRUCTURE_POLYGLOT' : 'MERCURY_STRUCTURE')})`
        } else {
          const engine = resolveGrammarEngineDir()
          if (engine.state === 'ok') {
            let present: number | null = 0
            let readErr: string | null = null
            try {
              const { readdirSync } = await import('node:fs')
              const shipped = new Set(readdirSync(engine.dir))
              present = POLYGLOT_LANGUAGES.filter(lang => shipped.has(lang.wasm)).length
            } catch (error) {
              if (isENOENT(error)) present = 0
              else {
                present = null
                readErr = errorMessage(error)
              }
            }
            engineLine =
              present === null
                ? `polyglot patterns: tree-sitter (${engine.source}) · grammar dir unreadable (${readErr})`
                : present === POLYGLOT_LANGUAGES.length
                  ? `polyglot patterns: tree-sitter (${engine.source}) · ${present} languages`
                  : `polyglot patterns: tree-sitter (${engine.source}) · ${present} of ${POLYGLOT_LANGUAGES.length} languages present (${POLYGLOT_LANGUAGES.length - present} missing from ${engine.dir})`
          } else {
            engineLine = `polyglot patterns: engine UNAVAILABLE (${engine.note.slice(0, 80)})`
          }
        }
        const txId = openTransactionIdFor()
        return {
          status: manifestError !== undefined ? ('warn' as const) : ('ok' as const),
          evidence: `runners: ${runnersLine}`,
          detail: `${repoLine}\n${engineLine}\nopen coding transaction: ${txId ?? '—'}`,
        }
      },
    },
    {
      id: 'services-fast',
      label: 'Project services',
      run: async () => {
        const { servicesEnabled } = await import('../../../tools/engines/project-services/contracts.js')
        if (!servicesEnabled()) {
          return { status: 'off' as const, evidence: flagAsSet('MERCURY_SERVICES') }
        }
        const { reconcileAll } = await import('../../../tools/engines/project-services/serviceManager.js')
        const { getOriginalCwd } = await import('../../../boot/process-state/processState.js')
        const records = reconcileAll(getOriginalCwd())
        const live = records.filter(r => ['starting', 'ready', 'running'].includes(r.state))
        return {
          status: 'ok' as const,
          evidence: `${records.length} record(s), ${live.length} live after reconciliation${live.length > 0 ? `: ${live.map(r => r.spec.name).join(', ')}` : ''}`,
        }
      },
    },
  ]
}

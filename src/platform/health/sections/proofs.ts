import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isENOENT } from '../../errors/errors.js'
import { whichSync } from '../../processes/which.js'
import { decodeGateVerdict, interpretGateVerdict } from '../healthCertCore.js'
import { healthFixEnabled } from '../healthFix.js'
import { gateVerdictPath, computeWorkingTreeSha, runRemedyCmd, type CheckSpec, type HealthContext } from '../healthReport.js'

export function proofsChecks(context: HealthContext): CheckSpec[] {
  const { cwd, head } = context
  return [
    {
      id: 'gate',
      label: 'Green gate',
      run: async probeCtx => {
        const signal = probeCtx?.signal
        let verdictRaw: unknown = null
        try {
          verdictRaw = JSON.parse(await readFile(gateVerdictPath(), 'utf8'))
        } catch (error) {
          if (!isENOENT(error)) throw error
          verdictRaw = null
        }
        const verdict = decodeGateVerdict(verdictRaw)
        if (!existsSync(join(cwd, 'scripts', 'run-all-suites.sh'))) {
          return {
            status: 'info',
            evidence:
              verdict === null
                ? 'no proof-suite gate in this project (scripts/run-all-suites.sh absent)'
                : 'a gate verdict artifact exists but this project has NO gate (scripts/run-all-suites.sh absent) — project-authored data is not certified as Mercury evidence',
          }
        }
        const currentTree = await computeWorkingTreeSha(cwd, { signal })
        const interpreted = interpretGateVerdict(
          verdict,
          { sha: head.sha, dirty: head.dirty, treeSha: currentTree },
          Date.now(),
        )
        const fixable =
          interpreted.status === 'stale' || interpreted.status === 'fail' || interpreted.status === 'warn'
        return {
          ...interpreted,
          ...(fixable && healthFixEnabled() && existsSync(join(cwd, 'scripts', 'run-all-suites.sh'))
            ? {
                remedy: {
                  plan: 'run the full proof-suite gate (bash scripts/run-all-suites.sh, ~7 min) and re-read the verdict artifact',
                  class: 'safe' as const,
                  apply: async () => {
                    const res = await runRemedyCmd('bash', ['scripts/run-all-suites.sh'], cwd, 20 * 60_000)
                    return res.status === 0
                      ? { ok: true, note: 'gate exited 0 (all suites green)' }
                      : { ok: false, note: `gate exited ${res.status}: ${res.tail.slice(-200)}` }
                  },
                  verify: async () => {
                    try {
                      const raw = JSON.parse(await readFile(gateVerdictPath(), 'utf8'))
                      const v = interpretGateVerdict(
                        decodeGateVerdict(raw),
                        { sha: head.sha, dirty: head.dirty, treeSha: await computeWorkingTreeSha(cwd) },
                        Date.now(),
                      )
                      return v.status === 'ok'
                        ? { ok: true, note: v.evidence }
                        : { ok: false, note: `verdict still ${v.status}: ${v.evidence.slice(0, 140)}` }
                    } catch {
                      return { ok: false, note: 'verdict artifact unreadable after the run' }
                    }
                  },
                },
              }
            : {}),
        }
      },
    },
    {
      id: 'verification',
      label: 'Mutation evidence',
      run: async () => {
        try {
          const { verificationSummary } = await import('../../verification/verificationState.js')
          const s = verificationSummary(cwd)
          const evidenceLine = s.lastEvidence
            ? `${s.detail} · last: ${s.lastEvidence.command.slice(0, 90)}`
            : s.detail
          switch (s.state) {
            case 'verified':
              return { status: 'ok', evidence: evidenceLine }
            case 'failed':
              return { status: 'fail', evidence: evidenceLine, fix: 'Fix the failure, then re-run the failing check or `bash scripts/run-all-suites.sh`.' }
            case 'stale':
              return { status: 'stale', evidence: evidenceLine, fix: 'Re-run `bun run verify:fast`, or `bash scripts/run-all-suites.sh` for the release-level verdict.' }
            default:
              return { status: 'info', evidence: evidenceLine }
          }
        } catch (e) {
          return { status: 'unknown', evidence: `verification state unreadable: ${String(e).slice(0, 120)}` }
        }
      },
    },
    {
      id: 'project-gates',
      label: 'Project gates',
      run: async () => {
        try {
          const { loadDeclaredGates } = await import('../../verification/projectGates.js')
          const { workspaceVerifiable } = await import('../../verification/verificationState.js')
          const declared = loadDeclaredGates(cwd)
          const godot = existsSync(join(cwd, 'project.godot'))
          const verifiable = workspaceVerifiable(cwd)
          const parts: string[] = []
          if (declared.length > 0) {
            parts.push(
              `${declared.length} declared gate(s): ${declared
                .map(g => (g.minRuns > 1 ? `${g.id}(soak ${g.minRuns})` : g.id))
                .slice(0, 6)
                .join(' · ')}`,
            )
          }
          if (godot) parts.push('Godot project (headless scene/parse gates recognized)')
          if (parts.length === 0) {
            return {
              status: 'info',
              evidence: verifiable
                ? 'no declared gates — recognized machinery is command-family based (package.json scripts, suites, Make…)'
                : 'no verification machinery discovered here (read-back is the evidence class)',
            }
          }
          return { status: 'ok', evidence: parts.join(' · ') }
        } catch (e) {
          return { status: 'unknown', evidence: `gate registry unreadable: ${String(e).slice(0, 120)}` }
        }
      },
    },
    {
      id: 'renders',
      label: 'Render-verify',
      run: async () => {
        const { renderTuiCheckoutRoot, renderTuiRuntime } = await import('../../../integrations/mcp/renderTuiTool.js')
        const root =
          renderTuiCheckoutRoot() ?? (existsSync(join(cwd, 'scripts', 'ui', 'render-tui.ts')) ? cwd : null)
        if (root === null) {
          return {
            status: 'info',
            evidence:
              'not the harness source repo (scripts/ui/render-tui.ts absent beside this build and under the cwd) — render-verify n/a here; the render_tui tool answers unavailable',
          }
        }
        const vshot = join(root, 'scripts', 'ui', 'vshot.py')
        const runtime = renderTuiRuntime()
        const runtimeWords = 'bun' in runtime ? `bun at ${runtime.bun}` : runtime.missing
        const python = whichSync('python3') ?? whichSync('python')
        if (process.platform === 'win32') {
          return {
            status: 'info',
            evidence: `Windows source checkout — the POSIX render pipeline (vshot.py) does not run here${python ? ` (python present: ${python})` : ''}`,
            fix: 'Capture UI frames via scripts/winreg locally, or the hosted windows-ui workflow.',
          }
        }
        if (!python) {
          return {
            status: 'warn',
            evidence: `render-tui.ts ${existsSync(vshot) ? '+ vshot.py ' : ''}present at ${root} but no python on PATH — UI claims cannot be render-verified`,
            fix: 'Install Python 3, or point MERCURY_PYTHON at one — the PTY renderer needs it.',
          }
        }
        if ('missing' in runtime) {
          return {
            status: 'warn',
            evidence: `render pipeline present at ${root} · python at ${python} · ${runtime.missing} — the render_tui tool answers unavailable until bun is found`,
            fix: 'Install bun (~/.bun/bin/bun), put it on PATH, or point MERCURY_BUN at one — the render script runs under it.',
          }
        }
        return {
          status: 'ok',
          evidence: `render pipeline present at ${root} (render-tui.ts${existsSync(vshot) ? ' + vshot.py' : ''}) · python at ${python} · ${runtimeWords}`,
        }
      },
    },
  ]
}

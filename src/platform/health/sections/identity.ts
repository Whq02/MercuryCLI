import { gitArgsAsync } from '../../git/spawnArgs.js'
import { subprocessEnv } from '../../processes/subprocessEnv.js'
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { stripExtendedLengthPrefixForPlatform } from '../../host-os/paths.js'
import { artifactIdentityLine, describeArtifactIdentity } from '../../product/artifactIdentity.js'
import { getMercuryHome } from '../../environment/envUtils.js'
import { isMercurySubstrateProfileOn } from '../../settings/config.js'
import { formatAge } from '../healthCertCore.js'
import { daemonSnapshot } from '../../../screen/cockpit-gauges/daemonSnapshot.js'
import { healthFixEnabled } from '../healthFix.js'
import { assessDeployedAssets } from '../healthDeployedAssets.js'
import { MERCURY_CONSTITUTION, MERCURY_CREWMATE_CONTRACT } from '../../../engine/system-prompt/mercuryContract.js'
import { clientContractCheck, modelRefusalsCheck, computeWorkingTreeSha, runRemedyCmd, type CheckSpec, type HealthContext } from '../healthReport.js'
import { passedOver } from '../../errors/passedOver.js'

async function execGit(args: string[], cwd: string, timeoutMs = 1500): Promise<string | null> {
  const argv = await gitArgsAsync(args, cwd)
  return new Promise(resolve => {
    try {
      execFile('git', argv, { windowsHide: true, cwd, timeout: timeoutMs, env: { ...subprocessEnv() } }, (err, stdout) => {
        resolve(err ? null : stdout.trim())
      })
    } catch {
      resolve(null)
    }
  })
}

export function identityChecks(context: HealthContext): CheckSpec[] {
  const { version } = context
  return [
    {
      id: 'build-identity',
      label: 'Mercury build',
      run: async () => {
        const identity = describeArtifactIdentity(version)
        const profile = isMercurySubstrateProfileOn()
        const [{ resolveSplashAsset }, { runningBundlePayloadDir }] = await Promise.all([
          import('../../substrate/directSplash.js'),
          import('../../update-channel/vendoredRuntime.js'),
        ])
        const splash = resolveSplashAsset({ bundleDir: runningBundlePayloadDir(), home: getMercuryHome() })
        const splashWords =
          splash === null
            ? 'splash asset absent (a direct start boots plain)'
            : `splash asset ${splash.rung === 'payload' ? 'beside the bundle' : splash.rung === 'home' ? 'in the config home' : 'in the source tree'}`
        let daemonBuild = ''
        if (daemonSnapshot().state === 'live') {
          const { daemonBuildBesideScreen, handshakeDaemon } = await import('../../../daemon/control/handshake.js')
          const beside = daemonBuildBesideScreen(await handshakeDaemon({ timeoutMs: 1000 }))
          if (beside !== null) daemonBuild = ` · ${beside}`
        }
        return {
          status: 'ok',
          evidence: `${artifactIdentityLine(identity)}${daemonBuild} · substrate profile ${profile ? 'on' : 'off'} · ${splashWords}`,
        }
      },
    },
    clientContractCheck(),
    modelRefusalsCheck(),
    {
      id: 'install-provenance',
      label: 'Install provenance',
      run: async () => {
        const [{ resolveInstallProvenance, provenanceGuidance, provenanceLine, NPM_WRAPPER_ROAD_WORDS }, { resolveLayoutRoots }, { commandOnPath, npmWrapperOnPath }] =
          await Promise.all([
            import('../../update-channel/installProvenance.js'),
            import('../../update-channel/installLayout.js'),
            import('../../update-channel/installPath.js'),
          ])
        const p = resolveInstallProvenance()
        if (p.kind === 'unknown' || p.disagreements.length > 0) {
          return {
            status: 'warn',
            evidence: `${provenanceLine(p)} — ${p.evidence.join(' · ')}`,
            fix: provenanceGuidance(p),
          }
        }
        const wrapper = p.kind === 'managed' ? npmWrapperOnPath(commandOnPath(resolveLayoutRoots())) : null
        return {
          status: 'ok',
          evidence: `${provenanceLine(p)} · ${wrapper === null ? '' : `${NPM_WRAPPER_ROAD_WORDS} · `}${provenanceGuidance(p)}`,
        }
      },
    },
    {
      id: 'command-on-path',
      label: 'Command on PATH',
      run: async () => {
        const [{ resolveInstallProvenance }, { resolveLayoutRoots, readWindowsScriptPolicies, windowsScriptPolicyNotice, WIN32_POWERSHELL_ENTRY }, { commandOnPath, commandOnPathWarning, npmWrapperOnPath }] = await Promise.all([
          import('../../update-channel/installProvenance.js'),
          import('../../update-channel/installLayout.js'),
          import('../../update-channel/installPath.js'),
        ])
        const p = resolveInstallProvenance()
        const roots = resolveLayoutRoots()
        const found = commandOnPath(roots)
        if (p.kind === 'managed') {
          if (roots.isWindows && existsSync(join(roots.binDir, WIN32_POWERSHELL_ENTRY))) {
            const notice = windowsScriptPolicyNotice(readWindowsScriptPolicies())
            if (notice.length > 0) return { status: 'warn', evidence: notice[0]!, fix: notice.slice(1).join('\n') }
          }
          const wrapper = npmWrapperOnPath(found)
          if (wrapper !== null) {
            return { status: 'ok', evidence: `the \`mercury\` your shell runs is npm's wrapper at ${wrapper}; it hands over to the stable command ${roots.shimPath}` }
          }
          const warning = commandOnPathWarning(roots, found)
          if (warning === null) {
            return { status: 'ok', evidence: `the \`mercury\` your shell runs is the stable command ${found.state === 'stable' ? found.resolved : roots.shimPath}` }
          }
          return { status: 'warn', evidence: warning[0], fix: warning[1] }
        }
        if (found.state === 'absent') {
          return { status: 'info', evidence: `no \`mercury\` is on your PATH; this Mercury runs from ${p.activeRoot}` }
        }
        const managedWords =
          found.state === 'stable' ? ` — the stable command of the managed install${p.managedCoResident?.current ? ` (${p.managedCoResident.current})` : ''}` : ''
        return { status: 'info', evidence: `the \`mercury\` your shell runs is ${found.resolved}${managedWords}; this Mercury runs from ${p.activeRoot}` }
      },
    },
    {
      id: 'artifact-signature',
      label: 'Artifact signature',
      run: async () => {
        const { resolveInstallProvenance } = await import('../../update-channel/installProvenance.js')
        const { artifactSignatureCheck } = await import('../../update-channel/artifactVerify.js')
        return artifactSignatureCheck(resolveInstallProvenance(), 'fast')
      },
    },
    {
      id: 'artifact-signature-payload',
      label: 'Payload signature',
      depth: 'deep',
      probe: 'functional',
      timeoutMs: 30_000,
      run: async () => {
        const { resolveInstallProvenance } = await import('../../update-channel/installProvenance.js')
        const { artifactSignatureCheck } = await import('../../update-channel/artifactVerify.js')
        return artifactSignatureCheck(resolveInstallProvenance(), 'deep')
      },
    },
    {
      id: 'wrapper',
      label: 'Mercury constitution',
      run: async () => ({
        status: 'ok',
        evidence: `the constitution ${MERCURY_CONSTITUTION.length} chars — built-in source; crewmate contract ${MERCURY_CREWMATE_CONTRACT.length} chars`,
      }),
    },
    {
      id: 'build-fresh',
      label: 'Running build',
      run: async probeCtx => {
        const signal = probeCtx?.signal
        const rawEntry = process.argv[1]
        const entry = rawEntry ? stripExtendedLengthPrefixForPlatform(rawEntry) : rawEntry
        if (!entry || !existsSync(entry)) {
          return {
            status: 'unknown',
            evidence: `entry bundle not statable (argv[1]=${entry ?? 'unset'})`,
          }
        }
        const entryMtime = statSync(entry).mtimeMs
        const root = dirname(dirname(entry))
        if (!existsSync(join(root, 'build.ts')) || !existsSync(join(root, 'src'))) {
          return {
            status: 'info',
            evidence: `running ${basename(entry)} from an installed location (no source checkout above it) — build freshness n/a`,
          }
        }
        const stampPath = join(dirname(entry), '.build-tree')
        if (existsSync(stampPath)) {
          try {
            const stamped = (await readFile(stampPath, 'utf8')).trim()
            const current = await computeWorkingTreeSha(root, { signal })
            if (stamped.length > 0 && current !== null && stamped === current) {
              return {
                status: 'ok',
                evidence: `bundle content-bound — built from exactly this source tree (${stamped.slice(0, 7)})`,
              }
            }
          } catch (error) {
            passedOver(error)
          }
        }
        const ct = await execGit(['log', '-1', '--format=%ct', '--', 'src', 'build.ts'], root)
        const commitSec = ct ? Number.parseInt(ct, 10) : Number.NaN
        if (!Number.isFinite(commitSec)) {
          return {
            status: 'unknown',
            evidence: `source checkout at ${root} but the last-src-commit probe returned nothing`,
          }
        }
        const commitMs = commitSec * 1000
        if (entryMtime < commitMs) {
          const { renderTuiRuntime } = await import('../../../integrations/mcp/renderTuiTool.js')
          const runtime = renderTuiRuntime()
          const bun = 'bun' in runtime ? runtime.bun : null
          return {
            status: 'stale',
            evidence: `bundle built ${formatAge(Date.now() - entryMtime)}, but src/ last changed ${formatAge(Date.now() - commitMs)} (committed) — the running build predates the source`,
            fix: 'Rebuild: bun run build.ts (then relaunch).',
            ...(healthFixEnabled()
              ? {
                  remedy: {
                    plan: `rebuild dist (${bun ?? 'bun'} run build.ts in ${root}, ~40s) — this session keeps the old bundle until relaunch`,
                    class: 'safe' as const,
                    apply: async () => {
                      if (bun === null) return { ok: false, note: 'missing' in runtime ? runtime.missing : 'no bun runtime' }
                      const res = await runRemedyCmd(bun, ['run', 'build.ts'], root, 5 * 60_000)
                      return res.status === 0
                        ? { ok: true, note: 'build.ts exited 0' }
                        : { ok: false, note: `build exited ${res.status}: ${res.tail.slice(-200)}` }
                    },
                    verify: async () => {
                      const stamp = join(dirname(entry), '.build-tree')
                      if (existsSync(stamp)) {
                        const stamped = (await readFile(stamp, 'utf8')).trim()
                        const current = await computeWorkingTreeSha(root)
                        if (stamped && current && stamped === current) {
                          return { ok: true, note: 'rebuilt bundle is content-bound to this source tree — relaunch to run it' }
                        }
                      }
                      const fresh = statSync(entry).mtimeMs
                      return fresh >= commitMs
                        ? { ok: true, note: `bundle now newer than the last src commit (rebuilt ${formatAge(Date.now() - fresh)}) — relaunch to run it` }
                        : { ok: false, note: 'bundle still predates the last src commit' }
                    },
                  },
                }
              : {}),
          }
        }
        return {
          status: 'ok',
          evidence: `bundle (${formatAge(Date.now() - entryMtime)}) is newer than the last committed src change (${formatAge(Date.now() - commitMs)})`,
        }
      },
    },
    {
      id: 'deployed-assets',
      label: 'Deployed assets',
      run: async () => {
        const rawEntry = process.argv[1]
        const entry = rawEntry ? stripExtendedLengthPrefixForPlatform(rawEntry) : rawEntry
        const root = entry ? dirname(dirname(entry)) : null
        if (
          !root ||
          !existsSync(join(root, 'build.ts')) ||
          !existsSync(join(root, 'scripts', 'ops', 'launcher-mercury.sh'))
        ) {
          return {
            status: 'info',
            evidence: 'no source checkout above the running bundle — deployed-asset drift n/a',
          }
        }
        const home = getMercuryHome()
        const a = assessDeployedAssets(root, home)
        return {
          status: a.status,
          evidence: a.evidence,
          ...(a.fix ? { fix: a.fix } : {}),
          ...(healthFixEnabled() && a.drifted.length > 0
            ? {
                remedy: {
                  plan: `redeploy ${a.drifted.map(d => d.label).join(' + ')} (${[...new Set(a.drifted.map(d => d.redeploy))].join(' && ')} in ${root})`,
                  class: 'safe' as const,
                  apply: async () => {
                    for (const redeploy of new Set(a.drifted.map(d => d.redeploy))) {
                      const argv = redeploy.split(' ')
                      const res = await runRemedyCmd(argv[0]!, argv.slice(1), root, 60_000)
                      if (res.status !== 0) {
                        return { ok: false, note: `${a.drifted.filter(d => d.redeploy === redeploy).map(d => d.label).join(' + ')} redeploy exited ${res.status}: ${res.tail.slice(-200)}` }
                      }
                    }
                    return { ok: true, note: 'redeploy script(s) exited 0' }
                  },
                  verify: async () => {
                    const after = assessDeployedAssets(root, home)
                    return after.drifted.length === 0
                      ? { ok: true, note: 'deployed copies byte-match the repo canon' }
                      : { ok: false, note: `still drifted: ${after.drifted.map(d => d.label).join(', ')}` }
                  },
                },
              }
            : {}),
        }
      },
    },
  ]
}

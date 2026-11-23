import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { crashReportDir } from '../../../logs/crashReport.js'
import { getAuthConfigHomeDir, getMercuryHome } from '../../../environment/envUtils.js'
import { classifyHarnessHome, harnessArtifactPath, type HarnessHomeReport } from '../../../environment/knownAgentClis.js'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import { daemonDir } from '../../../../daemon/control/controlSocket.js'
import { getGlobalMercuryFile } from '../../../environment/env.js'
import { getMacOsKeychainStorageServiceName } from '../../../secure-storage/macOsKeychainHelpers.js'
import { healthFixEnabled } from '../../healthFix.js'
import type { CheckSpec } from '../../healthReport.js'
import { errorMessage, isENOENT } from '../../../errors/errors.js'
import { passedOver } from '../../../errors/passedOver.js'

export function configHomeCheck(): CheckSpec {
  return {
    id: 'config-home',
    label: 'Config home',
    run: () => {
          
      const home = getMercuryHome()
      const source = flagEnv('MERCURY_CONFIG_DIR')
        ? 'explicit MERCURY_CONFIG_DIR'
        : flagEnv('MERCURY_HOME')
          ? 'MERCURY_HOME'
          : 'Mercury default home resolution'
      const problems: string[] = []
      const svc = getMacOsKeychainStorageServiceName()
      const authHome = getAuthConfigHomeDir()
      if (!/-[0-9a-f]{8}$/.test(svc)) {
        problems.push(`keychain service '${svc}' is UN-suffixed for the auth home ${authHome} — credential identity split`)
      }
      const globalFile = getGlobalMercuryFile()
      if (!globalFile.startsWith(home)) {
        problems.push(`global config ${globalFile} lives OUTSIDE the resolved home — config identity split`)
      }
      const dDir = daemonDir()
      if (!flagEnv('MERCURY_DAEMON_DIR') && !dDir.startsWith(home)) {
        problems.push(`daemon dir ${dDir} outside the resolved home — daemon-plane split`)
      }
      if (!crashReportDir().startsWith(home)) {
        problems.push(`crash dir ${crashReportDir()} outside the resolved home — forensics split`)
      }
      if (problems.length > 0) {
        return { status: 'fail', evidence: problems.join(' · '), fix: 'The config home resolved two ways — report this with `mercury health --json`.' }
      }
      const slotNote = authHome !== home ? ` · auth scope slotted → ${authHome}` : ''
      const daemonNote = flagEnv('MERCURY_DAEMON_DIR')
        ? ` · daemon plane OVERRIDDEN → ${dDir} (MERCURY_DAEMON_DIR)`
        : ' · global config + daemon plane inside the home'
      return { status: 'ok', evidence: `${home} via ${source} · keychain …${svc.slice(-12)}${slotNote}${daemonNote}` }
    },
  }
}

export function transcriptStoreCheck(): CheckSpec {
  return {
    id: 'transcript-store',
    label: 'Transcript store',
    run: async () => {
      const { getProjectsDir } = await import('../../../../sessions/transcripts/paths.js')
      const { statSync, accessSync, readdirSync, constants } = await import('node:fs')
      const dir = getProjectsDir()
      let st: import('node:fs').Stats
      try {
        st = statSync(dir)
      } catch (error) {
        if (!isENOENT(error)) throw error
        return { status: 'ok' as const, evidence: `${dir} not yet created — the first session creates it` }
      }
      if (!st.isDirectory()) {
        return {
          status: 'fail' as const,
          evidence: `${dir} exists but is not a directory — session transcripts cannot be stored or resumed`,
          fix: 'Move or remove the file at <config-home>/projects so Mercury can recreate the transcript store.',
        }
      }
      try {
        accessSync(dir, constants.W_OK)
      } catch {
        return {
          status: 'fail' as const,
          evidence: `${dir} is not writable — new session transcripts cannot be recorded`,
          fix: 'Fix permissions on <config-home>/projects (check ownership and antivirus holds).',
        }
      }
      const projectCount = readdirSync(dir).length
      const { getTranscriptPath } = await import('../../../../sessions/transcripts/paths.js')
      const transcript = getTranscriptPath()
      let transcriptStat: import('node:fs').Stats | undefined
      try {
        transcriptStat = statSync(transcript)
      } catch (error) {
        if (!isENOENT(error)) throw error
        return { status: 'ok' as const, evidence: `${dir} · ${projectCount} project dir(s), the folder is writable · this session has no transcript file yet` }
      }
      if (!transcriptStat.isFile()) {
        return {
          status: 'fail' as const,
          evidence: `this session's transcript ${transcript} exists but is not a regular file — its turns cannot be recorded or resumed`,
          fix: 'Move or remove what sits at that path so Mercury can record the session.',
        }
      }
      const { openSync, closeSync } = await import('node:fs')
      const denied = (['readable', 'writable'] as const).filter(need => {
        try {
          closeSync(openSync(transcript, need === 'readable' ? 'r' : 'a'))
          return false
        } catch (error) {
          passedOver(error)
          return true
        }
      })
      if (denied.length > 0) {
        return {
          status: 'fail' as const,
          evidence: `this session's transcript ${transcript} is not ${denied.join(' or ')} — its turns cannot be ${denied.includes('writable') ? 'recorded' : 'resumed'}`,
          fix: 'Fix permissions on that file (check ownership, a deny entry and antivirus holds).',
        }
      }
      return { status: 'ok' as const, evidence: `${dir} · ${projectCount} project dir(s), writable · this session's transcript ${transcript} readable, writable (${transcriptStat.size} bytes)` }
    },
  }
}

export function configWritesCheck(): CheckSpec {
  return {
    id: 'config-writes',
    label: 'Config writes',
    run: async () => {
      const { getConfigLocklessFallbackCount } = await import('../../../config/globalConfig.js')
      const n = getConfigLocklessFallbackCount()
      if (n === 0) {
        return {
          status: 'ok' as const,
          evidence: 'serialized under the config lock — 0 lockless fallbacks this session',
        }
      }
      return {
        status: 'warn' as const,
        evidence: `${n} config write(s) fell back to LOCKLESS this session — the lock could not be taken, and concurrent writes can race`,
        fix: 'Another instance may hold the config lock, or the lock directory cannot be created — check <config-home> permissions and other running Mercury processes.',
      }
    },
  }
}

export function configFieldsCheck(): CheckSpec {
  return {
    id: 'config-fields',
    label: 'Config fields',
    run: async () => {
      const { configShapeWords, getGlobalConfigFieldDrops } = await import('../../../config/globalConfig.js')
      const drops = getGlobalConfigFieldDrops()
      if (drops.length === 0) {
        return { status: 'ok' as const, evidence: 'every stored field has its declared shape' }
      }
      return {
        status: 'warn' as const,
        evidence: `${drops.length} field(s) ignored and read as their defaults: ${drops.map(d => `${d.field} expected ${configShapeWords(d.expected)}, found ${d.found}`).join(' · ')}`,
        fix: `Correct or remove the named field(s) in ${getGlobalMercuryFile()}.`,
      }
    },
  }
}

export function isolationCheck(): CheckSpec {
  return {
    id: 'isolation',
    label: 'Store isolation',
    run: async () => {
      const home = getMercuryHome()
      const expectedVersion =
        typeof MACRO !== 'undefined' && typeof MACRO.VERSION === 'string' ? MACRO.VERSION : undefined
      let report: HarnessHomeReport
      try {
        report = await classifyHarnessHome(home, { expectedVersion })
      } catch {
        return { status: 'unknown', evidence: 'isolation probe read failed' }
      }
      if (report.foreign.length > 0) {
        const writers = [
          ...new Set(report.foreign.map(a => a.tool?.displayName ?? 'an unrecognized tool')),
        ]
        const archiveDest = join(
          home,
          'archive',
          `foreign-harness-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`,
        )
        return {
          status: 'warn',
          evidence: `foreign harness artifacts in ${home}: ${report.foreign.map(a => a.evidence).join(' · ')}`,
          fix: `${writers.join(' + ')} wrote harness-state into the Mercury home (another tool was pointed at this home while it ran). Move or remove the foreign records.`,
          ...(healthFixEnabled()
            ? {
                remedy: {
                  plan: `move the foreign records to ${archiveDest} (reversible archive, nothing deleted)`,
                  class: 'safe' as const,
                  apply: async () => {
                    try {
                      await mkdir(archiveDest, { recursive: true })
                      const fresh = await classifyHarnessHome(home, { expectedVersion })
                      let movedCount = 0
                      for (const artifact of fresh.foreign) {
                        const src = harnessArtifactPath(home, artifact.rel)
                        let moved = false
                        try {
                          await rename(src, join(archiveDest, artifact.rel.replace(/\//g, '_')))
                          moved = true
                        } catch (error) {
                          if (!isENOENT(error)) throw error
                        }
                        if (moved) movedCount++
                      }
                      return movedCount > 0
                        ? { ok: true, note: `archived ${movedCount} foreign record(s) → ${archiveDest}` }
                        : { ok: false, note: 'no foreign records matched at apply time (already clean?)' }
                    } catch (e) {
                      return { ok: false, note: `archive failed: ${errorMessage(e)}` }
                    }
                  },
                  verify: async () => {
                    const after = await classifyHarnessHome(home, { expectedVersion })
                    return after.foreign.length === 0
                      ? { ok: true, note: 'no foreign-harness artifacts remain' }
                      : { ok: false, note: `still foreign: ${after.foreign.map(a => a.rel).join(', ')}` }
                  },
                },
              }
            : {}),
        }
      }
      const staleNote =
        report.oursStale.length > 0 ? ` · ${report.oursStale.map(a => a.evidence).join(' · ')}` : ''
      return { status: 'ok', evidence: `no foreign-harness artifacts in ${home}${staleNote}` }
    },
  }
}

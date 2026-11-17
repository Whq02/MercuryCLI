import { getHistoryFlushHealth, historyEverFlushedThisProcess } from '../../../history.js'
import { readBootAttemptResidue } from '../../../substrate/bootBeacon.js'
import { existsSync, statSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { crashReportDir } from '../../crashReport.js'
import { getAuthConfigHomeDir, getMercuryHome } from '../../envUtils.js'
import { classifyHarnessHome, harnessArtifactPath, type HarnessHomeReport } from '../../knownAgentClis.js'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import { binaryName } from '../../config.js'
import { formatAge } from '../../healthCertCore.js'
import { daemonSnapshot } from '../../cockpit/daemonSnapshot.js'
import { daemonDir } from '../../../daemon/controlSocket.js'
import type { DaemonSignInViewV1 } from '../../../daemon/protocol.js'
import { getGlobalMercuryFile } from '../../env.js'
import { getMacOsKeychainStorageServiceName } from '../../secureStorage/macOsKeychainHelpers.js'
import { healthFixEnabled } from '../../healthFix.js'
import type { CheckSpec } from '../../healthReport.js'

export function crewChecks(): CheckSpec[] {
  return [
    {
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
    },
    {
      id: 'transcript-store',
      label: 'Transcript store',
      run: async () => {
        const { getProjectsDir } = await import('../../sessionStorage/paths.js')
        const { statSync, accessSync, readdirSync, constants } = await import('node:fs')
        const dir = getProjectsDir()
        let st: import('node:fs').Stats
        try {
          st = statSync(dir)
        } catch {
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
        let projectCount = 0
        try {
          projectCount = readdirSync(dir).length
        } catch {
        }
        const { getTranscriptPath } = await import('../../sessionStorage/paths.js')
        const transcript = getTranscriptPath()
        let transcriptStat: import('node:fs').Stats | undefined
        try {
          transcriptStat = statSync(transcript)
        } catch {
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
          } catch {
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
    },
    {
      id: 'config-writes',
      label: 'Config writes',
      run: async () => {
        const { getConfigLocklessFallbackCount } = await import('../../config/globalConfig.js')
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
    },
    {
      id: 'config-fields',
      label: 'Config fields',
      run: async () => {
        const { configShapeWords, getGlobalConfigFieldDrops } = await import('../../config/globalConfig.js')
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
    },
    {
      id: 'scratch-leases',
      label: 'Scratch leases',
      run: async () => {
        const { listScratchLeftovers } = await import('../../scratchLeases.js')
        const leftovers = listScratchLeftovers()
        if (leftovers.length === 0) {
          return { status: 'ok', evidence: 'no leftover scratch leases for this project' }
        }
        const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)}MB`
        const total = leftovers.reduce((a, l) => a + l.sizeBytes, 0)
        const rows = leftovers
          .slice(0, 5)
          .map(l => `${l.owner.kind}:${l.owner.id.slice(0, 12)} ${mb(l.sizeBytes)} ${l.root} (${l.recovery})`)
        return {
          status: 'warn',
          evidence: `${leftovers.length} leftover lease(s), ${mb(total)} total · ${rows.join(' · ')}`,
          fix: 'Delete only the named lease paths, not all of /tmp.',
        }
      },
    },
    {
      id: 'session-scratch',
      label: 'Session scratchpads',
      run: async () => {
        const { idleScratchpads, scratchpadFootprint, sweepIdleScratchpads, SCRATCHPAD_WALK_ENTRIES } = await import('../../scratchpadRetention.js')
        const { retentionCutoffMs, retentionWindowDays } = await import('../../cleanup.js')
        const { formatFileSize } = await import('../../format.js')
        const none = 'only running sessions hold scratch'
        const idle = await idleScratchpads()
        let bytes = 0
        let unread = 0
        for (const dir of idle) {
          const seen = await scratchpadFootprint(dir, SCRATCHPAD_WALK_ENTRIES)
          bytes += seen.bytes
          if (!seen.whole) unread++
        }
        if (bytes === 0 && unread === 0) return { status: 'ok', evidence: none }
        const one = idle.length === 1
        const held = `${unread > 0 ? 'at least ' : ''}${formatFileSize(bytes)}`
        const aged = retentionCutoffMs() === null || unread === idle.length ? '' : ` · removed ${retentionWindowDays()} days after ${one ? 'its' : 'their'} last write`
        const large = unread === 0 ? '' : ` · ${unread} too large to scan ${unread === 1 ? 'stays' : 'stay'} until removed here`
        const evidence = `${one ? '1 session that is not running holds' : `${idle.length} sessions that are not running hold`} ${held} of scratch${aged}${large}`
        if (bytes < 1024 ** 3 && unread === 0) return { status: 'info', evidence }
        return {
          status: 'warn',
          evidence,
          fix: `Remove them (the chats stay resumable, their scratch files are deleted): press f here, or run \`${binaryName()} health --fix --only session-scratch --yes\`.`,
          remedy: {
            plan: `remove the ${one ? 'scratchpad of 1 session that is' : `scratchpads of ${idle.length} sessions that are`} not running (${held}); ${one ? 'its chat stays' : 'their chats stay'} resumable`,
            class: 'destructive' as const,
            apply: async () => {
              const { swept, kept } = await sweepIdleScratchpads()
              return { ok: kept.length === 0, note: `removed ${swept.length} scratchpad${swept.length === 1 ? '' : 's'}${kept.length === 0 ? '' : ` · ${kept.length} could not be removed`}` }
            },
            verify: async () => {
              const left = (await idleScratchpads()).length
              return { ok: left === 0, note: left === 0 ? none : `${left} still held` }
            },
          },
        }
      },
    },
    {
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
                          const moved = await rename(src, join(archiveDest, artifact.rel.replace(/\//g, '_'))).then(
                            () => true,
                            () => false,
                          )
                          if (moved) movedCount++
                        }
                        return movedCount > 0
                          ? { ok: true, note: `archived ${movedCount} foreign record(s) → ${archiveDest}` }
                          : { ok: false, note: 'no foreign records matched at apply time (already clean?)' }
                      } catch (e) {
                        return { ok: false, note: `archive failed: ${e}` }
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
    },
    {
      id: 'daemon-sign-ins',
      label: 'Daemon sign-in view',
      run: async () => {
        const d = daemonSnapshot()
        if (d.state !== 'live') {
          return { status: 'off', evidence: `no live daemon to compare with — ${d.reason}`, link: '/daemon' }
        }
        const { daemonControlRpc, restartDaemonWords } = await import('../../../daemon/controlSocket.js')
        const { compareSignInViews, composeSignInView, summarizeSignInView } = await import('../../../daemon/signInView.js')
        const reply = (await daemonControlRpc({ op: 'signIns', refresh: true } as never, { timeoutMs: 3000 })) as
          | { ok: true; view: DaemonSignInViewV1 }
          | { ok: false; code?: string; error?: string }
        const restart = restartDaemonWords(binaryName())
        if (!reply.ok) {
          return {
            status: 'warn',
            evidence: `the daemon did not answer signIns (${reply.code ?? '?'}${reply.error ? `: ${reply.error}` : ''}) — a daemon of an older build`,
            fix: `${restart} — the successor answers the sign-in verb.`,
            link: '/daemon',
          }
        }
        const mine = composeSignInView({ refresh: true })
        const gaps = compareSignInViews(mine, reply.view)
        const sameEstate = reply.view.home === mine.home && reply.view.store === mine.store
        const where = `daemon read ${reply.view.store} in ${reply.view.home}; this process reads ${mine.store} in ${mine.home}`
        if (gaps.length === 0 && sameEstate) {
          return { status: 'ok', evidence: `daemon and client agree — ${summarizeSignInView(reply.view)} · ${where}`, link: '/daemon' }
        }
        const named = gaps.map(g => `${g.family}: client ${g.client} vs daemon ${g.daemon}`).join('; ')
        const lists = `daemon: [${summarizeSignInView(reply.view)}] · client: [${summarizeSignInView(mine)}]`
        const now = Date.now()
        const olderLists = gaps.flatMap(gap => {
          const client = mine.families.find(family => family.family === gap.family)
          const daemon = reply.view.families.find(family => family.family === gap.family)
          if (!client?.credentialed || !daemon?.credentialed || client.refused || daemon.refused) return []
          const clientAt = client.catalogueReadAt
          const daemonAt = daemon.catalogueReadAt
          if (typeof clientAt !== 'number' || typeof daemonAt !== 'number' || !Number.isFinite(clientAt) || !Number.isFinite(daemonAt) || daemonAt <= 0 || clientAt > now || daemonAt >= clientAt) return []
          return [`${gap.family}: daemon list read ${formatAge(now - daemonAt)}`]
        })
        if (sameEstate && gaps.length > 0 && olderLists.length === gaps.length) {
          return { status: 'info', evidence: `daemon model lists are older — ${olderLists.join('; ')} · ${lists} · ${where}`, link: '/daemon' }
        }
        return {
          status: 'fail',
          evidence: `daemon ≠ client${named !== '' ? ` — ${named}` : ' — different home or store'} · ${lists} · ${where}`,
          fix: `the daemon and this screen read different homes, stores or env keys, or a family is signed in on one estate and not the other — point both at the same home or sign in there; the evidence names both reads.`,
          link: '/daemon',
        }
      },
    },
    {
      id: 'daemon',
      label: 'Scheduler daemon',
      run: async () => {
        const d = daemonSnapshot()
        if (d.state === 'live') {
          const { daemonHandshakeEvidence, daemonSkewLine, handshakeDaemon, reopenWayOut } = await import('../../../daemon/handshake.js')
          const hs = await handshakeDaemon({ timeoutMs: 1000 })
          const evidence = `daemon.json: ${d.reason} · ${daemonHandshakeEvidence(hs)}`
          if (hs.line !== null) return { status: 'warn', evidence, fix: hs.heal === 'reopen' ? reopenWayOut(hs) : hs.line, link: '/daemon' }
          const skew = daemonSkewLine(hs)
          if (skew !== null) return { status: 'warn', evidence, fix: skew, link: '/daemon' }
          return { status: 'ok', evidence, link: '/daemon' }
        }
        let receipt = ''
        const reconcileRecords = () => import('../../../daemon/reconcileRecords.js')
        try {
          const { reconcileDaemonRecords } = await reconcileRecords()
          const rec = await reconcileDaemonRecords()
          if (rec.state === 'reconciled' && rec.cleaned.length > 0) {
            receipt = `reconciled stale records: removed ${rec.cleaned.join(', ')}${
              rec.deadPid != null ? ` (pid ${rec.deadPid} gone)` : ''
            }`
          }
        } catch {
        }
        if (d.state === 'unavailable') {
          if (receipt) {
            return { status: 'ok', evidence: `${receipt} · daemon off (opt-in)`, link: '/daemon' }
          }
          return {
            status: 'warn',
            evidence: `daemon.json: ${d.reason}`,
            fix: `Run \`${binaryName()} daemon\` to restart, or clear the stale record.`,
            link: '/daemon',
          }
        }
        return {
          status: 'off',
          evidence: `no daemon record — ${d.reason}${receipt ? ` · ${receipt}` : ''}`,
          link: '/daemon',
        }
      },
    },
    {
      id: 'mercury-processes',
      label: 'Mercury processes',
      run: async () => {
        const { PROCESS_SWEEP_WORDS, processSweepCounts, processSweepLine } = await import('../../../daemon/processSweep.js')
        const { readMercuryProcesses, endStaleProcesses, processSweepOutcomeLine } = await import('../../../daemon/processSweepRun.js')
        const census = await readMercuryProcesses()
        const counts = processSweepCounts(census.entries)
        const stale = census.entries.filter(entry => entry.classification === 'stale')
        const cannotEnd = census.entries.filter(entry => entry.classification === 'cannot-end')
        const evidence = census.complete ? PROCESS_SWEEP_WORDS.counts(counts) : `${PROCESS_SWEEP_WORDS.counts(counts)} · ${census.error ?? 'the process table could not be read'}`
        const detail = [...stale, ...cannotEnd].map(entry => processSweepLine(entry, census.readAt)).join(' · ')
        const link = '/daemon'
        if (stale.length === 0) {
          return { status: census.complete ? 'ok' : 'warn', evidence, ...(detail === '' ? {} : { detail }), link }
        }
        const reviewed = stale
        return {
          status: 'warn',
          evidence,
          detail,
          fix: `${PROCESS_SWEEP_WORDS.action}: press f here, or run \`${binaryName()} health processes --end-stale\``,
          link,
          remedy: {
            plan: `${PROCESS_SWEEP_WORDS.confirm(reviewed.length)} ${reviewed.map(entry => processSweepLine(entry, census.readAt)).join(' · ')}`,
            class: 'destructive' as const,
            apply: async () => {
              const after = await endStaleProcesses(reviewed)
              return { ok: after.endings.every(ending => ending.outcome === 'ended'), note: processSweepOutcomeLine(after) }
            },
            verify: async () => {
              const again = await readMercuryProcesses()
              const left = again.entries.filter(entry => entry.classification === 'stale').length
              return { ok: left === 0, note: left === 0 ? `no stale Mercury process remains · ${PROCESS_SWEEP_WORDS.counts(processSweepCounts(again.entries))}` : `${left} stale Mercury process(es) remain` }
            },
          },
        }
      },
    },
    {
      id: 'history',
      label: 'Prompt history appends',
      run: () => {
        const h = getHistoryFlushHealth()
        const storePath = join(getMercuryHome(), 'history.jsonl')
        try {
          if (existsSync(storePath) && statSync(storePath).isDirectory()) {
            return {
              status: 'warn',
              evidence: 'history.jsonl is a DIRECTORY — no append can land; the per-process counters cannot see this from a one-shot run',
              fix: 'Remove the directory at <config-home>/history.jsonl (prompts recorded elsewhere are unaffected).',
            }
          }
        } catch {
        }
        if (h.streak >= 3) {
          return {
            status: 'warn',
            evidence: `history.jsonl flush failing — streak ${h.streak}, ${h.pending} pending: ${h.lastFailure?.message ?? 'unknown'}`,
            fix: 'Prompts are safe in memory this session. Check permissions or antivirus holds on <config-home>/history.jsonl.',
          }
        }
        const historyPath = join(getMercuryHome(), 'history.jsonl')
        try {
          if (existsSync(historyPath) && statSync(historyPath).isDirectory()) {
            return {
              status: 'fail',
              evidence: 'history.jsonl is a DIRECTORY — every append fails',
              fix: 'Remove the directory at <config-home>/history.jsonl; the next prompt recreates the file.',
            }
          }
        } catch {  }
        const lockDir = join(getMercuryHome(), 'history.jsonl.lock')
        if (existsSync(lockDir)) {
          let ageMs: number | null = null
          try {
            ageMs = Date.now() - statSync(lockDir).mtimeMs
          } catch {  }
          if (ageMs !== null && ageMs > 30_000) {
            return {
              status: 'warn',
              evidence: `history.jsonl.lock is ${Math.round(ageMs / 1000)}s old — it should have self-cleared by now`,
              fix: 'If it persists with no other Mercury process running, delete the lock dir.',
            }
          }
        }
        return {
          status: 'ok',
          evidence:
            h.pending === 0
              ? h.lastFailure === null && h.streak === 0 && !historyEverFlushedThisProcess()
                ? 'no append attempted this run · store path writable-shaped'
                : 'appends healthy'
              : `${h.pending} pending (flush scheduled)`,
        }
      },
    },
    {
      id: 'boot-beacon',
      label: 'Boots complete',
      run: () => {
        const residue = readBootAttemptResidue()
        if (residue && residue.count >= 3) {
          return {
            status: 'warn',
            evidence: `${residue.count} enter-screen handoff(s) since the last completed boot — latest ${formatAge(Date.now() - residue.lastTs)}`,
            fix: '`mercury update --rollback` returns to the previous version; `MERCURY_SPLASH=off mercury` boots without the enter screen. Include `mercury health --json` when reporting.',
          }
        }
        return {
          status: 'ok',
          evidence: residue
            ? `${residue.count} pending attempt(s) (a boot may be in flight or was cancelled mid-handoff)`
            : 'no pending attempts',
        }
      },
    },
    {
      id: 'launch-spine',
      label: 'Boot milestones',
      run: async () => {
        const { lastBootReachedInputLive, lastInteractiveBootSpine } = await import(
          '../../../substrate/launchMilestones.js'
        )
        const reached = lastBootReachedInputLive()
        if (reached === null) return { status: 'off', evidence: 'no interactive boot recorded yet' }
        const RANK: Record<string, number> = { 'runtime-entry': 0, 'route-ready': 1, 'first-frame': 2, 'input-live': 3 }
        const rungRows = lastInteractiveBootSpine().filter(r => r.milestone in RANK)
        const lastRungs = rungRows.map(r => r.milestone)
        const spine = lastRungs.join(' → ')
        const setupScreenFirst = rungRows.some(r => r.milestone === 'first-frame' && r.beforeLaunch === true)
        const routeAt = lastRungs.indexOf('route-ready')
        const setupRoute = setupScreenFirst && lastRungs[0] === 'runtime-entry' && routeAt > 0 && routeAt === lastRungs.lastIndexOf('route-ready')
        const ranks = lastRungs.filter((_, i) => !setupRoute || i !== routeAt).map(m => RANK[m] ?? -1)
        const inOrder = ranks.every((r, i) => r >= 0 && (i === 0 || r > ranks[i - 1]!))
        if (reached && !inOrder) {
          return {
            status: 'warn',
            evidence: `last boot's spine fired OUT OF ORDER: ${spine}`,
            fix: 'The rungs must fire runtime-entry → route-ready → first-frame → input-live; an inverted spine means a stamp moved — include `mercury health --json` when reporting.',
          }
        }
        return reached
          ? { status: 'ok', evidence: `last boot: ${spine}` }
          : {
              status: 'warn',
              evidence: `last boot's spine truncated: ${spine || '(empty)'} — the process never reached input-live`,
              fix: 'A boot that exits 0 before input is live is a launcher defect — include `mercury health --json` when reporting.',
            }
      },
    },
    {
      id: 'invocation-record',
      label: 'Invocation record',
      run: async () => {
        const { readInvocationRecords } = await import('../../../substrate/invocationRecord.js')
        const rows = readInvocationRecords()
        const last = rows[rows.length - 1]
        if (!last) return { status: 'off', evidence: 'no invocation recorded yet' }
        return {
          status: 'ok',
          evidence: `${last.platform} · ${last.shellHint} · tty in/out/err ${last.stdinTTY ? 'y' : 'n'}/${last.stdoutTTY ? 'y' : 'n'}/${last.stderrTTY ? 'y' : 'n'}${last.termProgram ? ` · ${last.termProgram}` : ''} (${rows.length} recorded)`,
        }
      },
    },
    {
      id: 'invocation-trace',
      label: 'Trace appends',
      run: async () => {
        const { getTraceFlushHealth, getInvocationTracePath, isInvocationTraceEnabled } =
          await import('../../observability/invocationTrace.js')
        if (!isInvocationTraceEnabled()) {
          return { status: 'off', evidence: 'tracing off (MERCURY_TRACE/substrate profile)' }
        }
        const t = getTraceFlushHealth()
        if (t.streak >= 3) {
          return {
            status: 'warn',
            evidence: `mercury-trace.jsonl flush failing — streak ${t.streak}, ${t.pending} pending${t.dropped > 0 ? `, ${t.dropped} dropped at the buffer cap` : ''}: ${t.lastFailure?.message ?? 'unknown'}`,
            fix: 'Check permissions/AV holds on <config-home>/mercury-trace.jsonl; records keep buffering (bounded) until appends recover.',
          }
        }
        let ageNote = 'no records this session yet'
        if (t.lastWriteOkAt !== null) {
          ageNote = `last write ${Math.max(0, Math.round((Date.now() - t.lastWriteOkAt) / 1000))}s ago`
        } else {
          try {
            const mtime = statSync(getInvocationTracePath()).mtimeMs
            ageNote = `last write ${Math.max(0, Math.round((Date.now() - mtime) / 1000))}s ago (prior session)`
          } catch {
          }
        }
        return {
          status: 'ok',
          evidence:
            t.pending === 0
              ? `appends healthy · ${ageNote}`
              : `${t.pending} pending (flush scheduled) · ${ageNote}`,
        }
      },
    },
    {
      id: 'cache-clock',
      label: 'Usage metering',
      run: async () => {
        const { cacheClockGateWords, cacheClockSnapshot, getCacheClockFlushHealth, NO_REQUEST_YET } = await import(
          '../../cache/cacheClock.js'
        )
        const snap = cacheClockSnapshot()
        if (!snap.engaged && snap.reason === NO_REQUEST_YET) {
          const { promptCache1hEligibility } = await import('../../../services/providers/anthropic/requestParams.js')
          return { status: 'off', evidence: `clock not engaged in this process: ${cacheClockGateWords(promptCache1hEligibility())}` }
        }
        if (!snap.engaged) {
          return { status: 'off', evidence: `clock not engaged this session: ${snap.reason ?? 'the session is not eligible for the 1h tier'}` }
        }
        const c = getCacheClockFlushHealth()
        if (c.streak >= 3) {
          return {
            status: 'warn',
            evidence: `session rollup writes failing — streak ${c.streak}: ${c.lastFailure?.message ?? 'unknown'}`,
            fix: 'Check the project store (projects/<key>/cache-clock/sessions) for permissions/AV holds; metering state is safe in memory and rewrites whole on the next flush.',
          }
        }
        const age =
          c.lastRollupOkAt !== null
            ? `last rollup ${Math.max(0, Math.round((Date.now() - c.lastRollupOkAt) / 1000))}s ago`
            : 'no rollup written yet (flushes at 3 requests, then on cadence)'
        return { status: 'ok', evidence: `ttl ${snap.ttl ?? '?'} (${snap.cls ?? '?'}) · ${age}` }
      },
    },
    {
      id: 'activity',
      label: 'Activity counts',
      run: async () => {
        const { getHeadlessActivity } = await import('../../activityLedger.js')
        const { getGlobalConfig } = await import('../../config/globalConfig.js')
        const a = getHeadlessActivity()
        const startups = getGlobalConfig().numStartups ?? 0
        const last = a.lastAt > 0 ? `last headless ${new Date(a.lastAt).toISOString()} (${a.lastKind})` : 'no headless activity recorded'
        const verbs = Object.values(a.verbs ?? {}).reduce((sum, n) => sum + n, 0)
        return {
          status: 'ok',
          evidence: `interactive boots ${startups} · print ${a.print} · sdk ${a.sdk} · verbs ${verbs} · ${last}`,
        }
      },
    },
    {
      id: 'pid-lock-release',
      label: 'Lock releases',
      run: async () => {
        const { pidLockReleaseHealth } = await import('../../../substrate/pidLock.js')
        const h = pidLockReleaseHealth()
        if (h.notRemoved.count > 0) {
          const last = h.notRemoved.last
          return {
            status: 'warn',
            evidence: `${h.notRemoved.count} lock release(s) settled ${last?.outcome ?? 'non-removed'} this session${last ? ` — last: ${last.path} (${last.fsCode ?? 'unknown'}, ${last.attempts} attempts)` : ''}`,
            fix: 'A deferred lock is reclaimed by the next boot reconcile once its owner dies; persistent failures name a permissions/AV hold on the lock path.',
          }
        }
        const retried =
          h.retriedSuccesses.count > 0
            ? `releases healthy (${h.retriedSuccesses.count} saved by the bounded retry)`
            : 'releases healthy'
        return { status: 'ok', evidence: retried }
      },
    },
    {
      id: 'permission-posture',
      label: 'Sovereign mode',
      run: async () => {
        const { getCurrentProjectConfig, getProjectPathForConfig } = await import('../../config/projectConfig.js')
        const { flagEnv } = await import('../../../substrate/flagRegistry.js')
        const { isEnvTruthy } = await import('../../envUtils.js')
        const posture = getCurrentProjectConfig().permissionPosture
        const envArmedNow = isEnvTruthy(flagEnv('MERCURY_SKIP_PERMISSIONS'))
        const OFF = 'sovereign mode off — every permission question is asked (files, commands, the first act of the session for computer use)'
        if (!posture) {
          if (envArmedNow) {
            return {
              status: 'warn',
              evidence:
                "sovereign mode is armed by the Boot Menu's Sovereign mode row (standing consent) but NO posture record exists yet for this project — the record is written by an interactive boot in the project's own folder",
              fix: `Open Mercury interactively once in this project (${getProjectPathForConfig()}) — its boot records the permission composition; an interactive Mercury open in another folder records that folder's.`,
            }
          }
          return { status: 'ok', evidence: `${OFF} · no posture recorded yet for this project` }
        }
        const trust = posture.trustDialogAccepted ? 'trust dialog accepted' : 'trust dialog NOT accepted'
        if (posture.mode === 'bypass') {
          const armed =
            posture.armedBy === 'env-standing-consent'
              ? "saved in the Boot Menu's Sovereign mode row (standing consent)"
              : posture.armedBy === 'cli-flag'
                ? 'armed by the launch flag'
                : "armed by the session's own choice"
          const dialog =
            posture.consentDialog === 'suppressed-by-standing-consent'
              ? 'consent dialog suppressed by settings'
              : 'consent dialog shown and accepted'
          return { status: 'ok', evidence: `sovereign mode on — no permission question is asked, computer use included · ${armed} · ${dialog} · ${trust}` }
        }
        return { status: 'ok', evidence: `${OFF} · ${trust}` }
      },
    },
    {
      id: 'lifecycle-collection',
      label: 'State cleanup',
      run: async () => {
        const { getLifecycleHealth } = await import('../../../substrate/stateLifecycle.js')
        const { statSync: statSentinel } = await import('node:fs')
        const { join: joinPath } = await import('node:path')
        const { getMercuryHome: homeDir } = await import('../../envUtils.js')
        let sentinelAge: string
        try {
          const mtime = statSentinel(joinPath(homeDir(), '.last-cleanup')).mtimeMs
          const days = (Date.now() - mtime) / 86_400_000
          sentinelAge = days < 2 ? `last complete sweep ${Math.round(days * 24)}h ago` : `last complete sweep ${Math.round(days)}d ago`
        } catch {
          sentinelAge = 'no complete sweep recorded yet'
        }
        const { fileHistoryStorage } = await import('../../cleanup.js')
        const history = await fileHistoryStorage()
        sentinelAge += ` · file history ${(history.bytes / (1024 * 1024)).toFixed(1)} MB / ${history.limit / (1024 * 1024)} MB`
        if (history.bytes > history.limit) return { status: 'warn', evidence: `${sentinelAge} · cleanup pending` }
        const pass = getLifecycleHealth()
        if (pass && pass.cycleFailures > 0) {
          const firstFailure = pass.receipts.flatMap(r => r.failures.map(f => `${r.id}: ${f.path}${f.code ? ` (${f.code})` : ''}`))[0]
          return {
            status: 'warn',
            evidence: `collection failing — ${pass.cycleFailures} failure(s) this cycle${firstFailure ? `; first: ${firstFailure}` : ''} · ${sentinelAge}`,
            fix: 'Check permissions/AV holds on the named path; the sentinel is withheld until a cycle completes clean, so the sweep keeps retrying on its cadence.',
          }
        }
        const passNote = pass
          ? `last pass removed ${pass.removed}, ${pass.cycleComplete ? 'cycle complete' : 'cursor mid-cycle'}`
          : 'no pass this session'
        return { status: 'ok', evidence: `${passNote} · ${sentinelAge}` }
      },
    },
    {
      id: 'image-decode',
      label: 'Inline image decode',
      run: async () => {
        const { detectImageProtocol } = await import(
          '../../../services/visual/imageDisplay.js'
        )
        const tier = detectImageProtocol()
        try {
          await import('sharp')
          return {
            status: 'ok',
            evidence: `native decode available · detected tier: ${tier}`,
          }
        } catch (e) {
          return {
            status: 'warn',
            evidence: `images render as file links on this install — native decode unavailable (${(e as Error)?.message?.slice(0, 120) ?? 'import failed'}); detected tier: ${tier}`,
            fix: 'Reinstall via `mercury update` to restore the bundled image binding; iTerm2, WezTerm and kitty render PNGs natively regardless.',
          }
        }
      },
    },
    {
      id: 'agent-definitions',
      label: 'Agent definitions',
      run: async () => {
        const { existsSync, readdirSync } = await import('node:fs')
        const { join } = await import('node:path')
        const { getMercuryHome } = await import('../../envUtils.js')
        const { projectLocalPath } = await import('../../../services/projectLocal/paths.js')
        const { getOriginalCwd } = await import('../../../bootstrap/state.js')
        const userDir = join(getMercuryHome(), 'agents')
        let projectDir = ''
        try {
          projectDir = projectLocalPath(getOriginalCwd(), 'agents')
        } catch {
        }
        const countMd = (dir: string): number | null => {
          try {
            if (!dir || !existsSync(dir)) return null
            return readdirSync(dir).filter(f => f.endsWith('.md')).length
          } catch {
            return null
          }
        }
        const user = countMd(userDir)
        const project = countMd(projectDir)
        const parts = [
          user === null ? 'user dir absent' : `user ${user} .md file(s)`,
          project === null ? 'project dir absent' : `project ${project} .md file(s)`,
        ]
        return { status: 'info', evidence: `${parts.join(' · ')} — files on disk; a nameless .md is a reference document, so the loaded roster (mercury roster) can be smaller` }
      },
    },
    {
      id: 'seats',
      label: 'Seats',
      run: async () => {
        const { seatCeilingFacts, seatCeilingValueWords, seatCostWarning } = await import('../../../services/switchboard/capacityCheck.js')
        const { liveCeilingFacts, composeGovernorCeilings, composeProvenance } = await import('../../../services/capacity/composeCeilings.js')
        const { seatNarrowingWords } = await import('../../../services/capacity/seatWords.js')
        const facts = seatCeilingFacts()
        const live = liveCeilingFacts(null)
        const composed = composeGovernorCeilings(live)
        const provenance = composeProvenance(live, composed)
        const narrowed = seatNarrowingWords(provenance.narrowing)
        const warning = seatCostWarning(facts)
        const lanes = `${composed.delegationLanes} delegated lane${composed.delegationLanes === 1 ? '' : 's'} for the crew`
        return {
          status: narrowed !== null || warning !== null ? 'info' : 'ok',
          evidence: `${seatCeilingValueWords(facts)} · ${facts.readingSentence} · ${lanes}${narrowed !== null ? ` — ${narrowed}` : ' (the seats)'}`,
          detail: `Sessions and crewmates all run under this one number; a seat is held only while a model call is in flight, and a call past the ceiling waits with its row saying so.${warning !== null ? ` ${warning}.` : ''} Setting: ${facts.lever}.`,
        }
      },
    },
    {
      id: 'swarm',
      label: 'Swarm',
      run: async () => {
        const { swarmMasterEnabled, swarmSessionEnabled } = await import('../../../services/crewBoard/seam.js')
        const master = swarmMasterEnabled()
        return {
          status: master ? 'ok' : 'off',
          evidence: master ? `Swarm ${swarmSessionEnabled() ? 'on' : 'off'} for new crewmates` : 'Swarm off',
          detail: 'swarm.enabled in user settings.json is the master switch; /swarm on enables this session for subsequently launched crewmates.',
          link: '/config',
        }
      },
    },
    {
      id: 'spawn-switches',
      label: 'Crewmates',
      run: async () => {
        const { spawnSwitchFacts, spawnSwitchLine } = await import('../../../services/switchboard/spawnSwitches.js')
        const { BACKGROUND_LAUNCH_LABEL, backgroundSessionsLaunchCrewmates } = await import('../../../services/switchboard/backgroundLaunch.js')
        const { getFocusedSessionConnector, hasFocusedSession } = await import('../../../services/engine-connector/focusedConnector.js')
        const focused = hasFocusedSession()
        const facts = focused ? getFocusedSessionConnector().spawnSwitches() : spawnSwitchFacts()
        const scope = focused ? 'the focused session' : 'this process — the next session is born with it'
        const anyOff = !facts.subagents.on
        const backgrounded = backgroundSessionsLaunchCrewmates() ? ` · backgrounded sessions launch too (${BACKGROUND_LAUNCH_LABEL} on)` : ''
        return {
          status: anyOff ? 'info' : 'ok',
          evidence: `${spawnSwitchLine('subagents', facts.subagents)} — ${scope}${backgrounded}`,
          detail: 'Flip a running session with /crewmates on|off (at its next turn boundary); the boot menu\'s Agents section sets the next session\'s default. Off: the Crewmate tool is absent from the roster and every spawn road answers one receipt.',
          link: '/bootmenu',
        }
      },
    },
  ]
}

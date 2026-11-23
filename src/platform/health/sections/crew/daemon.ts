import { binaryName } from '../../../settings/config.js'
import { formatAge } from '../../healthCertCore.js'
import { daemonSnapshot } from '../../../../screen/cockpit-gauges/daemonSnapshot.js'
import type { DaemonSignInViewV1 } from '../../../../daemon/control/protocol.js'
import type { CheckSpec } from '../../healthReport.js'
import { passedOver } from '../../../errors/passedOver.js'

export function daemonSignInsCheck(): CheckSpec {
  return {
    id: 'daemon-sign-ins',
    label: 'Daemon sign-in view',
    run: async () => {
      const d = daemonSnapshot()
      if (d.state !== 'live') {
        return { status: 'off', evidence: `no live daemon to compare with — ${d.reason}`, link: '/daemon' }
      }
      const { daemonControlRpc, restartDaemonWords } = await import('../../../../daemon/control/controlSocket.js')
      const { compareSignInViews, composeSignInView, summarizeSignInView } = await import('../../../../daemon/session-seat/signInView.js')
      const reply = await daemonControlRpc({ op: 'signIns', refresh: true }, { timeoutMs: 3000 })
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
  }
}

export function daemonCheck(): CheckSpec {
  return {
    id: 'daemon',
    label: 'Scheduler daemon',
    run: async () => {
      const d = daemonSnapshot()
      if (d.state === 'live') {
        const { daemonHandshakeEvidence, daemonSkewLine, handshakeDaemon, reopenWayOut } = await import('../../../../daemon/control/handshake.js')
        const hs = await handshakeDaemon({ timeoutMs: 1000 })
        const evidence = `daemon.json: ${d.reason} · ${daemonHandshakeEvidence(hs)}`
        if (hs.line !== null) return { status: 'warn', evidence, fix: hs.heal === 'reopen' ? reopenWayOut(hs) : hs.line, link: '/daemon' }
        const skew = daemonSkewLine(hs)
        if (skew !== null) return { status: 'warn', evidence, fix: skew, link: '/daemon' }
        return { status: 'ok', evidence, link: '/daemon' }
      }
      let receipt = ''
      try {
        const { reconcileDaemonRecords } = await import('../../../../daemon/control/reconcileRecords.js')
        const rec = await reconcileDaemonRecords()
        if (rec.state === 'reconciled' && rec.cleaned.length > 0) {
          receipt = `reconciled stale records: removed ${rec.cleaned.join(', ')}${
            rec.deadPid != null ? ` (pid ${rec.deadPid} gone)` : ''
          }`
        }
      } catch (error) {
        passedOver(error)
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
  }
}

export function mercuryProcessesCheck(): CheckSpec {
  return {
    id: 'mercury-processes',
    label: 'Mercury processes',
    run: async () => {
      const { PROCESS_SWEEP_WORDS, processSweepCounts, processSweepLine } = await import('../../../../daemon/process-sweep/processSweep.js')
      const { readMercuryProcesses, endStaleProcesses, processSweepOutcomeLine } = await import('../../../../daemon/process-sweep/processSweepRun.js')
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
  }
}

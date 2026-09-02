// resources/adapters/health — the persisted health certificate
// (mercury://health/cert) and the last gate verdict (mercury://health/gate).
// Reads the SAME last-cert summary the Helm chip folds — never a re-derived
// verdict; a cert from an older HEAD reads with its honest age, and
// "run /health" stays the only re-issuer. The `doctor` kind stays a working
// alias (the command keeps its /doctor alias for the same reason): refs in
// old transcripts and automation keep resolving, canonicalized to health.

import { readFileSync } from 'node:fs'
import { decodeGateVerdict, decodeLastCertSummary } from '../../../utils/healthCertCore.js'
import { gateVerdictPath, lastCertPath } from '../../../utils/healthReport.js'
import type {
  ResourceContext,
  ParsedRef,
  ResourceAdapter,
  ResourceResult,
} from '../contracts.js'

export const healthAdapter: ResourceAdapter = {
  kind: 'health',
  describe: 'the last health certificate + gate verdict (mercury://health/cert)',
  async resolve(ref: ParsedRef): Promise<ResourceResult> {
    if (ref.id !== '' && ref.id !== 'cert' && ref.id !== 'gate') {
      return {
        state: 'absent',
        note: 'health refs: mercury://health/cert (last certificate) · mercury://health/gate (last gate verdict)',
      }
    }
    if (ref.id === 'gate') {
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(gateVerdictPath(), 'utf8'))
      } catch {
        return { state: 'absent', note: 'no gate verdict has been written (run scripts/run-all-suites.sh)' }
      }
      const v = decodeGateVerdict(raw)
      if (!v) {
        return { state: 'absent', note: 'gate verdict artifact unreadable (not the recorded shape)' }
      }
      // The RECORDED verdict with its own provenance — /health interprets
      // staleness against the live tree; this resource never re-derives it.
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://health/gate',
          kind: 'health',
          title: 'gate verdict',
          summary: `recorded ${v.ok ? 'GREEN' : 'RED'} · ${v.pass.length} pass / ${v.fail.length} fail${v.fail.length > 0 ? ` (${v.fail.join(', ')})` : ''} · ${v.ranAt} @ ${v.headSha?.slice(0, 8) ?? '?'}${v.dirty ? ' (dirty)' : ''} — /health interprets freshness`,
          version: `${v.headSha ?? '?'}`,
          mutable: false,
          structured: raw,
        },
      }
    }
    let summary
    try {
      summary = decodeLastCertSummary(JSON.parse(readFileSync(lastCertPath(), 'utf8')))
    } catch {
      summary = null
    }
    if (!summary) {
      return { state: 'absent', note: 'no certificate has been issued (run /health)' }
    }
    const counts = Object.entries(summary.counts)
      .filter(([, n]) => (n as number) > 0)
      .map(([k, n]) => `${k} ${n}`)
      .join(' · ')
    return {
      state: 'ok',
      resource: {
        ref: 'mercury://health/cert',
        kind: 'health',
        title: `certificate: ${summary.verdict}`,
        summary: `${summary.verdict} · issued ${summary.ranAt} @ ${summary.head.sha?.slice(0, 8) ?? '?'} · ${counts}`,
        version: `${summary.head.sha ?? '?'}-${summary.ranAt}`,
        mutable: false,
        structured: summary as unknown,
        text: [
          `verdict: ${summary.verdict}`,
          `issued: ${summary.ranAt}`,
          `head: ${summary.head.sha ?? '?'}${summary.head.dirty ? ' (dirty tree)' : ''}`,
          `counts: ${counts}`,
          '',
          'Re-run /health for live truth — this is the persisted summary the Helm chip reads.',
        ].join('\n'),
      },
    }
  },
}

/** Compat alias: mercury://doctor/* refs from old transcripts and automation
 *  resolve through the health adapter unchanged (results carry the canonical
 *  mercury://health refs). Mirrors the /health command's `doctor` alias. */
export const doctorAliasAdapter: ResourceAdapter = {
  kind: 'doctor',
  describe: "alias of mercury://health/* (the layer's former name)",
  resolve: (ref: ParsedRef, ctx: ResourceContext): Promise<ResourceResult> => healthAdapter.resolve(ref, ctx),
}

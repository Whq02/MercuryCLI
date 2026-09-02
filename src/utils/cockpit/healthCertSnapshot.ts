// healthCertSnapshot — the Helm telemetry rail's per-render reading of the
// persisted /health certificate summary (<state-root>/doctor/last-cert.json,
// written by runAndRecordHealthReport). Mirrors daemonSnapshot's shape
// discipline: a cheap SYNC read (never blocks a render, never spawns),
// degrading to an honest state — `unavailable` when no certificate has ever
// been issued is a valid UI state, not an error. Staleness policy is pure in
// healthCertCore (chipFromLastCert): age > 24h ⇒ stale; the age label itself
// is the honesty signal either way.
//
// Trust-cockpit: the chip now FOLDS IN newer evidence via
// composeChip — a boot-preflight FAULT (last-preflight.json) or a gate
// verdict (<state-root>/gate/verdict.json) newer than the cert surfaces as
// one calm `alert` line. Doctrine: newer evidence only DOWNGRADES/annotates;
// the cert's verdict + age stay the assurance signal (only /health re-issues).
import { readFileSync } from 'node:fs'
import {
  composeChip,
  decodeGateVerdict,
  decodeLastCertSummary,
  decodePreflightSummary,
  type ComposedCertChip,
} from '../healthCertCore.js'
import { lastPreflightPath } from '../healthPreflight.js'
import { healthCertEnabled, gateVerdictPath, lastCertPath } from '../healthReport.js'
import { type Snapshot } from './types.js'

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function healthCertSnapshot(): Snapshot<{ data: ComposedCertChip }> {
  const none: ComposedCertChip = {
    verdict: null,
    ageMs: null,
    ageLabel: 'never',
    stale: false,
  }
  try {
    if (!healthCertEnabled()) {
      return { state: 'off', reason: 'certificate surface gated off', source: 'health', data: none }
    }
    const summary = decodeLastCertSummary(readJson(lastCertPath()))
    const preflight = decodePreflightSummary(readJson(lastPreflightPath()))
    const gate = decodeGateVerdict(readJson(gateVerdictPath()))
    const chip = composeChip(summary, preflight, gate, Date.now())
    if (chip.verdict === null && !chip.alert) {
      return {
        state: 'unavailable',
        reason: 'no certificate issued — run /health',
        source: 'health',
        data: chip,
      }
    }
    return { state: 'live', source: 'health', data: chip }
  } catch {
    return { state: 'unavailable', reason: 'certificate unreadable', source: 'health', data: none }
  }
}

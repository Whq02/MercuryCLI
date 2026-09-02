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

#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-telemetry-absence.ts —-P5/ruling-4:
//  no-phoning-home is STRUCTURAL. The legacy telemetry estate (logEvent
//  facade + queue, discard sink, Datadog/1P transports, events_mono proto
//  types) is deleted, not gated — this ratchet keeps it deleted.
//
//  Caller-graph re-proof, post-delete form:
//    - initSinks attaches ONLY the error-log sink;
//    - no logEvent/logEventAsync facade exists to queue anything, so boot
//      memory-flatness holds by construction (nothing buffers pre-attach);
//    - the four modules are absent from src.
// ============================================================================
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' Telemetry absence (SM-J-P5) — structural ratchet')
console.log('============================================================')

// ── 1. the four modules (and the facade/sink) are absent ─────────────────────
for (const p of [
  'src/services/analytics/index.ts',
  'src/services/analytics/sink.ts',
  'src/services/analytics/datadog.ts',
  'src/services/analytics/firstPartyEventLogger.ts',
  'src/services/analytics/growthbook.ts',
  'src/types/generated/events_mono',
]) {
  check(`absent: ${p}`, !existsSync(join(ROOT, p)))
}

// ── 2. zero logEvent call sites / facade references in src ─────────────────
function* tsFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) yield* tsFiles(p)
    else if (/\.tsx?$/.test(e)) yield p
  }
}
const offenders: string[] = []
for (const f of tsFiles(join(ROOT, 'src'))) {
  const text = readFileSync(f, 'utf8')
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
    if (/\blogEvent(Async)?\s*\(/.test(line)) offenders.push(`${f}:${i + 1}`)
    if (/from\s+['"][^'"]*services\/analytics\/(index|sink)(\.js)?['"]/.test(line)) offenders.push(`${f}:${i + 1} (facade import)`)
  })
}
check('zero logEvent facade call sites and zero facade imports in src', offenders.length === 0, offenders.slice(0, 5).join(' · '))

// ── 3. initSinks attaches only the error-log sink ──────────────────────────
const sinks = readFileSync(join(ROOT, 'src/utils/sinks.ts'), 'utf8')
check('initSinks: error-log sink only', sinks.includes('initializeErrorLogSink()') && !sinks.includes('initializeAnalyticsSink'))

// ── 4. the owned feature-gate table remains (renamed owner, no network) ────
const gates = readFileSync(join(ROOT, 'src/services/analytics/featureGates.ts'), 'utf8')
check(
  'featureGates: the owned static table (no SDK/network import)',
  !/from '@growthbook|from 'axios|node:https/.test(gates),
)

// ── 5. the OpenTelemetry estate is DELETED ────────────────
// All @opentelemetry/* deps, the exporter/tracing module family, and the
// foreign ENABLE_TELEMETRY / OTEL_* consumption paths are absent. The
// subprocessEnv OTEL_*-stripping stays: it is a secret-hygiene control
// (OTLP headers carry bearer tokens), not a telemetry feature.
for (const p of [
  'src/utils/telemetry/sessionTracing.ts',
  'src/utils/telemetry/events.ts',
  'src/utils/telemetry/betaSessionTracing.ts',
  'src/utils/telemetry/instrumentation.ts',
  'src/utils/telemetry/logger.ts',
  'src/utils/telemetry/bigqueryExporter.ts',
  'src/utils/telemetry/pluginTelemetry.ts',
  'src/utils/telemetry/skillLoadedEvent.ts',
  'src/bootstrap/runtime/telemetry-handles.ts',
  'src/utils/telemetryAttributes.ts',
]) {
  check(`OTel absent: ${p}`, !existsSync(join(ROOT, p)))
}
const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8')
check('zero @opentelemetry deps in package.json', !pkg.includes('@opentelemetry'))
check('zero @anthropic-ai/claude-agent-sdk dep', !pkg.includes('@anthropic-ai/claude-agent-sdk'))
const otelOffenders: string[] = []
for (const f of tsFiles(join(ROOT, 'src'))) {
  const text = readFileSync(f, 'utf8')
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
    if (/from ['"]@opentelemetry\//.test(line)) otelOffenders.push(`${f}:${i + 1}`)
    if (/\blogOTelEvent\s*\(/.test(line)) otelOffenders.push(`${f}:${i + 1} (logOTelEvent)`)
    if (line.includes(`${['CLAUDE', 'CODE'].join('_')}_ENABLE_TELEMETRY`)) otelOffenders.push(`${f}:${i + 1} (retired flag)`)
  })
}
check('zero @opentelemetry imports / OTel call sites / retired-flag reads in src', otelOffenders.length === 0, otelOffenders.slice(0, 5).join(' · '))

console.log(failures === 0 ? '\n ✅ TELEMETRY ABSENCE GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

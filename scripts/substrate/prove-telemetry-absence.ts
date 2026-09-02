#!/usr/bin/env bun
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

const sinks = readFileSync(join(ROOT, 'src/utils/sinks.ts'), 'utf8')
check('initSinks: error-log sink only', sinks.includes('initializeErrorLogSink()') && !sinks.includes('initializeAnalyticsSink'))

const gates = readFileSync(join(ROOT, 'src/services/analytics/featureGates.ts'), 'utf8')
check(
  'featureGates: the owned static table (no SDK/network import)',
  !/from '@growthbook|from 'axios|node:https/.test(gates),
)

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

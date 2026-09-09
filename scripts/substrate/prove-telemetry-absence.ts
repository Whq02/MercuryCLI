#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' Telemetry absence (SM-J-P5) — structural proof')
console.log('============================================================')

console.log('\n§1 initSinks attaches the error-log sink and nothing else')
const sinks = readFileSync(join(ROOT, 'src/utils/sinks.ts'), 'utf8')
const initStart = sinks.indexOf('export function initSinks()')
const initBody = sinks.slice(sinks.indexOf('{', initStart) + 1, sinks.indexOf('\n}', initStart))
const initCalls = initBody.match(/\b\w+\(/g) ?? []
check('initSinks calls exactly initializeErrorLogSink', initStart !== -1 && initCalls.join(',') === 'initializeErrorLogSink(', initCalls.join(','))

console.log('\n§2 no OpenTelemetry dependency or import anywhere in the product')
function* tsFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) yield* tsFiles(p)
    else if (/\.tsx?$/.test(e)) yield p
  }
}
const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8')
check('zero @opentelemetry deps in package.json', !pkg.includes('@opentelemetry'))
const otelOffenders: string[] = []
for (const f of tsFiles(join(ROOT, 'src'))) {
  const lines = readFileSync(f, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
    if (/from ['"]@opentelemetry\//.test(line)) otelOffenders.push(`${f}:${i + 1}`)
  })
}
check('zero @opentelemetry imports in src', otelOffenders.length === 0, otelOffenders.slice(0, 5).join(' · '))

console.log(failures === 0 ? '\n ✅ TELEMETRY ABSENCE GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

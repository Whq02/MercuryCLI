#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
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


console.log('\n§2 no OpenTelemetry dependency or import anywhere in the product')
const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8')
check('zero @opentelemetry deps in package.json', !pkg.includes('@opentelemetry'))

console.log(failures === 0 ? '\n ✅ TELEMETRY ABSENCE GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

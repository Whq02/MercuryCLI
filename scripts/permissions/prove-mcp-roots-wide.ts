#!/usr/bin/env bun
import { getFlagSpec } from '../../src/substrate/flagRegistry.ts'

let failures = 0
const t = (name: string, ok: boolean): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures = 1
}


t('flag registered', getFlagSpec('MERCURY_MCP_ROOTS_WIDE') !== undefined)

console.log(failures ? '\n❌ MCP-ROOTS-WIDE RED' : '\n✅ MCP-ROOTS-WIDE GREEN')
process.exit(failures)

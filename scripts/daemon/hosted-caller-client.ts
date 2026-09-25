#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { daemonMain } = await import('../../src/daemon/main.ts')
await daemonMain(process.argv.slice(2))
process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0)

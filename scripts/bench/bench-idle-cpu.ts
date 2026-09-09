#!/usr/bin/env bun
if (process.argv.includes('--help')) {
  console.log('Usage: bun scripts/bench/bench-idle-cpu.ts [--blur] [optimised|interpreted|interpreted-wide|padded ...]')
  console.log('Boots the built terminal in a scratch project against a loopback fixture. Reports 1 Hz CPU mean/p95, CPU-time share and terminal writes, without performance thresholds.')
  console.log('MEASURE_DIST selects a built mercury.mjs and its vendored Node. MEASURE_SETTINGS selects auto,full,reduced,off (default full,auto). MEASURE_WINDOW_S selects the window (default 30). MEASURE_OUT_DIR retains raw observations and summary.json.')
  process.exit(0)
}
await import('../ui/measure-idle-cpu.ts')

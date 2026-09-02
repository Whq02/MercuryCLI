// ============================================================================
//  utils/cockpit — the snapshot/data bridge.
//
//  One import surface for every honest-state snapshot. UI components never scrape
//  env/files/git directly; they take a Snapshot<T> from here. Every helper catches
//  its own errors and returns a labelled state — a missing backend is a UI state,
// not a crash.
// ============================================================================

export * from './types.js'
export * from './modelGauge.js'
export * from './contextGauge.js'
export * from './contextUsageLive.js'
export * from './presenceLive.js'
export * from './gitSnapshot.js'
export * from './substrateSnapshot.js'
export * from './agentStateSnapshot.js'
export * from './permissionsSnapshot.js'
export * from './fleetGauge.js'
export * from './traceSnapshot.js'
export * from './mcpGauge.js'
export * from './daemonSnapshot.js'
export * from './daemonRosterSnapshot.js'
export * from './attentionDerive.js'

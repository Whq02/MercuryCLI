// ============================================================================
//  render-engine — the flag-gated paint engine (MERCURY_RENDER_ENGINE).
//
//  The public seam, in dependency order: contracts (types), the settled-row
//  ledger (E1/E2), the flat projection (E10), the stable-prefix stream cache
//  (spec 02), the write door (E4), capability probing (spec 03), the
//  scheduler (E5/E6), the resize gate (E7), composition (E3/E8), the inline
//  painter, and the assembled engine. scripts/render-engine/ proves each law
//  mechanically.
// ============================================================================

export * from './contracts.js'
export * from './ledger.js'
export * from './projection.js'
export * from './stablePrefix.js'
export * from './door.js'
export * from './capabilities.js'
export * from './scheduler.js'
export * from './resizeSettle.js'
export * from './compose.js'
export * from './inlinePainter.js'
export * from './engine.js'
export * from './flag.js'
export { tokenizeAnsi, clampRowToWidth, ENGINE_C0 } from './ansiText.js'

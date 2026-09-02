// ============================================================================
//  mercury-ui — the shared Mercury terminal UI kit.
//
//  One import surface for the warm-ink command-center primitives so every
//  Mercury surface (MercuryFrame, /deck, /fleet, /trace, /substrate, /policy, the
//  parity specimens, the fullscreen rails) renders from the same components,
//  tokens, glyphs, and honest-state spine. Components take props only — they
//  never read env/files/git; data arrives via the utils/cockpit snapshot bridge.
// ============================================================================

export * from './theme.js'
export * from './glyphs.js'
export * from './assets.js'
export * from './components.js'

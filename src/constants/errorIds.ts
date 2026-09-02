// ============================================================================
//  src/constants/errorIds.ts — obfuscated numeric error-source IDs tracing
//  which error-logging call site produced a production error. Exported as
//  individual constants so a downstream build sees only numbers and can
//  dead-code-eliminate the rest.
//
//  Adding one: (1) take the next free id below and bump it; (2) export the
//  new constant and pass it at the logging call site.
//  Next free id: 346
// ============================================================================

export const E_TOOL_USE_SUMMARY_GENERATION_FAILED = 344

// ============================================================================
//  services/primitives — Mercury's six primitive contracts.
//
//  Owner · Resource · Execution · Transaction · Evidence · View — every major
//  subsystem is a composition of these (or documents why it cannot
//  be). The package re-exports the existing
//  authoritative seams (OwnerKey, the mercury:// plane) and ratifies the
//  vocabularies the domains would otherwise duplicate. Import direction is DOWN
//  only: domains import primitives; primitives never import a domain
//  implementation.
// ============================================================================

export * from './owner.js'
export * from './resource.js'
export * from './execution.js'
export * from './executionPlane.js'
export * from './transaction.js'
export * from './transactionPlane.js'
export * from './evidence.js'
export * from './evidencePlane.js'
export * from './view.js'
export * from './runtimeKernel.js'
export * from './canonicalStream.js'

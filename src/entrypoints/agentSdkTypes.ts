// ============================================================================
//  src/entrypoints/agentSdkTypes.ts — the public Agent-SDK TYPE barrel.
//
//  A re-export surface only: it must export ZERO runtime functions (the
//  former throwing runtime shell is deleted; a prover scans for both a
//  structural function body and a literal "not implemented" throw). Note the
//  star re-export of the core-types module deliberately carries three
//  runtime VALUES — the contract-version constant and the two vocabulary
//  tuples — so "type-only" describes the absence of callable behaviour, not
//  the absence of values.
// ============================================================================
export type { SDKControlRequest, SDKControlResponse } from './sdk/controlTypes.js'
export * from './sdk/coreTypes.js'
export * from './sdk/runtimeTypes.js'

import type { z } from 'zod/v4'
import type { SettingsSchema } from '../utils/settings/types.js'

/** Inferred from the LIVE settings schema, never a generated snapshot. */
export type Settings = z.infer<ReturnType<typeof SettingsSchema>>

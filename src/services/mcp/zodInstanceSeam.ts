// ============================================================================
//  zodInstanceSeam — the ONE typed boundary between OUR zod and the MCP SDK's.
//
//  @modelcontextprotocol/sdk nests its own zod (3.25.x, whose .d.ts import
//  'zod/v4' resolves to the NESTED copy's v4-compat subpath) while src builds
//  schemas with the hoisted zod@4. The two instantiations are runtime-
//  compatible (the SDK validates our schemas fine) but TYPE-distinct, and
//  whether tsc relates them structurally is import-graph-order dependent —
//  a sweep perturbed that order and surfaced phantom
//  `AnyObjectSchema`/`AnySchema` mismatches in every file that passes a
//  LOCALLY-BUILT schema across the SDK boundary (files passing SDK-provided
//  schemas are unaffected).
//
//  Rather than sprinkle casts, every such call site routes through this seam:
//  the ONE deliberate, documented cast, with the caller's handler types fully
//  preserved from OUR schema via z.output. Runtime behavior is byte-identical
//  (the seam is a pass-through call).
// ============================================================================
import type { z } from 'zod/v4'

/**
 * Register a notification handler on an SDK client using a schema built with
 * OUR zod. The handler's notification param is typed from that schema.
 */
export function setMcpNotificationHandler<S extends z.ZodType>(
  client: {
    setNotificationHandler: (schema: never, handler: never) => void
  },
  schema: S,
  handler: (notification: z.output<S>) => void | Promise<void>,
): void {
  ;(
    client.setNotificationHandler as unknown as (
      schema: unknown,
      handler: unknown,
    ) => void
  )(schema, handler)
}

import type { z } from 'zod/v4'

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

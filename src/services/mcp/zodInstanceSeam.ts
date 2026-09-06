import type { z } from 'zod/v4'

type NotificationShape = { method: z.ZodLiteral<string>; params: z.ZodType }

export function setMcpNotificationHandler<S extends z.ZodObject<NotificationShape>>(
  client: {
    setNotificationHandler: (method: never, schemas: never, handler: never) => void
  },
  schema: S,
  handler: (notification: z.output<S>) => void | Promise<void>,
): void {
  const method = schema.shape.method.value
  const params = schema.shape.params
  ;(
    client.setNotificationHandler as unknown as (
      method: string,
      schemas: { params: unknown },
      handler: (params: unknown) => void | Promise<void>,
    ) => void
  )(method, { params }, parsed => handler({ method, params: parsed } as z.output<S>))
}

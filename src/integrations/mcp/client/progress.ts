import { Client } from '../../mcp-shapes/sdk.js'

type ProgressParams = { progressToken?: string | number; progress: number; total?: number; message?: string }
const progressRouters = new WeakMap<Client, Map<string, (params: ProgressParams) => void>>()
export function routeProgress(client: Client, token: string, handler: (params: ProgressParams) => void): () => void {
  let routes = progressRouters.get(client)
  if (!routes) {
    const table = new Map<string, (params: ProgressParams) => void>()
    routes = table
    progressRouters.set(client, table)
    client.setNotificationHandler('notifications/progress', notification => {
      const params = notification.params as ProgressParams
      if (params.progressToken === undefined) return
      table.get(String(params.progressToken))?.(params)
    })
  }
  routes.set(token, handler)
  return () => {
    routes?.delete(token)
  }
}

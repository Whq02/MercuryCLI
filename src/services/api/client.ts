import { AnthropicClient as Anthropic } from '../providers/anthropic/anthropicClient.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


export const CLIENT_REQUEST_ID_HEADER: Unbuilt = unbuilt('src/services/api/client.ts:31')

type GetClientOptions = Unbuilt

export async function getAnthropicClient(options: GetClientOptions): Promise<Anthropic> {
  return notBuilt('src/services/api/client.ts:113')
}

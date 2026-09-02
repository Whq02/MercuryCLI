import { join } from 'path'
import { getMercuryHome } from '../../utils/envUtils.js'

let channelsRootCache: string | undefined
export function channelsRoot(): string {
  if (channelsRootCache) return channelsRootCache
  channelsRootCache = join(getMercuryHome(), 'channels')
  return channelsRootCache
}

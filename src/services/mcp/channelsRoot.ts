import { join } from 'path'
import { getMercuryHome } from '../../utils/envUtils.js'

/**
 * The channels ROOT — the cross-process rendezvous every bus peer must agree
 * on: `<config home>/channels`, always. (The bounded legacy `~/.claude/
 * channels` continuity read is retired.) Lazy-cached:
 * the bus polls, and the answer cannot change within a process lifetime.
 *
 * Kept in its own module so presenceLive can share the resolution WITHOUT
 * importing the heavy bus module (see getPresenceDir's doc).
 */
let channelsRootCache: string | undefined
export function channelsRoot(): string {
  if (channelsRootCache) return channelsRootCache
  channelsRootCache = join(getMercuryHome(), 'channels')
  return channelsRootCache
}

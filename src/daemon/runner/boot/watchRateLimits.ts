import { type AnthropicLimits, statusListeners } from '../../../models/roads/anthropic/anthropicLimits.js'
import { rateLimitRow } from '../../../engine/rows/project.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<'rateLimitListener'> {
  const { enqueueRow, liveScope } = ports
  const rateLimitListener = (limits: AnthropicLimits): void => {
    enqueueRow(rateLimitRow(liveScope(), limits))
  }
  statusListeners.add(rateLimitListener)
  return { rateLimitListener }
}

export const watchRateLimits: BootStep<'rateLimitListener'> = { name: 'watchRateLimits', makes: ['rateLimitListener'], run }

import axios from 'axios'

import { anthropicAccountApiBase } from '../../constants/oauth.js'
import { getClaudeAIOAuthTokens, hasProfileScope, isClaudeAISubscriber } from '../../utils/auth.js'
import { getAuthHeaders } from '../../utils/http.js'
import { getAnthropicClientUserAgent } from '../../utils/userAgent.js'
import { isOAuthTokenExpired } from '../oauth/client.js'
import { logError } from '../../utils/log.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'


export type RateLimit = Unbuilt

export type Utilization = Unbuilt

const USAGE_TIMEOUT_MS = 5000

export function usageEndpointBase(): string {
  return anthropicAccountApiBase()
}

export async function fetchUtilization(): Promise<Utilization | null> {
  return notBuilt('src/services/api/usage.ts:40')
}

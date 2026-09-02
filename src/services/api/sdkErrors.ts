// ============================================================================
//  services/api/sdkErrors — the ONE app-side import site for the provider
//  SDK's runtime error classes.
//
//  Everything outside the provider leaves imports these from here: the class
//  identities stay the SDK's (instanceof against SDK-thrown errors works)
//  while the '@anthropic-ai/sdk' import fence holds at this owner.
//
//  This module must import NOTHING but the SDK — it sits below the whole
//  application graph, so importing it can never create a module cycle
//  (live-found: routing these through api/errors.ts TDZ-crashed mcp/client's
//  error classes through the errors→state→…→client cycle).
// ============================================================================
export {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'

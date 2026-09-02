/**
 * The first-party OAuth flow orchestrator: PKCE setup, dual
 * (automatic-loopback / manual-entry) authorization racing, code exchange,
 * profile enrichment, credential shaping, cleanup.
 */
import { getOauthConfig } from '../../constants/oauth.js'
import { openBrowser } from '../../utils/browser.js'
import { logForDebugging } from '../../utils/debug.js'
import { AuthCodeListener } from './auth-code-listener.js'
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchProfileInfo,
  parseScopes,
} from './client.js'
import { generateCodeChallenge, generateCodeVerifier, generateState } from './crypto.js'
import type { OAuthTokens } from './types.js'

export type OAuthFlowOptions = {
  loginWithClaudeAi?: boolean
  inferenceOnly?: boolean
  expiresIn?: number
  orgUUID?: string
  loginHint?: string
  loginMethod?: string
  skipBrowserOpen?: boolean
}

type AuthUrlHandler = (autoUrl: string, manualUrl: string) => void | Promise<void>

export class OAuthService {
  /** One verifier per flow (generated at construction). */
  private readonly codeVerifier = generateCodeVerifier()
  private readonly listener = new AuthCodeListener()
  private pendingManualResolve:
    | ((input: { authorizationCode: string; state: string }) => void)
    | null = null

  /**
   * Run the full flow and return the shaped credential.
   *
   * The loopback listener starts FIRST (and stays open until used, avoiding
   * a bind race); both authorize URLs are built from one challenge/state/
   * port; the automatic redirect races manual code entry; which flow won is
   * decided by whether the listener still holds a pending HTTP response.
   */
  async startOAuthFlow(
    authUrlHandler: AuthUrlHandler,
    options?: OAuthFlowOptions,
  ): Promise<OAuthTokens> {
    const codeChallenge = generateCodeChallenge(this.codeVerifier)
    const state = generateState()
    const port = await this.listener.start()

    const loginWithClaudeAi = options?.loginWithClaudeAi === true
    const common = {
      loginWithClaudeAi,
      port,
      codeChallenge,
      state,
      ...(options?.inferenceOnly === undefined ? {} : { inferenceOnly: options.inferenceOnly }),
      ...(options?.orgUUID === undefined ? {} : { orgUUID: options.orgUUID }),
      ...(options?.loginHint === undefined ? {} : { loginHint: options.loginHint }),
      ...(options?.loginMethod === undefined ? {} : { loginMethod: options.loginMethod }),
    }
    const autoUrl = buildAuthUrl({ ...common, isManual: false })
    const manualUrl = buildAuthUrl({ ...common, isManual: true })

    const manualEntry = new Promise<{ authorizationCode: string; state: string }>(resolve => {
      this.pendingManualResolve = resolve
    })

    try {
      const winner = await Promise.race([
        this.listener
          .waitForAuthorization(state, () => {
            void (async () => {
              await authUrlHandler(autoUrl, manualUrl)
              if (options?.skipBrowserOpen !== true) {
                logForDebugging(`oauth: opening browser to ${autoUrl}`)
                await openBrowser(autoUrl)
              }
            })()
          })
          .then(code => ({ authorizationCode: code, state })),
        manualEntry,
      ])

      // The automatic flow won exactly when the listener is still holding the
      // redirect's HTTP response open.
      const automaticWon = this.listener.hasPendingResponse()

      try {
        const response = await exchangeCodeForTokens(
          winner.authorizationCode,
          winner.state,
          this.codeVerifier,
          port,
          !automaticWon,
          options?.expiresIn,
        )
        const scopes = parseScopes(response.scope)
        const profile = await fetchProfileInfo(response.access_token)
        if (automaticWon) {
          this.listener.handleSuccessRedirect(scopes)
        }
        return {
          accessToken: response.access_token,
          refreshToken: response.refresh_token ?? null,
          expiresAt: Date.now() + response.expires_in * 1000,
          scopes,
          subscriptionType: profile?.subscriptionType ?? null,
          rateLimitTier: profile?.rateLimitTier ?? null,
          ...(profile?.profile === undefined ? {} : { profile: profile.profile }),
          ...(response.account !== undefined
            ? {
                tokenAccount: {
                  uuid: response.account.uuid,
                  emailAddress: response.account.email_address,
                  // The organisation block is separate and may be absent.
                  ...(response.organization?.uuid === undefined
                    ? {}
                    : { organizationUuid: response.organization.uuid }),
                },
              }
            : {}),
        }
      } catch (error) {
        if (this.listener.hasPendingResponse()) {
          this.listener.handleErrorRedirect()
        }
        throw error
      }
    } finally {
      this.listener.close()
      this.pendingManualResolve = null
    }
  }

  /**
   * Manual code entry: resolves the pending wait and closes the listener; a
   * no-op when nothing is waiting. No local state comparison happens — the
   * given state still travels to the token endpoint, which is where a
   * mismatch is caught.
   */
  handleManualAuthCodeInput({
    authorizationCode,
    state,
  }: {
    authorizationCode: string
    state: string
  }): void {
    const resolve = this.pendingManualResolve
    if (resolve === null) return
    this.pendingManualResolve = null
    this.listener.close()
    resolve({ authorizationCode, state })
  }

  /** Close the listener and drop any pending manual resolver. */
  cleanup(): void {
    this.listener.close()
    this.pendingManualResolve = null
  }
}

export { AuthCodeListener } from './auth-code-listener.js'
export { getOauthConfig }

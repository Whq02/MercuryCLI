/**
 * Loopback HTTP listener for the first-party OAuth authorization-code
 * redirect. Captures the code, then keeps the HTTP response OPEN so the
 * success/error redirect can be issued after the token exchange settles.
 */
import { createServer, type Server, type ServerResponse } from 'node:http'

import { logError } from '../../utils/log.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { shouldUseClaudeAIAuth } from './client.js'

export class AuthCodeListener {
  private server: Server | null = null
  private port = 0
  private readonly callbackPath: string
  private pendingResponse: ServerResponse | null = null
  private pendingResolve: ((code: string) => void) | null = null
  private pendingReject: ((error: Error) => void) | null = null
  private expectedState: string | null = null

  constructor(callbackPath: string = '/callback') {
    this.callbackPath = callbackPath
  }

  /** Bind on localhost. Port 0 (the default) means OS-assigned; the actually
   *  bound port is returned and kept for `getPort()`. A bind failure rejects
   *  naming the underlying cause. */
  start(port: number = 0): Promise<number> {
    return new Promise<number>((resolvePromise, rejectPromise) => {
      const server = createServer((request, response) => {
        this.handleRequest(request.url ?? '/', request.headers.host, response)
      })
      server.on('error', (error: Error) => {
        if (this.server === null) {
          rejectPromise(new Error(`Failed to start the OAuth callback listener: ${error.message}`))
          return
        }
        logError(`OAuth callback listener error: ${error.message}`)
        const reject = this.pendingReject
        this.clearPending()
        this.close()
        reject?.(error)
      })
      server.listen(port, 'localhost', () => {
        this.server = server
        const address = server.address()
        this.port = typeof address === 'object' && address !== null ? address.port : port
        resolvePromise(this.port)
      })
    })
  }

  getPort(): number {
    return this.port
  }

  /** True while a captured redirect's HTTP response is still open. */
  hasPendingResponse(): boolean {
    return this.pendingResponse !== null
  }

  /**
   * Wait for the authorization-code redirect. `onReady` fires once the
   * listener is armed (the caller then shows/opens the authorize URLs).
   */
  waitForAuthorization(state: string, onReady?: () => void): Promise<string> {
    return new Promise<string>((resolvePromise, rejectPromise) => {
      this.expectedState = state
      this.pendingResolve = resolvePromise
      this.pendingReject = rejectPromise
      onReady?.()
    })
  }

  private handleRequest(rawUrl: string, host: string | undefined, response: ServerResponse): void {
    const url = new URL(rawUrl, `http://${host ?? 'localhost'}`)
    if (url.pathname !== this.callbackPath) {
      response.writeHead(404)
      response.end()
      return
    }
    const code = url.searchParams.get('code')
    if (code === null || code === '') {
      response.writeHead(400, { 'Content-Type': 'text/plain' })
      response.end('No authorization code received')
      const reject = this.pendingReject
      this.clearPending()
      reject?.(new Error('No authorization code received'))
      return
    }
    if (this.expectedState !== null && url.searchParams.get('state') !== this.expectedState) {
      response.writeHead(400, { 'Content-Type': 'text/plain' })
      response.end('Invalid state parameter')
      const reject = this.pendingReject
      this.clearPending()
      reject?.(new Error('Invalid state parameter'))
      return
    }
    // Retain the response so the success/error redirect can be issued after
    // the token exchange.
    this.pendingResponse = response
    const resolve = this.pendingResolve
    this.pendingResolve = null
    this.pendingReject = null
    resolve?.(code)
  }

  /**
   * Complete the browser journey: 302 to the page chosen by the granted
   * scopes (the account page when inference was granted, the console page
   * otherwise), or delegate to a caller-supplied handler.
   */
  handleSuccessRedirect(scopes: string[], custom?: (response: ServerResponse) => void): void {
    const response = this.pendingResponse
    if (response === null) return
    this.pendingResponse = null
    if (custom !== undefined) {
      custom(response)
      return
    }
    const config = getOauthConfig()
    const target = shouldUseClaudeAIAuth(scopes)
      ? config.CLAUDEAI_SUCCESS_URL
      : config.CONSOLE_SUCCESS_URL
    response.writeHead(302, { Location: target })
    response.end()
  }

  /** The error redirect (no distinct error page exists today — the account
   *  success page is used). */
  handleErrorRedirect(): void {
    const response = this.pendingResponse
    if (response === null) return
    this.pendingResponse = null
    response.writeHead(302, { Location: getOauthConfig().CLAUDEAI_SUCCESS_URL })
    response.end()
  }

  private clearPending(): void {
    this.pendingResolve = null
    this.pendingReject = null
  }

  /** Close. A still-pending response first receives the error redirect. */
  close(): void {
    if (this.pendingResponse !== null) {
      this.handleErrorRedirect()
    }
    if (this.server !== null) {
      this.server.removeAllListeners()
      this.server.on('error', () => {})
      this.server.close()
      this.server = null
    }
    this.clearPending()
    this.expectedState = null
  }
}

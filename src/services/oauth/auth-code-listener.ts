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

  hasPendingResponse(): boolean {
    return this.pendingResponse !== null
  }

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
    this.pendingResponse = response
    const resolve = this.pendingResolve
    this.pendingResolve = null
    this.pendingReject = null
    resolve?.(code)
  }

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

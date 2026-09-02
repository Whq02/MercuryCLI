import axios from 'axios'

import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { HookCommand } from '../settings/types.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { logForDebugging } from '../debug.js'
import { getProxyUrl, shouldBypassProxy } from '../proxy.js'
import { getInitialSettings } from '../settings/settings.js'
import { escapeRegExp } from '../stringUtils.js'
import { ssrfGuardedLookup } from './ssrfGuard.js'

type HttpHook = Extract<HookCommand, { type: 'http' }>

export type HttpHookResult = {
  ok: boolean
  statusCode?: number
  body: string
  error?: string
  aborted?: boolean
}

/** This module's own ten-minute default for the HTTP hook timeout. */
const HTTP_HOOK_TIMEOUT_MS = 600_000

/** `*` means any characters; every other regex metacharacter is a literal; anchored both ends. */
function matchesAllowlistPattern(url: string, pattern: string): boolean {
  const regex = new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, '.*')}$`)
  return regex.test(url)
}

const ENV_REFERENCE_PATTERN = /\$(?:\{([A-Z_][A-Z0-9_]*)\}|([A-Z_][A-Z0-9_]*))/g

/**
 * Interpolate `$NAME` / `${NAME}` from the process environment, but only
 * for allowlisted names — the point is to keep secrets out of settings
 * files while preventing a project-configured hook from exfiltrating
 * arbitrary environment variables. Disallowed references and allowed-but-
 * unset variables both become the empty string.
 */
function interpolateHeaderValue(value: string, allowedNames: ReadonlySet<string>): string {
  return value.replace(ENV_REFERENCE_PATTERN, (_match, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? ''
    if (!allowedNames.has(name)) {
      logForDebugging(`http hook header referenced a non-allowlisted environment variable: ${name}`, {
        level: 'warn',
      })
      return ''
    }
    return process.env[name] ?? ''
  })
}

/** Strip CR, LF, and NUL so neither a malicious env value nor a header template can inject headers. */
function sanitiseHeaderValue(value: string): string {
  return value.replace(/[\r\n\x00]/g, '')
}

/**
 * Executor for `http`-type hooks: POST the event payload JSON to the
 * configured URL and return the raw response for the caller to interpret.
 * The event parameter is accepted and unused (signature stability with the
 * sibling executors).
 */
export async function execHttpHook(
  hook: HttpHook,
  hookEvent: HookEvent,
  jsonInput: string,
  signal?: AbortSignal,
): Promise<HttpHookResult> {
  void hookEvent

  // Allowlist semantics match the MCP server allowlist: undefined = no
  // restriction; empty = block everything; non-empty = a pattern must match.
  // Enforced before any I/O. The MERGED settings are the source — the merge
  // concatenates arrays across every settings source.
  const allowlist = getInitialSettings().allowedHttpHookUrls
  if (allowlist !== undefined && !allowlist.some(pattern => matchesAllowlistPattern(hook.url, pattern))) {
    logForDebugging(`http hook blocked: ${hook.url} matched no pattern in allowedHttpHookUrls`, { level: 'warn' })
    return {
      ok: false,
      body: '',
      error: `URL ${hook.url} matched no pattern in the allowedHttpHookUrls setting`,
    }
  }

  const timeoutMs = hook.timeout ? hook.timeout * 1000 : HTTP_HOOK_TIMEOUT_MS
  const { signal: combinedSignal, cleanup } = createCombinedAbortSignal(signal, { timeoutMs })

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (hook.headers && Object.keys(hook.headers).length > 0) {
    // The hook's own declared allowlist, intersected with the MERGED
    // settings list when that list is defined. Header NAMES are never
    // interpolated.
    const settingsList = getInitialSettings().httpHookAllowedEnvVars
    const hookList = hook.allowedEnvVars ?? []
    const allowedNames = new Set(
      settingsList === undefined ? hookList : hookList.filter(name => settingsList.includes(name)),
    )
    for (const [name, value] of Object.entries(hook.headers)) {
      headers[name] = sanitiseHeaderValue(interpolateHeaderValue(value, allowedNames))
    }
  }

  try {
    let response
    const { SandboxManager } = await import('../sandbox/sandbox-adapter.js')
    // The sandbox proxy enforces the domain allowlist (403 for blocked
    // domains). In the interactive path network initialisation is
    // fire-and-forget, so AWAIT it BEFORE reading the proxy port — the port
    // is unset until initialisation completes, and a first racing hook would
    // otherwise go direct, skipping the sandbox domain allowlist. The module
    // is imported dynamically to avoid a static import cycle.
    let sandboxProxyPort: number | undefined
    if (SandboxManager.isSandboxingEnabled()) {
      await SandboxManager.waitForNetworkInitialization()
      sandboxProxyPort = SandboxManager.getProxyPort()
    }
    if (sandboxProxyPort !== undefined) {
      logForDebugging(`http hook routed through the sandbox network proxy: ${hook.url}`)
      response = await axios.post(hook.url, jsonInput, {
        headers,
        signal: combinedSignal,
        proxy: { host: '127.0.0.1', port: sandboxProxyPort, protocol: 'http' },
        validateStatus: () => true,
        maxRedirects: 0,
        responseType: 'text',
      })
    } else {
      // Axios's own proxy auto-detection stays off; the global request
      // interceptor supplies an agent for an env-configured proxy. The env
      // proxy is in use only when BOTH a proxy URL is configured AND the
      // hook's URL is not excluded by the no-proxy list; a NO_PROXY-listed
      // target goes direct WITH the SSRF guard installed as the resolver —
      // with a proxy the proxy does the target's DNS, and guarding here
      // would instead validate the proxy's own (often private) address.
      const envProxy = getProxyUrl()
      const viaEnvProxy = envProxy !== undefined && !shouldBypassProxy(hook.url)
      logForDebugging(
        viaEnvProxy
          ? `http hook routed through the environment proxy: ${hook.url}`
          : `http hook direct: ${hook.url}`,
      )
      response = await axios.post(hook.url, jsonInput, {
        headers,
        signal: combinedSignal,
        proxy: false,
        ...(viaEnvProxy ? {} : { lookup: ssrfGuardedLookup as never }),
        validateStatus: () => true,
        maxRedirects: 0,
        responseType: 'text',
      })
    }
    cleanup()
    const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? '')
    return {
      ok: response.status >= 200 && response.status < 300,
      statusCode: response.status,
      body,
    }
  } catch (error) {
    cleanup()
    if (combinedSignal.aborted || axios.isCancel(error)) {
      return { ok: false, body: '', aborted: true }
    }
    const message = error instanceof Error ? error.message : String(error)
    logForDebugging(`http hook failed: ${message}`, { level: 'error' })
    return {
      ok: false,
      body: '',
      error: message,
    }
  }
}

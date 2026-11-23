import type { CDPSession, Page } from 'puppeteer-core'
import type { PageKit } from './shapes.js'
import { passedOver, passedOverAs } from '../../../platform/errors/passedOver.js'

export function resolveHostLanguages(localeOverride?: string): {
  primary: string
  languages: string[]
  acceptLanguage: string
} {
  let raw = 'en-US'
  try {
    const resolved = localeOverride ?? Intl.DateTimeFormat().resolvedOptions().locale
    if (resolved && /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(resolved) && resolved !== 'C' && resolved !== 'POSIX') {
      const parts = resolved.split('-')
      const lang = parts[0]!.toLowerCase()
      raw = parts.length >= 2 ? `${lang}-${parts[1]!.toUpperCase()}` : lang === 'en' ? 'en-US' : lang
    }
  } catch (error) { passedOver(error) }
  const base = raw.split('-')[0] || 'en'
  const languages = raw.includes('-') && base !== raw ? [raw, base] : [raw, 'en'].filter((v, i, a) => a.indexOf(v) === i)
  const acceptLanguage = languages.join(',')
  return { primary: languages[0]!, languages, acceptLanguage }
}

export function resolveNavigatorPlatform(
  cleanUa: string,
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const isMac = cleanUa.includes('Macintosh') || platform === 'darwin'
  if (isMac) return 'MacIntel'
  const isWin = cleanUa.includes('Windows') || platform === 'win32'
  if (isWin) return 'Win32'
  return cleanUa.includes('aarch64') || arch === 'arm64' ? 'Linux aarch64' : 'Linux x86_64'
}

export function resolveHostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch (error) {
    passedOver(error)
    return 'UTC'
  }
}

function pageStealthInit(langs: string[]): void {
  const nativeStrings = new WeakMap<Function, string>()
  const origToString = Function.prototype.toString
  const markNative = <T extends Function>(fn: T, name: string): T => {
    nativeStrings.set(fn, `function ${name}() { [native code] }`)
    Object.defineProperty(fn, 'name', { value: name, configurable: true })
    return fn
  }
  const patchedToString = {
    toString(this: Function): string {
      if (typeof this === 'function' && nativeStrings.has(this)) {
        return nativeStrings.get(this)!
      }
      return origToString.call(this)
    },
  }.toString
  markNative(patchedToString, 'toString')
  Object.defineProperty(Function.prototype, 'toString', {
    value: patchedToString,
    writable: true,
    enumerable: false,
    configurable: true,
  })
  const navProto = Object.getPrototypeOf(navigator)
  if (navigator.webdriver !== false) {
    Object.defineProperty(navProto, 'webdriver', {
      get: markNative({ webdriver() {
        return false
      } }.webdriver, 'get webdriver'),
      enumerable: true,
      configurable: true,
    })
  }
  if (Object.prototype.hasOwnProperty.call(navigator, 'webdriver')) {
    Reflect.deleteProperty(navigator, 'webdriver')
  }
  const nativeLanguages = Object.getOwnPropertyDescriptor(navProto, 'languages')?.get
  let frozenLangs = Object.freeze([...langs])
  const currentLanguages = (): readonly string[] => {
    const current = nativeLanguages?.call(navigator) as string[] | undefined
    if (current?.length && (current.length !== frozenLangs.length || current.some((value, index) => value !== frozenLangs[index]))) {
      frozenLangs = Object.freeze([...current])
    }
    return frozenLangs
  }
  Object.defineProperty(navProto, 'language', {
    get: markNative({ language() {
      return currentLanguages()[0] ?? 'en-US'
    } }.language, 'get language'),
    enumerable: true,
    configurable: true,
  })
  Object.defineProperty(navProto, 'languages', {
    get: markNative({ languages() {
      return currentLanguages()
    } }.languages, 'get languages'),
    enumerable: true,
    configurable: true,
  })
  const w: Window & { chrome?: unknown } = window
  if (!('chrome' in w) || typeof w.chrome !== 'object' || w.chrome === null) {
    Object.defineProperty(w, 'chrome', {
      value: {},
      writable: true,
      enumerable: true,
      configurable: false,
    })
  }
  const chromeObj = w.chrome as Record<string, unknown>
  if (!('app' in chromeObj) || !chromeObj.app) {
    chromeObj.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails: markNative({ getDetails() {
        if (arguments.length) throw new TypeError('Error in invocation of app.getDetails()')
        return null
      } }.getDetails, 'getDetails'),
      getIsInstalled: markNative({ getIsInstalled() {
        if (arguments.length) throw new TypeError('Error in invocation of app.getIsInstalled()')
        return false
      } }.getIsInstalled, 'getIsInstalled'),
      runningState: markNative({ runningState() {
        if (arguments.length) throw new TypeError('Error in invocation of app.runningState()')
        return 'cannot_run'
      } }.runningState, 'runningState'),
    }
  }
  if (!('csi' in chromeObj) || typeof chromeObj.csi !== 'function') {
    chromeObj.csi = markNative(function csi() {
      const t = window.performance?.timing
      const start = t?.navigationStart || Date.now()
      return {
        onloadT: t?.domContentLoadedEventEnd || start,
        startE: start,
        pageT: Date.now() - start,
        tran: 15,
      }
    }, '')
  }
  if (!('loadTimes' in chromeObj) || typeof chromeObj.loadTimes !== 'function') {
    chromeObj.loadTimes = markNative(function loadTimes() {
      const t = window.performance?.timing
      const navEntry = (window.performance?.getEntriesByType?.('navigation')?.[0] ?? null) as {
        nextHopProtocol?: string
        type?: string
      } | null
      const hop = navEntry?.nextHopProtocol || 'h2'
      const start = (t?.navigationStart || Date.now()) / 1000
      return {
        connectionInfo: hop,
        npnNegotiatedProtocol: hop,
        navigationType: navEntry?.type || 'other',
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: hop === 'h2' || hop === 'hq',
        wasNpnNegotiated: hop === 'h2' || hop === 'hq',
        firstPaintAfterLoadTime: 0,
        requestTime: start,
        startLoadTime: start,
        commitLoadTime: (t?.responseStart || Date.now()) / 1000,
        finishDocumentLoadTime: (t?.domContentLoadedEventEnd || Date.now()) / 1000,
        finishLoadTime: (t?.loadEventEnd || Date.now()) / 1000,
        firstPaintTime: start,
      }
    }, '')
  }
  if (!('runtime' in chromeObj) || !chromeObj.runtime) {
    const validExtId = (s: unknown): s is string => typeof s === 'string' && /^[a-p]{32}$/i.test(s)
    const sendMessage = markNative({ sendMessage(extId?: unknown, _msg?: unknown, opts?: unknown, cb?: unknown) {
      const pre =
        'Error in invocation of runtime.sendMessage(optional string extensionId, any message, optional object options, optional function responseCallback): '
      if (arguments.length === 0 || arguments.length > 4 || (opts && typeof opts !== 'object') || (cb && typeof cb !== 'function')) {
        throw new TypeError(`${pre}No matching signature.`)
      }
      if (arguments.length < 2) {
        throw new TypeError(`${pre}chrome.runtime.sendMessage() called from a webpage must specify an Extension ID (string) for its first argument.`)
      }
      if (typeof extId !== 'string') throw new TypeError(`${pre}No matching signature.`)
      if (!validExtId(extId)) throw new TypeError(`${pre}Invalid extension id: '${extId}'`)
      return undefined
    } }.sendMessage, 'sendMessage')
    const connect = markNative({ connect(extId?: unknown, info?: unknown) {
      const pre = 'Error in invocation of runtime.connect(optional string extensionId, optional object connectInfo): '
      if (arguments.length === 0 || (arguments.length === 1 && extId === '')) {
        throw new TypeError(`${pre}chrome.runtime.connect() called from a webpage must specify an Extension ID (string) for its first argument.`)
      }
      if (arguments.length > 2 || (info && typeof info !== 'object')) {
        throw new TypeError(`${pre}No matching signature.`)
      }
      if (typeof extId !== 'string') {
        throw new TypeError(`${pre}chrome.runtime.connect() called from a webpage must specify an Extension ID (string) for its first argument.`)
      }
      if (!validExtId(extId)) throw new TypeError(`${pre}Invalid extension id: '${extId}'`)
      const ev = () => ({
        addListener: markNative({ addListener() {} }.addListener, 'addListener'),
        dispatch: markNative({ dispatch() {} }.dispatch, 'dispatch'),
        hasListener: markNative({ hasListener() {} }.hasListener, 'hasListener'),
        hasListeners: markNative({ hasListeners() {
          return false
        } }.hasListeners, 'hasListeners'),
        removeListener: markNative({ removeListener() {} }.removeListener, 'removeListener'),
      })
      return {
        name: '',
        sender: undefined,
        disconnect: markNative({ disconnect() {} }.disconnect, 'disconnect'),
        onDisconnect: ev(),
        onMessage: ev(),
        postMessage: markNative({ postMessage() {
          if (!arguments.length) throw new TypeError('Insufficient number of arguments.')
          throw new Error('Attempting to use a disconnected port object')
        } }.postMessage, 'postMessage'),
      }
    } }.connect, 'connect')
    chromeObj.runtime = {
      OnInstalledReason: {
        CHROME_UPDATE: 'chrome_update',
        INSTALL: 'install',
        SHARED_MODULE_UPDATE: 'shared_module_update',
        UPDATE: 'update',
      },
      OnRestartRequiredReason: {
        APP_UPDATE: 'app_update',
        OS_UPDATE: 'os_update',
        PERIODIC: 'periodic',
      },
      PlatformArch: {
        ARM: 'arm',
        ARM64: 'arm64',
        MIPS: 'mips',
        MIPS64: 'mips64',
        X86_32: 'x86-32',
        X86_64: 'x86-64',
      },
      PlatformNaclArch: {
        ARM: 'arm',
        MIPS: 'mips',
        MIPS64: 'mips64',
        X86_32: 'x86-32',
        X86_64: 'x86-64',
      },
      PlatformOs: {
        ANDROID: 'android',
        CROS: 'cros',
        LINUX: 'linux',
        MAC: 'mac',
        OPENBSD: 'openbsd',
        WIN: 'win',
      },
      RequestUpdateCheckStatus: {
        NO_UPDATE: 'no_update',
        THROTTLED: 'throttled',
        UPDATE_AVAILABLE: 'update_available',
      },
      id: undefined,
      connect,
      sendMessage,
    }
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
    Object.defineProperty(Notification, 'permission', {
      get: markNative({ permission() {
        return 'default'
      } }.permission, 'get permission'),
      enumerable: true,
      configurable: true,
    })
  }
  if (typeof Permissions !== 'undefined' && Permissions.prototype && typeof Permissions.prototype.query === 'function') {
    const origQuery = Permissions.prototype.query
    const query = markNative({ query(this: Permissions, desc: PermissionDescriptor) {
      return origQuery.call(this, desc).then(status => {
        if (desc && (desc as { name?: string }).name === 'notifications' && typeof Notification !== 'undefined') {
          const expected = Notification.permission === 'default' ? 'prompt' : Notification.permission
          if (status.state !== expected) {
            return new Proxy(status, {
              get(target, prop) {
                if (prop === 'state') return expected
                const val = Reflect.get(target, prop, target)
                return typeof val === 'function' ? val.bind(target) : val
              },
            })
          }
        }
        return status
      })
    } }.query, 'query')
    Object.defineProperty(Permissions.prototype, 'query', {
      value: query,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }
  const patchWebGL = (ctor: { prototype?: { getParameter?: Function } } | undefined) => {
    const proto = ctor?.prototype
    if (!proto || typeof proto.getParameter !== 'function') return
    const origGetParameter = proto.getParameter
    const getParameter = markNative({ getParameter(this: unknown, param: number) {
      const val = origGetParameter.call(this, param)
      if (param === 37445) {
        if (!val || /SwiftShader|Brian Paul|Mesa|llvmpipe|Google Inc\.\s*\(Google\)/i.test(String(val))) {
          return 'Intel Inc.'
        }
      }
      if (param === 37446) {
        if (!val || /SwiftShader|OffScreen|Brian Paul|llvmpipe|Subzero/i.test(String(val))) {
          return 'Intel Iris OpenGL Engine'
        }
      }
      if (param === 0x1f00 && /Brian Paul/i.test(String(val))) return 'WebKit'
      if (param === 0x1f01 && /Mesa OffScreen|SwiftShader/i.test(String(val))) return 'WebKit WebGL'
      return val
    } }.getParameter, 'getParameter')
    Object.defineProperty(proto, 'getParameter', {
      value: getParameter,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }
  patchWebGL(typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext : undefined)
  patchWebGL(typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext : undefined)
  if (
    navigator.plugins.length === 0 &&
    typeof PluginArray !== 'undefined' &&
    typeof Plugin !== 'undefined' &&
    typeof MimeTypeArray !== 'undefined' &&
    typeof MimeType !== 'undefined'
  ) {
    const pluginNames = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF']
    const mimeDefs = [
      { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    ]
    const mimeArr = Object.create(MimeTypeArray.prototype)
    const pluginArr = Object.create(PluginArray.prototype)
    pluginNames.forEach((pName, pIdx) => {
      const pObj = Object.create(Plugin.prototype)
      Object.defineProperties(pObj, {
        name: { value: pName, enumerable: true },
        filename: { value: 'internal-pdf-viewer', enumerable: true },
        description: { value: 'Portable Document Format', enumerable: true },
        length: { value: mimeDefs.length, enumerable: true },
      })
      mimeDefs.forEach((mDef, mIdx) => {
        const mObj = Object.create(MimeType.prototype)
        Object.defineProperties(mObj, {
          type: { value: mDef.type, enumerable: true },
          suffixes: { value: mDef.suffixes, enumerable: true },
          description: { value: mDef.description, enumerable: true },
          enabledPlugin: { value: pObj, enumerable: true },
        })
        Object.defineProperty(pObj, mIdx, { value: mObj, enumerable: true })
        Object.defineProperty(pObj, mDef.type, { value: mObj, enumerable: false })
        if (pIdx === 0) {
          Object.defineProperty(mimeArr, mIdx, { value: mObj, enumerable: true })
          Object.defineProperty(mimeArr, mDef.type, { value: mObj, enumerable: false })
        }
      })
      pObj.item = markNative({ item(idx: number) {
        return pObj[idx] ?? null
      } }.item, 'item')
      pObj.namedItem = markNative({ namedItem(k: string) {
        return pObj[k] ?? null
      } }.namedItem, 'namedItem')
      Object.defineProperty(pluginArr, pIdx, { value: pObj, enumerable: true })
      Object.defineProperty(pluginArr, pName, { value: pObj, enumerable: false })
    })
    Object.defineProperty(pluginArr, 'length', { value: pluginNames.length, enumerable: true })
    pluginArr.item = markNative({ item(idx: number) {
      return pluginArr[idx] ?? null
    } }.item, 'item')
    pluginArr.namedItem = markNative({ namedItem(k: string) {
      return pluginArr[k] ?? null
    } }.namedItem, 'namedItem')
    pluginArr.refresh = markNative({ refresh() {} }.refresh, 'refresh')
    Object.defineProperty(mimeArr, 'length', { value: mimeDefs.length, enumerable: true })
    mimeArr.item = markNative({ item(idx: number) {
      return mimeArr[idx] ?? null
    } }.item, 'item')
    mimeArr.namedItem = markNative({ namedItem(k: string) {
      return mimeArr[k] ?? null
    } }.namedItem, 'namedItem')
    Object.defineProperty(navProto, 'plugins', {
      get: markNative({ plugins() {
        return pluginArr
      } }.plugins, 'get plugins'),
      enumerable: true,
      configurable: true,
    })
    Object.defineProperty(navProto, 'mimeTypes', {
      get: markNative({ mimeTypes() {
        return mimeArr
      } }.mimeTypes, 'get mimeTypes'),
      enumerable: true,
      configurable: true,
    })
  }
  const origOuterW = Object.getOwnPropertyDescriptor(window, 'outerWidth')
  const origOuterH = Object.getOwnPropertyDescriptor(window, 'outerHeight')
  Object.defineProperty(window, 'outerWidth', {
    get: markNative({ outerWidth() {
      const raw = origOuterW?.get ? origOuterW.get.call(window) : (origOuterW?.value ?? 0)
      const inner = window.innerWidth || 1280
      return typeof raw === 'number' && raw >= inner ? raw : inner
    } }.outerWidth, 'get outerWidth'),
    enumerable: true,
    configurable: true,
  })
  Object.defineProperty(window, 'outerHeight', {
    get: markNative({ outerHeight() {
      const raw = origOuterH?.get ? origOuterH.get.call(window) : (origOuterH?.value ?? 0)
      const inner = window.innerHeight || 800
      return typeof raw === 'number' && raw >= inner ? raw : inner + 85
    } }.outerHeight, 'get outerHeight'),
    enumerable: true,
    configurable: true,
  })
}

export const pageKits = new WeakMap<Page, PageKit>()

export function pageKitOf(page: Page): PageKit | null {
  return pageKits.get(page) ?? null
}

export function stealthSource(languages: string[]): string {
  return `(${pageStealthInit})(${JSON.stringify(languages)})`
}

export async function prepareDocuments(page: Page, own: CDPSession | null, languages: string[]): Promise<void> {
  if (typeof page.evaluateOnNewDocument !== 'function') return
  if (own === null) {
    await page.evaluateOnNewDocument(pageStealthInit, languages).catch(passedOverAs(undefined))
  } else {
    await own.send('Page.enable').catch(passedOverAs(undefined))
    await own.send('Page.addScriptToEvaluateOnNewDocument', { source: stealthSource(languages) }).catch(passedOverAs(undefined))
  }
  await page.evaluate(pageStealthInit, languages).catch(passedOverAs(undefined))
}

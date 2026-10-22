#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import type { Browser as DriverBrowser, LaunchOptions } from 'puppeteer-core'

const ROOT = resolve(process.env.PROOF_SUBJECT_ROOT ?? join(import.meta.dir, '..', '..'))
const SCRATCH_HOME = mkdtempSync(join(tmpdir(), 'mercury-stealth-home-'))
const SCRATCH_BROWSERS = join(SCRATCH_HOME, 'browsers')
mkdirSync(SCRATCH_BROWSERS, { recursive: true })

const inheritedCache = process.env.MERCURY_BROWSER_CACHE_DIR
const ambientCache = process.env.MERCURY_CONFIG_DIR ? join(process.env.MERCURY_CONFIG_DIR, 'browsers') : null
const sharedCache = '/private/tmp/mw/browser-stealth/browsers'
const seedCache =
  inheritedCache && existsSync(join(inheritedCache, 'chrome'))
    ? inheritedCache
    : ambientCache && existsSync(join(ambientCache, 'chrome'))
      ? ambientCache
      : existsSync(join(sharedCache, 'chrome'))
        ? sharedCache
        : null
if (seedCache) console.log(`  seeding the scratch home's managed browser from ${seedCache} (no second download)`)
if (seedCache && !existsSync(join(SCRATCH_BROWSERS, 'chrome'))) {
  symlinkSync(join(seedCache, 'chrome'), join(SCRATCH_BROWSERS, 'chrome'))
}

process.env.MERCURY_CONFIG_DIR = SCRATCH_HOME
process.env.MERCURY_HOME = SCRATCH_HOME
process.env.MERCURY_BROWSER_CACHE_DIR = SCRATCH_BROWSERS
process.env.MERCURY_BROWSER_NO_DISCOVERY = '1'
process.env.MERCURY_BROWSER = '1'
delete process.env.MERCURY_BROWSER_PATH
delete process.env.MERCURY_BROWSER_MAX_SESSIONS

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { resolveBrowser } = await import(join(ROOT, 'src/services/browser/browserResolver.ts'))
const sessionMod = await import(join(ROOT, 'src/services/browser/browserSession.ts'))
const {
  activeSession,
  browserProfileDirForOrigin,
  closeBrowserSession,
  ensureBrowserSession,
  resolveHostLanguages,
  resolveNavigatorPlatform,
  setBrowserLaunchDriverForProof,
} = sessionMod
const { BrowserTool } = await import(join(ROOT, 'src/tools/BrowserTool/BrowserTool.ts'))
const { processOwnerForLane } = await import(join(ROOT, 'src/services/run/resolveOwner.ts'))
const { decideToolPermission } = await import(join(ROOT, 'src/utils/permissions/decision/engine.ts'))
const { getEmptyToolPermissionContext } = await import(join(ROOT, 'src/Tool.ts'))

const OWNER = processOwnerForLane(null)
type ToolInput = Parameters<typeof BrowserTool.call>[0]
const ctx = {} as Parameters<typeof BrowserTool.call>[1]

async function run(input: ToolInput): Promise<{ result: string; outcome: string; ms: number }> {
  const t0 = Date.now()
  const { data } = await BrowserTool.call(input, ctx)
  return { result: data.result, outcome: data.outcome, ms: Date.now() - t0 }
}

async function perm(input: Partial<ToolInput>): Promise<{ behavior: string; message?: string }> {
  return (await BrowserTool.checkPermissions(input, ctx)) as { behavior: string; message?: string }
}

{
  let resolved = resolveBrowser()
  if (resolved.state !== 'ok') {
    const { provisionManagedBrowserForTheGate } = await import(join(ROOT, 'scripts/lib/provisionManagedBrowser.ts'))
    const provisioned = await provisionManagedBrowserForTheGate(line => console.log(line))
    if (provisioned.ok) resolved = resolveBrowser()
  }
  if (resolved.state !== 'ok') {
    console.error(`  [FAIL] no managed Chrome-for-Testing in scratch home (${SCRATCH_BROWSERS}): ${resolved.note}`)
    process.exit(1)
  }
  console.log(`  managed browser in scratch home: ${resolved.source} — ${resolved.label} (${resolved.executablePath})`)
  check(
    'managed browser resolves from the proof scratch home (never an installed app)',
    resolved.source === 'managed-cache' &&
      resolved.family === 'chrome-for-testing' &&
      resolved.executablePath.startsWith(SCRATCH_BROWSERS),
    JSON.stringify(resolved),
  )
}

const hostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

function detectionHtml(headers: http.IncomingHttpHeaders, expectedTz: string): string {
  const hdrJson = JSON.stringify({
    userAgent: String(headers['user-agent'] ?? ''),
    acceptLanguage: String(headers['accept-language'] ?? ''),
    secChUa: String(headers['sec-ch-ua'] ?? ''),
    secChUaMobile: String(headers['sec-ch-ua-mobile'] ?? ''),
    secChUaPlatform: String(headers['sec-ch-ua-platform'] ?? ''),
  })
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>loopback-bot-wall-check</title></head>
<body>
  <h1>Loopback Bot Detection Check</h1>
  <div id="hover-target" style="margin:24px;padding:14px;width:160px;border:1px solid #333">Hover Zone</div>
  <button id="click-target" style="margin:24px;padding:14px;width:160px">Action Button</button>
  <button id="point-target" style="margin:24px;padding:14px;width:160px">Point Button</button>
  <input id="type-target" type="text" style="margin:24px;padding:8px">
  <input id="pw-target" type="password" style="margin:24px;padding:8px">
  <pre id="report">running</pre>
  <script>
    const serverHeaders = ${hdrJson};
    const expectedTimeZone = ${JSON.stringify(expectedTz)};
    window.__telemetry = {
      moves: [],
      hovered: false,
      downAt: 0,
      upAt: 0,
      clicked: 0,
      pointClicked: 0,
      keydowns: [],
      keyups: [],
      allTrusted: true,
    };
    window.addEventListener('mousemove', e => {
      if (!e.isTrusted) window.__telemetry.allTrusted = false;
      window.__telemetry.moves.push({ x: e.clientX, y: e.clientY, t: performance.now(), trusted: e.isTrusted });
    });
    document.getElementById('hover-target').addEventListener('mouseenter', e => {
      if (!e.isTrusted) window.__telemetry.allTrusted = false;
      window.__telemetry.hovered = true;
    });
    document.getElementById('click-target').addEventListener('mousedown', e => {
      if (!e.isTrusted) window.__telemetry.allTrusted = false;
      window.__telemetry.downAt = performance.now();
    });
    document.getElementById('click-target').addEventListener('mouseup', e => {
      if (!e.isTrusted) window.__telemetry.allTrusted = false;
      window.__telemetry.upAt = performance.now();
    });
    document.getElementById('click-target').addEventListener('click', e => {
      if (!e.isTrusted) window.__telemetry.allTrusted = false;
      window.__telemetry.clicked++;
    });
    document.getElementById('point-target').addEventListener('click', e => {
      if (!e.isTrusted) window.__telemetry.allTrusted = false;
      window.__telemetry.pointClicked++;
    });
    document.getElementById('type-target').addEventListener('keydown', e => {
      if (!e.isTrusted) window.__telemetry.allTrusted = false;
      window.__telemetry.keydowns.push({ key: e.key, t: performance.now(), trusted: e.isTrusted });
    });
    document.getElementById('type-target').addEventListener('keyup', e => {
      if (!e.isTrusted) window.__telemetry.allTrusted = false;
      window.__telemetry.keyups.push({ key: e.key, t: performance.now(), trusted: e.isTrusted });
    });

    window.__runDetection = async function(spawnFlags) {
      const checks = {};
      checks.webdriver =
        navigator.webdriver === false &&
        !Object.prototype.hasOwnProperty.call(navigator, 'webdriver');
      checks.headless =
        !/HeadlessChrome|Headless/i.test(navigator.userAgent) &&
        !/HeadlessChrome|Headless/i.test(navigator.appVersion) &&
        !/HeadlessChrome|Headless/i.test(serverHeaders.userAgent) &&
        window.outerWidth >= window.innerWidth &&
        window.outerHeight >= window.innerHeight &&
        window.innerWidth > 0 &&
        window.innerHeight > 0;
      let pluginsProtoOk =
        navigator.plugins instanceof PluginArray &&
        Object.getPrototypeOf(navigator.plugins) === PluginArray.prototype &&
        navigator.plugins.length > 0;
      for (let i = 0; i < navigator.plugins.length; i++) {
        if (Object.getPrototypeOf(navigator.plugins[i]) !== Plugin.prototype) pluginsProtoOk = false;
      }
      let mimesProtoOk =
        navigator.mimeTypes instanceof MimeTypeArray &&
        Object.getPrototypeOf(navigator.mimeTypes) === MimeTypeArray.prototype &&
        navigator.mimeTypes.length > 0;
      for (let i = 0; i < navigator.mimeTypes.length; i++) {
        if (Object.getPrototypeOf(navigator.mimeTypes[i]) !== MimeType.prototype) mimesProtoOk = false;
      }
      checks.plugins = pluginsProtoOk && mimesProtoOk;
      checks.chromeObject = Boolean(
        window.chrome &&
          typeof window.chrome === 'object' &&
          'app' in window.chrome &&
          'csi' in window.chrome &&
          'loadTimes' in window.chrome &&
          'runtime' in window.chrome &&
          window.chrome.runtime &&
          typeof window.chrome.runtime.connect === 'function' &&
          typeof window.chrome.runtime.sendMessage === 'function' &&
          window.chrome.runtime.connect.toString() === 'function connect() { [native code] }' &&
          window.chrome.runtime.sendMessage.toString() === 'function sendMessage() { [native code] }'
      );
      const permStatus = await navigator.permissions.query({ name: 'notifications' });
      const defaultConsistent =
        permStatus instanceof PermissionStatus &&
        !(Notification.permission === 'denied' && permStatus.state === 'prompt') &&
        ((Notification.permission === 'default' && permStatus.state === 'prompt') ||
          Notification.permission === permStatus.state) &&
        navigator.permissions.query.toString() === 'function query() { [native code] }';
      const origDesc = Object.getOwnPropertyDescriptor(Notification, 'permission');
      let deniedConsistent = false;
      try {
        Object.defineProperty(Notification, 'permission', { get: () => 'denied', configurable: true });
        const deniedStatus = await navigator.permissions.query({ name: 'notifications' });
        deniedConsistent = deniedStatus instanceof PermissionStatus && deniedStatus.state === 'denied';
      } finally {
        if (origDesc) Object.defineProperty(Notification, 'permission', origDesc);
        else delete Notification.permission;
      }
      checks.permissions = defaultConsistent && deniedConsistent;
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl');
      const dbg = gl ? gl.getExtension('WEBGL_debug_renderer_info') : null;
      const vendor = gl ? String(gl.getParameter(gl.VENDOR) ?? '') : '';
      const renderer = gl ? String(gl.getParameter(gl.RENDERER) ?? '') : '';
      const unmaskedVendor = dbg && gl ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) ?? '') : vendor;
      const unmaskedRenderer = dbg && gl ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '') : renderer;
      checks.webgl = Boolean(
        gl &&
          vendor.length > 0 &&
          renderer.length > 0 &&
          unmaskedVendor.length > 0 &&
          unmaskedRenderer.length > 0 &&
          !/Brian Paul|Mesa OffScreen|SwiftShader|llvmpipe/i.test(vendor + ' ' + renderer + ' ' + unmaskedVendor + ' ' + unmaskedRenderer) &&
          WebGLRenderingContext.prototype.getParameter.toString() === 'function getParameter() { [native code] }'
      );
      const uad = navigator.userAgentData;
      const he = uad ? await uad.getHighEntropyValues(['architecture', 'bitness', 'fullVersionList', 'model', 'platform', 'platformVersion']) : null;
      const brandNames = uad ? uad.brands.map(b => b.brand) : [];
      const fullBrandNames = he && he.fullVersionList ? he.fullVersionList.map(b => b.brand) : [];
      checks.clientHints = Boolean(
        uad &&
          brandNames.includes('Google Chrome') &&
          brandNames.includes('Chromium') &&
          fullBrandNames.includes('Google Chrome') &&
          fullBrandNames.includes('Chromium') &&
          serverHeaders.secChUa.includes('Google Chrome') &&
          serverHeaders.secChUa.includes('Chromium') &&
          serverHeaders.secChUaPlatform.replace(/"/g, '') === uad.platform
      );
      const primaryHeaderLang = (serverHeaders.acceptLanguage.split(',')[0] || '').split(';')[0].trim();
      const pageTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const platformConsistent =
        (navigator.userAgent.includes('Macintosh') && navigator.platform === 'MacIntel') ||
        (navigator.userAgent.includes('Windows') && navigator.platform === 'Win32') ||
        (navigator.userAgent.includes('Linux') && navigator.platform.startsWith('Linux'));
      checks.uaConsistency = Boolean(
        serverHeaders.userAgent === navigator.userAgent &&
          navigator.appVersion === navigator.userAgent.replace(/^Mozilla\\//, '') &&
          platformConsistent &&
          primaryHeaderLang === navigator.language &&
          !serverHeaders.acceptLanguage.includes(';q=0.9;q=0.9') &&
          Array.isArray(navigator.languages) &&
          navigator.languages.length >= 2 &&
          navigator.languages[0] === navigator.language &&
          pageTz === expectedTimeZone
      );
      const args = Array.isArray(spawnFlags) ? spawnFlags : [];
      checks.automationBannerFlag = Boolean(
        args.length > 0 &&
          !args.includes('--enable-automation') &&
          !args.includes('--disable-extensions') &&
          !args.includes('--disable-default-apps') &&
          !args.includes('--disable-component-extensions-with-background-pages') &&
          args.includes('--disable-blink-features=AutomationControlled') &&
          args.some(a => a.startsWith('--window-size=1280,800'))
      );
      const entries = Object.entries(checks);
      const passed = entries.filter(([, v]) => v === true).length;
      const summary = {
        passed,
        total: entries.length,
        checks,
        details: {
          ua: navigator.userAgent,
          headerUa: serverHeaders.userAgent,
          acceptLanguage: serverHeaders.acceptLanguage,
          languages: navigator.languages,
          webdriver: navigator.webdriver,
          chromeKeys: window.chrome ? Object.keys(window.chrome) : [],
          outer: [window.outerWidth, window.outerHeight],
          inner: [window.innerWidth, window.innerHeight],
          brands: brandNames,
          timeZone: pageTz,
          unmaskedVendor,
          unmaskedRenderer,
        },
      };
      document.getElementById('report').textContent =
        'score: ' + passed + '/' + entries.length + ' passed\\n' + JSON.stringify(summary);
      return summary;
    };
  </script>
</body>
</html>`
}

function startServer(): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(detectionHtml(req.headers, hostTimeZone))
  })
  return new Promise(resolveServer => {
    server.listen(0, '127.0.0.1', () => {
      resolveServer({ port: (server.address() as { port: number }).port, server })
    })
  })
}

const srvA = await startServer()
const srvB = await startServer()
const srvC = await startServer()
const ORIGIN_A = `http://127.0.0.1:${srvA.port}`
const ORIGIN_B = `http://127.0.0.1:${srvB.port}`
const ORIGIN_C = `http://127.0.0.1:${srvC.port}`

try {
  console.log('\n§1 Loopback detection page (9 public checks scored)')
  {
    const opened = await run({ op: 'open', url: `${ORIGIN_A}/` })
    check('open detection page succeeds', opened.outcome === 'succeeded', opened.result)
    const live = activeSession(OWNER)
    const spawnargs = live?.browser.process()?.spawnargs ?? []
    const report = (await live!.page.evaluate(
      (flags: string[]) => (window as unknown as { __runDetection: (f: string[]) => Promise<unknown> }).__runDetection(flags),
      spawnargs,
    )) as {
      passed: number
      total: number
      checks: Record<string, boolean>
      details: Record<string, unknown>
    }
    const extracted = await run({ op: 'extract', mode: 'text', selector: '#report' })
    console.log(`  detection score line: ${extracted.result.split('\n')[1] ?? ''}`)
    check('check 1 — webdriver is false on Navigator.prototype (no own property)', report.checks.webdriver === true, JSON.stringify(report.details))
    check('check 2 — headless tells absent (no HeadlessChrome in UA/appVersion, outer >= inner)', report.checks.headless === true, JSON.stringify(report.details))
    check('check 3 — navigator.plugins & mimeTypes are populated PluginArray / MimeTypeArray instances', report.checks.plugins === true, JSON.stringify(report.details))
    check('check 4 — window.chrome carries app, csi, loadTimes, and runtime (connect + sendMessage)', report.checks.chromeObject === true, JSON.stringify(report.details))
    check('check 5 — Notification.permission and navigator.permissions.query({name:"notifications"}) agree', report.checks.permissions === true, JSON.stringify(report.details))
    check('check 6 — WebGL vendor and renderer report non-software strings with native getParameter', report.checks.webgl === true, JSON.stringify(report.details))
    check('check 7 — Sec-CH-UA and navigator.userAgentData carry Google Chrome and Chromium brands', report.checks.clientHints === true, JSON.stringify(report.details))
    check('check 8 — User-Agent, Accept-Language, navigator.languages, platform, and timezone match the host', report.checks.uaConsistency === true, JSON.stringify(report.details))
    check('check 9 — automation-banner flag (--enable-automation) stripped and AutomationControlled disabled', report.checks.automationBannerFlag === true, JSON.stringify(spawnargs))
    check('all 9 public detection checks pass (score: 9/9 passed)', report.passed === 9 && report.total === 9 && extracted.result.includes('score: 9/9 passed'), extracted.result)
  }

  console.log('\n§2 Human-paced input road (hover, selector click, point click, plain type, secretRef type)')
  {
    const hov = await run({ op: 'hover', selector: '#hover-target' })
    check('hover succeeds', hov.outcome === 'succeeded', hov.result)
    const clk = await run({ op: 'click', selector: '#click-target' })
    check('selector click succeeds within turn budget (<1500ms)', clk.outcome === 'succeeded' && clk.ms < 1500, `${clk.ms}ms · ${clk.result}`)
    const live = activeSession(OWNER)!
    const ptBox = await (await live.page.$('#point-target'))!.boundingBox()
    const ptClk = await run({
      op: 'click',
      x: Math.round(ptBox!.x + ptBox!.width / 2),
      y: Math.round(ptBox!.y + ptBox!.height / 2),
    })
    check('point click (x, y) succeeds within turn budget (<1500ms)', ptClk.outcome === 'succeeded' && ptClk.ms < 1500, `${ptClk.ms}ms · ${ptClk.result}`)
    const typed = await run({ op: 'type', selector: '#type-target', text: 'steady human keys' })
    check('plain type succeeds within turn budget (<1500ms)', typed.outcome === 'succeeded' && typed.ms < 1500, `${typed.ms}ms · ${typed.result}`)

    process.env.MERCURY_BROWSER_SECRET_STEALTH_PW = 's3cr3t-cadence!'
    const secTyped = await run({ op: 'type', selector: '#pw-target', secretRef: 'STEALTH_PW' })
    const pwLanded = await live.page.$eval('#pw-target', el => (el as HTMLInputElement).value)
    check('secretRef type lands with human pacing and never echoes secret', secTyped.outcome === 'succeeded' && pwLanded === 's3cr3t-cadence!' && !secTyped.result.includes('s3cr3t-cadence!'), secTyped.result)
    delete process.env.MERCURY_BROWSER_SECRET_STEALTH_PW

    const tel = (await live.page.evaluate(() => (window as unknown as { __telemetry: unknown }).__telemetry)) as {
      moves: Array<{ x: number; y: number; t: number; trusted: boolean }>
      hovered: boolean
      downAt: number
      upAt: number
      clicked: number
      pointClicked: number
      keydowns: Array<{ key: string; t: number; trusted: boolean }>
      keyups: Array<{ key: string; t: number; trusted: boolean }>
      allTrusted: boolean
    }
    const preClickMoves = tel.moves.filter(m => m.t <= tel.downAt)
    const firstMove = preClickMoves[0] ?? { x: 0, y: 0 }
    const lastMove = preClickMoves[preClickMoves.length - 1] ?? { x: 0, y: 0, t: 0 }
    const chord = Math.hypot(lastMove.x - firstMove.x, lastMove.y - firstMove.y) || 1
    const maxCurveDeviation = Math.max(
      0,
      ...preClickMoves.map(
        m =>
          Math.abs(
            (lastMove.y - firstMove.y) * m.x -
              (lastMove.x - firstMove.x) * m.y +
              lastMove.x * firstMove.y -
              lastMove.y * firstMove.x,
          ) / chord,
      ),
    )
    const dwellMs = tel.downAt - lastMove.t
    const holdMs = tel.upAt - tel.downAt
    const keyDeltas = tel.keydowns.slice(1).map((k, i) => k.t - tel.keydowns[i]!.t)
    const minKeyDelta = Math.min(...keyDeltas)
    const maxKeyDelta = Math.max(...keyDeltas)
    const typedValue = await live.page.$eval('#type-target', el => (el as HTMLInputElement).value)

    check('hover and clicks traversed a multi-step curved trajectory (never a 1-step teleport)', preClickMoves.length >= 12 && maxCurveDeviation > 1, `moves=${preClickMoves.length} curveDev=${maxCurveDeviation.toFixed(2)}px`)
    check('click dwelled before mousedown and held before mouseup', dwellMs >= 12 && holdMs >= 10, `dwell=${dwellMs.toFixed(1)}ms hold=${holdMs.toFixed(1)}ms`)
    check('hover, selector click, and point click all delivered their DOM actions', tel.hovered && tel.clicked === 1 && tel.pointClicked === 1, JSON.stringify({ hovered: tel.hovered, clicked: tel.clicked, pointClicked: tel.pointClicked }))
    check('typing paced individual keystrokes with non-zero inter-key timing and variance', tel.keydowns.length === 17 && minKeyDelta >= 2 && maxKeyDelta - minKeyDelta >= 2 && typedValue === 'steady human keys', `keys=${tel.keydowns.length} min=${minKeyDelta.toFixed(1)}ms max=${maxKeyDelta.toFixed(1)}ms val="${typedValue}"`)
    check('every dispatched mouse and keyboard event is trusted (isTrusted === true)', tel.allTrusted === true)

    const spawnargs = live.browser.process()?.spawnargs ?? []
    const afterInputReport = (await live.page.evaluate(
      (flags: string[]) => (window as unknown as { __runDetection: (f: string[]) => Promise<{ passed: number; total: number }> }).__runDetection(flags),
      spawnargs,
    )) as { passed: number; total: number }
    check('no detection tell is re-introduced after hover, click, and type (still 9/9)', afterInputReport.passed === 9 && afterInputReport.total === 9, JSON.stringify(afterInputReport))
  }

  console.log('\n§3 Persistent per-origin profile under config home & isolation across origins')
  {
    const liveA = activeSession(OWNER)!
    const spawnargsA = liveA.browser.process()?.spawnargs ?? []
    const userDataArgA = spawnargsA.find(a => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length) ?? ''
    const expectedProfileA = browserProfileDirForOrigin ? browserProfileDirForOrigin(ORIGIN_A, OWNER) : null
    check(
      'origin A profile lives under <configHome>/browser-profiles/<origin> (never in /tmp/puppeteer_dev_*)',
      Boolean(expectedProfileA) &&
        userDataArgA === expectedProfileA &&
        userDataArgA.startsWith(join(SCRATCH_HOME, 'browser-profiles') + sep) &&
        existsSync(userDataArgA),
      `arg=${userDataArgA} expected=${expectedProfileA}`,
    )
    if (process.platform !== 'win32') {
      const rootMode = statSync(dirname(userDataArgA)).mode & 0o777
      const dirMode = statSync(userDataArgA).mode & 0o777
      check(
        'browser-profiles root and origin profile directory are created with owner-only mode 0700',
        rootMode === 0o700 && dirMode === 0o700,
        `root=${rootMode.toString(8)} dir=${dirMode.toString(8)}`,
      )
    }

    await liveA.page.evaluate(() => {
      localStorage.setItem('originMarker', 'alpha-persisted-value')
      document.cookie = 'originCookie=alpha-cookie; Max-Age=3600; Path=/'
    })
    await run({ op: 'close' })
    check('origin A profile directory survives session close', existsSync(userDataArgA), userDataArgA)

    await run({ op: 'open', url: `${ORIGIN_A}/` })
    const reopenedA = activeSession(OWNER)!
    const restoredA = await reopenedA.page.evaluate(() => ({
      ls: localStorage.getItem('originMarker'),
      cookie: document.cookie,
    }))
    check(
      'reopening origin A restores localStorage and cookies from its persistent profile',
      restoredA.ls === 'alpha-persisted-value' && restoredA.cookie.includes('originCookie=alpha-cookie'),
      JSON.stringify(restoredA),
    )

    await run({ op: 'open', url: `${ORIGIN_B}/` })
    const liveB = activeSession(OWNER)!
    const spawnargsB = liveB.browser.process()?.spawnargs ?? []
    const userDataArgB = spawnargsB.find(a => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length) ?? ''
    const expectedProfileB = browserProfileDirForOrigin ? browserProfileDirForOrigin(ORIGIN_B, OWNER) : null
    const stateB = await liveB.page.evaluate(() => ({
      ls: localStorage.getItem('originMarker'),
      cookie: document.cookie,
    }))
    check(
      'opening origin B rotates to a distinct per-origin profile directory (never shared with origin A)',
      Boolean(expectedProfileB) &&
        userDataArgB === expectedProfileB &&
        userDataArgB !== userDataArgA &&
        existsSync(userDataArgB),
      `A=${userDataArgA} B=${userDataArgB}`,
    )
    check(
      'origin B profile holds none of origin A storage or cookies',
      stateB.ls === null && !stateB.cookie.includes('originCookie'),
      JSON.stringify(stateB),
    )
  }

  console.log('\n§4 refusals — hostile profile inputs, site permission laws across modes, visible window option, prompt byte-identity')
  {
    for (const [label, badInput] of [
      ['empty string', ''],
      ['file:// scheme', 'file:///etc/passwd'],
      ['about:blank scheme', 'about:blank'],
      ['javascript: scheme', 'javascript:alert(1)'],
      ['relative traversal ../', '../../../etc/passwd'],
      ['windows drive path', 'C:\\Windows\\System32'],
      ['semicolon injection', 'http://example.com;rm -rf /'],
      ['quote injection', 'http://example.com"bad'],
      ['dot-dot host', 'http://../etc'],
    ] as const) {
      const out = browserProfileDirForOrigin ? browserProfileDirForOrigin(badInput, OWNER) : 'missing-fn'
      check(`refusal: browserProfileDirForOrigin refuses ${label}`, out === null, String(out))
    }

    const engineCtx = (opts: { mode?: string; allow?: string[]; deny?: string[] }) => {
      const toolPermissionContext = {
        ...getEmptyToolPermissionContext(),
        mode: (opts.mode ?? 'default') as never,
        alwaysAllowRules: opts.allow ? { localSettings: opts.allow } : {},
        alwaysDenyRules: opts.deny ? { localSettings: opts.deny } : {},
        alwaysAskRules: {},
        isBypassPermissionsModeAvailable: false,
      }
      const appState = { toolPermissionContext }
      return {
        abortController: new AbortController(),
        getAppState: () => appState,
        setAppState: () => {},
        messages: [],
        options: {},
      } as unknown as Parameters<typeof BrowserTool.call>[1]
    }

    const unapprovedOpen = { op: 'open', url: `${ORIGIN_C}/` } as ToolInput
    const openPlain = await decideToolPermission(BrowserTool as never, unapprovedOpen, engineCtx({ mode: 'default' }) as never)
    const openImpl = await decideToolPermission(BrowserTool as never, unapprovedOpen, engineCtx({ mode: 'implement' }) as never)
    const openSov = await decideToolPermission(BrowserTool as never, unapprovedOpen, engineCtx({ mode: 'sovereign' }) as never)
    check(
      'permission law: unapproved origin open asks in plain (default) and implement',
      openPlain.decision.behavior === 'ask' &&
        openImpl.decision.behavior === 'ask' &&
        openImpl.trace.mode === 'implement' &&
        openImpl.trace.decidedBy === 'resolution',
    )
    check('permission law: unapproved origin open runs without asking in sovereign', openSov.decision.behavior === 'allow' && openSov.trace.decidedBy === 'bypassPosture')

    const denyRule = `Browser(origin:${ORIGIN_C})`
    for (const mode of ['default', 'implement', 'sovereign'] as const) {
      const denied = await decideToolPermission(BrowserTool as never, unapprovedOpen, engineCtx({ mode, deny: [denyRule] }) as never)
      check(
        `refusal: origin deny rule refuses in ${mode} mode`,
        denied.decision.behavior === 'deny' && denied.trace.mode === mode && denied.trace.decidedBy === 'toolVerdictDeny',
        JSON.stringify(denied.decision),
      )
    }

    await activeSession(OWNER)!.page.goto(`${ORIGIN_C}/`)
    const crossAct = { op: 'click', selector: '#click-target' } as ToolInput
    const crossToolAllow = await decideToolPermission(BrowserTool as never, crossAct, engineCtx({ mode: 'default', allow: ['Browser'] }) as never)
    const crossImplAllow = await decideToolPermission(BrowserTool as never, crossAct, engineCtx({ mode: 'implement', allow: ['Browser'] }) as never)
    const crossSov = await decideToolPermission(BrowserTool as never, crossAct, engineCtx({ mode: 'sovereign' }) as never)
    check(
      'refusal: crossing act asks with safetyCheck in plain and implement even under whole-tool Browser allow',
      crossToolAllow.decision.behavior === 'ask' &&
        crossToolAllow.trace.decidedBy === 'safetyCheckAsk' &&
        crossImplAllow.decision.behavior === 'ask' &&
        crossImplAllow.trace.mode === 'implement' &&
        crossImplAllow.trace.decidedBy === 'safetyCheckAsk',
    )
    check('permission law: crossing act runs in sovereign without asking', crossSov.decision.behavior === 'allow' && crossSov.trace.decidedBy === 'safetyCheckAsk')

    await run({ op: 'open', url: `${ORIGIN_A}/` })
    const pwRefusal = await run({ op: 'type', selector: '#pw-target', text: 'plain-password' })
    check('refusal: plain text into password field refuses by name', pwRefusal.outcome === 'failed' && pwRefusal.result.includes('credential field'), pwRefusal.result)
    const secretAsk = await perm({ op: 'type', selector: '#pw-target', secretRef: 'NEW_SECRET' })
    check('refusal: secretRef on an approved origin still asks for secret+origin pairing consent', secretAsk.behavior === 'ask' && (secretAsk.message ?? '').includes('NEW_SECRET'))

    await closeBrowserSession(OWNER)

    const recordedLaunches: LaunchOptions[] = []
    let failNextLaunch = false
    const spawnedChildren: Array<{ closed: boolean }> = []
    setBrowserLaunchDriverForProof(async options => {
      recordedLaunches.push(options)
      if (failNextLaunch) {
        failNextLaunch = false
        throw new Error('simulated replacement launch failure')
      }
      const childRec = { closed: false }
      spawnedChildren.push(childRec)
      return {
        connected: true,
        process: () => ({ pid: 999000 + spawnedChildren.length, spawnargs: [], kill: () => { childRec.closed = true } }),
        pages: async () => [
          {
            url: () => 'about:blank',
            on: () => undefined,
            viewport: () => ({ width: 1280, height: 800 }),
            close: async () => undefined,
          },
        ],
        newPage: async () => ({}),
        on: () => undefined,
        close: async () => {
          childRec.closed = true
        },
      } as unknown as DriverBrowser
    })
    try {
      const OWNER_VIS = processOwnerForLane('visible-window-check')
      await ensureBrowserSession(OWNER_VIS, { headless: false })
      check('visible window: ensureBrowserSession({ headless: false }) passes headless: false to driver', recordedLaunches.length === 1 && recordedLaunches[0]!.headless === false, JSON.stringify(recordedLaunches[0]?.headless))
      await sessionMod.disposeBrowserOwner(OWNER_VIS)
      await ensureBrowserSession(OWNER_VIS)
      check('headless default: ensureBrowserSession() passes headless: true by default', recordedLaunches.length === 2 && recordedLaunches[1]!.headless === true, JSON.stringify(recordedLaunches[1]?.headless))
      const rotatedFromOriginless = await ensureBrowserSession(OWNER_VIS, { origin: 'http://127.0.0.1:61001' })
      check(
        'an originless session rotates to the origin persistent profile when ensureBrowserSession({ origin }) is called',
        recordedLaunches.length === 3 &&
          !('state' in rotatedFromOriginless) &&
          rotatedFromOriginless.profileOrigin === 'http://127.0.0.1:61001' &&
          typeof recordedLaunches[2]?.userDataDir === 'string' &&
          recordedLaunches[2]!.userDataDir.endsWith('http-127.0.0.1-61001'),
        JSON.stringify(recordedLaunches[2]?.userDataDir),
      )
      await sessionMod.disposeBrowserOwner(OWNER_VIS)

      const OWNER_ROT = processOwnerForLane('rotation-safety-check')
      const OWNER_HOLD = processOwnerForLane('rotation-cap-holder')
      const firstRot = await ensureBrowserSession(OWNER_ROT, { origin: 'http://127.0.0.1:61001' })
      await ensureBrowserSession(OWNER_HOLD, { origin: 'http://127.0.0.1:61002' })
      sessionMod.approveWebOrigin(OWNER_ROT, 'http://127.0.0.1:61001/')
      sessionMod.approveSecretPairing(OWNER_ROT, 'ROT_SECRET', 'http://127.0.0.1:61001')
      const rotChild = spawnedChildren[spawnedChildren.length - 2]!
      let networkClosed = 0
      if (!('state' in firstRot)) {
        ;(firstRot as unknown as { closeNetwork?: () => void }).closeNetwork = () => {
          networkClosed++
        }
      }
      process.env.MERCURY_BROWSER_MAX_SESSIONS = '1'
      const preflightRefused = await ensureBrowserSession(OWNER_ROT, { origin: 'http://127.0.0.1:61003' })
      delete process.env.MERCURY_BROWSER_MAX_SESSIONS
      check(
        'rotation pre-flight refusal keeps the existing session reachable and unclosed (no leaked browser)',
        'state' in preflightRefused &&
          preflightRefused.state === 'at-capacity' &&
          activeSession(OWNER_ROT) !== null &&
          rotChild.closed === false,
        JSON.stringify({ refused: preflightRefused, active: activeSession(OWNER_ROT) !== null, closed: rotChild.closed }),
      )

      failNextLaunch = true
      let launchThrew = false
      try {
        await ensureBrowserSession(OWNER_ROT, { origin: 'http://127.0.0.1:61003' })
      } catch {
        launchThrew = true
      }
      check(
        'rotation with a throwing replacement launch closes the old browser and its network and wipes origin and secret grants',
        launchThrew &&
          rotChild.closed === true &&
          networkClosed === 1 &&
          activeSession(OWNER_ROT) === null &&
          !sessionMod.originApproved(OWNER_ROT, 'http://127.0.0.1:61001') &&
          !sessionMod.secretPairingApproved(OWNER_ROT, 'ROT_SECRET', 'http://127.0.0.1:61001'),
        JSON.stringify({
          launchThrew,
          closed: rotChild.closed,
          networkClosed,
          active: activeSession(OWNER_ROT) !== null,
          originGrant: sessionMod.originApproved(OWNER_ROT, 'http://127.0.0.1:61001'),
          secretGrant: sessionMod.secretPairingApproved(OWNER_ROT, 'ROT_SECRET', 'http://127.0.0.1:61001'),
        }),
      )
      await sessionMod.disposeBrowserOwner(OWNER_ROT)
      await sessionMod.disposeBrowserOwner(OWNER_HOLD)
    } finally {
      delete process.env.MERCURY_BROWSER_MAX_SESSIONS
      setBrowserLaunchDriverForProof(null)
    }

    const bareEn = resolveHostLanguages('en')
    check(
      'bare "en" host locale normalizes to en-US with two-element languages array',
      bareEn.primary === 'en-US' &&
        bareEn.languages.length === 2 &&
        bareEn.languages[0] === 'en-US' &&
        bareEn.languages[1] === 'en' &&
        bareEn.acceptLanguage === 'en-US,en',
      JSON.stringify(bareEn),
    )
    check(
      'Linux arm64 resolves navigatorPlatform to Linux aarch64 and x64 to Linux x86_64',
      resolveNavigatorPlatform('Mozilla/5.0 (X11; Linux aarch64) Chrome/155.0.0.0', 'linux', 'arm64') === 'Linux aarch64' &&
        resolveNavigatorPlatform('Mozilla/5.0 (X11; Linux x86_64) Chrome/155.0.0.0', 'linux', 'x64') === 'Linux x86_64',
    )
    const toolSrc = readFileSync(join(ROOT, 'src/tools/BrowserTool/BrowserTool.ts'), 'utf8')
    check(
      'BrowserTool.ts carries no dead void browserProfileDirForOrigin call',
      !toolSrc.includes('void browserProfileDirForOrigin'),
    )
    const desc = await BrowserTool.description({} as never)
    const prompt = await BrowserTool.prompt({} as never)
    check(
      'control: BrowserTool description and prompt bytes are unchanged',
      desc.startsWith('Drive a headless Chrome for Testing from the managed cache') &&
        prompt.startsWith('Drive a real browser through the bundled driver: one owned headless session per agent') &&
        prompt.endsWith('The driver needs node >= 22.12.'),
    )
  }
} finally {
  await closeBrowserSession(OWNER).catch(() => undefined)
  srvA.server.closeAllConnections()
  srvB.server.closeAllConnections()
  srvC.server.closeAllConnections()
  await Promise.all([
    new Promise<void>(r => srvA.server.close(() => r())),
    new Promise<void>(r => srvB.server.close(() => r())),
    new Promise<void>(r => srvC.server.close(() => r())),
  ])
  rmSync(SCRATCH_HOME, { recursive: true, force: true })
}

console.log(`\n${checks} checks, ${failures} failures`)
if (failures > 0) {
  console.error(`prove-browser-stealth: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('prove-browser-stealth: ALL LAWS HOLD')

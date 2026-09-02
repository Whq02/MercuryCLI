// ============================================================================
//  probeAdapter — the PRODUCT-side deterministic DAP responder (Sol 5.6
// /health's deep DAP probe exercises the REAL protocol engine
//  (dapClient) against this adapter — launch → verified breakpoint →
//  stopped → stack → evaluate → continue → terminated — with zero external
//  debuggers and zero test-script dependencies: the responder ships as an
//  embedded source string and runs via `node -e`, so the built artifact is
//  self-contained. Mirrors scripts/dap/mock-dap-adapter.mjs's contract
//  (thread 1/MainThread, frame main@probe.py:3, Locals ref 100, x=41,
//  evaluate x+1 → 42).
// ============================================================================

import type { DapAdapterSpec } from './dapClient.js'

const PROBE_ADAPTER_SOURCE = `
let buffer = Buffer.alloc(0);
let seq = 1000;
let launchReq = null;
let configDone = false;
let breakpointsSet = false;
function send(msg) {
  const payload = JSON.stringify({ seq: seq++, ...msg });
  process.stdout.write('Content-Length: ' + Buffer.byteLength(payload, 'utf-8') + '\\r\\n\\r\\n' + payload);
}
function respond(req, body = {}, success = true, message = undefined) {
  send({ type: 'response', request_seq: req.seq, command: req.command, success, body, message });
}
function event(name, body = {}) { send({ type: 'event', event: name, body }); }
function maybeFinishLaunch() {
  if (launchReq && configDone) {
    respond(launchReq, {});
    launchReq = null;
    event('output', { category: 'stdout', output: 'probe: started\\n' });
    if (breakpointsSet) setTimeout(() => event('stopped', { reason: 'breakpoint', threadId: 1 }), 20);
  }
}
function handle(req) {
  switch (req.command) {
    case 'initialize':
      respond(req, { supportsConfigurationDoneRequest: true });
      event('initialized');
      break;
    case 'setBreakpoints': {
      const lines = (req.arguments?.breakpoints ?? []).map(b => b.line);
      breakpointsSet = breakpointsSet || lines.length > 0;
      respond(req, { breakpoints: lines.map(line => ({ verified: true, line })) });
      break;
    }
    case 'configurationDone': configDone = true; respond(req, {}); maybeFinishLaunch(); break;
    case 'launch': launchReq = req; maybeFinishLaunch(); break;
    case 'threads': respond(req, { threads: [{ id: 1, name: 'MainThread' }] }); break;
    case 'stackTrace':
      respond(req, { stackFrames: [
        { id: 1000, name: 'main', line: 3, source: { path: '/tmp/probe.py' } },
        { id: 1001, name: 'caller', line: 9, source: { path: '/tmp/probe.py' } },
      ] });
      break;
    case 'scopes': respond(req, { scopes: [{ name: 'Locals', variablesReference: 100 }] }); break;
    case 'variables': respond(req, { variables: [{ name: 'x', value: '41', type: 'int' }] }); break;
    case 'evaluate': respond(req, { result: req.arguments?.expression === 'x+1' ? '42' : '?', type: 'int' }); break;
    case 'continue':
      respond(req, { allThreadsContinued: true });
      setTimeout(() => { event('terminated'); event('exited', { exitCode: 0 }); }, 20);
      break;
    case 'disconnect': respond(req, {}); setTimeout(() => process.exit(0), 10); break;
    default: respond(req, {}, true);
  }
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd < 0) return;
    const m = buffer.subarray(0, headerEnd).toString('utf-8').match(/Content-Length:\\s*(\\d+)/i);
    if (!m) { buffer = buffer.subarray(headerEnd + 4); continue; }
    const start = headerEnd + 4;
    const length = Number(m[1]);
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString('utf-8');
    buffer = buffer.subarray(start + length);
    try { handle(JSON.parse(body)); } catch {}
  }
});
`

/** The spec dapClient spawns for the deep probe — self-contained (node -e). */
export function probeAdapterSpec(): DapAdapterSpec {
  return {
    command: process.execPath,
    args: ['-e', PROBE_ADAPTER_SOURCE],
    installHint: 'built-in deterministic probe adapter',
  }
}

// ============================================================================
//  workshop/workerSource — the Workshop worker, shipped as an EMBEDDED
//  source string (the DAP probeAdapter idiom): `new Worker(src, {eval:true})`
//  resolves identically from the repo and from the built artifact — no
//  worker-path drift class at all.
//
//  Inside the worker:
//    · one persistent vm context per runtime — top-level var/let/const/
//      class/function in a NON-await cell persist across cells (V8 keeps
//      script lexical declarations on the context);
//    · a cell containing top-level await runs as a sloppy-mode async IIFE
//      with top-level declaration KEYWORDS stripped, so its bindings land
//      on the same context global (documented: TLA-cell function/class
//      statements stay cell-local);
//    · console + process.stdout writes stream to the host as output events;
//    · the `mercury` bridge RPCs to the host (inspect/tool/agent/display) —
//      parallel/pipeline compose in-worker;
//    · `require` resolves from the session cwd, and non-node_modules cache
//      entries are dropped before every cell so later cells observe file
//      changes (dynamic import() stays cached — disclosed in the docs).
// ============================================================================

export const WORKSHOP_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const util = require('node:util');
const { createRequire } = require('node:module');
const path = require('node:path');

const cwd = workerData.cwd;
const cellRequire = createRequire(path.join(cwd, '__workshop__.js'));

let rpcSeq = 0;
const pendingRpc = new Map();
function rpc(kind, payload) {
  return new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    pendingRpc.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'rpc', id, kind, payload });
  });
}
function emitOutput(stream, text) {
  parentPort.postMessage({ type: 'output', stream, text: String(text) });
}
function bounded(value, depth) {
  try {
    return util.inspect(value, { depth: depth ?? 4, maxArrayLength: 50, maxStringLength: 2000, breakLength: 100 });
  } catch (e) {
    return '[uninspectable: ' + String(e && e.message) + ']';
  }
}

const mercury = {
  inspect: (ref) => rpc('inspect', { ref }),
  tool: (name, input) => rpc('tool', { name, input }),
  agent: (input) => rpc('agent', { input }),
  display: (value) => {
    let kind = 'text';
    let text;
    if (typeof value === 'string') {
      text = value;
      kind = /^#{1,6}\s|^\s*[-*]\s|\x60\x60\x60/m.test(value) ? 'markdown' : 'text';
    } else if (Array.isArray(value) && value.length > 0 && value.every(r => r && typeof r === 'object' && !Array.isArray(r))) {
      kind = 'table';
      text = JSON.stringify(value.slice(0, 50), null, 1);
    } else {
      kind = 'json';
      try { text = JSON.stringify(value, null, 1); } catch { text = bounded(value); }
    }
    if (typeof text === 'string' && text.startsWith('mercury://')) kind = 'ref';
    parentPort.postMessage({ type: 'display', kind, value: String(text).slice(0, 20000) });
  },
  parallel: (thunks) => Promise.all((thunks || []).map(t => (typeof t === 'function' ? t() : t))),
  pipeline: (items, ...stages) =>
    Promise.all((items || []).map(async (item, i) => {
      let v = item;
      for (const stage of stages) v = await stage(v, item, i);
      return v;
    })),
};

const workshopConsole = {};
for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
  workshopConsole[level] = (...args) => emitOutput(level === 'error' || level === 'warn' ? 'stderr' : 'stdout', util.format(...args));
}
workshopConsole.dir = (v) => emitOutput('stdout', bounded(v));

const sandbox = {
  console: workshopConsole,
  mercury,
  require: cellRequire,
  process,
  Buffer,
  URL, URLSearchParams, TextEncoder, TextDecoder,
  setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
  queueMicrotask, structuredClone, fetch, AbortController, AbortSignal,
  __dirname: cwd,
  __workshop_cwd: cwd,
};
sandbox.globalThis = sandbox;
const context = vm.createContext(sandbox);

function dropFreshRequireCache() {
  for (const key of Object.keys(cellRequire.cache || {})) {
    if (!key.includes('node_modules')) delete cellRequire.cache[key];
  }
}

/** Strip SIMPLE top-level declaration keywords ("const x = …") so a TLA
 *  cell's bindings land on the context global via sloppy-mode assignment.
 *  Line-anchored + depth-tracked: nested declarations keep their keywords;
 *  complex patterns (destructuring, multi-declarator) run fine but stay
 *  cell-local — the documented TLA-cell limitation. */
function stripTopLevelDeclarations(code) {
  const lines = code.split('\n');
  let depth = 0;
  const out = lines.map(line => {
    let transformed = line;
    if (depth === 0) {
      const simple = line.match(/^(\s*)(?:const|let|var)\s+([A-Za-z_$][\w$]*\s*=)(?![=>])/);
      if (simple) transformed = simple[1] + simple[2] + line.slice(simple[0].length);
    }
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') depth++;
      else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    }
    return transformed;
  });
  return out.join('\n');
}

let active = null;

/** Make a TLA cell's completion value real: when the LAST top-level line
 *  reads as a bare expression, return it from the IIFE (mirrors script
 *  completion values). Statement keywords and multi-line tails stay as-is
 *  (value undefined — documented heuristic). */
const STATEMENT_KEYWORD = /^\s*(const|let|var|function|class|if|for|while|do|switch|try|throw|return|import|export|break|continue|\}|\/\/)/;
function returnLastExpression(body) {
  const lines = body.split('\n');
  let depth = 0;
  let lastTopLevel = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (depth === 0 && trimmed.length > 0) lastTopLevel = i;
    for (const ch of lines[i]) {
      if (ch === '{' || ch === '(' || ch === '[') depth++;
      else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    }
  }
  if (lastTopLevel === -1) return body;
  const candidate = lines[lastTopLevel];
  if (STATEMENT_KEYWORD.test(candidate)) return body;
  lines[lastTopLevel] = 'return (' + candidate.replace(/;\s*$/, '') + ');';
  return lines.join('\n');
}

async function runCell(msg) {
  const { cellId, code, hasTopLevelAwait } = msg;
  dropFreshRequireCache();
  let value;
  try {
    if (hasTopLevelAwait) {
      const body = returnLastExpression(stripTopLevelDeclarations(code));
      const wrapped = '(async () => {\n' + body + '\n})()';
      value = await vm.runInContext(wrapped, context, { filename: cellId + '.js' });
    } else {
      const script = new vm.Script(code, { filename: cellId + '.js' });
      value = script.runInContext(context);
      if (value && typeof value.then === 'function') value = await value;
    }
    parentPort.postMessage({
      type: 'cell-done',
      cellId,
      ok: true,
      valuePreview: value === undefined ? '' : bounded(value),
    });
  } catch (err) {
    parentPort.postMessage({
      type: 'cell-done',
      cellId,
      ok: false,
      error: err && err.stack ? String(err.stack).slice(0, 4000) : String(err),
    });
  }
}

parentPort.on('message', (msg) => {
  if (msg.type === 'run') {
    active = runCell(msg);
  } else if (msg.type === 'rpc-result') {
    const pending = pendingRpc.get(msg.id);
    if (pending) {
      pendingRpc.delete(msg.id);
      if (msg.ok) pending.resolve(msg.value);
      else pending.reject(new Error(msg.error || 'bridge call failed'));
    }
  }
});
parentPort.postMessage({ type: 'ready' });
`

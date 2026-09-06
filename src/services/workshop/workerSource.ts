
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

let active = null;

async function runCell(msg) {
  const { cellId, code, hasTopLevelAwait } = msg;
  dropFreshRequireCache();
  let value;
  try {
    if (hasTopLevelAwait) {
      // The host prepared this body from the parsed cell; the wrapper is
      // the only transformation the worker applies.
      const wrapped = '(async () => {\n' + code + '\n})()';
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

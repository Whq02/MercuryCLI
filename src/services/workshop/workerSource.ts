
export const WORKSHOP_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const util = require('node:util');
const { createRequire } = require('node:module');
const path = require('node:path');

const cwd = workerData.cwd;
const cellRequire = createRequire(path.join(cwd, '__workshop__.js'));
const cwdReal = (() => {
  try {
    return require('node:fs').realpathSync(cwd);
  } catch {
    return cwd;
  }
})();

let rpcSeq = 0;
let cellRpcSeq = 0;
const pendingRpc = new Map();
function rpc(kind, payload) {
  const site = new Error();
  const call = { ordinal: ++cellRpcSeq, label: kind === 'tool' && payload && payload.name ? String(payload.name) : kind };
  return new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    pendingRpc.set(id, {
      resolve,
      reject: (message) => {
        const err = new Error(message);
        err.bridgeCall = call;
        err.stack = site.stack;
        reject(err);
      },
    });
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
if (workerData.samples === true) {
  mercury.sample = (spec) => rpc('sample', { spec });
}

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

const ERROR_TEXT_CAP = 4000;
const ERROR_HEAD_CAP = 3500;
const ERROR_FRAME_CAP = 8;
const escapeRe = (s) => s.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

function cellFrames(stack, cellId, lineOffset, lineCount) {
  const file = cellId + '.js';
  const fileAt = new RegExp(escapeRe(file) + ':(\\d+)(:\\d+)?');
  const out = [];
  for (const raw of String(stack || '').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('at ')) continue;
    const inCell = line.includes(file + ':');
    const inCwd = line.includes(cwd + path.sep) || line.includes(cwdReal + path.sep);
    if (!inCell && !inCwd) continue;
    let text = line;
    if (inCell) {
      let outside = false;
      text = text.replace(fileAt, (m, l, c) => {
        const n = Number(l) - lineOffset;
        if (n < 1 || n > lineCount) outside = true;
        return file + ':' + n + (c || '');
      });
      if (outside) continue;
    }
    out.push('    ' + clip(text, 200));
    if (out.length >= ERROR_FRAME_CAP) break;
  }
  return out;
}

function excerptAt(code, pos) {
  const source = String(code).split('\n')[pos.line - 1];
  if (source === undefined) return [];
  const at = Math.max(0, Math.min(source.length, pos.column - 1));
  const start = Math.max(0, at - 60);
  const end = Math.min(source.length, at + 40);
  const head = start > 0 ? '…' : '';
  const tail = end < source.length ? '…' : '';
  return ['    near: ' + head + source.slice(start, end) + tail, '    ' + ' '.repeat(6 + head.length + (at - start)) + '^'];
}

function describeCellError(err, cellId, code, hasTopLevelAwait, parseError) {
  if (err === null || typeof err !== 'object') return String(err);
  if (typeof err.stack !== 'string' && typeof err.message !== 'string') return bounded(err, 2);
  const lineOffset = hasTopLevelAwait ? 1 : 0;
  const lineCount = String(code).split('\n').length;
  const message = err.message === undefined ? '' : String(err.message);
  const lines = [];
  if (err.bridgeCall) {
    lines.push(clip('bridge call ' + err.bridgeCall.ordinal + ' (' + err.bridgeCall.label + ') failed: ' + message, ERROR_HEAD_CAP));
    lines.push('the cell stopped at that call');
    lines.push(...cellFrames(err.stack, cellId, lineOffset, lineCount));
  } else if (parseError && String(err.name) === 'SyntaxError') {
    const pos = { line: parseError.line, column: parseError.column + 1 };
    lines.push(clip('SyntaxError: ' + parseError.message, ERROR_HEAD_CAP) + ' (' + cellId + '.js:' + pos.line + ':' + pos.column + ')');
    lines.push(...excerptAt(code, pos));
  } else {
    lines.push(clip(String(err.name || 'Error') + (message ? ': ' + message : ''), ERROR_HEAD_CAP));
    lines.push(...cellFrames(err.stack, cellId, lineOffset, lineCount));
  }
  return lines.join('\n').slice(0, ERROR_TEXT_CAP);
}

async function runCell(msg) {
  const { cellId, code, hasTopLevelAwait, parseError } = msg;
  dropFreshRequireCache();
  cellRpcSeq = 0;
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
      error: describeCellError(err, cellId, code, hasTopLevelAwait, parseError),
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
      else pending.reject(msg.error || 'bridge call failed');
    }
  }
});
parentPort.postMessage({ type: 'ready' });
`

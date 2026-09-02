#!/usr/bin/env python3
"""Apply erased-token restorations from a workflow result, verifying each file's
edits are runtime-inert (Bun.Transpiler byte-identical) before keeping them.

Usage: apply-restorations.py <workflow-output.json>

Workflow result shape: {"result": [{"file","edits":[{"old_string","new_string","token"}],"notes"}]}
or a bare list. Applies all edits for a file, then transpiles before/after; if the
JS differs the whole file is reverted (a non-type edit slipped in). Leaves a report;
the caller runs tsc + reverts any file that introduced a NEW fingerprint, then
regens the baseline.
"""
import json, os, subprocess, sys, tempfile

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BUN = os.path.expanduser('~/.bun/bin/bun')
TRANSPILE = '/tmp/transpile.js'

def load(path):
    d = json.load(open(path))
    if isinstance(d, dict):
        d = d.get('result', [])
    return d

def transpile(path):
    r = subprocess.run([BUN, TRANSPILE, path], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None

def main():
    results = load(sys.argv[1])
    applied_files, reverted_files, skipped = [], [], []
    total_edits = 0
    for r in results:
        f = r.get('file', '')
        edits = r.get('edits') or []
        if not f or not edits:
            continue
        path = f if f.startswith('/') else os.path.join(REPO, f)
        if not os.path.exists(path):
            skipped.append((f, 'missing file'))
            continue
        original = open(path).read()
        before_js = transpile(path)
        if before_js is None:
            skipped.append((f, 'before-transpile failed'))
            continue
        text = original
        n = 0
        for e in edits:
            old, new = e.get('old_string', ''), e.get('new_string', '')
            if not old or old == new:
                continue
            if text.count(old) != 1:
                continue  # non-unique or already-applied; skip just this edit
            text = text.replace(old, new, 1)
            n += 1
        if text == original:
            skipped.append((f, 'no edits matched'))
            continue
        open(path, 'w').write(text)
        after_js = transpile(path)
        if after_js is None or after_js != before_js:
            open(path, 'w').write(original)  # revert: not byte-identical => not inert
            reverted_files.append(f)
        else:
            applied_files.append(f)
            total_edits += n
    print(f"APPLIED {len(applied_files)} files / {total_edits} edits (transpile byte-identical)")
    print(f"REVERTED (not inert) {len(reverted_files)}: {reverted_files}")
    print(f"SKIPPED {len(skipped)}: {skipped[:8]}{'...' if len(skipped)>8 else ''}")
    # write the applied list for the fingerprint-revert step
    open('/tmp/applied_files.txt', 'w').write('\n'.join(applied_files))

if __name__ == '__main__':
    main()

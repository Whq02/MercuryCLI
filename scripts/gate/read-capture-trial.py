#!/usr/bin/env python3
import json
import sys


def report(verdict):
    timeline = verdict.get('timeline') or {}
    suites = {s for s, cls in verdict.get('classes', {}).items() if cls in ('pty', 'undeclared')}
    runs = timeline.get('runs', [])
    suites.update(r['suite'] for r in runs if r.get('class') in ('pty', 'undeclared'))
    complete = bool(suites) and timeline.get('ptyMax') == 8 and verdict.get('scope') == 'release'
    red = False
    print('suite\tfirst rc/load1\trerun rc/load1\tsolo rc/load1')
    for suite in sorted(suites):
        attempts = [r for r in runs if r['suite'] == suite]
        cells = []
        for kind in ('pool', 'retry-in-pool', 'retry-solo'):
            matching = [r for r in attempts if r.get('kind') == kind]
            if not matching:
                cells.append('missing' if kind == 'pool' else 'not run')
                if kind == 'pool':
                    complete = False
                continue
            if len(matching) != 1:
                complete = False
            run = matching[0]
            box = run.get('box') or {}
            load = box.get('load1')
            cells.append('%s/%s' % (run.get('rc', '?'), load if load is not None else '?'))
            complete = complete and load is not None and run.get('rc') is not None and box.get('ptyMax') == 8 and box.get('vshotSlots') == 8
            red = red or run.get('rc') != 0 or bool(run.get('proofRerun'))
        print(suite + '\t' + '\t'.join(cells))
    if not complete:
        print('zero flakes at 8: NOT VERIFIED (missing attempts, start loads, paired 8/8 shape, or full release scope)')
        return 2
    if red or verdict.get('flakes'):
        print('zero flakes at 8: NO (a red attempt remains recorded; diagnose its words, not just the final rc)')
        return 1
    print('zero flakes at 8: YES (all recorded pty attempts green first time; this is not a claim about other suites)')
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('usage: python3 scripts/gate/read-capture-trial.py <verdict.json>')
    with open(sys.argv[1]) as source:
        sys.exit(report(json.load(source)))

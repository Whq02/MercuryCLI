#!/usr/bin/env python3
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/lib'))
from box_shape import adaptive_scale, start_reading

for args, expected_val in [
    ((1, 0, 15), 1),
    ((1, 7.5, 15), 1.5),
    ((1, 0.1, 15), 1.1),
    ((3, 7.5, 15), 3),
    ((1, 90, 15), 7),
    ((3.123, 7.5, 15), 3.123),
]:
    got_val = adaptive_scale(*args)
    assert got_val == expected_val, f'scripts/lib/box_shape.py adaptive_scale{args} returned {got_val!r}, expected {expected_val!r}'
for load in [0, 0.1, 7.5, 15, 90]:
    with patch('box_shape.os.getloadavg', return_value=(load, 0, 0)):
        rec = start_reading(20, {'MERCURY_GATE_CORES': '15', 'MERCURY_VSHOT_BUDGET_SCALE': '1'}, 'pty')
        expected_budget = math.ceil(20 * adaptive_scale(1, load, 15))
        assert rec['budgetS'] == expected_budget, f'scripts/lib/box_shape.py start_reading(load={load}) budgetS={rec["budgetS"]!r}, expected {expected_budget!r}'
        assert rec['load1'] == load, f'scripts/lib/box_shape.py start_reading(load={load}) load1={rec["load1"]!r}'
        fixed = start_reading(20, {'MERCURY_GATE_CORES': '15', 'MERCURY_VSHOT_BUDGET_SCALE': '1'}, 'pty', 'fixed')
        assert fixed['budgetS'] == 20 and fixed['budgetScale'] == rec['budgetScale'], f'scripts/lib/box_shape.py fixed start_reading(load={load}) got {fixed!r}, expected budgetS=20 budgetScale={rec["budgetScale"]!r}'
with patch('box_shape.os.getloadavg', return_value=(7.5, 0, 0)):
    rec = start_reading(20, {'MERCURY_GATE_CORES': '15', 'MERCURY_VSHOT_BUDGET_SCALE': '3'}, 'pty')
    assert rec['budgetS'] == 20, f'scripts/lib/box_shape.py start_reading(pace=3,load=7.5) double-counted pace: budgetS={rec["budgetS"]!r}, expected 20'
print('[PASS] load raises capture budgets, never lowers pace, and never counts the pace twice')
print('[PASS] hosted fixed walls retain their measured ceiling while captures carry their start reading')

with tempfile.TemporaryDirectory(prefix='suite-scale-') as work:
    work = Path(work)
    gate = work / 'scripts/gate'
    gate.mkdir(parents=True)
    for name in ['lib', 'ui']:
        (work / 'scripts' / name).symlink_to(ROOT / 'scripts' / name)
    text = (ROOT / 'scripts/gate/run-suite.sh').read_text()
    if '--ref' in sys.argv:
        ref = sys.argv[sys.argv.index('--ref') + 1]
        text = subprocess.check_output(['git', 'show', ref + ':scripts/gate/run-suite.sh'], cwd=ROOT, text=True)
    (gate / 'run-suite.sh').write_text(text)
    suite = work / 'capture'
    suite.mkdir()
    received = work / 'scale'
    (suite / 'run-all.sh').write_text('#!/usr/bin/env bash\n# gate-class: pty\nprintf "%s" "$MERCURY_VSHOT_BUDGET_SCALE" > "' + str(received) + '"\n')
    out = work / 'out'
    out.mkdir()
    env = dict(os.environ, MERCURY_GATE_CORES='1', MERCURY_VSHOT_BUDGET_SCALE='1')
    run = subprocess.run(['bash', str(gate / 'run-suite.sh'), str(suite / 'run-all.sh'), '20', str(out)], cwd=ROOT, env=env, capture_output=True, text=True)
    rec = json.loads((out / 'capture.start.json').read_text())
    expected = adaptive_scale(1, rec['load1'], 1)
    actual = float(received.read_text())
    if run.returncode != 0 or actual != expected or rec['budgetS'] != math.ceil(20 * expected):
        print('[FAIL] runner threads the measured adaptive budget into the capture: rc=%s load=%s scale=%s expected=%s wall=%s' % (run.returncode, rec['load1'], actual, expected, rec['budgetS']))
        sys.exit(1)
    capture_out = (out / 'capture.out').read_text()
    assert 'suite start:' in capture_out, f'scripts/gate/run-suite.sh capture.out missing "suite start:" header: {capture_out[:120]!r}'
    print('[PASS] runner records and exports scale=%s at load=%s on cores=1, wall=%s' % (actual, rec['load1'], rec['budgetS']))

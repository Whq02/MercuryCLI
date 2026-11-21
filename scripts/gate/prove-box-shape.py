#!/usr/bin/env python3
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/lib'))
from box_shape import shape, capture_slots, capture_slot_dir

pinned = capture_slot_dir({'MERCURY_GATE_PTY_MAX': '3'})
expected_pinned = os.path.join(os.path.realpath('/tmp'), 'mercury-vshot-slots-%s' % os.getuid())
assert pinned == expected_pinned, f'scripts/lib/box_shape.py capture_slot_dir(MERCURY_GATE_PTY_MAX=3) returned {pinned!r}, expected {expected_pinned!r}'
old_tmp = os.environ.get('TMPDIR')
with tempfile.TemporaryDirectory(prefix='box-shape-run-root-') as run_root:
    os.environ['TMPDIR'] = run_root
    tempfile.tempdir = None
    pinned_under_tmp = capture_slot_dir({'MERCURY_GATE_PTY_MAX': '3'})
    assert pinned_under_tmp == pinned, f'scripts/lib/box_shape.py pool slot dir drifted under TMPDIR: got {pinned_under_tmp!r}, expected {pinned!r}'
    standalone = capture_slot_dir({'VSHOT_SLOTS': '999'})
    assert standalone != pinned, f'scripts/lib/box_shape.py standalone VSHOT_SLOTS shared pool dir {pinned!r}'
    assert os.path.dirname(standalone) in (run_root, os.path.realpath(run_root)), f'scripts/lib/box_shape.py standalone slot dir {standalone!r} escaped run_root {run_root!r}'
    default_standalone = capture_slot_dir({})
    assert default_standalone == standalone, f'scripts/lib/box_shape.py default capture_slot_dir({{}}) returned {default_standalone!r}, expected {standalone!r}'
if old_tmp is None:
    del os.environ['TMPDIR']
else:
    os.environ['TMPDIR'] = old_tmp
tempfile.tempdir = None
print('[PASS] the pool pin shares one machine-wide slot directory; a standalone run serializes under its own TMPDIR and never takes the pool slots')

got_default_shape = shape({})
assert got_default_shape[1] == 3, f'scripts/lib/box_shape.py shape({{}}) pty cap={got_default_shape[1]!r}, expected 3'
got_pinned_shape = shape({'MERCURY_GATE_CORES': '4', 'MERCURY_GATE_PTY_MAX': '8'})
assert got_pinned_shape == (4, 8), f'scripts/lib/box_shape.py shape(4,8) returned {got_pinned_shape!r}, expected (4, 8)'
got_pool_slots = capture_slots({'MERCURY_GATE_PTY_MAX': '8', 'VSHOT_SLOTS': '1'})
assert got_pool_slots == 8, f'scripts/lib/box_shape.py capture_slots(pool=8,vshot=1) returned {got_pool_slots!r}, expected 8'
got_standalone_999 = capture_slots({'VSHOT_SLOTS': '999'})
assert got_standalone_999 == 999, f'scripts/lib/box_shape.py capture_slots(vshot=999) returned {got_standalone_999!r}, expected 999'
got_standalone_0 = capture_slots({'VSHOT_SLOTS': '0'})
assert got_standalone_0 == 0, f'scripts/lib/box_shape.py capture_slots(vshot=0) returned {got_standalone_0!r}, expected 0'
got_zero_pty = shape({'MERCURY_GATE_PTY_MAX': '0'})
assert got_zero_pty[1] == 3, f'scripts/lib/box_shape.py shape(MERCURY_GATE_PTY_MAX=0) pty cap={got_zero_pty[1]!r}, expected 3'
got_bad_pty = shape({'MERCURY_GATE_PTY_MAX': 'bad'})
assert got_bad_pty[1] == 3, f'scripts/lib/box_shape.py shape(MERCURY_GATE_PTY_MAX=bad) pty cap={got_bad_pty[1]!r}, expected 3'
print('[PASS] one measured default; the pool pin pairs both caps, standalone overrides remain')

with tempfile.TemporaryDirectory(prefix='box-shape-') as work:
    work = Path(work)
    scripts = work / 'project/scripts'
    scripts.mkdir(parents=True)
    for name in ['gate', 'lib']:
        (scripts / name).symlink_to(ROOT / 'scripts' / name)
    text = (ROOT / 'scripts/run-all-suites.sh').read_text()
    if '--ref' in sys.argv:
        ref = sys.argv[sys.argv.index('--ref') + 1]
        text = subprocess.check_output(['git', 'show', ref + ':scripts/run-all-suites.sh'], cwd=ROOT, text=True)
    (scripts / 'run-all-suites.sh').write_text(text)
    suite = work / 'suites/capture'
    suite.mkdir(parents=True)
    result = work / 'pair'
    (suite / 'run-all.sh').write_text('#!/usr/bin/env bash\n# gate-class: pty\nprintf "%s/%s" "$MERCURY_GATE_PTY_MAX" "$VSHOT_SLOTS" > "' + str(result) + '"\n')
    env = {k: v for k, v in os.environ.items() if not k.startswith('MERCURY_GATE_')}
    env.update(MERCURY_GATE_SUITES_DIR=str(suite.parent), MERCURY_GATE_VERDICT_FILE=str(work / 'verdict.json'), MERCURY_GATE_PTY_MAX='8', VSHOT_SLOTS='1', MERCURY_GATE_CORES='4')
    run = subprocess.run(['bash', str(scripts / 'run-all-suites.sh')], env=env, cwd=ROOT, capture_output=True, text=True)
    pair = result.read_text() if result.exists() else 'absent'
    if run.returncode != 0 or pair != '8/8':
        print('[FAIL] the suite receives the paired 8/8 capture shape: rc=%s pair=%s' % (run.returncode, pair))
        sys.exit(1)
    verdict = json.loads((work / 'verdict.json').read_text())
    box = verdict['timeline']['runs'][0]['box']
    assert box['cores'] == 4 and box['ptyMax'] == 8 and box['vshotSlots'] == 8 and isinstance(box['load1'], (int, float)), f'scripts/run-all-suites.sh verdict box mismatch: got {box!r}, expected cores=4 ptyMax=8 vshotSlots=8 numeric load1'
    print('[PASS] paired 8/8 reaches the suite; its measured start load and box reach the timeline')

spec = importlib.util.spec_from_file_location('reader', ROOT / 'scripts/gate/read-capture-trial.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
v = dict(scope='release', classes={'p': 'pty'}, timeline=dict(ptyMax=8, runs=[dict(suite='p', kind='pool', rc=0, box=dict(load1=2.5, ptyMax=8, vshotSlots=8))]))
with contextlib.redirect_stdout(io.StringIO()):
    rc0 = reader.report(v)
    assert rc0 == 0, f'scripts/gate/read-capture-trial.py report(zero reds) returned {rc0!r}, expected 0'
    v['timeline']['runs'][0]['rc'] = 3
    rc1 = reader.report(v)
    assert rc1 == 1, f'scripts/gate/read-capture-trial.py report(recorded red rc=3) returned {rc1!r}, expected 1'
    v['timeline']['runs'][0]['box']['load1'] = None
    rc2 = reader.report(v)
    assert rc2 == 2, f'scripts/gate/read-capture-trial.py report(missing load1) returned {rc2!r}, expected 2'
print('[PASS] the reader distinguishes zero reds, recorded reds, and missing measurements')

import json
import math
import os
import sys
import tempfile
import time

DEFAULT_PTY_MAX = 3


def positive_int(value, fallback):
    return int(value) if str(value).isdigit() and int(value) > 0 else fallback


def shape(env=None):
    env = os.environ if env is None else env
    cores = positive_int(env.get('MERCURY_GATE_CORES'), os.cpu_count() or 1)
    pty_max = positive_int(env.get('MERCURY_GATE_PTY_MAX'), DEFAULT_PTY_MAX)
    return cores, pty_max


def capture_slots(env=None):
    env = os.environ if env is None else env
    if env.get('MERCURY_GATE_PTY_MAX'):
        return shape(env)[1]
    try:
        return int(env.get('VSHOT_SLOTS', DEFAULT_PTY_MAX))
    except (ValueError, TypeError):
        return DEFAULT_PTY_MAX


def capture_slot_dir(env=None):
    env = os.environ if env is None else env
    root = os.path.realpath('/tmp') if env.get('MERCURY_GATE_PTY_MAX') else tempfile.gettempdir()
    return os.path.join(root, 'mercury-vshot-slots-%s' % os.getuid())


def adaptive_scale(pace, load, cores):
    adaptive = math.ceil((1 + max(0, load or 0) / max(1, cores)) * 10) / 10
    return max(1.0, pace, adaptive)


def start_reading(budget, env=None, resource='pure', wall_mode='adaptive'):
    env = os.environ if env is None else env
    cores, pty_max = shape(env)
    try:
        load = os.getloadavg()[0]
    except (AttributeError, OSError):
        load = None
    try:
        pace = float(env.get('MERCURY_VSHOT_BUDGET_SCALE', '1'))
    except (ValueError, TypeError):
        pace = 1.0
    if not math.isfinite(pace) or pace <= 0:
        pace = 1.0
    capture = resource in ('pty', 'undeclared')
    scale = adaptive_scale(pace, load, cores) if capture else pace
    wall = max(budget, math.ceil(budget * scale / pace)) if capture and wall_mode != 'fixed' else budget
    return dict(startedAt=time.time(), cores=cores, load1=load, ptyMax=pty_max,
                vshotSlots=capture_slots(env), paceKnob=pace, budgetScale=scale,
                authoredBudgetS=budget, budgetS=wall, wallMode=wall_mode, resource=resource)


if __name__ == '__main__':
    if sys.argv[1:] == ['--shell']:
        print(*shape())
    elif len(sys.argv) in (4, 6) and sys.argv[1] == '--start':
        reading = start_reading(int(sys.argv[3]), resource=sys.argv[4] if len(sys.argv) == 6 else 'pure', wall_mode=sys.argv[5] if len(sys.argv) == 6 else 'adaptive')
        with open(sys.argv[2], 'w') as target:
            json.dump(reading, target)
        print('suite start: cores={cores} load1={load1} pace={paceKnob} scale={budgetScale} wall={budgetS}s pty={ptyMax} vshot={vshotSlots}'.format(**reading))
    elif len(sys.argv) == 3 and sys.argv[1] == '--budget':
        with open(sys.argv[2]) as source:
            reading = json.load(source)
        print(reading['budgetS'], reading['budgetScale'])
    else:
        sys.exit('usage: box_shape.py --shell | --start <receipt.json> <budget-seconds> [resource wall-mode] | --budget <receipt.json>')

#!/usr/bin/env python3
import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from observed_walk import ObservedWalk

walk = ObservedWalk([
    {"awaitText": "settings", "text": "\x1b"},
    {"awaitText": "Boot face", "text": "\x1b"},
    {"awaitText": "Boot face", "awaitAbsent": "selected", "text": "\x1b"},
    {"awaitText": "receipt", "text": ""},
])
assert walk.next(["Boot face"], 0) is None
assert walk.next(["settings"], 100) is None
assert walk.next(["settings"], 500)[1]["step"] == 0
assert walk.next(["Boot face selected"], 600) is None
assert walk.next(["Boot face selected"], 1000)[1]["step"] == 1
assert walk.next(["Boot face selected"], 1400) is None
assert walk.next(["Boot face"], 1600) is None
assert walk.next(["Boot face"], 2000)[1]["step"] == 2
assert walk.next(["Boot face"], 2500) is None
assert len(walk.pending()) == 1
assert walk.next(["receipt"], 3000) is None
assert walk.next(["receipt"], 3400)[1]["step"] == 3
assert walk.pending() == []
print('[PASS] current-frame gates order all three Escs and require the receipt')
for rows in [["Alpha", "Beta"], ["Beta", "Alpha"]]:
    walk = ObservedWalk([{"awaitText": "Beta", "targetText": "Beta"}])
    assert walk.next(rows, 0) is None
    payload, receipt = walk.next(rows, 400)
    y = rows.index("Beta") + 1
    assert payload == ("\x1b[<0;1;%dM\x1b[<0;1;%dm" % (y, y)).encode()
    assert receipt["screen"] == rows
walk = ObservedWalk([{"awaitText": "Beta", "targetText": "Beta"}])
assert walk.next(["Beta", "Beta"], 0) is None
assert walk.next(["Beta", "Beta"], 500) is None
print('[PASS] row targeting follows words in either order and refuses ambiguous rows')

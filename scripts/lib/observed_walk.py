class ObservedWalk:
    def __init__(self, steps, scale=1.0):
        self.steps = steps
        self.scale = scale
        self.index = 0
        self.since = None
        self.previous = None
        self.last_sent = 0

    def next(self, rows, now_ms):
        if self.index >= len(self.steps):
            return None
        step = self.steps[self.index]
        text = "\n".join(rows)
        wanted = step["awaitText"]
        wanted = [wanted] if isinstance(wanted, str) else wanted
        absent = step.get("awaitAbsent", [])
        absent = [absent] if isinstance(absent, str) else absent
        arrived = step.get("arrivedText", [])
        arrived = [arrived] if isinstance(arrived, str) else arrived
        already = bool(arrived) and all(word in text for word in arrived) and step.get("arrivedAbsent", "\0") not in text
        ready = already or (all(word in text for word in wanted) and not any(word in text for word in absent))
        snapshot = tuple(rows)
        if not ready or snapshot != self.previous:
            self.since = now_ms if ready else None
        self.previous = snapshot
        if self.since is None or now_ms - self.since < float(step.get("settleMs", 400)) * self.scale:
            return None
        if now_ms - self.last_sent < step.get("afterPrevMs", 0) * self.scale:
            return None
        payload = "" if already else step.get("text", "")
        target = None if already else step.get("targetText")
        if target is not None:
            candidates = list(enumerate(rows))
            start_x = 0
            header = step.get("targetHeader")
            if header is not None:
                headers = [(y, row.find(header)) for y, row in candidates if header in row]
                if len(headers) != 1:
                    return None
                start_y, start_x = headers[0]
                candidates = []
                for y in range(start_y + 1, len(rows)):
                    if "╰" in rows[y][max(0, start_x - 3):start_x + 1]:
                        break
                    candidates.append((y, rows[y]))
            hits = [(row.find(target, start_x) + 1, y + 1) for y, row in candidates if target in row[start_x:]]
            if len(hits) != 1:
                return None
            x, y = hits[0]
            payload = "\x1b[<0;%d;%dM\x1b[<0;%d;%dm" % (x, y, x, y)
        receipt = {"step": self.index, "awaitText": step["awaitText"], "screen": list(rows)}
        if target is not None:
            receipt["targetText"] = target
        self.index += 1
        self.last_sent = now_ms
        self.previous = None
        self.since = None
        return payload.encode("utf-8"), receipt

    def pending(self):
        return ["step %d awaiting %r" % (i, step["awaitText"]) for i, step in enumerate(self.steps) if i >= self.index]

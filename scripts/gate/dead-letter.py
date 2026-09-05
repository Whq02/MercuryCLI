#!/usr/bin/env python3
import json
import os
import shutil
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ANSWER = json.dumps({"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}).encode()


class DeadLetter(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _drain(self):
        n = int(self.headers.get("content-length") or 0)
        while n > 0:
            chunk = self.rfile.read(min(n, 65536))
            if not chunk:
                break
            n -= len(chunk)

    def _answer(self, head=False):
        self._drain()
        if self.path == "/":
            self.send_response(200)
            self.send_header("content-length", "0")
            self.send_header("connection", "close")
            self.end_headers()
            return
        self.send_response(401)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(ANSWER)))
        self.send_header("x-should-retry", "false")
        self.send_header("connection", "close")
        self.end_headers()
        if not head:
            self.wfile.write(ANSWER)

    def do_GET(self):
        self._answer()

    def do_POST(self):
        self._answer()

    def do_PUT(self):
        self._answer()

    def do_DELETE(self):
        self._answer()

    def do_HEAD(self):
        self._answer(head=True)

    def log_message(self, *args):
        pass


def watch_parent(parent_pid):
    while True:
        time.sleep(1)
        if os.getppid() != parent_pid:
            shutil.rmtree(os.path.dirname(os.path.abspath(PORT_FILE)), ignore_errors=True)
            os._exit(0)


PORT_FILE = ""


def main():
    global PORT_FILE
    port_file = sys.argv[1]
    PORT_FILE = port_file
    server = ThreadingHTTPServer(("127.0.0.1", 0), DeadLetter)
    server.daemon_threads = True
    threading.Thread(target=watch_parent, args=(os.getppid(),), daemon=True).start()
    with open(port_file, "w") as f:
        f.write(str(server.server_address[1]))
    server.serve_forever()


if __name__ == "__main__":
    main()

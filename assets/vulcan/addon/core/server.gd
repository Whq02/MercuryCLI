@tool
class_name MercuryVulcanServer
extends Node
# Mercury VULCAN — token-authed loopback NDJSON control server (editor side).
#
# Per-connection state machine:
#   1. The FIRST line MUST be
#        {"op":"hello","token":"…","role":"client"|"runtime","version":1}
#      - token file missing -> every connection refused with TOKEN_MISSING
#      - bad token          -> socket dropped without a reply
#   2. Authed client: requests {"id":N,"op":"…","args":{…}} answer
#      {"id":N,"ok":true,"result":…} or {"id":N,"ok":false,"error":{code,
#      message,hint}}; {"op":"ping"} answers "pong"; unsolicited
#      {"event":…,"data":…} frames (play_started/play_stopped/editor_error,
#      forwarded runtime events) ride the same pipe.
#   3. Authed runtime (the play-mode bridge) is held SEPARATELY; runtime ops
#      are proxied to it as {"id":N,"rop":"…","args":{…}} frames on the
#      server's own id-space with a 10s timeout, and its {"event":…} frames
#      are forwarded up to the client.
#
# NDJSON both ways: one JSON object per \n-terminated line; lines over 8 MB
# are refused. The listener binds 127.0.0.1 ONLY and re-checks the peer
# address on accept. On start the actual listening port is written to
# .godot/mercury-vulcan-port so the play-mode bridge back-connects to the
# right port even when mercury_vulcan/port was tuned.

const ContextScript := preload("context.gd")
const UndoScript := preload("undo.gd")
const TypesScript := preload("types.gd")
const PathsScript := preload("paths.gd")
const RegistryScript := preload("registry.gd")
const OpClassesScript := preload("op_classes.gd")

const DEFAULT_PORT := 6010
const PORT_SETTING := "mercury_vulcan/port"
const TOKEN_PATH := "res://.godot/mercury-vulcan-token"
const PORT_FILE := "res://.godot/mercury-vulcan-port"
const MAX_LINE_BYTES := 8 * 1024 * 1024
const MAX_CONNECTIONS := 8
const UNAUTHED_GRACE_MS := 10000
const RUNTIME_TIMEOUT_MS := 10000
const PLAY_POLL_INTERVAL := 0.25
const MERCURY_SIDE_OPS := ["vulcan_install", "vulcan_uninstall", "vulcan_status"]
const LOOPBACK_HOSTS := ["127.0.0.1", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]

class Conn:
	extends RefCounted
	var peer: StreamPeerTCP = null
	var buf := PackedByteArray()
	var authed := false
	var role := ""
	var opened_ms := 0

class RuntimeProxy:
	extends RefCounted
	# What category handlers see as ctx.runtime. request() is awaitable and
	# ALWAYS returns a {ok:…} dictionary (id stripped), never throws.
	var _server: Node = null
	func _init(server: Node) -> void:
		_server = server
	func is_alive() -> bool:
		return _server != null and _server.runtime_connected()
	func request(op: String, args: Dictionary) -> Dictionary:
		if _server == null:
			return {"ok": false, "error": {"code": "NO_RUNTIME",
				"message": "the runtime bridge is gone",
				"hint": "start a play session with scene_play first"}}
		return await _server.proxy_to_runtime(op, args)

var _server: TCPServer = null
var _conns: Array = []
var _client: Conn = null
var _runtime: Conn = null
var _registry: RefCounted = null
var _undo: RefCounted = null
var _types: RefCounted = null
var _play_accum := 0.0
var _was_playing := false
var _runtime_next_id := 1
var _runtime_pending := {}

func setup(undo_manager: Object) -> void:
	_undo = UndoScript.new()
	_undo.setup(undo_manager)
	_types = TypesScript.new()
	_registry = RegistryScript.new()

func start() -> void:
	if _server != null:
		return
	var port := DEFAULT_PORT
	if ProjectSettings.has_setting(PORT_SETTING):
		port = int(ProjectSettings.get_setting(PORT_SETTING, DEFAULT_PORT))
	_server = TCPServer.new()
	var listen_err := _server.listen(port, "127.0.0.1")
	if listen_err != OK:
		push_warning("mercury_vulcan: cannot listen on 127.0.0.1:%d (%s)" % [port, error_string(listen_err)])
		_server = null
		_remove_port_file()
		return
	var pf := FileAccess.open(PORT_FILE, FileAccess.WRITE)
	if pf != null:
		pf.store_string(str(port))
	set_process(true)
	print("mercury_vulcan: listening on 127.0.0.1:%d" % port)

func stop() -> void:
	for c in _conns:
		if c.peer != null:
			c.peer.disconnect_from_host()
	_conns.clear()
	_client = null
	_runtime = null
	_runtime_pending.clear()
	if _server != null:
		_server.stop()
		_server = null
	_remove_port_file()
	set_process(false)

# A stale port file would send the next play session's bridge to a port some
# OTHER process may own — remove it whenever we are not actually listening.
func _remove_port_file() -> void:
	if FileAccess.file_exists(PORT_FILE):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(PORT_FILE))

func runtime_connected() -> bool:
	return _runtime != null

func _process(delta: float) -> void:
	if _server == null:
		return
	while _server.is_connection_available():
		var peer := _server.take_connection()
		if peer == null:
			break
		if _conns.size() >= MAX_CONNECTIONS or not _is_loopback(peer.get_connected_host()):
			peer.disconnect_from_host()
			continue
		var conn := Conn.new()
		conn.peer = peer
		conn.opened_ms = Time.get_ticks_msec()
		_conns.append(conn)
	var now := Time.get_ticks_msec()
	for conn: Conn in _conns.duplicate():
		conn.peer.poll()
		var status := conn.peer.get_status()
		if status == StreamPeerTCP.STATUS_ERROR or status == StreamPeerTCP.STATUS_NONE:
			_drop(conn)
			continue
		if not conn.authed and now - conn.opened_ms > UNAUTHED_GRACE_MS:
			_drop(conn)
			continue
		if status != StreamPeerTCP.STATUS_CONNECTED:
			continue
		var avail := conn.peer.get_available_bytes()
		if avail > 0:
			var chunk := conn.peer.get_data(avail)
			if chunk[0] == OK:
				conn.buf.append_array(chunk[1])
		_drain_lines(conn)
	_poll_play_state(delta)

func _drain_lines(conn: Conn) -> void:
	while _conns.has(conn):
		var idx := conn.buf.find(10)
		if idx == -1:
			if conn.buf.size() > MAX_LINE_BYTES:
				_send(conn, {"ok": false, "error": _err_body("LINE_TOO_LONG",
					"NDJSON line exceeded 8 MB",
					"keep each frame under 8 MB; page large reads with limit/depth args")})
				_drop(conn)
			return
		var line_bytes := conn.buf.slice(0, idx)
		conn.buf = conn.buf.slice(idx + 1)
		if line_bytes.size() > MAX_LINE_BYTES:
			_send(conn, {"ok": false, "error": _err_body("LINE_TOO_LONG",
				"NDJSON line exceeded 8 MB",
				"keep each frame under 8 MB; page large reads with limit/depth args")})
			_drop(conn)
			return
		var line := line_bytes.get_string_from_utf8().strip_edges()
		if line.is_empty():
			continue
		_handle_line(conn, line)

func _handle_line(conn: Conn, line: String) -> void:
	var msg = JSON.parse_string(line)
	if typeof(msg) != TYPE_DICTIONARY:
		_send(conn, {"ok": false, "error": _err_body("BAD_JSON",
			"line was not a JSON object",
			"send one JSON object per newline-terminated line")})
		if not conn.authed:
			_drop(conn)
		return
	if not conn.authed:
		_handle_hello(conn, msg)
		return
	if conn.role == "runtime":
		_handle_runtime_frame(conn, msg)
		return
	_handle_request(conn, msg)

func _handle_hello(conn: Conn, msg: Dictionary) -> void:
	if String(msg.get("op", "")) != "hello":
		_send(conn, {"ok": false, "error": _err_body("AUTH_REQUIRED",
			"the first frame must be the hello handshake",
			"send {op:\"hello\", token, role:\"client\", version:1} as line one")})
		_drop(conn)
		return
	var expected := _read_expected_token()
	if expected.is_empty():
		_send(conn, {"ok": false, "error": _err_body("TOKEN_MISSING",
			"no token file at .godot/mercury-vulcan-token",
			"run vulcan_install / let Mercury write the token")})
		_drop(conn)
		return
	if not _ct_eq(String(msg.get("token", "")), expected):
		_drop(conn)
		return
	if int(msg.get("version", 0)) != 1:
		_send(conn, {"ok": false, "error": _err_body("VERSION_MISMATCH",
			"protocol version must be 1",
			"update Mercury or reinstall the addon (vulcan_install) so both speak version 1")})
		_drop(conn)
		return
	var role := String(msg.get("role", ""))
	if role != "client" and role != "runtime":
		_send(conn, {"ok": false, "error": _err_body("BAD_ROLE",
			"role must be \"client\" or \"runtime\"",
			"Mercury connects as role:\"client\"; the play-mode bridge as role:\"runtime\"")})
		_drop(conn)
		return
	conn.authed = true
	conn.role = role
	if role == "client":
		if _client != null and _client != conn:
			_drop(_client)
		_client = conn
	else:
		if _runtime != null and _runtime != conn:
			_drop(_runtime)
		_runtime = conn
	_send(conn, {"ok": true, "result": {
		"version": 1,
		"godot": String(Engine.get_version_info().get("string", "")),
		"project": String(ProjectSettings.get_setting("application/config/name", "")),
	}})

func _handle_runtime_frame(conn: Conn, msg: Dictionary) -> void:
	if msg.has("event"):
		emit_vulcan_event(String(msg["event"]), msg.get("data"))
		return
	if msg.has("id"):
		var rid := int(msg.get("id", -1))
		if _runtime_pending.has(rid):
			_runtime_pending[rid] = msg
			return
	if String(msg.get("op", "")) == "ping":
		_send(conn, {"id": msg.get("id"), "ok": true, "result": "pong"})

func _handle_request(conn: Conn, msg: Dictionary) -> void:
	var op := String(msg.get("op", ""))
	var id = msg.get("id")
	if typeof(id) == TYPE_FLOAT and id == floor(id):
		id = int(id)
	if op == "ping":
		_send(conn, {"id": id, "ok": true, "result": "pong"})
		return
	if op == "hello":
		_send(conn, {"id": id, "ok": false, "error": _err_body("ALREADY_AUTHED",
			"this connection already said hello",
			"send requests as {id, op, args}")})
		return
	if typeof(id) != TYPE_INT:
		_send(conn, {"ok": false, "error": _err_body("BAD_REQUEST",
			"requests need an integer id",
			"send {id:<int>, op:\"…\", args:{…}}")})
		return
	if op.is_empty():
		_send(conn, {"id": id, "ok": false, "error": _err_body("BAD_REQUEST",
			"op is required",
			"send {id:<int>, op:\"…\", args:{…}}")})
		return
	var args = msg.get("args", {})
	if typeof(args) != TYPE_DICTIONARY:
		_send(conn, {"id": id, "ok": false, "error": _err_body("BAD_REQUEST",
			"args must be a JSON object",
			"send {id:<int>, op:\"…\", args:{…}}")})
		return
	# Fire-and-forget: _process can never await, so the coroutine runs to its
	# first suspension here and finishes on later frames (bare call — assigning
	# a void coroutine's return is a parse error on current GDScript).
	_serve(conn, id, op, args)

func _serve(conn: Conn, id: int, op: String, args: Dictionary) -> void:
	var res: Dictionary = await dispatch_op(op, args)
	var out := {"id": id}
	out.merge(res)
	_send(conn, out)

# Routes one op through the registry and returns the {ok:…} envelope. Also the
# ctx.dispatch seam: frontier's batch_transaction re-enters here for its
# sub-ops (each nested call gets a fresh ctx; the shared _undo instance is what
# lets undo.begin/commit group them into one editor undo step).
func dispatch_op(op: String, args: Dictionary) -> Dictionary:
	if MERCURY_SIDE_OPS.has(op):
		return _err("MERCURY_SIDE",
			"\"%s\" is handled by Mercury before the wire" % op,
			"run it through Mercury's Godot tool; it never reaches the editor")
	var handler = _registry.handler_for(op)
	if handler == null:
		return _err("UNKNOWN_OP", "unknown op \"%s\"" % op,
			"closest category: %s" % _registry.closest_category(op))
	var ctx := _make_ctx()
	var res = await handler.handle(op, args, ctx)
	if typeof(res) != TYPE_DICTIONARY or not res.has("ok"):
		emit_vulcan_event("editor_error",
			{"op": op, "message": "handler returned a malformed result"})
		return _err("INTERNAL",
			"the handler for \"%s\" returned a malformed result" % op,
			"this is an addon bug; report it (vulcan_status shows versions)")
	return res

# The ctx.op_class seam (optable class lookup, generated table).
func op_class_of(op: String) -> String:
	return OpClassesScript.of(op)

func proxy_to_runtime(op: String, args: Dictionary) -> Dictionary:
	if _runtime == null:
		return _err("NO_RUNTIME", "no play session bridge is connected",
			"start a play session with scene_play first")
	var rid := _runtime_next_id
	_runtime_next_id += 1
	_runtime_pending[rid] = null
	# The runtime leg uses the "rop" key (the bridge ignores frames without it)
	# so a bridge can never confuse a proxied op with the client protocol.
	_send(_runtime, {"id": rid, "rop": op, "args": args})
	var timeout_ms := _runtime_deadline_ms(op, args)
	var deadline := Time.get_ticks_msec() + timeout_ms
	while Time.get_ticks_msec() < deadline:
		if not _runtime_pending.has(rid):
			return _err("CONNECTION_LOST",
				"the runtime bridge dropped while \"%s\" was in flight" % op,
				"scene_play again, then retry")
		var resp = _runtime_pending[rid]
		if resp != null:
			_runtime_pending.erase(rid)
			if typeof(resp) != TYPE_DICTIONARY:
				return _err("BAD_RUNTIME_REPLY",
					"the runtime bridge answered \"%s\" with a malformed frame" % op,
					"restart the play session (scene_stop, then scene_play)")
			var out: Dictionary = resp.duplicate()
			out.erase("id")
			if not out.has("ok"):
				return _err("BAD_RUNTIME_REPLY",
					"the runtime bridge answered \"%s\" without an ok field" % op,
					"restart the play session (scene_stop, then scene_play)")
			return out
		var tree := get_tree()
		if tree == null:
			break
		await tree.process_frame
	_runtime_pending.erase(rid)
	return _err("RUNTIME_TIMEOUT",
		"runtime op \"%s\" timed out after %ds" % [op, timeout_ms / 1000],
		"the game may be paused or busy; check runtime_status, or restart with scene_play")

# The proxy deadline must exceed the op's own declared duration: the bridge
# legitimately runs runtime_watch/profile_snapshot up to 30s, runtime_wait_signal
# up to 120s, and input_sequence for the sum of its waits — a flat 10s would
# time out healthy work (and a retried side-effecting op would double its input).
func _runtime_deadline_ms(op: String, args: Dictionary) -> int:
	var ms := RUNTIME_TIMEOUT_MS
	for key in ["timeout_ms", "duration_ms"]:
		if args.has(key) and str(args[key]).is_valid_float():
			ms = maxi(ms, int(args[key]) + RUNTIME_TIMEOUT_MS)
	if op == "input_sequence" and args.get("steps") is Array:
		var total := 0
		for step in args.get("steps"):
			if step is Dictionary and step.has("wait_ms"):
				total += maxi(0, int(step["wait_ms"]))
		ms = maxi(ms, total + RUNTIME_TIMEOUT_MS)
	if op == "runtime_replay":
		# The recording's length is unknown editor-side; give replays a wide lane.
		ms = maxi(ms, 120000)
	return ms

func emit_vulcan_event(event_name: String, data) -> void:
	if _client == null:
		return
	_send(_client, {"event": event_name, "data": data})

func _make_ctx() -> RefCounted:
	var ctx = ContextScript.new()
	ctx.editor = EditorInterface
	ctx.undo = _undo
	ctx.types = _types
	ctx.paths = PathsScript.new()
	ctx.runtime = RuntimeProxy.new(self) if _runtime != null else null
	ctx.server = self
	return ctx

func _poll_play_state(delta: float) -> void:
	_play_accum += delta
	if _play_accum < PLAY_POLL_INTERVAL:
		return
	_play_accum = 0.0
	var playing := EditorInterface.is_playing_scene()
	if playing == _was_playing:
		return
	_was_playing = playing
	emit_vulcan_event("play_started" if playing else "play_stopped", {})
	if not playing and _runtime != null:
		_drop(_runtime)

func _send(conn: Conn, frame: Dictionary) -> void:
	if conn == null or conn.peer == null:
		return
	if conn.peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		return
	var line := JSON.stringify(frame) + "\n"
	conn.peer.put_data(line.to_utf8_buffer())

func _drop(conn: Conn) -> void:
	if conn == null:
		return
	if conn.peer != null:
		conn.peer.disconnect_from_host()
	_conns.erase(conn)
	if _client == conn:
		_client = null
	if _runtime == conn:
		_runtime = null
		_runtime_pending.clear()

func _read_expected_token() -> String:
	if not FileAccess.file_exists(TOKEN_PATH):
		return ""
	var f := FileAccess.open(TOKEN_PATH, FileAccess.READ)
	if f == null:
		return ""
	return f.get_as_text().strip_edges()

static func _ct_eq(a: String, b: String) -> bool:
	var ab := a.to_utf8_buffer()
	var bb := b.to_utf8_buffer()
	var diff := ab.size() ^ bb.size()
	var n: int = max(ab.size(), bb.size())
	for i in n:
		var x := ab[i] if i < ab.size() else 0
		var y := bb[i] if i < bb.size() else 0
		diff |= x ^ y
	return diff == 0

static func _is_loopback(host: String) -> bool:
	return LOOPBACK_HOSTS.has(host)

func _err(code: String, message: String, hint: String) -> Dictionary:
	return {"ok": false, "error": _err_body(code, message, hint)}

static func _err_body(code: String, message: String, hint: String) -> Dictionary:
	return {"code": code, "message": message, "hint": hint}

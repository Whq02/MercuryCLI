extends RefCounted

const MAX_FRAME := 8 * 1024 * 1024
const HELLO_MAX := 16384
const InstanceScript := preload("instance.gd")
const OPS := ["engine_scene_tree", "engine_node_get", "engine_node_call", "engine_signal_wait"]

class Connection:
	extends RefCounted
	var peer: StreamPeerTCP
	var bytes := PackedByteArray()
	var authed := false
	var opened := Time.get_ticks_msec()
	var pending := 0

var instance: RefCounted
var handler: Callable
var connections: Array = []

func setup(owner_instance: RefCounted, dispatch: Callable) -> void:
	instance = owner_instance
	handler = dispatch

func poll() -> void:
	if instance.listener == null:
		return
	while instance.listener.is_connection_available():
		var peer: StreamPeerTCP = instance.listener.take_connection()
		if peer == null:
			break
		if connections.size() >= 8 or peer.get_connected_host() != "127.0.0.1":
			peer.disconnect_from_host()
			continue
		var conn := Connection.new()
		conn.peer = peer
		connections.append(conn)
	for conn: Connection in connections.duplicate():
		conn.peer.poll()
		if conn.peer.get_status() != StreamPeerTCP.STATUS_CONNECTED or (not conn.authed and Time.get_ticks_msec() - conn.opened > 5000):
			drop(conn)
			continue
		var cap := MAX_FRAME if conn.authed else HELLO_MAX
		var count := mini(conn.peer.get_available_bytes(), cap + 1 - conn.bytes.size())
		if count > 0:
			var data := conn.peer.get_data(count)
			if data[0] != OK:
				drop(conn)
				continue
			conn.bytes.append_array(data[1])
		while connections.has(conn):
			var nl := conn.bytes.find(10)
			cap = MAX_FRAME if conn.authed else HELLO_MAX
			if (nl < 0 and conn.bytes.size() > cap) or nl > cap:
				drop(conn)
				break
			if nl < 0:
				break
			var line := conn.bytes.slice(0, nl).get_string_from_utf8()
			conn.bytes = conn.bytes.slice(nl + 1)
			var msg = JSON.parse_string(line)
			if not (msg is Dictionary):
				drop(conn)
				break
			if not conn.authed:
				if msg.get("op") != "hello" or msg.get("version") != 1 or msg.get("role") != "client" or msg.get("instance") != instance.identity["id"] or not InstanceScript.equal_token(str(msg.get("token", "")), instance.token):
					drop(conn)
					break
				conn.authed = true
				send(conn, {"ok": true, "result": {"version": 1}})
				continue
			var id = msg.get("id")
			if not (id is int or id is float) or float(id) != floor(float(id)) or not (msg.get("args", {}) is Dictionary):
				drop(conn)
				break
			var op := str(msg.get("op", ""))
			if op == "ping":
				send(conn, {"id": id, "ok": true, "result": "pong"})
			elif not OPS.has(op):
				send(conn, {"id": id, "ok": false, "error": {"code": "UNKNOWN_OP", "message": "this runtime listener serves the engine query operations"}})
			elif conn.pending >= 64:
				send(conn, {"id": id, "ok": false, "error": {"code": "BUSY", "message": "too many runtime queries in flight"}})
			else:
				serve(conn, int(id), op, msg.get("args", {}))

func serve(conn: Connection, id: int, op: String, args: Dictionary) -> void:
	conn.pending += 1
	var result: Dictionary = await handler.call(op, args)
	conn.pending -= 1
	result["id"] = id
	send(conn, result)

func send(conn: Connection, result: Dictionary) -> void:
	if not connections.has(conn):
		return
	var frame := result.duplicate()
	frame["instance"] = instance.identity.duplicate()
	var bytes := (JSON.stringify(frame) + "\n").to_utf8_buffer()
	if bytes.size() > MAX_FRAME:
		drop(conn)
		return
	conn.peer.put_data(bytes)

func drop(conn: Connection) -> void:
	connections.erase(conn)
	conn.peer.disconnect_from_host()

func stop() -> void:
	for conn: Connection in connections.duplicate():
		drop(conn)

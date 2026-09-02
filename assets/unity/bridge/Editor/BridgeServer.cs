// BridgeServer — the listener, the framing, the hello gate, and the
// main-thread pump; the heart of the package.
//
// THREADING LAW: the Unity scripting API is main-thread-only. The socket
// thread therefore does exactly three things — frame bytes into lines,
// answer the hello from a lock-guarded snapshot (token/version compare +
// cached facts, no Unity API), and answer pings — everything else is queued
// and executed inside EditorApplication.update (the [InitializeOnLoad]
// update-pump pattern from the attribute's own documentation example).
// A ping answered on the socket thread while the main thread grinds through
// an import means: a BUSY editor stays connected (per-request timeouts say
// "busy"), only a DEAD editor drops the heartbeat.
//
// DOMAIN-RELOAD LAW: entering play mode / recompiling kills this domain —
// DomainUnload closes the listener and the live socket, and the next
// domain's [InitializeOnLoad] static constructor re-arms everything
// (listener, console ring, test callbacks, snapshot). Mercury's client
// treats the drop as contract and reconnects.
//
// ACCEPT-NEWEST LAW, HELLO-TIME: one AUTHED client at a time; a newer
// connection replaces the older only when it AUTHENTICATES (a stale
// post-reload socket on Mercury's side self-heals) — a bare connect that
// never hellos (a port probe, a scanner) can never kick the live client,
// and an unauthed socket dies on a 10s receive deadline.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEngine;

namespace Mercury.UnityBridge
{
    /** A typed wire refusal — handlers throw it, the pump answers it. */
    internal sealed class BridgeRefusal : Exception
    {
        public readonly string Code;
        public readonly string Hint;

        public BridgeRefusal(string code, string message, string hint = null) : base(message)
        {
            Code = code;
            Hint = hint;
        }
    }

    [InitializeOnLoad]
    internal static class BridgeServer
    {
        private const int MaxLineBytes = 8 * 1024 * 1024;

        private sealed class Request
        {
            public object Id;
            public string Op;
            public Dictionary<string, object> Args;
        }

        private sealed class Client
        {
            public TcpClient Tcp;
            public NetworkStream Stream;
            public volatile bool Authed;
            public readonly object WriteGate = new object();
        }

        private static TcpListener _listener;
        private static Thread _acceptThread;
        private static volatile bool _running;
        private static Client _client;
        private static readonly object ClientGate = new object();
        private static readonly ConcurrentQueue<Request> MainQueue = new ConcurrentQueue<Request>();

        // The snapshot the socket thread answers hellos from — built and
        // refreshed ONLY on the main thread, swapped whole.
        private static volatile Dictionary<string, object> _helloSnapshot;

        static BridgeServer()
        {
            BridgeSettings.ProjectRoot(); // cache-safe on the main thread
            ConsoleRing.Arm();
            TestsHandler.Rearm();
            RefreshSnapshot();
            EditorApplication.update += Pump;
            EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
            AppDomain.CurrentDomain.DomainUnload += (sender, e) => Stop();
            Start();
        }

        // ── lifecycle ────────────────────────────────────────────────────────

        private static void Start()
        {
            int port = BridgeSettings.ReadPort();
            try
            {
                _listener = new TcpListener(IPAddress.Loopback, port);
                _listener.Start();
            }
            catch (Exception e)
            {
                // A squatted port (another editor, a foreign process) is a
                // report, not a crash loop — Mercury's doctor names the port.
                Debug.LogWarning("[MercuryBridge] cannot listen on 127.0.0.1:" + port + " — " + e.Message);
                _listener = null;
                return;
            }
            _running = true;
            _acceptThread = new Thread(AcceptLoop) { IsBackground = true, Name = "MercuryBridgeAccept" };
            _acceptThread.Start();
        }

        private static void Stop()
        {
            _running = false;
            try { _listener?.Stop(); } catch { }
            lock (ClientGate)
            {
                try { _client?.Tcp.Close(); } catch { }
                _client = null;
            }
        }

        private static void AcceptLoop()
        {
            while (_running)
            {
                TcpClient tcp;
                try
                {
                    tcp = _listener.AcceptTcpClient();
                }
                catch
                {
                    return; // listener stopped (domain unload / editor quit)
                }
                tcp.NoDelay = true;
                // Unauthed sockets carry a receive deadline — a connect that
                // never hellos (a probe) exits its reader in bounded time.
                tcp.ReceiveTimeout = 10_000;
                var client = new Client { Tcp = tcp, Stream = tcp.GetStream() };
                var reader = new Thread(() => ReadLoop(client)) { IsBackground = true, Name = "MercuryBridgeRead" };
                reader.Start();
            }
        }

        // ── the socket thread: framing + hello + ping only ───────────────────

        private static void ReadLoop(Client client)
        {
            var buffer = new byte[64 * 1024];
            var line = new StringBuilder();
            try
            {
                while (_running)
                {
                    int n = client.Stream.Read(buffer, 0, buffer.Length);
                    if (n <= 0) return;
                    string chunk = Encoding.UTF8.GetString(buffer, 0, n);
                    foreach (char c in chunk)
                    {
                        if (c == '\n')
                        {
                            string one = line.ToString();
                            line.Length = 0;
                            if (one.Trim().Length > 0) HandleLine(client, one);
                            continue;
                        }
                        line.Append(c);
                        if (line.Length > MaxLineBytes)
                        {
                            client.Tcp.Close(); // an oversized frame is a dead peer
                            return;
                        }
                    }
                }
            }
            catch
            {
                // Socket died (accept-newest, reload, Mercury gone) — done.
            }
        }

        private static void HandleLine(Client client, string raw)
        {
            Dictionary<string, object> frame;
            try
            {
                frame = MiniJson.Parse(raw) as Dictionary<string, object>;
            }
            catch
            {
                frame = null;
            }
            if (frame == null)
            {
                if (!client.Authed) client.Tcp.Close(); // garbage hello ⇒ not our client
                return; // one bad frame after auth never kills the stream
            }
            if (!client.Authed)
            {
                HandleHello(client, frame);
                return;
            }
            string op = frame.TryGetValue("op", out object o) ? o as string : null;
            if (op == "ping")
            {
                // Answered HERE so a busy main thread still looks alive at
                // the transport level (only a dead editor misses pongs).
                Send(client, new Dictionary<string, object>
                {
                    { "id", frame.TryGetValue("id", out object pid) ? pid : null },
                    { "ok", true },
                    { "result", "pong" },
                });
                return;
            }
            MainQueue.Enqueue(new Request
            {
                Id = frame.TryGetValue("id", out object id) ? id : null,
                Op = op ?? string.Empty,
                Args = frame.TryGetValue("args", out object a) ? a as Dictionary<string, object> : null,
            });
        }

        private static void HandleHello(Client client, Dictionary<string, object> frame)
        {
            string op = frame.TryGetValue("op", out object o) ? o as string : null;
            string token = frame.TryGetValue("token", out object t) ? t as string : null;
            // Token read fresh from disk per hello (pure file IO, cached
            // root) — an install that just wrote it works without a reload.
            string expected = BridgeSettings.ReadToken();
            if (op != "hello" || expected == null || token != expected)
            {
                Send(client, ErrorFrame(null, "AUTH_FAILED", "bad token",
                    "op:\"unity_bridge_install\" rewrites the token file"));
                client.Tcp.Close();
                return;
            }
            double version = frame.TryGetValue("version", out object v) && v is double d ? d : double.NaN;
            if (version != BridgeSettings.ProtocolVersion)
            {
                Send(client, ErrorFrame(null, "VERSION_SKEW",
                    "the bridge package speaks protocol " + BridgeSettings.ProtocolVersion +
                    " but the client sent " + (double.IsNaN(version) ? "(unstated)" : version.ToString()),
                    "op:\"unity_bridge_install\" refreshes the bundled package so both halves match"));
                client.Tcp.Close();
                return;
            }
            client.Authed = true;
            client.Tcp.ReceiveTimeout = 0; // authed: the deadline comes off
            lock (ClientGate)
            {
                // ACCEPT-NEWEST AT HELLO TIME: the older AUTHED client dies
                // only now — never on a bare accept.
                if (_client != null && _client != client)
                {
                    try { _client.Tcp.Close(); } catch { }
                }
                _client = client;
            }
            Send(client, new Dictionary<string, object>
            {
                { "ok", true },
                { "result", _helloSnapshot },
            });
        }

        // ── the main thread: pump + dispatch + events ────────────────────────

        private static void Pump()
        {
            while (MainQueue.TryDequeue(out Request req))
            {
                Client client;
                lock (ClientGate) { client = _client; }
                if (client == null || !client.Authed) continue;
                Dictionary<string, object> response;
                try
                {
                    object result = Dispatch(req.Op, req.Args);
                    response = new Dictionary<string, object>
                    {
                        { "id", req.Id }, { "ok", true }, { "result", result },
                    };
                }
                catch (BridgeRefusal r)
                {
                    response = ErrorFrame(req.Id, r.Code, r.Message, r.Hint);
                }
                catch (Exception e)
                {
                    response = ErrorFrame(req.Id, "INTERNAL", e.Message);
                }
                Send(client, response);
            }
        }

        private static object Dispatch(string op, Dictionary<string, object> args)
        {
            switch (op)
            {
                case "play_state": return PlayModeHandler.State(args);
                case "play_enter": return PlayModeHandler.Enter(args);
                case "play_exit": return PlayModeHandler.Exit(args);
                case "play_pause": return PlayModeHandler.Pause(args);
                case "scene_list": return ScenesHandler.List(args);
                case "scene_open": return ScenesHandler.Open(args);
                case "hierarchy_read": return HierarchyHandler.Read(args);
                case "console_tail":
                {
                    int limit = 100;
                    if (args != null && args.TryGetValue("limit", out object l) && l is double n && n >= 1) limit = (int)n;
                    string severity = args != null && args.TryGetValue("severity", out object s) ? s as string : null;
                    return ConsoleRing.Tail(limit, severity);
                }
                case "tests_run": return TestsHandler.Run(args);
                default:
                    throw new BridgeRefusal("UNKNOWN_OP", "bridge does not handle '" + op + "'",
                        "one of: play_state, play_enter, play_exit, play_pause, scene_list, scene_open, hierarchy_read, console_tail, tests_run");
            }
        }

        private static void OnPlayModeStateChanged(PlayModeStateChange change)
        {
            RefreshSnapshot();
            EmitEvent("play_state_changed", new Dictionary<string, object>
            {
                { "playState", PlayModeHandler.StateDict() },
            });
        }

        private static void RefreshSnapshot()
        {
            _helloSnapshot = new Dictionary<string, object>
            {
                { "version", BridgeSettings.ProtocolVersion },
                { "bridge", "com.mercury.unity-bridge/0.1.0" },
                { "unity", Application.unityVersion },
                { "project", PlayerSettings.productName },
                { "playState", PlayModeHandler.StateDict() },
            };
        }

        /** Event frames ride the same connection (main thread callers). */
        public static void EmitEvent(string name, Dictionary<string, object> data)
        {
            Client client;
            lock (ClientGate) { client = _client; }
            if (client == null || !client.Authed) return;
            Send(client, new Dictionary<string, object> { { "event", name }, { "data", data } });
        }

        // ── writing ──────────────────────────────────────────────────────────

        private static Dictionary<string, object> ErrorFrame(object id, string code, string message, string hint = null)
        {
            var error = new Dictionary<string, object> { { "code", code }, { "message", message } };
            if (!string.IsNullOrEmpty(hint)) error.Add("hint", hint);
            var frame = new Dictionary<string, object> { { "ok", false }, { "error", error } };
            if (id != null) frame.Add("id", id);
            return frame;
        }

        private static void Send(Client client, Dictionary<string, object> frame)
        {
            try
            {
                byte[] bytes = Encoding.UTF8.GetBytes(MiniJson.Serialize(frame) + "\n");
                lock (client.WriteGate)
                {
                    client.Stream.Write(bytes, 0, bytes.Length);
                    client.Stream.Flush();
                }
            }
            catch
            {
                // A dead socket mid-send: drop the client; Mercury reconnects.
                lock (ClientGate)
                {
                    if (_client == client) _client = null;
                }
                try { client.Tcp.Close(); } catch { }
            }
        }
    }
}

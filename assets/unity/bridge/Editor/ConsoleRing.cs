// ConsoleRing — the console_tail verb's backing store: a lock-guarded ring
// fed by Application.logMessageReceivedThreaded ("the handler code has to be
// thread-safe" — the handler only appends under the lock and touches no
// Unity API). The threaded variant also receives main-thread messages, so
// one registration covers everything. Capacity 1000 (the contract's
// UNITY_BRIDGE_CONSOLE_RING_CAP); evictions are counted, never hidden. The
// ring dies with every domain reload and re-arms from the server's
// [InitializeOnLoad] path — a reload therefore empties the tail, which is
// honest (the editor's own console survives; the BRIDGE's window restarts).

using System;
using System.Collections.Generic;
using UnityEngine;

namespace Mercury.UnityBridge
{
    internal static class ConsoleRing
    {
        public const int Capacity = 1000;

        internal struct Entry
        {
            public string Severity;
            public string Message;
            public string StackTrace;
            public long At;
        }

        private static readonly object Gate = new object();
        private static readonly List<Entry> Ring = new List<Entry>(Capacity);
        private static long _dropped;
        private static bool _armed;

        public static void Arm()
        {
            if (_armed) return;
            _armed = true;
            Application.logMessageReceivedThreaded += OnLog;
        }

        private static void OnLog(string condition, string stackTrace, LogType type)
        {
            var entry = new Entry
            {
                Severity = SeverityOf(type),
                Message = condition ?? string.Empty,
                StackTrace = stackTrace ?? string.Empty,
                At = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            lock (Gate)
            {
                if (Ring.Count >= Capacity)
                {
                    Ring.RemoveAt(0);
                    _dropped++;
                }
                Ring.Add(entry);
            }
        }

        private static string SeverityOf(LogType type)
        {
            switch (type)
            {
                case LogType.Error: return "error";
                case LogType.Assert: return "assert";
                case LogType.Warning: return "warning";
                case LogType.Exception: return "exception";
                default: return "log";
            }
        }

        private static int Rank(string severity)
        {
            switch (severity)
            {
                case "exception": return 4;
                case "error": return 3;
                case "assert": return 2;
                case "warning": return 1;
                default: return 0;
            }
        }

        /** The tail: newest-last, floor-filtered, bounded by limit. */
        public static Dictionary<string, object> Tail(int limit, string severityFloor)
        {
            int floor = Rank(severityFloor ?? "log");
            var entries = new List<object>();
            long dropped;
            lock (Gate)
            {
                dropped = _dropped;
                var kept = new List<Entry>();
                foreach (Entry e in Ring)
                {
                    if (Rank(e.Severity) >= floor) kept.Add(e);
                }
                int start = Math.Max(0, kept.Count - limit);
                for (int i = start; i < kept.Count; i++)
                {
                    entries.Add(new Dictionary<string, object>
                    {
                        { "severity", kept[i].Severity },
                        { "message", kept[i].Message },
                        { "stackTrace", kept[i].StackTrace },
                        { "at", kept[i].At },
                    });
                }
            }
            return new Dictionary<string, object>
            {
                { "entries", entries },
                { "dropped", dropped },
            };
        }
    }
}

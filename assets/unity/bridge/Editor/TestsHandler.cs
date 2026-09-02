
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using UnityEditor;
using UnityEditor.TestTools.TestRunner.Api;
using UnityEngine;

namespace Mercury.UnityBridge
{
    internal static class TestsHandler
    {
        private const string RunKey = "MercuryUnityBridge.pendingResultsPath";
        private static TestRunnerApi _api;

        public static void Rearm()
        {
            if (_api != null) return;
            _api = ScriptableObject.CreateInstance<TestRunnerApi>();
            _api.RegisterCallbacks(new BridgeTestCallbacks());
        }

        public static object Run(Dictionary<string, object> args)
        {
            string modeRaw = args != null && args.TryGetValue("mode", out object m) ? m as string : null;
            if (modeRaw != "EditMode" && modeRaw != "PlayMode")
            {
                throw new BridgeRefusal("BAD_ARGS", "mode must be \"EditMode\" or \"PlayMode\"");
            }
            if (!string.IsNullOrEmpty(SessionState.GetString(RunKey, string.Empty)))
            {
                throw new BridgeRefusal("RUN_IN_FLIGHT", "a test run is already executing — one at a time");
            }
            string wirePath = args.TryGetValue("resultsPath", out object rp) ? rp as string : null;
            if (string.IsNullOrEmpty(wirePath))
            {
                wirePath = Path.Combine(
                    ".mercury", "unity-test-results", modeRaw.ToLowerInvariant() + ".xml");
            }
            string resultsPath = BridgeSettings.ResolveInsideProject(wirePath);
            if (resultsPath == null)
            {
                throw new BridgeRefusal("BAD_ARGS", "resultsPath must stay inside the project");
            }

            var filter = new Filter
            {
                testMode = modeRaw == "PlayMode" ? TestMode.PlayMode : TestMode.EditMode,
            };
            List<string> testNames = StringList(args, "testNames");
            if (testNames != null) filter.testNames = testNames.ToArray();
            List<string> groupNames = StringList(args, "groupNames");
            if (groupNames != null) filter.groupNames = groupNames.ToArray();

            SessionState.SetString(RunKey, resultsPath);
            Rearm();
            _api.Execute(new ExecutionSettings(filter));
            return new Dictionary<string, object>
            {
                { "started", true },
                { "mode", modeRaw },
                { "resultsPath", resultsPath },
            };
        }

        private static List<string> StringList(Dictionary<string, object> args, string key)
        {
            if (args == null || !args.TryGetValue(key, out object raw) || !(raw is List<object> list) || list.Count == 0)
            {
                return null;
            }
            var strings = new List<string>();
            foreach (object item in list)
            {
                if (item is string s && s.Length > 0) strings.Add(s);
            }
            return strings.Count > 0 ? strings : null;
        }

        private sealed class BridgeTestCallbacks : ICallbacks
        {
            public void RunStarted(ITestAdaptor testsToRun)
            {
            }

            public void TestStarted(ITestAdaptor test)
            {
            }

            public void TestFinished(ITestResultAdaptor result)
            {
            }

            public void RunFinished(ITestResultAdaptor result)
            {
                string path = SessionState.GetString(RunKey, string.Empty);
                if (string.IsNullOrEmpty(path)) return;
                SessionState.EraseString(RunKey);
                try
                {
                    WriteResultsXml(result, path);
                }
                catch (System.Exception e)
                {
                    Debug.LogWarning("[MercuryBridge] could not write test results XML: " + e.Message);
                    return;
                }
                BridgeServer.EmitEvent("test_run_finished", new Dictionary<string, object>
                {
                    { "resultsPath", path },
                    { "passed", result.PassCount },
                    { "failed", result.FailCount },
                    { "skipped", result.SkipCount },
                    { "inconclusive", result.InconclusiveCount },
                    { "durationMs", (long)(result.Duration * 1000.0) },
                });
            }
        }

        private static void WriteResultsXml(ITestResultAdaptor result, string path)
        {
            string xml = result.ToXml().OuterXml;
            string trimmed = xml.TrimStart();
            if (!trimmed.StartsWith("<test-run", System.StringComparison.Ordinal))
            {
                int total = result.PassCount + result.FailCount + result.SkipCount + result.InconclusiveCount;
                string duration = result.Duration.ToString("0.000000", CultureInfo.InvariantCulture);
                xml =
                    "<test-run testcasecount=\"" + total + "\" result=\"" + result.TestStatus +
                    "\" total=\"" + total + "\" passed=\"" + result.PassCount +
                    "\" failed=\"" + result.FailCount + "\" inconclusive=\"" + result.InconclusiveCount +
                    "\" skipped=\"" + result.SkipCount + "\" duration=\"" + duration + "\">" +
                    xml +
                    "</test-run>";
            }
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" + xml);
        }
    }
}

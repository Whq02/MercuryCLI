using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace Mercury.UnityBridge
{
    internal static class BridgeSettings
    {
        public const int ProtocolVersion = 1;
        public const int DefaultPort = 6011;

        private static string _cachedRoot;

        public static string ProjectRoot()
        {
            if (_cachedRoot == null)
            {
                _cachedRoot = Path.GetDirectoryName(Application.dataPath);
            }
            return _cachedRoot;
        }

        public static int ReadPort()
        {
            try
            {
                string file = Path.Combine(ProjectRoot(), "ProjectSettings", "MercuryUnityBridge.json");
                if (!File.Exists(file)) return DefaultPort;
                var parsed = MiniJson.Parse(File.ReadAllText(file)) as Dictionary<string, object>;
                if (parsed != null && parsed.TryGetValue("port", out object raw) && raw is double n)
                {
                    int port = (int)n;
                    if (port >= 1 && port <= 65535 && port == n) return port;
                }
            }
            catch (Exception e)
            {
                Debug.LogWarning("[MercuryBridge] unreadable MercuryUnityBridge.json — using default port " + DefaultPort + ": " + e.Message);
            }
            return DefaultPort;
        }

        public static string ReadToken()
        {
            try
            {
                string file = Path.Combine(ProjectRoot(), "Library", "mercury-unity-bridge-token");
                if (!File.Exists(file)) return null;
                string token = File.ReadAllText(file).Trim();
                if (token.Length != 64) return null;
                foreach (char c in token)
                {
                    bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
                    if (!hex) return null;
                }
                return token;
            }
            catch
            {
                return null;
            }
        }

        public static bool InsideProject(string absolutePath)
        {
            try
            {
                string root = Path.GetFullPath(ProjectRoot());
                string full = Path.GetFullPath(absolutePath);
                return full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)
                    || full == root;
            }
            catch
            {
                return false;
            }
        }

        public static string ResolveInsideProject(string wirePath)
        {
            if (string.IsNullOrEmpty(wirePath)) return null;
            string abs = Path.IsPathRooted(wirePath) ? wirePath : Path.Combine(ProjectRoot(), wirePath);
            return InsideProject(abs) ? Path.GetFullPath(abs) : null;
        }
    }
}

// BridgeSettings — the package's half of the two-halves alignment law.
// Mercury dials MERCURY_UNITY_BRIDGE_PORT; the PACKAGE listens on the port
// in ProjectSettings/MercuryUnityBridge.json ({"port": N}, written by
// Mercury's install when its port differs from the default) and falls back
// to 6011. The token is read from Library/mercury-unity-bridge-token —
// minted by Mercury's install, never by the package (an absent token means
// every hello refuses with the install hint; the package listens but grants
// nothing).

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

        /** The project root: Application.dataPath is <project>/Assets.
         *  CACHED on first call — the first call happens in the server's
         *  [InitializeOnLoad] static constructor ON THE MAIN THREAD, and
         *  every later socket-thread read (the per-hello token read) sees
         *  only the cached string, never the Unity API. */
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

        /** Null when absent/malformed — the server then refuses every hello
         *  with the install hint instead of running open. */
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

        /** True when the absolute path stays inside the project root — every
         *  path-taking verb runs its arguments through this fence. */
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

        /** Resolve a wire path argument (absolute, or project-relative like
         *  "Assets/Scenes/Main.unity") to an absolute path inside the
         *  project; null when it escapes. */
        public static string ResolveInsideProject(string wirePath)
        {
            if (string.IsNullOrEmpty(wirePath)) return null;
            string abs = Path.IsPathRooted(wirePath) ? wirePath : Path.Combine(ProjectRoot(), wirePath);
            return InsideProject(abs) ? Path.GetFullPath(abs) : null;
        }
    }
}

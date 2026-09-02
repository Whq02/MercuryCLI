// PlayModeHandler — play_state / play_enter / play_exit / play_pause.
// THE ACK-THEN-TRANSITION LAW: enter/exit schedule the actual mode change
// with EditorApplication.delayCall, which fires after the current update
// tick — so the response (carrying willReload) is written and flushed
// BEFORE the domain reload can kill the socket. All methods run on the main
// thread (the server's update pump).

using System.Collections.Generic;
using UnityEditor;

namespace Mercury.UnityBridge
{
    internal static class PlayModeHandler
    {
        /** Domain reload on entering play is the DEFAULT; the project can
         *  disable it via Enter Play Mode Settings (enterPlayModeOptions
         *  DisableDomainReload). */
        public static bool WillReloadOnPlay()
        {
            if (!EditorSettings.enterPlayModeOptionsEnabled) return true;
            return (EditorSettings.enterPlayModeOptions & EnterPlayModeOptions.DisableDomainReload) == 0;
        }

        public static Dictionary<string, object> StateDict()
        {
            return new Dictionary<string, object>
            {
                { "isPlaying", EditorApplication.isPlaying },
                { "isPaused", EditorApplication.isPaused },
                { "isPlayingOrWillChangePlaymode", EditorApplication.isPlayingOrWillChangePlaymode },
                { "willReloadOnPlay", WillReloadOnPlay() },
            };
        }

        public static object State(Dictionary<string, object> args)
        {
            return StateDict();
        }

        public static object Enter(Dictionary<string, object> args)
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode)
            {
                throw new BridgeRefusal("PLAY_MODE_ACTIVE", "already in play mode");
            }
            bool willReload = WillReloadOnPlay();
            EditorApplication.delayCall += () => EditorApplication.EnterPlaymode();
            return new Dictionary<string, object> { { "willReload", willReload } };
        }

        public static object Exit(Dictionary<string, object> args)
        {
            if (!EditorApplication.isPlaying)
            {
                throw new BridgeRefusal("PLAY_MODE_ACTIVE", "not in play mode");
            }
            bool willReload = WillReloadOnPlay();
            EditorApplication.delayCall += () => EditorApplication.ExitPlaymode();
            return new Dictionary<string, object> { { "willReload", willReload } };
        }

        public static object Pause(Dictionary<string, object> args)
        {
            if (args == null || !args.TryGetValue("paused", out object raw) || !(raw is bool paused))
            {
                throw new BridgeRefusal("BAD_ARGS", "paused must be a boolean");
            }
            EditorApplication.isPaused = paused;
            return new Dictionary<string, object> { { "isPaused", EditorApplication.isPaused } };
        }
    }
}

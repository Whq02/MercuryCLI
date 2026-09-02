// ScenesHandler — scene_list / scene_open. Open is EDIT MODE ONLY ("In Play
// mode, use the SceneManager API to load and unload scenes" — the editor
// doc's own boundary), and a dirty open scene REFUSES with the save road
// named: the bridge never silently discards unsaved work, and it never
// drives the save dialog either (saving is the operator's gesture).

using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine.SceneManagement;

namespace Mercury.UnityBridge
{
    internal static class ScenesHandler
    {
        public static object List(Dictionary<string, object> args)
        {
            var open = new List<object>();
            Scene active = SceneManager.GetActiveScene();
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                Scene scene = SceneManager.GetSceneAt(i);
                open.Add(new Dictionary<string, object>
                {
                    { "path", scene.path },
                    { "name", scene.name },
                    { "isDirty", scene.isDirty },
                    { "isLoaded", scene.isLoaded },
                    { "isActive", scene == active },
                });
            }
            var build = new List<object>();
            foreach (EditorBuildSettingsScene row in EditorBuildSettings.scenes)
            {
                build.Add(new Dictionary<string, object>
                {
                    { "path", row.path },
                    { "enabled", row.enabled },
                });
            }
            return new Dictionary<string, object> { { "open", open }, { "build", build } };
        }

        public static object Open(Dictionary<string, object> args)
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode)
            {
                throw new BridgeRefusal(
                    "PLAY_MODE_ACTIVE",
                    "scene_open is edit-mode only — in play mode the SceneManager owns loading");
            }
            string wirePath = args != null && args.TryGetValue("path", out object p) ? p as string : null;
            if (string.IsNullOrEmpty(wirePath))
            {
                throw new BridgeRefusal("BAD_ARGS", "path is required");
            }
            string abs = BridgeSettings.ResolveInsideProject(wirePath);
            if (abs == null)
            {
                throw new BridgeRefusal("BAD_ARGS", "path must stay inside the project");
            }
            if (!File.Exists(abs) || !abs.EndsWith(".unity", System.StringComparison.Ordinal))
            {
                throw new BridgeRefusal("SCENE_NOT_FOUND", "no scene at " + wirePath);
            }
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                if (SceneManager.GetSceneAt(i).isDirty)
                {
                    throw new BridgeRefusal(
                        "SCENE_DIRTY",
                        "an open scene has unsaved changes",
                        "save it in the editor first (File > Save) — the bridge never discards unsaved work");
                }
            }
            bool additive = args.TryGetValue("additive", out object a) && a is bool b && b;
            // OpenScene takes the project-relative spelling (Assets/…).
            string root = Path.GetFullPath(BridgeSettings.ProjectRoot());
            string relative = Path.GetFullPath(abs).Substring(root.Length + 1).Replace('\\', '/');
            EditorSceneManager.OpenScene(relative, additive ? OpenSceneMode.Additive : OpenSceneMode.Single);
            return new Dictionary<string, object>
            {
                { "opened", relative },
                { "mode", additive ? "Additive" : "Single" },
            };
        }
    }
}

// HierarchyHandler — hierarchy_read: the loaded scenes' root GameObjects
// (Scene.GetRootGameObjects) walked depth-first. The TOTAL counts the whole
// tree even past the cap — only the KEPT set is bounded, so truncatedNodes
// stays honest at any cap (the same law the Mercury-side fake encodes).
// Component names only in v1 (GetComponents<Component>() type names; a
// missing script slot reports "(missing script)" instead of vanishing).

using System.Collections.Generic;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Mercury.UnityBridge
{
    internal static class HierarchyHandler
    {
        public const int DefaultNodeCap = 2000;

        private sealed class Walk
        {
            public int Total;
            public int Kept;
            public int Cap;
        }

        public static object Read(Dictionary<string, object> args)
        {
            string wanted = args != null && args.TryGetValue("scenePath", out object sp) ? sp as string : null;
            int cap = DefaultNodeCap;
            if (args != null && args.TryGetValue("maxNodes", out object mn) && mn is double n && n >= 1)
            {
                cap = (int)n;
            }
            var walk = new Walk { Cap = cap };
            var scenes = new List<object>();
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                Scene scene = SceneManager.GetSceneAt(i);
                if (!scene.isLoaded) continue;
                if (!string.IsNullOrEmpty(wanted) && scene.path != wanted) continue;
                var roots = new List<object>();
                foreach (GameObject root in scene.GetRootGameObjects())
                {
                    object node = WalkNode(root, walk);
                    if (node != null) roots.Add(node);
                }
                scenes.Add(new Dictionary<string, object>
                {
                    { "path", scene.path },
                    { "roots", roots },
                });
            }
            return new Dictionary<string, object>
            {
                { "scenes", scenes },
                { "nodeCount", walk.Total },
                { "truncatedNodes", walk.Total - walk.Kept },
            };
        }

        private static object WalkNode(GameObject go, Walk walk)
        {
            walk.Total++;
            bool keep = walk.Kept < walk.Cap;
            if (keep) walk.Kept++;
            var children = new List<object>();
            Transform t = go.transform;
            for (int i = 0; i < t.childCount; i++)
            {
                object child = WalkNode(t.GetChild(i).gameObject, walk);
                if (child != null && keep) children.Add(child);
            }
            if (!keep) return null;
            var componentNames = new List<object>();
            foreach (Component c in go.GetComponents<Component>())
            {
                componentNames.Add(c == null ? "(missing script)" : c.GetType().Name);
            }
            return new Dictionary<string, object>
            {
                { "name", go.name },
                { "active", go.activeSelf },
                { "componentTypeNames", componentNames },
                { "children", children },
            };
        }
    }
}

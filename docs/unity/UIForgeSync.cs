// Two-way sync: pushes RectTransform changes made in Unity back to UIForge through the
// app's local bridge (http://127.0.0.1:47821). Requires the app to be running.
// Menu: UIForge > Push Layout To Design (selected hierarchy) · UIForge > Watch & Push (toggle)
#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace UIForge
{
    // UIForgeNodeRef (runtime, Assets/UIForge/UIForgeNodeRef.cs) is added by the importer to every node.

    public static class UIForgeSync
    {
        static readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        public static string BridgeUrl = "http://127.0.0.1:47821";
        static bool watching;
        static double lastPush;
        static bool dirty;

        [MenuItem("UIForge/Push Layout To Design")]
        public static void PushSelected()
        {
            var roots = Selection.gameObjects.Length > 0 ? Selection.gameObjects : GameObject.FindObjectsOfType<GameObject>();
            int n = Push(roots);
            Debug.Log($"[UIForgeSync] pushed {n} nodes");
        }

        [MenuItem("UIForge/Watch & Push (toggle)")]
        public static void ToggleWatch()
        {
            watching = !watching;
            if (watching)
            {
                EditorApplication.hierarchyChanged += MarkDirty;
                EditorApplication.update += Tick;
                Undo.postprocessModifications += OnModified;
            }
            else
            {
                EditorApplication.hierarchyChanged -= MarkDirty;
                EditorApplication.update -= Tick;
                Undo.postprocessModifications -= OnModified;
            }
            Debug.Log("[UIForgeSync] watch = " + watching);
        }

        static UndoPropertyModification[] OnModified(UndoPropertyModification[] mods)
        {
            foreach (var m in mods) if (m.currentValue != null && m.currentValue.target is RectTransform) { dirty = true; break; }
            return mods;
        }
        static void MarkDirty() { dirty = true; }
        static void Tick()
        {
            if (!dirty || EditorApplication.timeSinceStartup - lastPush < 0.5) return;
            dirty = false;
            lastPush = EditorApplication.timeSinceStartup;
            Push(GameObject.FindObjectsOfType<GameObject>());
        }

        /// Computes each UIForgeNodeRef's rect in its parent's top-left/Y-down space and sends setNodeProps ops.
        public static int Push(GameObject[] roots)
        {
            var ops = new JArray();
            var seen = new HashSet<string>();
            foreach (var go in roots)
            {
                foreach (var r in go.GetComponentsInChildren<UIForgeNodeRef>(true))
                {
                    if (string.IsNullOrEmpty(r.nodeId) || !seen.Add(r.nodeId)) continue;
                    var rt = r.GetComponent<RectTransform>();
                    var parent = rt.parent as RectTransform;
                    if (rt == null || parent == null) continue;
                    // local rect (Y up, pivot-relative) → parent top-left, Y down
                    Vector2 size = rt.rect.size;
                    Vector2 pivotPos = rt.anchoredPosition; // relative to anchor reference point
                    Vector2 pw = parent.rect.size;
                    float ax0 = rt.anchorMin.x * pw.x, ax1 = rt.anchorMax.x * pw.x;
                    float ay0 = rt.anchorMin.y * pw.y, ay1 = rt.anchorMax.y * pw.y; // Y up
                    float refX = ax0 + rt.pivot.x * (ax1 - ax0);
                    float refY = ay0 + rt.pivot.y * (ay1 - ay0);
                    float pivX = refX + pivotPos.x;
                    float pivY = refY + pivotPos.y;
                    float left = pivX - rt.pivot.x * size.x;
                    float bottom = pivY - rt.pivot.y * size.y;
                    float xTL = left;
                    float yTL = pw.y - (bottom + size.y);
                    var op = new JObject
                    {
                        ["op"] = "setNodeProps",
                        ["node"] = r.nodeId,
                        ["props"] = new JObject
                        {
                            ["x"] = Math.Round(xTL, 2), ["y"] = Math.Round(yTL, 2),
                            ["width"] = Math.Round(size.x, 2), ["height"] = Math.Round(size.y, 2),
                            ["rotation"] = Math.Round(-rt.localEulerAngles.z, 2),
                            ["visible"] = r.gameObject.activeSelf,
                            ["anchor"] = new JObject { ["minX"] = rt.anchorMin.x, ["minY"] = 1 - rt.anchorMax.y, ["maxX"] = rt.anchorMax.x, ["maxY"] = 1 - rt.anchorMin.y },
                            ["pivot"] = new JObject { ["x"] = rt.pivot.x, ["y"] = 1 - rt.pivot.y }
                        }
                    };
                    ops.Add(op);
                }
            }
            if (ops.Count == 0) return 0;
            try
            {
                var body = new JObject { ["method"] = "apply", ["params"] = new JObject { ["ops"] = ops } };
                var res = http.PostAsync(BridgeUrl + "/rpc", new StringContent(body.ToString(), Encoding.UTF8, "application/json")).Result;
                var txt = res.Content.ReadAsStringAsync().Result;
                if (!res.IsSuccessStatusCode) Debug.LogWarning("[UIForgeSync] bridge error: " + txt);
            }
            catch (Exception e)
            {
                Debug.LogWarning("[UIForgeSync] app không chạy? " + e.Message);
            }
            return ops.Count;
        }
    }
}
#endif

// Batch-mode verifier: imports a UIForge layout JSON with UIForgeLayoutImporter and writes the
// resulting RectTransform rects (frame space, top-left origin, Y down) to DM_OUT for comparison.
#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json;
using UnityEditor;
using UnityEngine;

namespace UIForge
{
    public static class UIForgeVerify
    {
        [Serializable]
        public class Row
        {
            public string path;
            public string name;
            public float x, y, w, h;
            public bool active;
            public string components;
        }

        public static void Run()
        {
            string layout = Environment.GetEnvironmentVariable("DM_LAYOUT");
            string outPath = Environment.GetEnvironmentVariable("DM_OUT");
            try
            {
                UIForgeLayoutImporter.StretchRoot = false; // verify at reference resolution
                var frameGo = UIForgeLayoutImporter.Import(layout);
                if (frameGo == null) throw new Exception("import returned null");
                Canvas.ForceUpdateCanvases();
                var frameRt = frameGo.GetComponent<RectTransform>();
                float fw = frameRt.rect.width, fh = frameRt.rect.height;
                var rows = new List<Row>();
                foreach (var rt in frameGo.GetComponentsInChildren<RectTransform>(true))
                {
                    if (rt == frameRt) continue;
                    var corners = new Vector3[4];
                    rt.GetWorldCorners(corners);
                    var bl = frameRt.InverseTransformPoint(corners[0]);
                    var tr = frameRt.InverseTransformPoint(corners[2]);
                    // frame local: origin at center, Y up → top-left origin, Y down
                    float x = bl.x + fw / 2f;
                    float y = fh / 2f - tr.y;
                    float w = tr.x - bl.x;
                    float h = tr.y - bl.y;
                    var names = new List<string>();
                    var t = rt.transform;
                    while (t != null && t != frameRt.transform) { names.Insert(0, t.name); t = t.parent; }
                    var comps = new List<string>();
                    foreach (var c in rt.GetComponents<Component>()) if (!(c is Transform)) comps.Add(c.GetType().Name);
                    rows.Add(new Row { path = string.Join("/", names), name = rt.name, x = x, y = y, w = w, h = h, active = rt.gameObject.activeSelf, components = string.Join(",", comps) });
                }
                File.WriteAllText(outPath, JsonConvert.SerializeObject(rows, Formatting.Indented));
                Debug.Log("[UIForgeVerify] wrote " + rows.Count + " rows to " + outPath);
                EditorApplication.Exit(0);
            }
            catch (Exception e)
            {
                Debug.LogError("[UIForgeVerify] failed: " + e);
                File.WriteAllText(outPath + ".error.txt", e.ToString());
                EditorApplication.Exit(1);
            }
        }
    }
}
#endif

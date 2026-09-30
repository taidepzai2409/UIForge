// UIForge → Unity uGUI importer (Editor script).
// Put this file in Assets/Editor/UIForge/ of your Unity project, and the runtime scripts
// (UIForgeNodeRef.cs, UIForgeSafeArea.cs) in Assets/UIForge/.
// Requires: com.unity.ugui, com.unity.nuget.newtonsoft-json (Window > Package Manager > add by name).
// Menu: UIForge > Import Layout JSON...
//
// Reads a frame layout file produced by "Export Layout" (see docs/LAYOUT_SPEC.md):
//  - sprites from the page sprite atlas (export/atlas/<page>_<n>.png, names screen_element_state)
//    or, when no atlas / "Use Sprite Atlas" is off, one PNG per asset
//  - exact RectTransform values (anchors / pivot / anchoredPosition / sizeDelta)
//  - auto layout  → HorizontalLayoutGroup / VerticalLayoutGroup (+ ContentSizeFitter when hug)
//  - safeArea     → nodes are parented under a "SafeArea" RectTransform with UIForgeSafeArea
//  - components   → prefabs in Assets/UIForgeUI/<project>/Prefabs/<name>.prefab, instances → prefab instances
//  - every node gets UIForgeNodeRef(nodeId) so UIForgeSync can push edits back to the design tool
//  - component states (normal/hover/pressed/disabled/selected layers) → Button SpriteSwap
//  - UIForge > Import Page: all frames of a page + flows JSON + UIForgeFlowRunner (clickable prototype in Play mode)
//  - text          → TextMeshProUGUI with a TMP_FontAsset built from export/fonts (UIForgeTmp.cs); legacy Text when TMP is absent

#if UNITY_EDITOR
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;

namespace UIForge
{
    public static class UIForgeLayoutImporter
    {
        const string PrefUseAtlas = "UIForge.UseAtlas";
        /// Stretch the frame root to the whole canvas (anchors 0..1) so nodes anchored to the frame's edges follow the
        /// real screen on every aspect ratio — this is what the design tool's device preview simulates.
        /// Set false to keep the root at the reference size (pixel verification at reference resolution).
        public static bool StretchRoot = true;
        const string PrefUseTmp = "UIForge.UseTMP";
        /// Use TextMeshProUGUI (+ generated TMP_FontAsset from export/fonts) when the package is present.
        public static bool UseTMP
        {
            get => EditorPrefs.GetBool(PrefUseTmp, true) && UIForgeTmp.Available;
            set => EditorPrefs.SetBool(PrefUseTmp, value);
        }

        [MenuItem("UIForge/Use TextMeshPro (toggle)")]
        public static void ToggleTmp()
        {
            UseTMP = !EditorPrefs.GetBool(PrefUseTmp, true);
            Debug.Log("[UIForge] Use TMP = " + EditorPrefs.GetBool(PrefUseTmp, true) + (UIForgeTmp.Available ? "" : " (package TextMeshPro chưa cài → dùng Text legacy)"));
        }
        public static bool UseAtlas
        {
            get => EditorPrefs.GetBool(PrefUseAtlas, true);
            set => EditorPrefs.SetBool(PrefUseAtlas, value);
        }

        [MenuItem("UIForge/Import Layout JSON...")]
        public static void ImportMenu()
        {
            string path = EditorUtility.OpenFilePanel("Chọn file layout (<frame>_<id>.json)", "", "json");
            if (string.IsNullOrEmpty(path)) return;
            Import(path);
        }

        [MenuItem("UIForge/Import Page (all frames + flows)...")]
        public static void ImportPageMenu()
        {
            string path = EditorUtility.OpenFilePanel("Chọn manifest.json của page", "", "json");
            if (string.IsNullOrEmpty(path)) return;
            ImportPage(path);
        }

        /// Imports every frame of a page (export/<page>/manifest.json), copies the flows JSON next to the
        /// sprites and adds a UIForgeFlowRunner to the Canvas so the prototype is clickable in Play mode.
        public static GameObject ImportPage(string manifestPath)
        {
            JObject man = JObject.Parse(File.ReadAllText(manifestPath));
            if (!SchemaIs(man, "manifest")) { Debug.LogError("Không phải manifest.json: " + manifestPath); return null; }
            string dir = Path.GetDirectoryName(manifestPath);
            GameObject first = null;
            foreach (JObject f in man["frames"])
            {
                var go = Import(Path.Combine(dir, (string)f["file"]));
                if (first == null) first = go;
            }
            if (first == null) return null;
            var canvas = first.GetComponentInParent<Canvas>();
            string project = Sanitize((string)man["project"]);
            string assetFolder = "Assets/UIForgeUI/" + project;
            string flowsAsset = (assetFolder + "/" + Sanitize((string)man["page"]) + "_flows.json").Replace('\\', '/');
            File.Copy(manifestPath, flowsAsset, true);
            AssetDatabase.ImportAsset(flowsAsset, ImportAssetOptions.ForceUpdate);
            var runner = canvas.GetComponent<UIForgeFlowRunner>() ?? canvas.gameObject.AddComponent<UIForgeFlowRunner>();
            runner.flows = AssetDatabase.LoadAssetAtPath<TextAsset>(flowsAsset);
            Debug.Log($"[UIForge] Imported page '{man["page"]}': {((JArray)man["frames"]).Count} frames, {((JArray)man["flows"]).Count} flows → UIForgeFlowRunner (Play để bấm thử)");
            return canvas.gameObject;
        }

        [MenuItem("UIForge/Use Sprite Atlas (toggle)")]
        public static void ToggleAtlas()
        {
            UseAtlas = !UseAtlas;
            Debug.Log("[UIForge] Use sprite atlas = " + UseAtlas);
        }

        // Exports made before the rename use the "dmobin-" prefix; both are accepted.
        static bool SchemaIs(JObject o, string kind)
        {
            string s = (string)o["schema"];
            return s == "uiforge-" + kind || s == "dmobin-" + kind;
        }

        public static GameObject Import(string layoutJsonPath)
        {
            JObject root = JObject.Parse(File.ReadAllText(layoutJsonPath));
            if (!SchemaIs(root, "layout"))
            {
                Debug.LogError("Không phải file uiforge-layout: " + layoutJsonPath);
                return null;
            }

            string exportDir = FindExportRoot(layoutJsonPath);
            string project = Sanitize((string)root["project"]);
            string assetFolder = "Assets/UIForgeUI/" + project;
            Directory.CreateDirectory(assetFolder);
            var nodes = (JArray)root["nodes"];

            // 1. sprites
            var sprites = new Dictionary<string, Sprite>();
            var borders = new Dictionary<string, Vector4>(); // assetId -> border (L,B,R,T) Unity order
            foreach (JObject n in nodes)
            {
                JObject img = n["image"] as JObject;
                if (img == null) continue;
                string assetId = (string)img["assetId"];
                JObject ns = img["nineSlice"] as JObject;
                if (ns != null && !borders.ContainsKey(assetId))
                    borders[assetId] = new Vector4((float)ns["left"], (float)ns["bottom"], (float)ns["right"], (float)ns["top"]);
            }
            bool atlasOk = UseAtlas && root["atlas"] is JObject atlas && ImportAtlas(exportDir, assetFolder, nodes, atlas, borders, sprites);
            if (!atlasOk) ImportSinglePngs(exportDir, assetFolder, (JObject)root["assets"], borders, sprites);

            // 2. canvas + frame root
            JObject frame = (JObject)root["frame"];
            float fw = (float)frame["width"], fh = (float)frame["height"];
            Canvas canvas = Object.FindObjectOfType<Canvas>();
            if (canvas == null)
            {
                var cgo = new GameObject("Canvas", typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
                canvas = cgo.GetComponent<Canvas>();
                canvas.renderMode = RenderMode.ScreenSpaceOverlay;
                var scaler = cgo.GetComponent<CanvasScaler>();
                scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
                scaler.referenceResolution = new Vector2(fw, fh);
                JObject sc = root["scaler"] as JObject;
                string mode = sc != null ? (string)sc["mode"] : "expand";
                if (mode == "expand") scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.Expand;
                else if (mode == "shrink") scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.Shrink;
                else
                {
                    scaler.screenMatchMode = CanvasScaler.ScreenMatchMode.MatchWidthOrHeight;
                    scaler.matchWidthOrHeight = sc != null && sc["match"] != null ? (float)sc["match"] : (fw > fh ? 1f : 0f);
                }
            }

            string frameName = (string)frame["name"];
            var frameGo = new GameObject(frameName, typeof(RectTransform));
            var frameRt = frameGo.GetComponent<RectTransform>();
            frameRt.SetParent(canvas.transform, false);
            frameRt.pivot = new Vector2(0.5f, 0.5f);
            if (StretchRoot)
            {
                frameRt.anchorMin = Vector2.zero;
                frameRt.anchorMax = Vector2.one;
                frameRt.offsetMin = frameRt.offsetMax = Vector2.zero;
            }
            else
            {
                frameRt.anchorMin = frameRt.anchorMax = new Vector2(0.5f, 0.5f);
                frameRt.sizeDelta = new Vector2(fw, fh);
                frameRt.anchoredPosition = Vector2.zero;
            }
            var frameRef = frameGo.AddComponent<UIForgeNodeRef>();
            frameRef.nodeId = (string)frame["id"];
            frameRef.framePath = frameName;
            JObject fill = frame["fill"] as JObject;
            if (fill != null)
            {
                var bg = frameGo.AddComponent<Image>();
                bg.color = ParseColor((string)fill["color"], (float)fill["alpha"]);
                bg.raycastTarget = false;
            }

            // safe area wrapper (created on demand, stretched to the frame; UIForgeSafeArea shrinks it on device)
            RectTransform safeRt = null;
            RectTransform SafeRoot()
            {
                if (safeRt != null) return safeRt;
                var sgo = new GameObject("SafeArea", typeof(RectTransform));
                safeRt = sgo.GetComponent<RectTransform>();
                safeRt.SetParent(frameRt, false);
                safeRt.anchorMin = Vector2.zero;
                safeRt.anchorMax = Vector2.one;
                safeRt.offsetMin = safeRt.offsetMax = Vector2.zero;
                sgo.AddComponent<UIForgeSafeArea>();
                return safeRt;
            }

            // 3. nodes (array order = parents before children, siblings bottom→top)
            var byId = new Dictionary<string, RectTransform>();
            var hasLayoutGroup = new HashSet<string>();
            foreach (JObject n in nodes)
            {
                string id = (string)n["id"];
                string type = (string)n["type"];
                var go = new GameObject((string)n["name"], typeof(RectTransform));
                var rt = go.GetComponent<RectTransform>();
                string parentId = (string)n["parentId"];
                RectTransform parent = parentId != null && byId.TryGetValue(parentId, out var p) ? p : frameRt;
                if (parentId == null && (bool?)n["safeArea"] == true) parent = SafeRoot();
                rt.SetParent(parent, false);

                JObject u = (JObject)n["unity"];
                if (parentId != null && hasLayoutGroup.Contains(parentId))
                {
                    // children of a layout group: plain top-left anchored rects so the group can read their size
                    JObject loc = (JObject)n["local"];
                    rt.anchorMin = rt.anchorMax = new Vector2(0, 1);
                    rt.pivot = new Vector2(0, 1);
                    rt.sizeDelta = new Vector2((float)loc["width"], (float)loc["height"]);
                    rt.anchoredPosition = new Vector2((float)loc["x"], -(float)loc["y"]);
                }
                else
                {
                    rt.anchorMin = V2(u["anchorMin"]);
                    rt.anchorMax = V2(u["anchorMax"]);
                    rt.pivot = V2(u["pivot"]);
                    rt.anchoredPosition = V2(u["anchoredPosition"]);
                    rt.sizeDelta = V2(u["sizeDelta"]);
                }
                rt.localRotation = Quaternion.Euler(0, 0, (float)u["rotationZ"]);

                var nref = go.AddComponent<UIForgeNodeRef>();
                nref.nodeId = id;
                nref.framePath = frameName + "/" + (string)n["path"];

                float opacity = (float)n["opacity"];
                if (opacity < 0.999f)
                {
                    var cg = go.AddComponent<CanvasGroup>();
                    cg.alpha = opacity;
                }

                switch (type)
                {
                    case "image":
                    case "nineslice":
                    {
                        var img = go.AddComponent<Image>();
                        string assetId = (string)n["image"]["assetId"];
                        if (sprites.TryGetValue(assetId, out var sp)) img.sprite = sp;
                        img.type = type == "nineslice" ? Image.Type.Sliced : Image.Type.Simple;
                        img.raycastTarget = false;
                        break;
                    }
                    case "rect":
                    {
                        JObject f = n["fill"] as JObject;
                        var img = go.AddComponent<Image>();
                        img.color = f != null ? ParseColor((string)f["color"], (float)f["alpha"]) : new Color(0, 0, 0, 0);
                        img.raycastTarget = false;
                        break;
                    }
                    case "text":
                    {
                        JObject t = (JObject)n["text"];
                        if (UseTMP && UIForgeTmp.AddText(go, t, exportDir, assetFolder)) break; // TextMeshPro (font từ export/fonts)
                        var txt = go.AddComponent<Text>();
                        txt.text = (string)t["text"];
                        txt.fontSize = Mathf.RoundToInt((float)t["fontSize"]);
                        txt.color = ParseColor((string)t["color"], 1f);
                        txt.alignment = ((string)t["align"]) == "center" ? TextAnchor.MiddleCenter
                            : ((string)t["align"]) == "right" ? TextAnchor.MiddleRight : TextAnchor.MiddleLeft;
                        txt.horizontalOverflow = HorizontalWrapMode.Overflow;
                        txt.verticalOverflow = VerticalWrapMode.Overflow;
                        txt.raycastTarget = false;
                        JObject fx = t["effects"] as JObject;
                        if (fx != null)
                        {
                            JObject st = fx["stroke"] as JObject;
                            if (st != null)
                            {
                                var o = go.AddComponent<Outline>();
                                o.effectColor = ParseColorObj(st["color"]);
                                float sw = (float)st["width"];
                                o.effectDistance = new Vector2(sw, -sw);
                            }
                            JObject sh = fx["shadow"] as JObject;
                            if (sh != null)
                            {
                                var s2 = go.AddComponent<Shadow>();
                                s2.effectColor = ParseColorObj(sh["color"]);
                                float ang = (float)sh["angle"] * Mathf.Deg2Rad, dist = (float)sh["distance"];
                                s2.effectDistance = new Vector2(-Mathf.Cos(ang) * dist, -Mathf.Sin(ang) * dist);
                            }
                            // gradient / glow / colorOverlay: use TextMeshPro (vertex gradient, glow) for full fidelity
                        }
                        break;
                    }
                    case "frame":
                    {
                        JObject f = n["fill"] as JObject;
                        if (f != null)
                        {
                            var img = go.AddComponent<Image>();
                            img.color = ParseColor((string)f["color"], (float)f["alpha"]);
                            img.raycastTarget = false;
                        }
                        if ((bool?)n["clipsContent"] == true) go.AddComponent<RectMask2D>();
                        break;
                    }
                    // "group" / "instance": plain RectTransform containers
                }

                // auto layout → LayoutGroup
                JObject lay = n["layout"] as JObject;
                if (lay != null)
                {
                    bool horiz = (string)lay["direction"] == "horizontal";
                    HorizontalOrVerticalLayoutGroup lg = horiz ? go.AddComponent<HorizontalLayoutGroup>() : go.AddComponent<VerticalLayoutGroup>();
                    lg.spacing = (float)lay["gap"];
                    JObject pad = lay["padding"] as JObject;
                    bool isGroup = type == "group";
                    lg.padding = pad != null && !isGroup
                        ? new RectOffset(Mathf.RoundToInt((float)pad["left"]), Mathf.RoundToInt((float)pad["right"]), Mathf.RoundToInt((float)pad["top"]), Mathf.RoundToInt((float)pad["bottom"]))
                        : new RectOffset(0, 0, 0, 0);
                    string al = (string)lay["align"] ?? "start";
                    lg.childAlignment = horiz
                        ? (al == "center" ? TextAnchor.MiddleLeft : al == "end" ? TextAnchor.LowerLeft : TextAnchor.UpperLeft)
                        : (al == "center" ? TextAnchor.UpperCenter : al == "end" ? TextAnchor.UpperRight : TextAnchor.UpperLeft);
                    lg.childControlWidth = lg.childControlHeight = false;
                    lg.childForceExpandWidth = lg.childForceExpandHeight = false;
                    lg.childScaleWidth = lg.childScaleHeight = false;
                    if (isGroup || (bool?)lay["hug"] == true)
                    {
                        var fit = go.AddComponent<ContentSizeFitter>();
                        fit.horizontalFit = fit.verticalFit = ContentSizeFitter.FitMode.PreferredSize;
                    }
                    hasLayoutGroup.Add(id);
                }

                if ((bool)n["visible"] == false) go.SetActive(false);
                byId[id] = rt;
            }

            // 3b. component states (normal/hover/pressed/disabled) → Button with SpriteSwap
            foreach (JObject n in nodes)
            {
                JObject states = (n["component"] as JObject)?["states"] as JObject ?? (n["instance"] as JObject)?["states"] as JObject;
                if (states == null || !byId.TryGetValue((string)n["id"], out var rootRt)) continue;
                Sprite SpriteOf(string stateId)
                {
                    if (stateId == null || !byId.TryGetValue(stateId, out var st)) return null;
                    var img = st.GetComponentInChildren<Image>(true);
                    return img != null ? img.sprite : null;
                }
                var normalSprite = SpriteOf((string)states["normal"]);
                var btn = rootRt.GetComponent<Button>() ?? rootRt.gameObject.AddComponent<Button>();
                // target graphic = the normal state's image (or an invisible raycast image on the root)
                Image target = null;
                if (states["normal"] != null && byId.TryGetValue((string)states["normal"], out var nrt)) target = nrt.GetComponentInChildren<Image>(true);
                if (target == null) { target = rootRt.GetComponent<Image>() ?? rootRt.gameObject.AddComponent<Image>(); target.color = new Color(1, 1, 1, 0); }
                target.raycastTarget = true;
                btn.targetGraphic = target;
                if (normalSprite != null)
                {
                    btn.transition = Selectable.Transition.SpriteSwap;
                    var ss = btn.spriteState;
                    ss.highlightedSprite = SpriteOf((string)states["hover"]) ?? normalSprite;
                    ss.pressedSprite = SpriteOf((string)states["pressed"]) ?? normalSprite;
                    ss.selectedSprite = SpriteOf((string)states["selected"]) ?? normalSprite;
                    ss.disabledSprite = SpriteOf((string)states["disabled"]) ?? normalSprite;
                    btn.spriteState = ss;
                }
                // non-normal state layers stay hidden; only their sprites are used
                foreach (var kv in states)
                    if (kv.Key != "normal" && byId.TryGetValue((string)kv.Value, out var srt)) srt.gameObject.SetActive(false);
            }

            // 4. flows → add Button on hotspots (UIForgeFlowRunner wires them at runtime; see ImportPage)
            foreach (JObject fl in root["flows"])
            {
                if (byId.TryGetValue((string)fl["from"], out var hot))
                {
                    var g = hot.GetComponent<Graphic>();
                    if (g == null) g = hot.gameObject.AddComponent<Image>();
                    g.raycastTarget = true;
                    if (hot.GetComponent<Button>() == null) hot.gameObject.AddComponent<Button>();
                    Debug.Log($"[UIForge] Flow: {fl["fromPath"]} → {fl["toFrame"]} ({fl["trigger"]}, {fl["transition"]})");
                }
            }

            // 5. components → prefabs, instances → prefab instances (+ overrides)
            string prefabDir = assetFolder + "/Prefabs";
            Directory.CreateDirectory(prefabDir);
            var prefabs = new Dictionary<string, GameObject>();
            foreach (JObject n in nodes)
            {
                JObject comp = n["component"] as JObject;
                if (comp == null) continue;
                string id = (string)n["id"];
                if (!byId.TryGetValue(id, out var mrt)) continue;
                string path = prefabDir + "/" + Sanitize((string)comp["name"]) + ".prefab";
                var prefab = PrefabUtility.SaveAsPrefabAssetAndConnect(mrt.gameObject, path, InteractionMode.AutomatedAction);
                prefabs[id] = prefab;
                Debug.Log("[UIForge] Prefab: " + path);
            }
            foreach (JObject n in nodes)
            {
                JObject inst = n["instance"] as JObject;
                if (inst == null) continue;
                string id = (string)n["id"];
                string cid = (string)inst["componentId"];
                if (!prefabs.TryGetValue(cid, out var prefab))
                {
                    string path = prefabDir + "/" + Sanitize((string)inst["componentName"]) + ".prefab";
                    prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                }
                if (prefab == null || !byId.TryGetValue(id, out var oldRt)) continue; // master not exported: keep the plain copy
                var igo = (GameObject)PrefabUtility.InstantiatePrefab(prefab, oldRt.parent);
                var irt = igo.GetComponent<RectTransform>();
                igo.name = oldRt.name;
                igo.transform.SetSiblingIndex(oldRt.GetSiblingIndex());
                irt.anchorMin = oldRt.anchorMin; irt.anchorMax = oldRt.anchorMax; irt.pivot = oldRt.pivot;
                irt.anchoredPosition = oldRt.anchoredPosition; irt.sizeDelta = oldRt.sizeDelta; irt.localRotation = oldRt.localRotation;
                igo.SetActive(oldRt.gameObject.activeSelf);
                var iref = igo.GetComponent<UIForgeNodeRef>();
                if (iref != null) iref.nodeId = id;
                // map master child ids → instance child ids, apply text / visibility overrides
                var refs = igo.GetComponentsInChildren<UIForgeNodeRef>(true).Where(r => r.gameObject != igo).ToDictionary(r => r.nodeId, r => r);
                foreach (JObject cn in nodes)
                {
                    JObject meta = cn["meta"] as JObject;
                    if (meta == null || (string)meta["fromInstance"] != id) continue;
                    string masterChild = (string)meta["instanceOf"];
                    if (masterChild == null || !refs.TryGetValue(masterChild, out var r)) continue;
                    r.nodeId = (string)cn["id"];
                    r.gameObject.SetActive((bool)cn["visible"]);
                    JObject t = cn["text"] as JObject;
                    var txt = r.GetComponent<Text>();
                    if (t != null && txt != null) txt.text = (string)t["text"];
                }
                Object.DestroyImmediate(oldRt.gameObject);
                byId[id] = irt;
            }

            Undo.RegisterCreatedObjectUndo(frameGo, "Import UIForge layout");
            Selection.activeGameObject = frameGo;
            Debug.Log($"[UIForge] Imported frame '{frameName}' with {nodes.Count} nodes" + (atlasOk ? " (atlas)" : "") + (prefabs.Count > 0 ? $", {prefabs.Count} prefabs" : "") + ".");
            return frameGo;
        }

        /// Imports export/atlas/<page>_<n>.png as Multiple-mode sprite sheets; fills sprites[assetId].
        static bool ImportAtlas(string exportDir, string assetFolder, JArray nodes, JObject atlas, Dictionary<string, Vector4> borders, Dictionary<string, Sprite> sprites)
        {
            var sheets = atlas["sheets"] as JArray;
            if (sheets == null || sheets.Count == 0) return false;
            // sprite metadata per sheet from the nodes' image.atlas entries
            var perSheet = new Dictionary<int, Dictionary<string, (string assetId, Rect rect)>>();
            foreach (JObject n in nodes)
            {
                JObject img = n["image"] as JObject;
                JObject a = img?["atlas"] as JObject;
                if (a == null) continue;
                int sheet = (int)a["sheet"];
                if (!perSheet.TryGetValue(sheet, out var dict)) perSheet[sheet] = dict = new Dictionary<string, (string, Rect)>();
                string name = (string)a["name"];
                if (!dict.ContainsKey(name)) dict[name] = ((string)img["assetId"], new Rect((float)a["x"], (float)a["y"], (float)a["width"], (float)a["height"]));
            }
            string atlasFolder = assetFolder + "/Atlas";
            Directory.CreateDirectory(atlasFolder);
            foreach (JObject sh in sheets)
            {
                int index = (int)sh["index"];
                string rel = (string)sh["file"];
                float sheetH = (float)sh["height"];
                string src = Path.Combine(exportDir, rel.Replace('/', Path.DirectorySeparatorChar));
                if (!File.Exists(src)) { Debug.LogWarning("[UIForge] Thiếu atlas: " + src + " — dùng PNG lẻ"); return false; }
                string dst = (atlasFolder + "/" + Path.GetFileName(rel)).Replace('\\', '/');
                File.Copy(src, dst, true);
                AssetDatabase.ImportAsset(dst, ImportAssetOptions.ForceUpdate);
                var ti = AssetImporter.GetAtPath(dst) as TextureImporter;
                if (ti == null) return false;
                ti.textureType = TextureImporterType.Sprite;
                ti.spriteImportMode = SpriteImportMode.Multiple;
                ti.mipmapEnabled = false;
                ti.alphaIsTransparency = true;
                ti.maxTextureSize = 4096;
                var metas = new List<SpriteMetaData>();
                if (perSheet.TryGetValue(index, out var dict))
                {
                    foreach (var kv in dict)
                    {
                        var r = kv.Value.rect;
                        var m = new SpriteMetaData
                        {
                            name = kv.Key,
                            rect = new Rect(r.x, sheetH - r.y - r.height, r.width, r.height), // Unity: bottom-left origin
                            alignment = (int)SpriteAlignment.Center,
                            pivot = new Vector2(0.5f, 0.5f)
                        };
                        if (borders.TryGetValue(kv.Value.assetId, out var b)) m.border = b;
                        metas.Add(m);
                    }
                }
#pragma warning disable CS0618
                ti.spritesheet = metas.ToArray();
#pragma warning restore CS0618
                ti.SaveAndReimport();
                var byName = AssetDatabase.LoadAllAssetsAtPath(dst).OfType<Sprite>().ToDictionary(s => s.name, s => s);
                if (dict != null)
                    foreach (var kv in dict)
                        if (byName.TryGetValue(kv.Key, out var sp)) sprites[kv.Value.assetId] = sp;
            }
            return sprites.Count > 0;
        }

        static void ImportSinglePngs(string exportDir, string assetFolder, JObject assets, Dictionary<string, Vector4> borders, Dictionary<string, Sprite> sprites)
        {
            foreach (var kv in assets)
            {
                string assetId = kv.Key;
                string rel = (string)kv.Value["file"]; // "assets/xxx.png"
                string src = Path.Combine(exportDir, rel.Replace('/', Path.DirectorySeparatorChar));
                string dst = Path.Combine(assetFolder, Path.GetFileName(rel)).Replace('\\', '/');
                if (!File.Exists(src)) { Debug.LogWarning("Thiếu ảnh: " + src); continue; }
                File.Copy(src, dst, true);
                AssetDatabase.ImportAsset(dst, ImportAssetOptions.ForceUpdate);
                var ti = AssetImporter.GetAtPath(dst) as TextureImporter;
                if (ti != null)
                {
                    ti.textureType = TextureImporterType.Sprite;
                    ti.spriteImportMode = SpriteImportMode.Single;
                    ti.mipmapEnabled = false;
                    ti.alphaIsTransparency = true;
                    if (borders.TryGetValue(assetId, out var b)) ti.spriteBorder = b;
                    ti.SaveAndReimport();
                }
                sprites[assetId] = AssetDatabase.LoadAssetAtPath<Sprite>(dst);
            }
        }

        static string FindExportRoot(string layoutPath)
        {
            // layout lives in export/<page>/<frame>.json → export root is two levels up
            var dir = Path.GetDirectoryName(layoutPath);
            var parent = Path.GetDirectoryName(dir);
            if (parent != null && Directory.Exists(Path.Combine(parent, "assets"))) return parent;
            if (Directory.Exists(Path.Combine(dir, "assets"))) return dir;
            return parent ?? dir;
        }

        static Vector2 V2(JToken t) => new Vector2((float)t[0], (float)t[1]);

        static Color ParseColorObj(JToken c)
        {
            if (c == null) return Color.black;
            return new Color((float)c["r"] / 255f, (float)c["g"] / 255f, (float)c["b"] / 255f, c["a"] != null ? (float)c["a"] : 1f);
        }

        static Color ParseColor(string hex, float alpha)
        {
            if (ColorUtility.TryParseHtmlString(hex, out var c)) { c.a = alpha; return c; }
            return new Color(1, 1, 1, alpha);
        }

        static string Sanitize(string s)
        {
            foreach (char ch in Path.GetInvalidFileNameChars()) s = s.Replace(ch, '_');
            return s;
        }
    }
}
#endif

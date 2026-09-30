// TextMeshPro support for the UIForge importer, through reflection so this file compiles with or
// without the com.unity.textmeshpro package (Unity 2022) / uGUI 2.x (Unity 2023+).
// Fonts exported by UIForge (export/fonts/*.ttf|otf) become TMP_FontAsset files in
// Assets/UIForgeUI/<project>/Fonts/. Layer styles map to the TMP material: stroke → outline,
// shadow → underlay, glow → glow, gradient → vertex gradient, colorOverlay → color.
#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace UIForge
{
    public static class UIForgeTmp
    {
        static Type _tmpText, _fontAsset;
        static bool _probed;

        public static bool Available
        {
            get
            {
                if (!_probed)
                {
                    _probed = true;
                    _tmpText = FindType("TMPro.TextMeshProUGUI");
                    _fontAsset = FindType("TMPro.TMP_FontAsset");
                }
                return _tmpText != null && _fontAsset != null;
            }
        }

        static Type FindType(string full)
        {
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                var t = asm.GetType(full);
                if (t != null) return t;
            }
            return null;
        }

        static readonly Dictionary<string, UnityEngine.Object> fontCache = new Dictionary<string, UnityEngine.Object>();
        static bool _essentialsTried;

        /// TMP needs its "Essential Resources" (shaders, TMP Settings) in Assets/TextMesh Pro. Imports them once if missing.
        public static bool EnsureEssentials()
        {
            if (Shader.Find("TextMeshPro/Distance Field") != null) return true;
            if (_essentialsTried) return false;
            _essentialsTried = true;
            try
            {
                var importer = FindType("TMPro.TMP_PackageResourceImporter") ?? FindType("TMPro.EditorUtilities.TMP_PackageResourceImporter");
                var m = importer?.GetMethod("ImportResources", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(bool), typeof(bool), typeof(bool) }, null);
                if (m != null) m.Invoke(null, new object[] { true, false, false });
                else
                {
                    string pkg = Path.GetFullPath("Packages/com.unity.textmeshpro/Package Resources/TMP Essential Resources.unitypackage");
                    if (File.Exists(pkg)) AssetDatabase.ImportPackage(pkg, false);
                }
                AssetDatabase.Refresh();
            }
            catch (Exception e) { Debug.LogWarning("[UIForge] Không import được TMP Essential Resources: " + e.Message); }
            return Shader.Find("TextMeshPro/Distance Field") != null;
        }

        [MenuItem("UIForge/Import TMP Essential Resources")]
        public static void ImportEssentialsMenu()
        {
            _essentialsTried = false;
            Debug.Log("[UIForge] TMP essentials " + (EnsureEssentials() ? "OK" : "chưa có (chạy lại sau khi import xong)"));
        }

        /// Batch: Unity.exe -batchmode -executeMethod UIForge.UIForgeTmp.ImportEssentialsBatch (no -quit; exits itself)
        public static void ImportEssentialsBatch()
        {
            if (Shader.Find("TextMeshPro/Distance Field") != null) { Debug.Log("[UIForge] TMP essentials already present"); EditorApplication.Exit(0); return; }
            double started = EditorApplication.timeSinceStartup;
            AssetDatabase.importPackageCompleted += _ => { AssetDatabase.SaveAssets(); Debug.Log("[UIForge] TMP essentials imported"); EditorApplication.Exit(0); };
            AssetDatabase.importPackageFailed += (_, msg) => { Debug.LogError("[UIForge] TMP essentials import failed: " + msg); EditorApplication.Exit(2); };
            EditorApplication.update += () => { if (EditorApplication.timeSinceStartup - started > 120) { Debug.LogError("[UIForge] TMP essentials import timeout"); EditorApplication.Exit(3); } };
            _essentialsTried = false;
            EnsureEssentials();
        }

        static bool HasDefaultFont()
        {
            var settings = FindType("TMPro.TMP_Settings");
            var p = settings?.GetProperty("defaultFontAsset", BindingFlags.Public | BindingFlags.Static);
            try { return p != null && p.GetValue(null) as UnityEngine.Object != null; } catch { return false; }
        }

        /// Imports export/fonts/<file> and creates (or reuses) a TMP_FontAsset for it.
        public static UnityEngine.Object GetFontAsset(string exportDir, string fontFile, string assetFolder)
        {
            if (!Available || string.IsNullOrEmpty(fontFile)) return null;
            if (fontCache.TryGetValue(fontFile, out var cached) && cached != null) return cached;
            if (!EnsureEssentials()) { Debug.LogWarning("[UIForge] Thiếu TMP Essential Resources (Window > TextMeshPro > Import TMP Essential Resources)"); return null; }
            string src = Path.Combine(exportDir, fontFile.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(src)) { Debug.LogWarning("[UIForge] Thiếu font: " + src); return null; }
            string fontsDir = assetFolder + "/Fonts";
            Directory.CreateDirectory(fontsDir);
            string dstFont = (fontsDir + "/" + Path.GetFileName(fontFile)).Replace('\\', '/');
            string dstAsset = Path.ChangeExtension(dstFont, null) + " SDF.asset";
            var existing = AssetDatabase.LoadAssetAtPath(dstAsset, _fontAsset);
            if (existing != null) { fontCache[fontFile] = existing; return existing; }
            File.Copy(src, dstFont, true);
            AssetDatabase.ImportAsset(dstFont, ImportAssetOptions.ForceUpdate);
            var font = AssetDatabase.LoadAssetAtPath<Font>(dstFont);
            if (font == null) { Debug.LogWarning("[UIForge] Không import được font: " + dstFont); return null; }
            // TMP_FontAsset.CreateFontAsset(Font) (static) — 3.x and 4.x
            var create = _fontAsset.GetMethod("CreateFontAsset", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(Font) }, null);
            if (create == null) { Debug.LogWarning("[UIForge] TMP_FontAsset.CreateFontAsset không có"); return null; }
            UnityEngine.Object fa = null;
            try { fa = create.Invoke(null, new object[] { font }) as UnityEngine.Object; }
            catch (Exception e) { Debug.LogWarning("[UIForge] CreateFontAsset lỗi: " + (e.InnerException ?? e).Message); }
            if (fa == null) return null;
            fa.name = Path.GetFileNameWithoutExtension(dstFont) + " SDF";
            AssetDatabase.CreateAsset(fa, dstAsset);
            var mat = _fontAsset.GetProperty("material")?.GetValue(fa) as Material;
            var atlas = _fontAsset.GetProperty("atlasTexture")?.GetValue(fa) as Texture2D;
            if (mat != null) { mat.name = fa.name + " Material"; AssetDatabase.AddObjectToAsset(mat, fa); }
            if (atlas != null) { atlas.name = fa.name + " Atlas"; AssetDatabase.AddObjectToAsset(atlas, fa); }
            AssetDatabase.SaveAssets();
            fontCache[fontFile] = fa;
            return fa;
        }

        /// Adds a TextMeshProUGUI configured from the layout's text block. Returns false when TMP is missing.
        public static bool AddText(GameObject go, JObject t, string exportDir, string assetFolder)
        {
            if (!Available) return false;
            var fa0 = GetFontAsset(exportDir, (string)t["fontFile"], assetFolder);
            if (fa0 == null && !HasDefaultFont()) return false; // no usable TMP font → legacy Text
            var tmp = go.AddComponent(_tmpText);
            Set(tmp, "text", (string)t["text"]);
            Set(tmp, "fontSize", (float)t["fontSize"]);
            Set(tmp, "color", ParseColor((string)t["color"], 1f));
            Set(tmp, "enableWordWrapping", false);
            Set(tmp, "richText", false);
            Set(tmp, "raycastTarget", false);
            // overflow: keep glyphs visible outside the rect like the design tool
            SetEnum(tmp, "overflowMode", "TMPro.TextOverflowModes", "Overflow");
            string align = (string)t["align"] ?? "left";
            SetEnum(tmp, "alignment", "TMPro.TextAlignmentOptions", align == "center" ? "Center" : align == "right" ? "Right" : "Left");
            float ls = t["letterSpacing"] != null ? (float)t["letterSpacing"] : 0f;
            float fs = (float)t["fontSize"];
            if (ls != 0 && fs > 0) Set(tmp, "characterSpacing", ls / fs * 100f); // TMP: % of font size
            float lh = t["lineHeight"] != null ? (float)t["lineHeight"] : 1.2f;
            if (Math.Abs(lh - 1.2f) > 0.01f) Set(tmp, "lineSpacing", (lh - 1.2f) * fs * 0.8f);
            int style = 0;
            int weight = t["fontWeight"] != null ? (int)t["fontWeight"] : 400;
            if (weight >= 600) style |= 1;           // Bold
            if ((bool?)t["italic"] == true) style |= 2; // Italic
            if ((bool?)t["uppercase"] == true) style |= 16; // UpperCase
            var fsType = FindType("TMPro.FontStyles");
            if (fsType != null) _tmpText.GetProperty("fontStyle")?.SetValue(tmp, Enum.ToObject(fsType, style));
            if (fa0 != null) Set(tmp, "font", fa0);

            JObject fx = t["effects"] as JObject;
            if (fx != null)
            {
                var mat = _tmpText.GetProperty("fontMaterial")?.GetValue(tmp) as Material; // instance
                if (mat != null)
                {
                    JObject st = fx["stroke"] as JObject;
                    if (st != null)
                    {
                        float w = (float)st["width"];
                        mat.EnableKeyword("OUTLINE_ON");
                        mat.SetColor("_OutlineColor", ParseColorObj(st["color"]));
                        mat.SetFloat("_OutlineWidth", Mathf.Clamp01(w / Mathf.Max(1f, fs) * 2.2f)); // ≈ px → SDF units
                    }
                    JObject sh = fx["shadow"] as JObject;
                    if (sh != null)
                    {
                        mat.EnableKeyword("UNDERLAY_ON");
                        mat.SetColor("_UnderlayColor", ParseColorObj(sh["color"]));
                        float ang = (float)sh["angle"] * Mathf.Deg2Rad, dist = (float)sh["distance"];
                        mat.SetFloat("_UnderlayOffsetX", Mathf.Clamp(-Mathf.Cos(ang) * dist / fs * 2f, -1f, 1f));
                        mat.SetFloat("_UnderlayOffsetY", Mathf.Clamp(-Mathf.Sin(ang) * dist / fs * 2f, -1f, 1f));
                        float blur = sh["blur"] != null ? (float)sh["blur"] : 0f;
                        mat.SetFloat("_UnderlaySoftness", Mathf.Clamp01(blur / fs));
                    }
                    JObject gl = fx["glow"] as JObject;
                    if (gl != null)
                    {
                        mat.EnableKeyword("GLOW_ON");
                        mat.SetColor("_GlowColor", ParseColorObj(gl["color"]));
                        mat.SetFloat("_GlowOuter", Mathf.Clamp01((float)gl["size"] / fs));
                        mat.SetFloat("_GlowPower", 1f);
                    }
                }
                JObject grad = fx["gradient"] as JObject;
                var stops = grad?["stops"] as JArray;
                if (stops != null && stops.Count >= 2)
                {
                    var vgType = FindType("TMPro.VertexGradient");
                    if (vgType != null)
                    {
                        Color top = ParseColorObj(stops[stops.Count - 1]["color"]);
                        Color bottom = ParseColorObj(stops[0]["color"]);
                        var vg = Activator.CreateInstance(vgType, top, top, bottom, bottom);
                        Set(tmp, "enableVertexGradient", true);
                        _tmpText.GetProperty("colorGradient")?.SetValue(tmp, vg);
                    }
                }
                if (fx["colorOverlay"] != null) Set(tmp, "color", ParseColorObj(fx["colorOverlay"]));
            }
            return true;
        }

        static void Set(object target, string prop, object value)
        {
            var p = target.GetType().GetProperty(prop);
            if (p != null && p.CanWrite) p.SetValue(target, value);
        }

        static void SetEnum(object target, string prop, string enumType, string member)
        {
            var et = FindType(enumType);
            var p = target.GetType().GetProperty(prop);
            if (et == null || p == null) return;
            try { p.SetValue(target, Enum.Parse(et, member)); } catch { }
        }

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
    }
}
#endif

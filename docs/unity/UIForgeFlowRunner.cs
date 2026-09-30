// Runtime prototype player for Unity (put in Assets/UIForge/). Reads the flows exported by
// UIForge (manifest.json → copied to Assets/UIForgeUI/<project>/<page>_flows.json by the importer)
// and wires Buttons at runtime: navigate / overlay (with dim, close outside) / swap / back / close,
// with dissolve / move / push / slide / scale transitions. Screens = the imported frame roots
// (children of the Canvas named like the frames). Lets the team click through the prototype
// in Play mode right after "UIForge > Import Page".
using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace UIForge
{
    public class UIForgeFlowRunner : MonoBehaviour
    {
        [Tooltip("Flows JSON exported by UIForge (manifest.json or <page>_flows.json)")]
        public TextAsset flows;
        [Tooltip("Frame (screen) name to show first; empty = manifest startFrameId")]
        public string startScreen;

        [Serializable] class Flow { public string id, from, fromFrame, trigger, action, to, toFrame, transition, direction, easing, key; public float duration = 300, delay = 1000; public Overlay overlay; }
        [Serializable] class Overlay { public string position = "center"; public float x, y; public bool dim = true; public string dimColor = "#000000"; public float dimOpacity = 0.5f; public bool closeOutside = true; }
        [Serializable] class Manifest { public string startFrameId; public FrameInfo[] frames; public Flow[] flows; }
        [Serializable] class FrameInfo { public string id, name; public float width, height; }

        Manifest data;
        readonly Dictionary<string, RectTransform> screens = new Dictionary<string, RectTransform>(); // frame id → root
        readonly Dictionary<string, string> frameNames = new Dictionary<string, string>();
        RectTransform current;
        readonly Stack<RectTransform> history = new Stack<RectTransform>();
        readonly List<(RectTransform root, GameObject dim, Flow via)> overlays = new List<(RectTransform, GameObject, Flow)>();
        RectTransform canvasRt;

        void Awake()
        {
            canvasRt = GetComponentInParent<Canvas>()?.GetComponent<RectTransform>() ?? (RectTransform)transform;
            if (flows == null) { Debug.LogWarning("[UIForgeFlowRunner] chưa gán flows JSON"); return; }
            data = JsonUtility.FromJson<Manifest>(FixJson(flows.text));
            foreach (var f in data.frames)
            {
                frameNames[f.id] = f.name;
                var t = FindScreen(f.name);
                if (t != null) screens[f.id] = t;
            }
            foreach (var kv in screens) kv.Value.gameObject.SetActive(false);
            // wire hotspots
            foreach (var fl in data.flows)
            {
                if (fl.trigger != "click" && fl.trigger != "press" && fl.trigger != "hover") continue;
                var node = FindNode(fl.from);
                if (node == null) continue;
                var g = node.GetComponent<Graphic>();
                if (g == null) { g = node.gameObject.AddComponent<Image>(); g.color = new Color(0, 0, 0, 0); }
                g.raycastTarget = true;
                var flow = fl;
                if (fl.trigger == "click")
                {
                    var b = node.GetComponent<Button>() ?? node.gameObject.AddComponent<Button>();
                    b.onClick.AddListener(() => Run(flow));
                }
                else
                {
                    var et = node.GetComponent<EventTrigger>() ?? node.gameObject.AddComponent<EventTrigger>();
                    Add(et, fl.trigger == "press" ? EventTriggerType.PointerDown : EventTriggerType.PointerEnter, () => Run(flow));
                    Add(et, fl.trigger == "press" ? EventTriggerType.PointerUp : EventTriggerType.PointerExit, () => Reverse(flow));
                }
            }
            string start = null;
            if (!string.IsNullOrEmpty(startScreen)) foreach (var kv in frameNames) if (kv.Value == startScreen) start = kv.Key;
            start = start ?? data.startFrameId;
            if (start == null || !screens.ContainsKey(start)) foreach (var kv in screens) { start = kv.Key; break; }
            if (start != null) Show(screens[start], null, true);
        }

        void Update()
        {
            if (data == null) return;
            if (!Input.anyKeyDown) return;
            foreach (var fl in data.flows)
            {
                if (fl.trigger != "key" || string.IsNullOrEmpty(fl.key)) continue;
                if (!OnScreen(fl.fromFrame)) continue;
                if (KeyDown(fl.key)) { Run(fl); return; }
            }
            if (Input.GetKeyDown(KeyCode.Escape) && overlays.Count > 0) CloseOverlay(null);
        }

        static bool KeyDown(string key)
        {
            string k = key.ToLowerInvariant();
            if (k == "escape") return Input.GetKeyDown(KeyCode.Escape);
            if (k == "enter") return Input.GetKeyDown(KeyCode.Return);
            if (k == "space") return Input.GetKeyDown(KeyCode.Space);
            if (k.StartsWith("arrow")) return Input.GetKeyDown((KeyCode)Enum.Parse(typeof(KeyCode), k.Substring(5) + "Arrow"));
            if (k.Length == 1) return Input.GetKeyDown(k);
            try { return Input.GetKeyDown((KeyCode)Enum.Parse(typeof(KeyCode), key, true)); } catch { return false; }
        }

        bool OnScreen(string frameId)
        {
            if (current != null && screens.TryGetValue(frameId, out var r) && r == current) return true;
            foreach (var o in overlays) if (screens.TryGetValue(frameId, out var r2) && r2 == o.root) return true;
            return false;
        }

        // ------------------------------------------------------------------ actions
        void Run(Flow f)
        {
            switch (f.action)
            {
                case "navigate": if (screens.TryGetValue(f.to, out var s)) Navigate(s, f, true); break;
                case "overlay": if (screens.TryGetValue(f.to, out var o)) OpenOverlay(o, f, false); break;
                case "swap": if (screens.TryGetValue(f.to, out var sw)) OpenOverlay(sw, f, true); break;
                case "back": Back(); break;
                case "close": CloseOverlay(f); break;
            }
        }

        void Reverse(Flow f)
        {
            if (f.action == "overlay") CloseOverlay(f);
            else if (f.action == "navigate") Back();
        }

        void Navigate(RectTransform to, Flow via, bool pushHistory)
        {
            if (current == to) return;
            foreach (var o in overlays) { Destroy(o.dim); o.root.gameObject.SetActive(false); }
            overlays.Clear();
            var from = current;
            if (pushHistory && from != null) history.Push(from);
            Show(to, via, false);
            if (from != null) StartCoroutine(TransitionOut(from, via, to));
        }

        void Show(RectTransform t, Flow via, bool instant)
        {
            current = t;
            t.SetAsLastSibling();
            t.gameObject.SetActive(true);
            ResetRect(t);
            if (!instant && via != null) StartCoroutine(TransitionIn(t, via, null));
            ScheduleDelays(t);
        }

        void OpenOverlay(RectTransform t, Flow via, bool replaceTop)
        {
            if (replaceTop && overlays.Count > 0) CloseOverlay(null, true);
            GameObject dim = null;
            if (via.overlay == null) via.overlay = new Overlay();
            if (via.overlay.dim)
            {
                dim = new GameObject("Dim", typeof(RectTransform), typeof(Image), typeof(Button));
                var drt = (RectTransform)dim.transform;
                drt.SetParent(canvasRt, false);
                drt.anchorMin = Vector2.zero; drt.anchorMax = Vector2.one; drt.offsetMin = drt.offsetMax = Vector2.zero;
                var c = Color.black; ColorUtility.TryParseHtmlString(via.overlay.dimColor, out c); c.a = via.overlay.dimOpacity;
                dim.GetComponent<Image>().color = c;
                var b = dim.GetComponent<Button>(); b.transition = Selectable.Transition.None;
                if (via.overlay.closeOutside) b.onClick.AddListener(() => CloseOverlay(via));
            }
            t.SetParent(canvasRt, false);
            t.SetAsLastSibling();
            t.gameObject.SetActive(true);
            PlaceOverlay(t, via.overlay);
            overlays.Add((t, dim, via));
            StartCoroutine(TransitionIn(t, via, dim));
            ScheduleDelays(t);
        }

        void CloseOverlay(Flow via, bool immediate = false)
        {
            if (overlays.Count == 0) return;
            var top = overlays[overlays.Count - 1];
            overlays.RemoveAt(overlays.Count - 1);
            if (immediate) { if (top.dim) Destroy(top.dim); top.root.gameObject.SetActive(false); return; }
            StartCoroutine(TransitionOutOverlay(top.root, top.dim, via ?? top.via));
        }

        public void Back()
        {
            if (overlays.Count > 0) { CloseOverlay(null); return; }
            if (history.Count == 0) return;
            var prev = history.Pop();
            var from = current;
            Show(prev, null, true);
            if (from != null) { from.gameObject.SetActive(false); }
        }

        // ------------------------------------------------------------------ helpers
        void PlaceOverlay(RectTransform t, Overlay o)
        {
            Vector2 size = t.rect.size;
            t.anchorMin = t.anchorMax = new Vector2(0.5f, 0.5f);
            t.pivot = new Vector2(0.5f, 0.5f);
            Vector2 cs = canvasRt.rect.size;
            float x = 0, y = 0;
            string p = o.position ?? "center";
            if (p.Contains("left")) x = -(cs.x - size.x) / 2; else if (p.Contains("right")) x = (cs.x - size.x) / 2;
            if (p.StartsWith("top")) y = (cs.y - size.y) / 2; else if (p.StartsWith("bottom")) y = -(cs.y - size.y) / 2;
            if (p == "manual") { x = o.x - (cs.x - size.x) / 2; y = -(o.y - (cs.y - size.y) / 2); }
            t.anchoredPosition = new Vector2(x, y);
        }

        static void ResetRect(RectTransform t)
        {
            var cg = t.GetComponent<CanvasGroup>();
            if (cg) cg.alpha = 1;
            t.localScale = Vector3.one;
        }

        void ScheduleDelays(RectTransform screen)
        {
            foreach (var fl in data.flows)
            {
                if (fl.trigger != "after-delay") continue;
                if (!screens.TryGetValue(fl.fromFrame, out var r) || r != screen) continue;
                var flow = fl;
                StartCoroutine(Delay(flow, screen));
            }
        }

        IEnumerator Delay(Flow f, RectTransform screen)
        {
            yield return new WaitForSeconds(f.delay / 1000f);
            if (screen.gameObject.activeSelf && (screen == current || OverlayRoot(screen))) Run(f);
        }

        bool OverlayRoot(RectTransform t) { foreach (var o in overlays) if (o.root == t) return true; return false; }

        static float Ease(float t, string e)
        {
            switch (e)
            {
                case "linear": return t;
                case "ease-in": return t * t * t;
                case "ease-in-out": return t < 0.5f ? 4 * t * t * t : 1 - Mathf.Pow(-2 * t + 2, 3) / 2;
                case "back-out": { float c1 = 1.70158f, c3 = c1 + 1; return 1 + c3 * Mathf.Pow(t - 1, 3) + c1 * Mathf.Pow(t - 1, 2); }
                case "spring": return t >= 1 ? 1 : Mathf.Pow(2, -10 * t) * Mathf.Sin((t * 10 - 0.75f) * (2 * Mathf.PI) / 3) + 1;
                default: return 1 - Mathf.Pow(1 - t, 3);
            }
        }

        Vector2 Dir(string d)
        {
            Vector2 cs = canvasRt.rect.size;
            switch (d ?? "left") { case "right": return new Vector2(-cs.x, 0); case "up": return new Vector2(0, -cs.y); case "down": return new Vector2(0, cs.y); default: return new Vector2(cs.x, 0); }
        }

        IEnumerator TransitionIn(RectTransform t, Flow via, GameObject dim)
        {
            string tr = via.transition ?? "instant";
            float dur = via.duration / 1000f;
            var cg = t.GetComponent<CanvasGroup>() ?? t.gameObject.AddComponent<CanvasGroup>();
            var dimCg = dim ? dim.GetComponent<CanvasGroup>() ?? dim.AddComponent<CanvasGroup>() : null;
            Vector2 basePos = t.anchoredPosition;
            if (tr == "instant" || dur <= 0) yield break;
            Vector2 v = Dir(via.direction);
            float t0 = Time.time;
            while (true)
            {
                float k = Mathf.Clamp01((Time.time - t0) / dur);
                float e = Ease(k, via.easing);
                switch (tr)
                {
                    case "move-in": case "slide-in": case "push": case "move-out": case "slide-out":
                        t.anchoredPosition = basePos + v * (1 - e); break;
                    case "scale-in": case "scale-out": case "smart":
                        t.localScale = Vector3.one * (0.7f + 0.3f * e); cg.alpha = Mathf.Min(1, k * 2); break;
                    default: cg.alpha = e; break;
                }
                if (dimCg) dimCg.alpha = e;
                if (k >= 1) break;
                yield return null;
            }
            t.anchoredPosition = basePos; t.localScale = Vector3.one; cg.alpha = 1;
        }

        IEnumerator TransitionOut(RectTransform from, Flow via, RectTransform to)
        {
            string tr = via?.transition ?? "instant";
            float dur = (via?.duration ?? 0) / 1000f;
            if (tr == "instant" || dur <= 0) { from.gameObject.SetActive(false); yield break; }
            var cg = from.GetComponent<CanvasGroup>() ?? from.gameObject.AddComponent<CanvasGroup>();
            Vector2 basePos = from.anchoredPosition;
            Vector2 v = Dir(via.direction);
            bool oldOnTop = tr == "move-out" || tr == "slide-out" || tr == "scale-out";
            if (oldOnTop) from.SetAsLastSibling();
            float t0 = Time.time;
            while (true)
            {
                float k = Mathf.Clamp01((Time.time - t0) / dur);
                float e = Ease(k, via.easing);
                switch (tr)
                {
                    case "push": case "move-out": case "slide-out": from.anchoredPosition = basePos - v * e; break;
                    case "slide-in": from.anchoredPosition = basePos - v * 0.3f * e; cg.alpha = 1 - k * 0.5f; break;
                    case "scale-out": from.localScale = Vector3.one * (1 + 0.2f * e); cg.alpha = 1 - e; break;
                    case "dissolve": case "smart": cg.alpha = 1 - e; break;
                }
                if (k >= 1) break;
                yield return null;
            }
            from.gameObject.SetActive(false);
            from.anchoredPosition = basePos; from.localScale = Vector3.one; cg.alpha = 1;
        }

        IEnumerator TransitionOutOverlay(RectTransform t, GameObject dim, Flow via)
        {
            string tr = via?.transition ?? "dissolve";
            float dur = (via?.duration ?? 200) / 1000f;
            var cg = t.GetComponent<CanvasGroup>() ?? t.gameObject.AddComponent<CanvasGroup>();
            var dimCg = dim ? dim.GetComponent<CanvasGroup>() ?? dim.AddComponent<CanvasGroup>() : null;
            Vector2 basePos = t.anchoredPosition;
            Vector2 v = Dir(via?.direction);
            float t0 = Time.time;
            while (dur > 0)
            {
                float k = Mathf.Clamp01((Time.time - t0) / dur);
                float e = Ease(k, "ease-in");
                switch (tr)
                {
                    case "move-in": case "slide-in": case "push": case "move-out": case "slide-out": t.anchoredPosition = basePos + v * e; break;
                    case "scale-in": case "scale-out": case "smart": t.localScale = Vector3.one * (1 - 0.3f * e); cg.alpha = 1 - e; break;
                    default: cg.alpha = 1 - e; break;
                }
                if (dimCg) dimCg.alpha = 1 - e;
                if (k >= 1) break;
                yield return null;
            }
            if (dim) Destroy(dim);
            t.gameObject.SetActive(false);
            t.anchoredPosition = basePos; t.localScale = Vector3.one; cg.alpha = 1;
        }

        RectTransform FindScreen(string name)
        {
            foreach (RectTransform c in canvasRt) if (c.name == name) return c;
            return null;
        }

        RectTransform FindNode(string nodeId)
        {
            foreach (var r in canvasRt.GetComponentsInChildren<UIForgeNodeRef>(true)) if (r.nodeId == nodeId) return (RectTransform)r.transform;
            return null;
        }

        static void Add(EventTrigger et, EventTriggerType type, Action cb)
        {
            var e = new EventTrigger.Entry { eventID = type };
            e.callback.AddListener(_ => cb());
            et.triggers.Add(e);
        }

        /// JsonUtility cannot read `null` numbers/objects reliably; strip "to": null etc.
        static string FixJson(string s) => s.Replace("\"to\": null", "\"to\": \"\"").Replace("\"to\":null", "\"to\":\"\"");
    }
}

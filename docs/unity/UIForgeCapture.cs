// Renders the imported Canvas to a PNG (works in batch mode WITHOUT -nographics) so the design
// tool can diff it against its own preview: UIForge > Capture Canvas PNG… or
//   Unity.exe -batchmode -projectPath … -executeMethod UIForge.UIForgeCapture.Run -quit
//   with env DM_LAYOUT=<layout.json> DM_OUT=<capture.png>
#if UNITY_EDITOR
using System;
using System.IO;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;

namespace UIForge
{
    public static class UIForgeCapture
    {
        [MenuItem("UIForge/Capture Canvas PNG...")]
        public static void CaptureMenu()
        {
            var canvas = UnityEngine.Object.FindObjectOfType<Canvas>();
            if (canvas == null) { Debug.LogError("No Canvas in scene"); return; }
            string path = EditorUtility.SaveFilePanel("Save capture", "", "capture.png", "png");
            if (string.IsNullOrEmpty(path)) return;
            Capture(canvas, path);
        }

        public static void Run()
        {
            string layout = Environment.GetEnvironmentVariable("DM_LAYOUT");
            string outPath = Environment.GetEnvironmentVariable("DM_OUT");
            try
            {
                UIForgeLayoutImporter.StretchRoot = false; // capture at reference resolution
                var go = UIForgeLayoutImporter.Import(layout);
                var canvas = go.GetComponentInParent<Canvas>();
                Capture(canvas, outPath);
                EditorApplication.Exit(0);
            }
            catch (Exception e)
            {
                Debug.LogError("[UIForgeCapture] " + e);
                EditorApplication.Exit(1);
            }
        }

        /// Renders the canvas with a temporary camera at the canvas reference resolution.
        public static void Capture(Canvas canvas, string path)
        {
            var scaler = canvas.GetComponent<CanvasScaler>();
            int w = scaler != null ? (int)scaler.referenceResolution.x : Screen.width;
            int h = scaler != null ? (int)scaler.referenceResolution.y : Screen.height;
            var camGo = new GameObject("UIForgeCaptureCam", typeof(Camera));
            var cam = camGo.GetComponent<Camera>();
            cam.orthographic = true;
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0, 0, 0, 0);
            var prevMode = canvas.renderMode;
            var prevCam = canvas.worldCamera;
            canvas.renderMode = RenderMode.ScreenSpaceCamera;
            canvas.worldCamera = cam;
            canvas.planeDistance = 10;
            Canvas.ForceUpdateCanvases();
            var rt = new RenderTexture(w, h, 24, RenderTextureFormat.ARGB32);
            cam.targetTexture = rt;
            // fit the canvas rect into the camera view
            var crt = canvas.GetComponent<RectTransform>();
            cam.orthographicSize = crt.rect.height * crt.localScale.y / 2f;
            cam.transform.position = new Vector3(crt.position.x, crt.position.y, crt.position.z - 10);
            cam.Render();
            var prevActive = RenderTexture.active;
            RenderTexture.active = rt;
            var tex = new Texture2D(w, h, TextureFormat.RGBA32, false);
            tex.ReadPixels(new Rect(0, 0, w, h), 0, 0);
            tex.Apply();
            RenderTexture.active = prevActive;
            File.WriteAllBytes(path, tex.EncodeToPNG());
            canvas.renderMode = prevMode;
            canvas.worldCamera = prevCam;
            cam.targetTexture = null;
            UnityEngine.Object.DestroyImmediate(rt);
            UnityEngine.Object.DestroyImmediate(tex);
            UnityEngine.Object.DestroyImmediate(camGo);
            Debug.Log("[UIForgeCapture] wrote " + path + " " + w + "x" + h);
        }
    }
}
#endif

// Attach to a RectTransform exported with "safeArea": true. Keeps the rect inside Screen.safeArea
// (notch / home indicator). Children anchored to this rect then behave exactly like in UIForge's
// device preview. Works in Editor (uses Screen.safeArea of the Game view) and at runtime.
using UnityEngine;

namespace UIForge
{
    [ExecuteAlways]
    [RequireComponent(typeof(RectTransform))]
    public class UIForgeSafeArea : MonoBehaviour
    {
        RectTransform _rt;
        Rect _last = new Rect(0, 0, 0, 0);
        Vector2Int _lastScreen;

        void OnEnable() { _rt = GetComponent<RectTransform>(); Apply(); }
        void Update()
        {
            var sa = Screen.safeArea;
            var scr = new Vector2Int(Screen.width, Screen.height);
            if (sa != _last || scr != _lastScreen) Apply();
        }

        public void Apply()
        {
            if (_rt == null) _rt = GetComponent<RectTransform>();
            var sa = Screen.safeArea;
            _last = sa;
            _lastScreen = new Vector2Int(Screen.width, Screen.height);
            if (Screen.width <= 0 || Screen.height <= 0) return;
            Vector2 min = sa.position;
            Vector2 max = sa.position + sa.size;
            min.x /= Screen.width; min.y /= Screen.height;
            max.x /= Screen.width; max.y /= Screen.height;
            _rt.anchorMin = min;
            _rt.anchorMax = max;
            _rt.offsetMin = Vector2.zero;
            _rt.offsetMax = Vector2.zero;
        }
    }
}

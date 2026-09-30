// Runtime component (put in Assets/UIForge/, NOT in an Editor folder).
// Added by UIForgeLayoutImporter to every imported node so UIForgeSync can push changes back to
// UIForge by node id, and UIForgeVerify / UIForgeCapture can find nodes.
using UnityEngine;

namespace UIForge
{
    public class UIForgeNodeRef : MonoBehaviour
    {
        /// Node id inside the UIForge document (instance children: "<instanceId>:<masterChildId>").
        public string nodeId;
        /// "Frame/Group/layer" path at import time (informational).
        public string framePath;
    }
}

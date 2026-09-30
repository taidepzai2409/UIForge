# UIForge — Layout Export Spec (v2)

Tài liệu này dành cho **Agent Unity / Agent Dev** (hoặc bất kỳ tool nào) cần đọc layout do UIForge xuất ra để dựng UI chính xác từng pixel.

## 1. Cấu trúc thư mục export

Sau khi bấm **Export Layout** (Ctrl+Shift+E), app ghi vào `<project>/export/`:

```
export/
  index.json                    # danh sách page
  assets/                       # toàn bộ ảnh PNG được dùng (tên file = <layer>_<hash8>.png)
  atlas/
    <PageName>_<n>.png          # sprite atlas của page (tối đa 2048², padding 2)
    <PageName>.json             # danh sách sprite: tên chuẩn screen_element_state, sheet, x/y/w/h, 9-slice
  <PageName>/
    manifest.json               # danh sách frame + flow của page (+ preview theo thiết bị)
    <FrameName>_<frameId>.json  # layout đầy đủ của từng frame (màn hình)
    <FrameName>_<frameId>_preview.png          # render 1:1 của tool
    <FrameName>_<frameId>_<device>.png         # render mô phỏng trên từng thiết bị (iphone15, galaxyS, ipad...)
    <FrameName>_<frameId>_devices.json         # rect từng node + lỗi safe area trên từng thiết bị
```

Ngoài ra `<project>/project.json` là file nguồn của app, cũng là JSON thuần, đọc được nếu cần thêm thông tin.

## 2. Hệ toạ độ

| Khái niệm | Editor / JSON (`rect`, `local`, `anchor`, `pivot`) | Unity (`unity.*`) |
|---|---|---|
| Gốc toạ độ | Góc **trên-trái** của frame/parent | Theo RectTransform |
| Trục Y | **Hướng xuống** | Hướng lên |
| Đơn vị | Pixel của frame (frame 1080×1920 nghĩa là Canvas reference resolution 1080×1920) | Unit của Canvas |
| Anchor | Tỷ lệ 0..1, (0,0)=trên-trái, (1,1)=dưới-phải | `anchorMin/anchorMax` đã lật Y |
| Pivot | Tỷ lệ 0..1, (0,0)=trên-trái | `pivot` đã lật Y |

**Quy tắc chuyển đổi** (đã tính sẵn trong `unity`, ghi lại để đối chiếu):

```
anchorMin = (a.minX, 1 - a.maxY)
anchorMax = (a.maxX, 1 - a.minY)
pivot     = (p.x, 1 - p.y)
anchorRect (editor) = [a.minX*PW, a.minY*PH] → [a.maxX*PW, a.maxY*PH]     (PW/PH = size parent)
pivotPoint (editor) = (local.x + p.x*w, local.y + p.y*h)
anchorRef  (editor) = (anchorRect.x0 + p.x*anchorRect.w, anchorRect.y0 + p.y*anchorRect.h)
anchoredPosition    = (pivotPoint.x - anchorRef.x, -(pivotPoint.y - anchorRef.y))
sizeDelta           = (w - anchorRect.w, h - anchorRect.h)
rotationZ           = -rotation   (editor xoay theo chiều kim đồng hồ)
```

Với anchor mặc định (top-left, `minX=minY=maxX=maxY=0`) và pivot (0.5,0.5): `anchoredPosition = (x + w/2, -(y + h/2))`, `sizeDelta = (w, h)`.

## 3. Frame layout JSON

```jsonc
{
  "schema": "uiforge-layout",
  "version": 1,
  "project": "MyGame",
  "page": "Page 1",
  "exportedAt": "2026-09-17T10:11:16.033Z",
  "frame": { "id": "d3vq0-VaPC", "name": "main_menu", "width": 1080, "height": 1920, "fill": { "color": "#ffffff", "alpha": 1 } },
  "nodes": [ /* xem 3.1 */ ],
  "flows": [ /* xem 3.2 */ ],
  "assets": { "<assetId>": { "file": "assets/btn_play_bg_acf84899.png", "width": 600, "height": 160, "source": "psd:ui.psd/Buttons/btn_play/btn_play_bg" } }
}
```

### 3.1 Node

`nodes` là danh sách phẳng, **duyệt theo chiều sâu, cha đứng trước con, anh em theo thứ tự từ dưới lên** (phần tử sau vẽ đè lên phần tử trước → đúng thứ tự sibling index trong Unity Hierarchy khi add lần lượt).

| Field | Ý nghĩa |
|---|---|
| `id` | id ổn định của node (giữ nguyên qua các lần export nếu không xoá node) |
| `name` | tên layer (từ PSD hoặc do designer đặt) |
| `path` | đường dẫn `Group/SubGroup/name` tính từ frame |
| `type` | `frame` \| `group` \| `image` \| `nineslice` \| `rect` \| `text` |
| `parentId` | id node cha, `null` nếu cha là frame gốc |
| `index` | thứ tự trong cha (0 = dưới cùng) |
| `depth` | độ sâu (0 = con trực tiếp của frame) |
| `visible`, `locked`, `opacity` (0..1), `rotation` (độ), `blendMode` | trạng thái |
| `rect` | `{x,y,width,height}` **tuyệt đối trong frame** (dùng khi muốn đặt theo toạ độ tuyệt đối) |
| `local` | `{x,y,width,height}` **so với cha** |
| `anchor`, `pivot` | theo quy ước editor (mục 2) |
| `unity` | `{anchorMin, anchorMax, pivot, anchoredPosition, sizeDelta, offsetMin, offsetMax, rotationZ}` — gán thẳng vào RectTransform |
| `image` | chỉ có ở `image`/`nineslice`: `{assetId, file, width, height, nineSlice, sourceFile?, contentOffset?, fillOpacity?, effects?}`; `file` là PNG **đã có layer style** (dùng cái này là ra đúng hình). Nếu layer có style thì thêm `sourceFile` (pixel gốc chưa có style), `contentOffset` (vị trí pixel gốc trong PNG đã style), `fillOpacity` và `effects` (tham số layer style đúng cấu trúc Photoshop/ag-psd: dropShadow[], innerShadow[], outerGlow, innerGlow, bevel, satin, solidFill[], gradientOverlay[], patternOverlay, stroke[]) để tái tạo bằng shader/material nếu muốn. `nineSlice` = `{left,top,right,bottom}` tính bằng **pixel ảnh gốc** (đúng bằng Border trong Sprite Editor) hoặc `null` |
| `text` | chỉ có ở `text`: `{text, fontFamily, fontSize, fontWeight, italic, letterSpacing, uppercase, color, align, lineHeight, psdFont}`. `fontSize` = px trong frame; `lineHeight` là hệ số nhân; `psdFont` là tên PostScript gốc trong PSD để chọn font asset tương ứng trong Unity. Text import từ PSD thường đi kèm một node `image` ẩn cùng tên + " (raster)" (`meta.psdTextRaster=true`) là hình gốc của Photoshop để đối chiếu, không cần dựng. `effects` (nếu có) là layer style của chữ: `stroke {color, width, position}`, `shadow {color, distance, angle, blur}` (góc theo Photoshop, 90 = bóng đổ xuống), `glow {color, size}`, `gradient {stops[{color,pos}], angle}` (90 = từ dưới lên), `colorOverlay`; màu có `a` = opacity. Map sang TMP: stroke → Outline (Face/Outline thickness), shadow → Underlay, glow → Glow, gradient → Vertex gradient; `unsupported[]` liệt kê style không tái tạo được (innerShadow, bevel, satin...). |
| `fill` | `rect`/`frame`: `{color:"#rrggbb", alpha}` hoặc `null` |
| `cornerRadius` | `rect` |
| `clipsContent` | `frame` (→ RectMask2D) |
| `children` | danh sách id con (chỉ `frame`/`group`) |
| `meta` | thông tin phụ: `psdPath`, `psdText` (chữ gốc trong PSD nếu layer là text đã raster), `psdClipping`, tag do designer thêm |

**Gợi ý map sang Unity**

| type | Unity |
|---|---|
| `group` / `frame` | GameObject rỗng + RectTransform (frame có `clipsContent` → thêm RectMask2D) |
| `image` | Image (sprite = `image.file`, `Set Native Size` không cần, dùng `sizeDelta`) |
| `nineslice` | Image, Image Type = Sliced, sprite border = `image.nineSlice` |
| `text` | TextMeshProUGUI với `fontSize`, `color`, alignment |
| `rect` | Image màu đơn (`fill.color`) hoặc Image + sprite bo góc |

Thứ tự dựng: duyệt `nodes` theo thứ tự, tạo GameObject dưới cha (`parentId` → frame root nếu null), gán RectTransform từ `unity`. Vì `anchoredPosition` được tính với size **thực** của cha, phải set cha trước con (đúng thứ tự có sẵn trong mảng).

### 3.1b Trường thêm ở v2

```jsonc
{
  "layout":    { "direction": "horizontal" | "vertical", "gap": 8, "padding": {"top","right","bottom","left"}, "align": "start"|"center"|"end", "hug": true },
  "safeArea":  true,                              // node cấp 1 neo theo vùng an toàn (tai thỏ/home bar) thay vì cả màn hình
  "component": { "name": "btn_play" },            // node này là component master → tạo prefab
  "instance":  { "componentId": "<masterId>", "componentName": "btn_play", "overrides": { "<masterChildId>": { "text": "SHOP", "visible": false } } },
  "image": { ..., "edits": { "crop": {...}, "flipH": true, "rotate": 90, "adjustments": [...] }, "originalFile": "assets/...png",
             "atlas": { "sheet": 0, "name": "main_menu_btn_play", "x": 12, "y": 340, "width": 200, "height": 80 } }
}
```

- **layout** (auto layout): con được xếp thành hàng/cột theo thứ tự `children`, cách nhau `gap`, lùi vào `padding` (group bỏ qua padding), căn trục còn lại theo `align`. `hug=true` → kích thước cha ôm sát nội dung. Unity: `HorizontalLayoutGroup`/`VerticalLayoutGroup` (childControl/ForceExpand = false) + `ContentSizeFitter` khi hug; con của layout group nên neo góc trên-trái và dùng `local` làm anchoredPosition/sizeDelta (importer mẫu đã làm vậy). Toạ độ `rect/local/unity` trong JSON **đã là kết quả xếp**, nên dựng thẳng không cần layout group vẫn đúng.
- **safeArea**: chỉ có ở node cấp 1 (parentId = null). Unity: đặt node dưới một RectTransform "SafeArea" stretch full + `UIForgeSafeArea.cs` (docs/unity), giá trị `unity.*` giữ nguyên. Ở reference resolution safe area = cả màn hình nên không đổi gì; trên máy có tai thỏ node tự lùi vào.
- **component.states** (và `instance.states`): `{ "normal": "<id>", "pressed": "<id>", "disabled": "<id>" }` — id các lớp con trạng thái (chỉ `normal` visible). Unity: Button (transition SpriteSwap) với sprite lấy từ ảnh đầu tiên trong mỗi lớp; importer mẫu làm sẵn, các lớp không phải normal bị SetActive(false). Tên atlas: `<frame>_<button>_<state>`.
- **component / instance**: master là group/frame bình thường có thêm `component.name`; instance là node `type: "instance"` với các con là bản sao (id = `<instanceId>:<masterChildId>`, `meta.instanceOf` = id con của master, `meta.fromInstance` = id instance). Toàn bộ node con đã có sẵn trong `nodes` nên dựng thẳng vẫn đúng; muốn dùng prefab thì tạo prefab từ master (`components` ở gốc JSON liệt kê master trong frame) và thay instance bằng prefab instance rồi áp `overrides` (text / visible). Master ở frame khác: tìm prefab theo `instance.componentName`.
- **text.fontFile / text.fontPostScript**: file font (`export/fonts/<PostScript>.ttf|otf`) đúng family + weight + italic của text, lấy từ font Windows đã cài hoặc `<project>/fonts/`. `manifest.fonts` liệt kê tất cả. Unity: `UIForgeTmp.cs` tạo `TMP_FontAsset` từ file này và dùng TextMeshProUGUI (fontSize, màu, căn lề, characterSpacing, bold/italic/uppercase, outline/underlay/glow/gradient từ `text.effects`); thiếu TextMeshPro thì rơi về `Text` legacy.
- **image.edits**: đã bake vào `image.file`; `originalFile` là ảnh gốc trước khi chỉnh (crop tính theo pixel ảnh gốc).
- **image.atlas**: vị trí sprite trong `atlas/<page>_<sheet>.png` (gốc trên-trái; Unity dùng gốc dưới-trái: `y_unity = sheetHeight - y - height`). Tên sprite chuẩn `screen_element_state` = `<frame>_<layer>` viết thường, ASCII, gạch dưới, duy nhất trong page. Mỗi asset chỉ có một tên (lấy theo node dùng đầu tiên).

### 3.2 Flows

```jsonc
{ "id": "...", "from": "<nodeId>", "fromPath": "Buttons/btn_shop",        // fromPath "" = hotspot là chính frame (after-delay / key)
  "trigger": "click" | "hover" | "press" | "drag" | "after-delay" | "key", "delay": 1000, "key": "Escape",
  "action": "navigate" | "overlay" | "swap" | "back" | "close",
  "to": "<frameId>" | null, "toFrame": "Shop",                            // null với back / close
  "transition": "instant" | "dissolve" | "smart" | "move-in" | "move-out" | "push" | "slide-in" | "slide-out" | "scale-in" | "scale-out",
  "direction": "left" | "right" | "up" | "down", "duration": 300, "easing": "ease-out" | "ease-in" | "ease-in-out" | "linear" | "back-out" | "spring",
  "overlay": { "position": "center" | "top" | "bottom" | ... | "manual", "x", "y", "dim": true, "dimColor": "#000000", "dimOpacity": 0.5, "closeOutside": true } }
```

- **navigate**: thay màn hình hiện tại bằng `to` (đẩy màn cũ vào history). **overlay**: mở `to` như popup đè lên màn hiện tại tại `overlay.position` (kích thước = kích thước frame `to`), `dim` = tối nền, `closeOutside` = bấm ra ngoài thì đóng. **swap**: thay popup đang mở. **back**: về màn trước (hoặc đóng popup trên cùng). **close**: đóng popup trên cùng.
- **hover** / **press**: chạy action khi rê vào / nhấn giữ, rời ra / thả thì tự chạy ngược (đóng popup, back). **after-delay** thường đặt trên frame (splash → menu). **key**: phím bấm trong lúc màn/popup đang hiện.
- **Transition** theo tên Figma: move-in (màn mới trượt đè lên), move-out (màn cũ trượt đi), push (cả hai cùng trượt), slide-in/out (kèm parallax), scale-in/out (pop), smart (node cùng path ở hai frame tự tween vị trí/kích cỡ/opacity; rất hợp cho popup mở từ nút). Unity: map `navigate` → chuyển scene/panel, `overlay` → bật panel popup + nền dim, `back` → pop stack; duration/easing dùng cho DOTween hoặc Animator.
- `FLOWS.md` có sơ đồ mermaid (nét đứt = overlay) và bảng đầy đủ.

## 4. manifest.json (per page)

```jsonc
{ "schema": "uiforge-manifest", "version": 2, "project": "...", "page": "Page 1",
  "startFrameId": "...",                       // màn hình bắt đầu của flow (có thể null)
  "frames": [ { "id", "name", "width", "height", "file": "main_menu_<id>.json", "preview": "main_menu_<id>_preview.png",
                "devices": [ { "id": "iphone15", "name", "width", "height", "preview": "main_menu_<id>_iphone15.png", "issues": ["Buttons/btn_x: lấn vùng không an toàn"] } ] } ],
  "atlas":  { "file": "atlas/page_1.json", "sheets": [ { "index": 0, "file": "atlas/page_1_0.png", "width", "height" } ] },
  "flows":  [ { "from", "fromFrame", "to", "trigger", "transition", "duration" } ] }
```

`scaler` (gốc layout và manifest) = thiết lập Unity `CanvasScaler` của project: `{ "mode": "expand" | "shrink" | "match", "match": 0..1 }`. Mặc định **expand** (Screen Match Mode = Expand): canvas không bao giờ nhỏ hơn reference ở cả hai chiều nên không node nào đè lên nhau, chỉ thừa khoảng trống ở mép (node neo theo mép tự dãn ra). Importer mẫu đặt đúng chế độ này. Mô phỏng thiết bị làm đúng như `CanvasScaler` đó + anchor/pivot: anchoredPosition và sizeDelta giữ nguyên, chỉ anchor rect đổi theo kích thước canvas mới. `issues` liệt kê node tràn màn hình hoặc lấn vùng tai thỏ/home bar. Có thể gọi lại qua MCP `simulate_frame`.

## 4a. Prototype chạy trong Unity

`UIForge > Import Page (all frames + flows)…` chọn `manifest.json` của page: import mọi frame, chép manifest thành `<page>_flows.json` và gắn `UIForgeFlowRunner` (docs/unity, runtime) lên Canvas. Bấm Play: nút có flow tự có Button, navigate/overlay (dim + đóng khi bấm ngoài)/swap/back/close, after-delay, phím, hover/press, animation dissolve/move/push/slide/scale. Screen = GameObject con của Canvas trùng tên frame; popup = frame riêng được đặt theo `overlay.position`.

## 4b. Đối chiếu Unity ↔ thiết kế (diff tự động)

1. Trong Unity: `UIForge > Capture Canvas PNG…` (hoặc batch `UIForgeCapture.Run` với `DM_LAYOUT`, `DM_OUT`) để chụp Canvas ở đúng reference resolution.
2. MCP `compare_frame {frame, capturePath, diffPath?}` (hoặc bridge `compareFrame`): tool render lại frame và so từng node lá; báo `shifted` (kèm dx,dy px cần sửa), `missing` (không thấy sprite), `mismatch` (khác sprite/font/màu). `diffPath` ghi ảnh heat-map có khung màu cho từng node lỗi.
3. Sửa trong Unity rồi `UIForge > Push Layout To Design` (UIForgeSync.cs) nếu muốn đẩy thay đổi ngược về tool (qua bridge, theo `UIForgeNodeRef.nodeId`).

## 5. Lưu ý

- Ảnh PNG đã cắt đúng bounds layer (không padding), kích thước ảnh = `image.width/height`. Nếu node được scale trong editor, `rect.width/height` ≠ kích thước ảnh → Image sẽ stretch (đúng ý designer).
- Layer ẩn trong PSD vẫn được export với `visible: false` — agent nên tạo GameObject nhưng `SetActive(false)`.
- Layer style của Photoshop (stroke, drop/inner shadow, outer/inner glow, color/gradient overlay) **đã được render** vào PNG, nên `rect` của layer có style sẽ rộng hơn bounds pixel gốc (đã cộng margin của shadow/stroke). Bevel & Emboss, Satin, Pattern Overlay chưa hỗ trợ. Group có layer style vẫn giữ nguyên các node con; style của group được tách thành hai node `image` trong group: `<tên> (style below)` (index 0, dưới mọi con: drop shadow, outer glow) và `<tên> (style above)` (trên cùng: stroke, inner shadow/glow, bevel, overlay) với `meta.psdGroupStyle = 'below' | 'above'`. Dựng cả hai như ảnh bình thường là ra đúng hình Photoshop. Adjustment layer (Hue/Saturation, Gradient Map, Levels, Curves...) đã được áp thẳng vào pixel của các layer bên dưới nó, không xuất hiện trong JSON. `meta.psdEffects` liệt kê các effect đã áp.
- `rect` có thể có `shape: "ellipse"` (vẽ oval nội tiếp) và `stroke {color, alpha, width}` (viền). Unity: Image màu phẳng (+ Outline) hoặc sprite tròn.
- Tất cả đường dẫn file là tương đối so với thư mục `export/`.

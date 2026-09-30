# UIForge

Công cụ dựng layout UI game kiểu Figma, chạy desktop (Windows 10+, sau này macOS).

## Làm được gì (v0.1)

- **Import PSD**: đọc đúng ảnh, vị trí, layer, group (kể cả lồng nhau), layer ẩn, opacity, blend mode, layer mask, clipping mask. **Layer style** được render vào ảnh đủ bộ như Photoshop: stroke (màu/gradient/pattern, outside/center/inside), drop shadow, inner shadow, outer/inner glow, contour, color overlay, gradient overlay, pattern overlay, satin, bevel & emboss (satin/bevel là xấp xỉ), fill opacity. Group có style giữ nguyên layer con, style tách thành 2 ảnh dưới/trên. **Hộp thoại Layer Style giống Photoshop** (Ctrl+Shift+L, nút fx ở panel phải, double-click nhãn fx ở panel Layers, hoặc chuột phải): cửa sổ nổi kéo/đổi cỡ được, không che canvas; 3 cột như Photoshop: Styles (checkbox, nút + để thêm nhiều Stroke/Shadow/Overlay), thiết lập theo nhóm Structure/Shading/Elements/Quality (Blend Mode, ô màu, Opacity, vòng xoay Angle + Use Global Light, Distance, Spread/Choke, Size, Contour 13 kiểu, Anti-aliased, Noise, Gradient, Pattern), cột OK/Cancel/Reset/Preview + thumbnail; Make Default / Reset to Default; Global Light dùng chung cả tài liệu. Dùng chung cho ảnh, text và group; text có style được render qua đúng pipeline như ảnh nên inner shadow, bevel, glow trên chữ ra hình như Photoshop. **Adjustment layer** (Hue/Saturation, Gradient Map, Levels, Curves, Brightness/Contrast, Exposure, Vibrance, Color Balance, Black & White, Photo Filter, Channel Mixer, Invert, Posterize, Threshold) được áp vào các layer bên dưới, kể cả clip vào một layer và mask. Group có layer style được gộp thành 1 ảnh. Text layer lấy pixel gốc + lưu nội dung chữ trong meta. Đã đối chiếu pixel với composite của Photoshop trên file thật (lệch < 0.1%).
- **Import nhiều màn trong một PSD**: hộp thoại import cho chọn "mỗi group cấp 1 = một frame", tick group nào lấy, layer lẻ (nền chung) được chép vào mọi frame.
- **Text sống**: text layer PSD thành Text node thật (font, size, màu, căn lề, tracking, uppercase, vị trí neo theo baseline như Photoshop) và giữ layer style của chữ: stroke, drop shadow, outer glow, gradient overlay, color overlay (inner shadow/glow, bevel chưa có trên text sống). Ảnh gốc của Photoshop giữ kèm ở dạng layer ẩn để đối chiếu. Font lấy từ Windows (queryLocalFonts) hoặc thư mục `fonts/` trong project; font thiếu được báo sau import.
- **Canvas**: zoom/pan, chọn, kéo, resize (Shift giữ tỷ lệ, Alt từ tâm), xoay bằng cách kéo ngoài góc (Shift bước 15°), snap vào cạnh/tâm/guide, thước và guide (kéo từ thước, Shift+R ẩn hiện), marquee, group/ungroup, sắp xếp thứ tự, undo/redo, copy/cut/paste kể cả giữa frame, align/distribute (Alt+A/D/W/S/H/V, Alt+Shift+H/V), layer panel kéo thả, tìm layer, F2 đổi tên.
- **9-slice**: chuyển ảnh thành 9-slice, kéo 4 đường guide trên canvas hoặc nhập số (pixel ảnh gốc, giống Sprite Editor Unity).
- **Anchor/Pivot kiểu Unity** cho từng node (preset 3×3 + stretch).
- **Prototype kiểu Figma**: kéo nút ⊕ (hiện khi rê chuột vào node) tới frame khác để tạo tương tác, giữ Alt = mở overlay; nhãn trên mũi tên (trigger → action · animation); action navigate / overlay (popup có dim, vị trí, đóng khi bấm ngoài) / swap / back / close; trigger click, hover, press, drag, after-delay, key; animation dissolve, smart animate, move in/out, push, slide, scale (pop) + easing (ease/back-out/spring). Tab Prototype liệt kê mọi flow, báo frame chưa có đường tới. **Present** (F5): back (Backspace), restart (R), nhảy frame, hiện hotspot (H), fit/100%, overlay stack, Esc đóng popup.
- **Export layout** JSON + PNG + preview từng màn + `FLOWS.md` (mermaid) + `SPEC.md` cho Agent Unity/Dev: xem [docs/LAYOUT_SPEC.md](docs/LAYOUT_SPEC.md). Script Unity mẫu: [docs/unity/UIForgeLayoutImporter.cs](docs/unity/UIForgeLayoutImporter.cs).
- **MCP server local** để Claude Code / Agent Dev đọc layout, luồng, render ảnh, import PSD, sửa node/flow không cần server: xem [docs/MCP.md](docs/MCP.md).
- **Game Link — nối với game HTML5/web** (Phaser, DOM/CSS, canvas): agent của game gọi `capture_game` → app mở game trong cửa sổ ẩn, đi tới từng màn, chụp ảnh, đọc element (ảnh nối về đúng file art trong thư mục game, chữ thành text sống, thứ vẽ bằng code thành ảnh cắt) và tạo project `<game>/uiforge/` với một frame mỗi màn + flow. Tab **Game** liệt kê file art của game: kéo-thả ảnh vào để thay (mọi chỗ dùng đổi theo), **Thay từ thư mục…** khớp theo tên file, chuột phải node → **Thay ảnh…**. **Sync → Game** ghi art đè lên file của game (backup), art mới vào `uiforge/incoming/`, `uiforge/CHANGES.md` liệt kê mọi thay đổi (vị trí, chữ, art, flow, kèm chỗ trong code) và có thể chạy luôn Claude Code trong thư mục game để tự sửa code cho khớp; capture lại là mốc mới. Xem [docs/GAME_LINK.md](docs/GAME_LINK.md).
- **Giao diện kiểu Figma**: thanh công cụ icon (Move/Hand/Frame/Rect/Text/9-slice), menu ☰ cho file, tab Design/Prototype ở panel phải, panel Layers ảo hoá (mượt với hàng nghìn layer), theme **sáng/tối theo Windows** (đổi trong Settings).
- **Hiệu năng**: canvas chỉ vẽ lại khi có thay đổi (không chạy 60 fps nền), hover/drag/zoom giới hạn đúng 1 khung hình kể cả file 700+ node.
- **Component & instance** (Ctrl+Alt+K tạo, tab Assets để chèn): sửa master là mọi instance đổi theo; instance ghi đè được text / ẩn-hiện; export giữ tên component → Unity tạo prefab.
- **Auto layout** (Shift+A): xếp con thành hàng/cột với gap/padding/align, ôm nội dung; export thành Horizontal/Vertical Layout Group.
- **Chỉnh ảnh nhẹ** (Ctrl+Shift+U): crop (kéo trên canvas), lật, xoay 90°, Hue/Saturation, Brightness/Contrast, Levels — không phá huỷ, luôn tính lại từ ảnh gốc.
- **Tự neo theo rule** (mặc định chạy ngay khi import PSD; Ctrl+Alt+A, nút ⚓ trong cửa sổ xem trước): nửa trên neo Top, nửa dưới neo Bottom, sát trái/phải neo Left/Right, ở giữa neo Center, nền full → stretch, 9-slice/rect rộng hết màn → giãn; node neo theo mép đi theo safe area; node đã chỉnh tay giữ nguyên.
- **Safe area & nhiều tỷ lệ** (Shift+D): mô phỏng đúng như Unity CanvasScaler + anchor trên iPhone 15/SE, Galaxy, Pixel, iPad, tablet, Fold; vẽ vùng tai thỏ/home bar, liệt kê node tràn màn/lấn safe area; node cấp 1 tick "Neo theo safe area".
- **Trạng thái component** (normal/hover/pressed/disabled/selected): panel Component có chip trạng thái + "thêm…" (sao chép lớp normal); export ghi `component.states`, tên atlas `<màn>_<nút>_<state>`, Unity importer tạo Button SpriteSwap.
- **Font & TextMeshPro**: export kèm file font Windows/project đúng weight/italic (`export/fonts/`), Unity importer (`UIForgeTmp.cs`) tạo TMP_FontAsset và TextMeshProUGUI với outline/shadow/glow/gradient từ layer style; tự import TMP Essential Resources nếu thiếu.
- **Prototype chạy trong Unity**: `UIForge > Import Page` + `UIForgeFlowRunner.cs` → bấm Play là click chuyển màn/popup y như Present.
- **Sprite atlas** khi export: `export/atlas/<page>_<n>.png` + JSON, tên sprite chuẩn `screen_element_state`; Unity importer nhập thẳng Multiple sprite kèm border 9-slice.
- **Two-way sync**: `docs/unity/UIForgeSync.cs` đẩy RectTransform sửa trong Unity ngược về tool (menu UIForge > Push Layout To Design / Watch & Push).
- **Diff tự động**: `UIForgeCapture.cs` chụp Canvas, MCP `compare_frame` báo từng node lệch (dx,dy), thiếu hoặc khác sprite/font kèm ảnh heat-map.
- **Tự lưu & khôi phục**: mỗi 30 giây (và khi ẩn cửa sổ) bản nháp được ghi vào `<project>/.autosave/` (project chưa lưu: vào thư mục dữ liệu app kèm assets). Mở lại app/project sau khi crash sẽ hỏi khôi phục; lưu thật (Ctrl+S) xoá bản nháp. Thêm `.autosave/` vào .gitignore của project.
- Project = một thư mục (`project.json` + `assets/`), commit git được.

## Chạy dev

```bash
npm install
npm run dev        # electron-vite dev (hot reload)
npm run build      # build ra out/
npm run typecheck
npm run dist       # đóng gói Windows (electron-builder) → dist/
```

Lưu ý: nếu chạy trong terminal của VS Code, biến môi trường `ELECTRON_RUN_AS_NODE=1` có thể được set sẵn làm Electron chạy như Node. Gỡ nó trước: `env -u ELECTRON_RUN_AS_NODE npm run dev` (bash) hoặc `Remove-Item Env:ELECTRON_RUN_AS_NODE` (PowerShell).

## Phím tắt

Mọi phím tắt đổi được trong Settings (nút ⚙ hoặc Ctrl+,): bấm vào ô phím, gõ tổ hợp mới; lưu tự động; có nút về mặc định. Mặc định:

| Phím | Chức năng |
|---|---|
| V / H / F / R / T | Select / Hand / Frame / Rect / Text |
| N | Chuyển ảnh đang chọn thành 9-slice / bật tắt chỉnh slice (cũng có nút 9-Slice trên thanh công cụ và menu chuột phải) |
| Ctrl+C / X / V | Copy / cut / paste (paste vào scope hoặc frame đang chọn) |
| Alt+A/D/W/S/H/V | Căn trái/phải/trên/dưới/giữa ngang/giữa dọc (1 node: theo cha; nhiều node: theo khung bao) |
| Alt+Shift+H / V | Chia đều ngang / dọc (≥3 node) |
| Kéo ngoài góc selection | Xoay (Shift: bước 15°) |
| Kéo từ thước | Tạo guide; kéo guide về thước hoặc Delete để xoá; Shift+R ẩn/hiện thước |
| F2 | Đổi tên layer |
| Chuột phải | Menu: 9-slice, group, thứ tự, ẩn/khoá, flow start, xoá |
| P | Đổi Design ↔ Prototype |
| Ctrl+Z / Ctrl+Shift+Z | Undo / Redo |
| Ctrl+D, Ctrl+G, Ctrl+Shift+G | Duplicate, Group, Ungroup |
| Ctrl+[ / Ctrl+] (+Shift) | Đưa xuống / lên (+ về cuối / đầu) |
| Enter / Esc | Vào trong group / ra ngoài, bỏ chọn |
| Ctrl+A | Chọn tất cả trong scope |
| Ctrl+Shift+H / Ctrl+Shift+L | Ẩn/hiện, khoá |
| Mũi tên (+Shift) | Nudge 1px (10px) |
| Ctrl+wheel, Space+drag | Zoom, pan |
| Ctrl+0, Shift+1, Shift+2 | Zoom 100%, fit tất cả, fit selection |
| Ctrl+S / Ctrl+Shift+S / Ctrl+O / Ctrl+N | Save / Save as / Open / New |
| Ctrl+Shift+I / Ctrl+Shift+E | Import PSD / Export layout |
| F5 | Present |
| Double-click | Vào group, sửa text, chỉnh 9-slice |

## Kiến trúc

```
src/main/       Electron main: cửa sổ, dialog, đọc/ghi file (IPC)
src/preload/    cầu nối window.api
src/renderer/src/
  model/        kiểu dữ liệu document, helper cây node, anchor→Unity
  store/        zustand store (doc, undo/redo, selection), assets cache, project (open/save/import/export)
  canvas/       PixiJS viewport, đồng bộ cây node → display objects, tương tác, overlay
  psd/          importer PSD (ag-psd)
  export/       sinh layout JSON
  ui/           React panels
```

Test tự động (không cần click tay): chạy app với biến môi trường
`DM_OPEN_PSD=<psd>`, `DM_PROJECT=<dir>`, `DM_SCRIPT=<file.js>` (chạy trong renderer, có `window.__dm`), `DM_SCREENSHOT=<png>`, `DM_SCREENSHOT_DELAY=ms`, `DM_EXIT_AFTER=1`, `DM_LOG_CONSOLE=1`.

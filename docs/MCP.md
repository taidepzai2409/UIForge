# UIForge MCP server

MCP server chạy **local** (stdio), không cần server ngoài. Claude Code / Cursor / agent bất kỳ dùng nó để đọc layout, luồng màn hình, render ảnh, import PSD, sửa node và thêm flow.

Hai chế độ, tự động chọn:

| App UIForge | Nguồn dữ liệu | Tool khả dụng |
|---|---|---|
| **Đang mở** | live từ app qua `http://127.0.0.1:47821` (chỉ loopback) | tất cả; mọi thay đổi được lưu ngay vào `project.json` |
| **Không mở** | đọc/ghi thẳng `project.json` trong thư mục project | tất cả trừ `render_frame`, `import_psd`, `save_project`; `export_layout` không có preview PNG |

## Dùng nhanh

- App **tự mở** khi một tool cần app mà bridge chưa chạy (ưu tiên bản dev `out/` cùng phiên bản với server; đặt `DM_APP_EXE` để chỉ định exe khác; `DM_NO_AUTOLAUNCH=1` để tắt). Tool `launch_app {project?}` mở app + project chủ động.
- Đăng ký ở phạm vi user để mọi session Claude Code đều có: `claude mcp add --scope user uiforge-design -- node F:/Figma_clone/out/mcp/server.js`.
- Lệnh `/ux` (`.claude/commands/ux.md`, cũng chép vào `~/.claude/commands/`): dán ảnh giao diện, gõ `/ux [ghi chú]` → Claude dựng lại UX bằng shape/text/component/flow theo `ux_guide`.

## Cài cho Claude Code

Trong repo này đã có `.mcp.json` nên mở Claude Code tại `F:\Figma_clone` là dùng được luôn. Với repo game (nơi Agent Dev làm việc), thêm vào `.mcp.json` của repo đó hoặc `~/.claude.json`:

```json
{
  "mcpServers": {
    "uiforge-design": {
      "command": "node",
      "args": ["F:/Figma_clone/out/mcp/server.js", "--project", "D:/Games/MyGame/design"]
    }
  }
}
```

`--project` là thư mục chứa `project.json` (tuỳ chọn; nếu app đang mở thì lấy project của app). Đổi cổng bằng `--port` hoặc biến `DM_BRIDGE_PORT` (đặt giống nhau cho app và MCP).

Chạy thử bằng tay: `node out/mcp/server.js --project <dir>` rồi gửi JSON-RPC qua stdin, hoặc dùng `npx @modelcontextprotocol/inspector node out/mcp/server.js`.

## Tools

| Tool | Mục đích |
|---|---|
| `project_info` | Tổng quan: thư mục, pages, frames (kích thước, số node), số flow. Gọi đầu tiên. |
| `get_spec` | Nội dung `LAYOUT_SPEC.md` (hệ toạ độ, map sang Unity). |
| `get_frame_layout {frame, compact?}` | Layout đầy đủ 1 màn hình: node, rect, anchor/pivot, Unity RectTransform, ảnh, 9-slice, text, flows. |
| `list_nodes {frame, query?, type?}` | Danh sách node rút gọn. |
| `get_node {node}` | Chi tiết 1 node (id, path `Frame/Group/name`, hoặc tên) + đường dẫn PNG. |
| `find_nodes {query?, type?}` | Tìm node toàn project. |
| `get_flows {page?}` | Luồng màn hình: JSON + mermaid + bảng. |
| `get_asset {asset, includeImage?}` | Đường dẫn PNG (và ảnh) của asset. |
| `render_frame {frame, scale?, savePath?, device?}` | Ảnh PNG frame đúng như app render (cần app). `device` = iphone15/iphoneSE/galaxyS/pixel/ipad/tablet/fold: render như trên máy đó (CanvasScaler + anchor + safe area). |
| `auto_anchor {frame, apply?, overwrite?, safeArea?, centerBand?, edgeBand?}` | Tự đặt anchor theo rule vị trí (nửa trên → Top, nửa dưới → Bottom, trái/phải, giữa, nền → stretch, sát mép → safe area). |
| `simulate_frame {frame, devices?, match?, allNodes?}` | Mô phỏng nhiều tỷ lệ màn hình, báo node tràn màn / lấn tai thỏ (không cần app). |
| `compare_frame {frame, capturePath, threshold?, maxShift?, diffPath?}` | Diff tự động capture Unity ↔ render tool: node lệch (dx,dy), thiếu, khác sprite/font (cần app). |
| `list_components` / `create_component {node, name?}` / `create_instance {component, parent, x?, y?}` / `set_instance_override {instance, child, text?, visible?}` / `detach_instance {node}` | Component master & instance (export → prefab Unity). |
| `add_component_state {component, state, show?}` | Thêm lớp trạng thái normal/hover/pressed/disabled/selected cho component (Unity Button SpriteState). |
| `set_layout {node, layout\|null}` | Auto layout hàng/cột (gap, padding, align, hug) → Unity Layout Group. |
| `set_image_edits {node, edits\|null}` | Crop/lật/xoay/Hue-Sat… không phá huỷ (cần app). |
| `import_psd {paths[], split?, groupIndexes?, includeLooseLayers?, textMode?}` | Import PSD thành frame mới (cần app). `split=true`: mỗi group cấp 1 = một frame. |
| `add_frame {name, width, height, x?, y?, fill?, background?}` | Tạo màn hình mới; `background` = screenshot đặt làm lớp nền 1:1 (khoá) để dựng đè lên. |
| `add_node {type, name, parent, x, y, width?, height?, fill?, text?, fontSize?, color?, file?, crop?, insets?, props?}` / `add_nodes {nodes[]}` | Tạo rect / text / image (cắt từ file ảnh bằng `crop`) / nineslice / group trong frame. |
| `group_nodes {nodes[], name?}` / `delete_node {node}` | Gom nhóm / xoá. |
| `set_node_props {node, props}` | Sửa x/y/w/h, anchor, pivot, insets, text, visible, safeArea, layout, meta... |
| `convert_nine_slice {node, toNineSlice, insets?}` | Đổi image ↔ 9-slice. |
| `add_flow {from, to?, action?, trigger?, delay?, key?, transition?, direction?, duration?, easing?, overlay?}` / `remove_flow {id}` / `set_start_frame {frame}` | Tương tác prototype kiểu Figma: navigate / overlay (popup, dim, đóng khi bấm ngoài) / swap / back / close; trigger click, hover, press, drag, after-delay, key; transition dissolve, smart animate, move/push/slide/scale. |
| `export_layout` | Xuất `export/` (JSON + PNG + preview + preview theo thiết bị + sprite atlas `atlas/` + FLOWS.md + SPEC.md). |
| `save_project {dir?}` / `open_project {dir}` | Quản lý project. |
| `game_guide` | Hướng dẫn nối game HTML5 với UIForge (đọc trước khi dùng các tool game). Chi tiết: [GAME_LINK.md](GAME_LINK.md). |
| `capture_game {root, url?, engine?, game?, viewport?, screens?[], flows?[], only?, dryRun?}` | Chụp UI game đang chạy (Phaser display list / DOM) trong cửa sổ ẩn, nối ảnh về file art trong thư mục game, tạo project `<root>/uiforge` với 1 frame mỗi màn + flows. Recipe lưu ở `<root>/uiforge/capture.json`. |
| `push_game_design {file \| design}` | Đẩy UI game từ JSON `uiforge-game-design` tự dựng (game không capture được). |
| `get_game_changes {root}` | Thay đổi artist đã làm mà game chưa có: art, vị trí, chữ, ẩn/hiện, thêm/xoá, flow, kèm `code` từng element. |
| `sync_game {root, resample?, runAgent?}` | Ghi art đã thay đè lên file của game (backup), art mới vào `uiforge/incoming/`, `uiforge/CHANGES.md` + `changes.json` + `layout/` + `preview/`; `runAgent` chạy Claude Code trong thư mục game để tự áp dụng. |
| `ack_game_changes {root}` | Game đã khớp thiết kế: lấy hiện trạng làm mốc mới. |
| `replace_game_art {root, source \| node \| folder, file?}` | Thay art trong project game (một file nguồn = mọi chỗ dùng đổi theo; thư mục = khớp theo tên). |

## Dựng UX từ ảnh (screenshot / mockup)

Gọi `ux_guide` để lấy quy trình đầy đủ. Tóm tắt: ảnh chỉ làm lớp tham chiếu; dựng bằng shape (rect/ellipse/stroke) + text + group, component hoá phần lặp, auto layout cho danh sách, flow cho điều hướng/popup, auto_anchor cho đa màn hình, render_frame đối chiếu.

Nếu cần asset thật (1:1):

1. `add_frame {name, width, height, background: "<ảnh>.png"}` → frame có lớp `_reference` khoá, kích thước = ảnh.
2. Với từng thành phần: `add_node image` với `file` = ảnh gốc và `crop` = vùng của thành phần (asset cắt ra), hoặc `rect` + `text` cho nút/chữ; dùng `add_nodes` để tạo hàng loạt.
3. `group_nodes` gom nút/panel, `add_flow` gắn tương tác, `auto_anchor` cho đa màn hình.
4. `render_frame` để đối chiếu với ảnh gốc, sửa bằng `set_node_props`; xong thì xoá hoặc ẩn `_reference`.

## Quy trình gợi ý cho Agent Dev (Unity)

1. `project_info` → `get_spec` (đọc một lần).
2. Với từng frame: `get_frame_layout` → dựng hierarchy theo thứ tự `nodes` (cha trước con), gán `unity.*` vào RectTransform, sprite từ `image.file`, border 9-slice từ `image.nineSlice`. Có sẵn script tham khảo `docs/unity/UIForgeLayoutImporter.cs` (đã kiểm chứng trên Unity 2022.3: mọi RectTransform khớp toạ độ layout tuyệt đối; `docs/unity/UIForgeVerify.cs` là script batch-mode dùng để kiểm tra lại, cần package com.unity.ugui + com.unity.nuget.newtonsoft-json).
3. `get_flows` → sinh điều hướng (Button → mở màn đích, transition).
4. `render_frame` (hoặc `<frame>_preview.png` trong `export/`) để đối chiếu kết quả dựng với thiết kế.
5. Chụp Canvas trong Unity (`UIForgeCapture.cs`) rồi `compare_frame` → sửa đúng node bị báo lệch; `simulate_frame` để kiểm tra safe area / nhiều tỷ lệ trước khi build.
6. Sửa tay trong Unity xong có thể `UIForge > Push Layout To Design` (`UIForgeSync.cs`) để đẩy RectTransform ngược về tool (two-way sync, qua bridge `apply`).

## Bảo mật

Bridge chỉ bind `127.0.0.1`, không có xác thực: bất kỳ process trên máy đều gọi được. Không mở port này ra mạng.

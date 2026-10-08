# UIForge ↔ game HTML5 (Game Link)

Đưa UI của một game web/H5 lên UIForge để xem toàn bộ màn hình + flow, thay art, rồi đưa thay đổi ngược về game.

```
game ──capture_game / push_game_design──▶ UIForge (project ở <game>/uiforge/)
                                            │  artist: xem màn + flow, thay art, kéo lại vị trí
game ◀──────────── Sync → Game ─────────────┘  (ghi đè file art + uiforge/CHANGES.md cho agent của game)
```

Mỗi game có một project UIForge riêng nằm trong `<thư mục game>/uiforge/` (`project.json` + `assets/`). Mọi tool dưới đây nhận `root` = đường dẫn tuyệt đối tới thư mục game.

## 1. Đưa UI của game lên app — `capture_game`

App tự mở game trong một cửa sổ ẩn, đi tới từng màn bằng đoạn JS bạn đưa, chụp ảnh và đọc element:

- **Phaser 3**: đọc display list của các scene đang chạy (Image, Sprite, NineSlice, Text, Container, Rectangle, Graphics…). Ảnh được nối về đúng file nguồn trong thư mục game (texture → URL → file).
- **DOM/CSS**: đọc cây DOM dưới `root` (img, background-image, border-image → 9-slice, màu nền/bo góc → rect, chữ → text). Mỗi element kèm `code: "css: <selector>"`.
- Thứ vẽ bằng code (Graphics, canvas, gradient, Spine) không có file nguồn → thành ảnh cắt từ screenshot (`snapshot`), vẫn thay art được.

Việc cần làm:

1. Chạy dev server của game (đúng cổng trong `.claude/launch.json`).
2. Tìm cách tới từng màn bằng JS: hook debug có sẵn (`window.__game.scene.start('Lobby')`, `show('menu', true)`, `state.phase = 'won'`…), tham số URL, hoặc click giả. Không có hook thì thêm một hook debug nhỏ vào game (chỉ bật ở dev).
3. Gọi `capture_game` với recipe. Lần đầu nên `dryRun: true` để xem id các element, sau đó thêm `flows` và gọi lại.

```jsonc
{
  "root": "F:/Youtube Playables/games/nova-bounce",
  "name": "Nova Bounce",
  "url": "http://localhost:3133/",
  "engine": "phaser",              // "phaser" | "dom" | "auto"
  "game": "window.__game",         // Phaser.Game (bỏ trống = tự tìm)
  "viewport": { "width": 720, "height": 1280 },   // = độ phân giải thiết kế của game
  "settleMs": 1500,
  "exclude": ["^particle", "debug"],              // regex theo id / tên / texture key
  "screens": [
    { "id": "lobby", "name": "Lobby", "enter": "window.__game.scene.start('Lobby')", "waitFor": "window.__game.scene.isActive('Lobby')" },
    { "id": "board", "name": "Gameplay HUD", "enter": "window.__game.scene.start('Board')", "waitMs": 1200, "exclude": ["enemy", "ball"] },
    { "id": "pause", "name": "Pause", "kind": "popup", "enter": "window.__game.scene.launch('Pause')", "scenes": ["Pause"] },
    // game DOM: root = selector của màn; clip "elements" = frame ôm vừa popup
    { "id": "victory", "kind": "popup", "engine": "dom", "root": "#victory", "clip": "elements", "enter": "show('victory', true)" }
  ],
  "components": [
    { "name": "btn_primary", "match": "btn_(play|retry|claim)$", "code": "src/game/ui.ts button()" }
  ],
  "flows": [
    { "from": "lobby/btn_play", "to": "board" },
    { "from": "board/btn_pause", "to": "pause", "action": "overlay" },
    { "from": "pause/btn_resume", "action": "close" }
  ],
  "start": "lobby"
}
```

- `enter` chạy trong trang (dùng được `await`); `reload: true` nếu màn cần tải lại trang; `waitFor` là biểu thức JS được thăm dò tới khi true.
- **Font**: mọi webfont game khai báo (`@font-face`, hoặc FontFace nạp bằng script và khớp được file theo tên) được chép vào `<root>/uiforge/fonts/<family>.<ext>` và app dùng ngay (không cần khởi động lại); export / Unity TMP lấy chúng như font project. Family có nhiều kiểu (bold/italic) chỉ lấy một file; font không lấy được hiện trong `fonts.warnings` — chép tay vào `uiforge/fonts/` với tên file = tên family.
- Recipe được lưu ở `<root>/uiforge/capture.json`; lần sau chỉ cần `capture_game { "root": "…" }`.
- **Tốc độ**: capture lại chỉ màn đang sửa bằng `only: ["gear"]` (1–2 s thay vì cả game); cửa sổ game được giữ sống ~4 phút giữa các lần gọi nên không phải load lại (`fresh: true` nếu muốn load mới); có `waitFor` chính xác thì đặt `waitMs: 100`, game load nhanh thì `settleMs: 600`. File art không đổi (mtime + size) được lấy từ cache, không đọc lại.
- Kết quả trả về: số element mỗi màn, cây id (để viết `flows`), cảnh báo (ảnh không tìm thấy file nguồn → thêm `assetRoots`, ví dụ `["public"]`).
- Id element phải ổn định giữa các lần capture: đặt `name` cho game object Phaser / `id` cho element DOM quan trọng (nút, panel). Id tự sinh dựa trên tên texture + thứ tự.
- `flows.from`: `"<màn>/<id element>"` (khớp cả phần đuôi id hoặc tên), hoặc id màn (trigger cấp màn). `action`: navigate (mặc định) · overlay · swap · back · close.
- Chỉ capture những màn có thật trong game. Thêm mọi màn + popup: artist cần thấy toàn bộ.

Kiểm tra: `render_frame { frame: "<tên màn>" }` trả ảnh app dựng lại; so với `uiforge/capture/<id>.png`.

### Game không capture tự động được — `push_game_design`

Tự dựng JSON `uiforge-game-design` (UI vẽ hết trên canvas bằng code, engine lạ…) rồi đẩy bằng `push_game_design { file }`:

```jsonc
{
  "schema": "uiforge-game-design", "version": 1,
  "game": { "name": "Koi Ascend", "root": "F:/…/games/koi-ascend", "engine": "canvas2d" },
  "screens": [{
    "id": "title", "name": "Title", "width": 720, "height": 1280, "kind": "screen",
    "screenshot": "uiforge/capture/title.png",          // ảnh game thật (nền tham chiếu, khoá)
    "elements": [                                         // dưới → trên; x,y,width,height tuyệt đối trong màn
      { "id": "logo", "type": "image", "x": 110, "y": 180, "width": 500, "height": 220, "asset": "assets/logo.png", "code": "src/main.js:212" },
      { "id": "btn_play", "type": "image", "x": 210, "y": 900, "width": 300, "height": 110, "snapshot": true, "interactive": true, "code": "src/main.js drawButton('play')" },
      { "id": "txt_best", "type": "text", "x": 260, "y": 60, "width": 200, "height": 40, "text": "BEST 120", "fontSize": 32, "color": "#ffffff" },
      { "id": "panel", "type": "group", "x": 60, "y": 400, "width": 600, "height": 300, "children": [ … ] }
    ]
  }],
  "flows": [{ "from": "title/btn_play", "to": "hud" }]
}
```

`type`: image · nineslice (`insets` theo px ảnh nguồn) · text · rect (`fill`, `cornerRadius`, `shape: "ellipse"`) · group. `asset` = file art tương đối so với `root` (`crop` nếu chỉ dùng một vùng của atlas/sprite sheet); không có file thì `snapshot: true`. `code` = chỗ trong source đặt element này — agent áp thay đổi sẽ sửa đúng chỗ đó.

Push lại bao nhiêu lần cũng được: element artist chưa đụng thì đi theo game; element đã chỉnh trong app thì giữ nguyên bản chỉnh (vẫn nằm trong danh sách chờ sync).

## Component — widget dùng chung của game

**Mindset**: thứ gì trong game được dựng bằng *cùng một đoạn code* (hàm `button()`, prefab, class `ShopItem`, CSS `.btn-primary`…) thì trong app là **một component**: một master + nhiều instance. Artist sửa master (dời chữ, thay art, đổi cỡ) là mọi chỗ đổi theo, và `CHANGES.md` chỉ ghi **một** mục cho component kèm chỗ code dựng nó → agent sửa đúng một chỗ trong code. Thứ chỉ xuất hiện một lần, hoặc giống nhau nhưng code dựng riêng từng chỗ, thì không phải component.

**Trong app**: master nằm trong frame **Components** (cạnh các màn, page Game UI). Instance ở các màn có:
- override riêng: chữ, cỡ chữ, ẩn/hiện, ảnh (chuột phải phần trong instance → Thay ảnh…);
- kích thước riêng: thu/phóng đều thì cả component co giãn; đổi tỉ lệ thì từng phần bám anchor như RectTransform (nền phủ kín → giãn, chữ căn giữa → giãn ngang, còn lại bám cạnh gần nhất).
Thay file art của master (tab Game) = mọi instance đổi theo.

**Component đến từ đâu** (theo thứ tự ưu tiên):
1. Game khai báo: recipe `components: [{ "name": "btn_primary", "match": "btn_(play|shop|claim)$", "code": "src/ui/widgets.ts button()" }]` — `match` là regex theo id/tên **group** (Phaser Container, element DOM có con). `push_game_design`: đặt `"component": "<name>"` trên element.
2. Đã là component ở lần push trước → giữ nguyên (kể cả khi `only` chỉ capture vài màn).
3. Tự phát hiện (`autoComponents`, mặc định bật): group lặp lại ≥ 2 lần với cùng cấu trúc + cùng art, chỉ khác chữ / kích thước tổng / phần ẩn. Tên lấy từ phần chung của tên element. Tắt bằng `autoComponents: false` nếu game không có widget dùng chung thật.

**Agent của game nên làm khi capture**:
- Đọc code tìm các widget factory (hàm tạo nút, panel, item danh sách, popup khung, thanh HUD…) → khai báo mỗi cái một rule trong `components` với `code` trỏ đúng hàm/file. Tên component = tên widget trong code.
- Đặt tên ổn định cho object widget trong code game (Phaser `setName`, DOM `id`/`data-ui`) để `match` bắt được và id không đổi giữa các lần capture.
- Sau capture xem `pushed.componentsFound` (tên, số chỗ dùng, nguồn `rule`/`auto`): component tự phát hiện sai (hai thứ khác nhau bị gộp, hoặc một widget bị tách vì khác art như huy hiệu hạng 1/2/3) → sửa bằng rule rõ ràng.
- Game mới: dựng UI bằng widget factory dùng chung ngay từ đầu (một hàm cho mỗi loại nút/panel/item, nhận text/icon làm tham số) — đó chính là component, và là thứ UIForge chỉnh được tập trung.

**Khi áp dụng thay đổi** (`CHANGES.md` mục "Component dùng chung"): toạ độ tính từ góc trên-trái component; sửa trong widget factory (mục `code`), không sửa từng màn. Mục `› phần` trong một màn là override của riêng instance đó (vd chữ của một nút) → sửa tham số truyền vào widget ở chỗ đó.

## Art agent — gen lại art UI (CLI)

Cho agent chạy tool bằng terminal (Agent Studio / Art Lead): `node F:/Figma_clone/Figma_clone/out/cli/uiforge.mjs <lệnh>`. Mỗi lệnh in **một dòng JSON**; exit `0` ok · `1` lỗi · `3` cần người xem. Không cần MCP.

1. **`list-assets --root <game>`** → `uiforge/ASSETS.json` + `ASSETS.md` + `assets.csv` (cùng cột với asset-inventory của studio, `nine_slice_LBRT` = trái,dưới,phải,trên) + `ASSETS.png` (ảnh tổng hợp đánh số). Mỗi asset: `stageName` (tên lưu art mới), kích thước px, 9-slice insets, vai trò (button/panel/icon/bar/badge/…), số chỗ hiện, component, màn dùng, ảnh hiện tại. `kind: "drawn"` = game vẽ bằng code/cắt atlas → không có file, art mới vào `uiforge/incoming/`. Sắp theo mức hiển thị: làm từ đầu danh sách.
2. Gen art theo brief (style chung + ảnh tham chiếu từ `ASSETS.png` / preview). Nền trắng phẳng là được.
3. **`fit-art --in <ảnh gen> --root <game> --target <stageName|file game|#số> [--out <png>]`** → PNG trong suốt **đúng px** của asset: cắt nền trắng/vignette nối với mép ảnh, bỏ đốm nhỏ (watermark ✦), trim, căn giữa (`--mode contain` mặc định; `cover`; `stretch`). Khung 9-slice mặc định lấp đầy khung và được kiểm: phần giữa theo chiều giãn phải phẳng → không đạt thì `needs_review` + exit 3. Không ghi đè (`--force`). Mặc định ra `<thư mục ảnh>/fit/<stageName>.png`.
4. **`stage-art --root <game> --folder <thư mục fit/> [--dry-run]`** → art vào **project UIForge** (khớp theo `stageName`), **không ghi vào game**. **Nhiều bản cho một asset** (`<stageName>_v1.png`, `_v2`, `_v3`…; fit-art với `--out` tên đó) → thành **phương án**: tab Game → "Phương án chờ chọn", bấm từng bản để xem trên mọi màn, "Xem cả bộ: v2" đổi mọi asset cùng lúc, **Chọn** / **Giữ gốc**. Sync bị chặn khi còn bản đang xem thử chưa chốt. `variants --root <game> [--since <ngày>]` (MCP `get_art_variants`) trả phương án đang chờ + board đã chọn / loại bản nào (để agent học gu). Mở app nếu chưa chạy (không mở được → exit 3). Loi xem trong app (tab Game / các màn) → **Sync → Game** mới ghi vào game; đó là bước duyệt.

MCP có `list_game_assets {root}` (bảng / JSON) cho session Claude Code thường.

## 2. Thay art trong app

- Tab **Game** (panel trái): danh sách file art của game đang dùng trong UI. Kéo-thả ảnh vào một dòng, hoặc bấm **Thay…**; một file thay = mọi chỗ dùng file đó đổi theo.
- **Thay từ thư mục…**: chọn thư mục art mới, khớp theo tên file (`ui_btn_primary.png` → `public/assets/ui/ui_btn_primary.webp`), không khớp file nào thì khớp theo id/tên element (dùng cho thứ vẽ bằng code).
- Chuột phải một node → **Thay ảnh…** (image, 9-slice, rect, text, ảnh snapshot).
- Art mới khác tỉ lệ: node giữ tâm, co vừa khung cũ. Kéo lại vị trí/kích thước tuỳ ý — đó là thay đổi layout gửi về game.
- MCP: `replace_game_art { root, source | node, file }` hoặc `{ root, folder }`.

## 3. Sync → Game

Nút **Sync → Game** (thanh trên, tab Game) hoặc tool `sync_game`:

- File art có nguồn trong game bị **ghi đè tại chỗ** (bản cũ lưu ở `uiforge/backup/rev<N>/…`). Art mới cùng tỉ lệ nhưng khác kích thước pixel được thu về kích thước cũ → game chạy đúng ngay, không cần sửa code (tắt bằng `resample: false`).
- Art cho element chưa có file (vẽ bằng code, vùng atlas, element mới) → `uiforge/incoming/<màn>__<element>.png`.
- `uiforge/CHANGES.md` + `changes.json`: mọi thay đổi so với lần push gần nhất (dời/đổi cỡ, art, chữ, ẩn/hiện, thêm, xoá, flow), kèm `code` của từng element.
- `uiforge/layout/<màn>.json`: toạ độ đích của mọi element; `uiforge/preview/<màn>.png`: ảnh đích.
- Bật **Chạy agent của game**: app chạy `claude -p` trong thư mục game với prompt áp dụng `CHANGES.md`.

## 4. Agent của game áp dụng thay đổi

1. Đọc `uiforge/CHANGES.md` (hoặc `get_game_changes { root }`).
2. "ĐÃ GHI ĐÈ": file đã đúng chỗ; chỉ sửa code nếu kích thước ảnh đổi. "ẢNH MỚI": chép từ `uiforge/incoming/` vào thư mục asset của game, nạp và dùng cho đúng element.
3. Sửa vị trí/kích thước/chữ/ẩn-hiện/thêm/xoá đúng chỗ ghi ở `code`; giữ cơ chế responsive sẵn có; không đổi gameplay.
4. Chạy build/test của game.
5. Gọi `capture_game { root }` để đẩy lại UI thật — app lấy đó làm mốc mới, thứ gì còn lệch sẽ vẫn hiện trong danh sách chờ. Không capture được thì `ack_game_changes { root }`.

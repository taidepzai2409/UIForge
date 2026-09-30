---
description: Dựng lại UX (wireframe) từ ảnh giao diện đã dán, bằng MCP uiforge-design
argument-hint: [tên màn hình hoặc ghi chú, tuỳ chọn]
---
Người dùng vừa dán một (hoặc nhiều) ảnh giao diện game/app. Hãy dựng lại UX của ảnh đó trong UIForge qua MCP `uiforge-design`. Ghi chú thêm từ người dùng: $ARGUMENTS

Làm theo đúng thứ tự:
1. Gọi `ux_guide` và làm theo (app tự mở nếu chưa chạy; nếu chưa có project thì gọi `project_info`, còn lỗi thì `launch_app`).
2. Quan sát ảnh: liệt kê các vùng UI (HUD, panel, hàng nút, danh sách, popup) và thành phần lặp lại. Kích thước frame chuẩn: dọc 1080×1920, ngang 1920×1080 (luôn 16:9, kể cả khi ảnh dài hơn — scale toạ độ theo chiều rộng nếu dọc, chiều cao nếu ngang; phần dư của ảnh dài để node neo theo mép).
3. `add_frame` cho từng màn hình / popup CÓ TRONG ẢNH — tuyệt đối không tự bịa thêm popup, màn phụ, nội dung không nhìn thấy (không dùng `background` trừ khi người dùng đưa đường dẫn file).
4. Dựng bằng `add_nodes`: rect (fill màu gần đúng, cornerRadius, stroke, ellipse cho icon tròn) + text (nội dung thật) + group theo vùng, tên node có nghĩa (btn_play, panel_shop, txt_title, hud_top…). Không cắt ảnh.
5. Thành phần lặp (nút cùng kiểu, item danh sách, tab): dựng một cái → `create_component` → `create_instance` cho các bản còn lại → `set_instance_override` đổi chữ. Hàng/cột đều nhau → `set_layout`.
6. `add_flow` chỉ khi đích thật sự có trong ảnh (overlay có dim, đóng khi bấm ngoài; nút X → close; back → back); nút chưa rõ đích thì bỏ qua và liệt kê. Đặt `set_start_frame`.
7. `auto_anchor` cho từng frame, `simulate_frame` (mặc định scaler expand, không đè) để chắc không tràn/đè, rồi `render_frame` (scale 0.25) từng màn để tự kiểm tra bố cục so với ảnh; sửa bằng `set_node_props` nếu lệch rõ.
8. `save_project`. Trả lời ngắn gọn bằng tiếng Việt: danh sách frame, component, flow đã tạo và những chỗ ước lượng (màu, font, kích thước) để người dùng chỉnh.

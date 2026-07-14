"use client";

import { createContext, useContext, useState, useEffect } from "react";

const I18nContext = createContext(null);

export const translations = {
  en: {
    // Common
    lang_btn: "🌐 EN / VI",
    back: "Back",
    save: "Save",
    host: "Host",
    delete: "Delete",
    edit: "Edit",
    close: "Close",
    seconds: "seconds",
    coins: "coins",
    left: "left",
    save_changes: "Save Changes",
    load: "Load",

    // HomePage
    game_title: "Brain Kingdom",
    game_subtitle: "Local-first trap puzzles, one-way REST sync, and cute chaos.",
    profile: "Profile",
    enter_username: "Enter username",
    save_username: "Save Username",
    create_quiz_set: "Create Quiz Set",
    join_room: "Join Room",
    room_code_placeholder: "6-character code",
    enter_match: "Enter Match",

    // CreatePage
    editor_title: "Doodle Quiz Editor",
    editor_subtitle: "Draw, write, place traps, and compile your custom set.",
    quiz_title_placeholder: "Quiz title",
    quick_presets: "Quick Presets",
    questions_list: "Questions List",
    add_question: "Add Question",
    upload_pdf: "Upload PDF / Slide",
    question_settings: "Question Settings",
    prompt_placeholder: "Question Prompt",
    note_placeholder: "Question Note / Correct Answer Details",
    duration_label: "Duration (seconds)",
    canvas_image_url: "Canvas Image URL",
    fit_contain: "Contain (fit)",
    fit_cover: "Cover (fill)",
    fit_fill: "Stretch",
    import_export: "Import / Export",
    export_json: "Export JSON",
    import_json: "Import JSON",
    download_zip: "Download ZIP Package",
    import_zip: "Import ZIP Package",
    export_pdf: "Export PDF / Slide",
    block_palette: "Block Palette",
    no_questions: "No questions added yet.",
    elements_in_q: "Elements in this question:",
    save_draft: "Save Draft",
    load_drafts: "Load Drafts",
    close_drafts: "Close",
    host_now: "Host Now",
    brush_mode: "Brush Mode",
    brush_normal: "Freehand",
    brush_fill: "Bucket Fill",
    brush_color: "Brush Color",
    brush_size: "Brush Size",
    blank_text: "Blank Text (Correct)",
    placeholder_text: "Placeholder",
    target_val: "Target Val",
    allowed_margin: "Allowed Margin",
    min_val: "Min",
    max_val: "Max",
    step_val: "Step",
    correct_value: "Correct Value",
    labels_type: "Labels Type",
    labels_numbers: "Numbers",
    labels_custom: "Custom List (comma separated)",
    shape_type: "Shape Type",
    shape_rect: "Rectangle",
    shape_circle: "Circle",
    shape_triangle: "Triangle",
    cover_text: "Cover Text",
    movable_by_player: "Movable by Player",
    text_content: "Text Content",
    font_size: "Font Size",
    preset_overlay_trap: "The Overlay Trap",
    preset_microscopic: "Microscopic Quest",
    preset_gauge: "Gauge Guess",
    quick_paste: "Quick Paste Questions",
    quick_paste_instructions: "Paste questions and A. B. C. D. options separated by --- lines.",
    no_drafts_desc: "No saved drafts yet. Click 💾 Save to create one.",
    ai_creator: "🤖 Generate with AI",
    tools_header: "🧱 TOOLS",

    // Palette items
    "palette_pan_label": "Pan",
    "palette_pan_desc": "Drag to pan · Scroll to zoom",
    "palette_draw-target_label": "Zone",
    "palette_draw-target_desc": "Draw a correct answer zone (freeform or rectangle)",
    "palette_draw-brush_label": "Brush",
    "palette_draw-brush_desc": "Freehand drawing on the canvas · pick a color and size below",
    "palette_place-text_label": "Text Block",
    "palette_place-text_desc": "Click canvas to place a static text label",
    "palette_place-answer_label": "Cover Block",
    "palette_place-answer_desc": "Place a draggable cover block players must move to reveal the answer",
    "palette_place-shape_label": "Shape",
    "palette_place-shape_desc": "Click canvas to place hand-drawn shapes (rect, circle, triangle)",
    "palette_place-gauge_label": "Gauge",
    "palette_place-gauge_desc": "Click canvas to place a numerical slider or custom list",
    "palette_place-blank_label": "Blank",
    "palette_place-blank_desc": "Click canvas to place a Fill-in-the-Blank input field",

    // RoomPage
    spectating_host: "Spectating as Host 👑",
    waiting_host: "⏳ Waiting for host to start the round...",
    round_ended_waiting: "Round ended. Waiting for next question...",
    round_label: "Round",
    leave: "Leave",
    spectator_arena: "Spectator Arena 🏟️",
    active_players: "Active Players",
    start_quiz_btn: "🚀 Start Quiz Room",
    end_room_btn: "🏁 End Room & Archive",
    end_room_plain: "🏁 End Room",
    next_question_in: "⏭ Next question in",
    waiting_next_question: "Waiting for next question...",
    view_canvas: "👁 View Canvas",
    close_btn: "❌ Close",
    correct_answers_title: "👁 View Question Answers",
    submitting_pill: "⏳ Timeout! Saving results...",
    bankrupt_title: "BANKRUPT!",
    bankrupt_desc: "You ran out of coins and are eliminated.",
    bankrupt_spectate: "Spectate the remaining rounds.",
    bankrupt_view_canvas: "👁 View Canvas & Answer",
    submitted_waiting_overlay: "📥 ANSWER SUBMITTED!",
    waiting_opponents: "Waiting for opponents to finish...",
    timeout_in: "Timeout in",
    lobby_title: "Brain Kingdom - Lobby",
    quiz_room: "Quiz Room:",
    players_joined: "Players Joined:",
    bet_label: "Bet",
    start_game_prompt: "Start the game when everyone has joined!",
    waiting_host_to_start: "Waiting for host to start the game...",
    submitted_pill: "📥 SUBMITTED!",
    timeout_pill: "⏰ TIME OUT!",
    final_scorecard: "🏆 Final Scorecard",
    round_scorecard: "📊 Round Scorecard",
    correct: "CORRECT!",
    incorrect: "INCORRECT!",
    win_coins: "You won",
    lose_coins: "You lost",
    current_balance: "Balance:",
    coins_unit: "coins",
    play_again: "Play Again",
    enter_name_modal: "Enter Name",
    choose_avatar: "Choose your character",
    confirm_name: "Confirm",
    spectating_spectator: "Spectating...",
    running_status: "Running",
    jumping_status: "Jumping",
    crashed_status: "Crashed",
    eliminated_status: "Eliminated",
    submitted_status: "Submitted",
    waiting_status: "Waiting",
    host_controls: "Host Controls",
    next_round_auto: "Next round will start automatically in {sec}s...",
    quiz_completed_spectate: "Quiz completed! Spectate the final leaderboard.",
    status: "Status",
    prev: "Prev",
    next: "Next",
    question_label: "Question",
    setup_character: "Setup Character 🎨",
    enter_name_placeholder: "Your nickname...",
    choose_avatar_desc: "👉 Choose your avatar (36 options):",
  },
  vi: {
    // Common
    lang_btn: "🌐 VI / EN",
    back: "Quay lại",
    save: "Lưu",
    host: "Bắt đầu",
    delete: "Xóa",
    edit: "Sửa",
    close: "Đóng",
    seconds: "giây",
    coins: "xu",
    left: "còn lại",
    save_changes: "Lưu thay đổi",
    load: "Mở",

    // HomePage
    game_title: "Brain Kingdom",
    game_subtitle: "Trò chơi câu đố đầy cạm bẫy, đồng bộ hóa thời gian thực và đầy bất ngờ thú vị.",
    profile: "Hồ sơ",
    enter_username: "Nhập tên người chơi",
    save_username: "Lưu tên",
    create_quiz_set: "Tạo bộ câu hỏi",
    join_room: "Vào phòng",
    room_code_placeholder: "Mã phòng 6 ký tự",
    enter_match: "Vào phòng chơi",

    // CreatePage
    editor_title: "Bộ biên tập câu hỏi Doodle",
    editor_subtitle: "Vẽ, viết, đặt cạm bẫy và biên soạn bộ câu hỏi của bạn.",
    quiz_title_placeholder: "Tiêu đề bộ câu hỏi",
    quick_presets: "Mẫu câu hỏi nhanh",
    questions_list: "Danh sách câu hỏi",
    add_question: "Thêm câu hỏi",
    upload_pdf: "Tải lên PDF / Slide",
    question_settings: "Cấu hình câu hỏi",
    prompt_placeholder: "Đề bài câu hỏi",
    note_placeholder: "Ghi chú câu hỏi / Đáp án chi tiết",
    duration_label: "Thời gian (giây)",
    canvas_image_url: "Đường dẫn ảnh nền Canvas",
    fit_contain: "Thu nhỏ vừa khít (contain)",
    fit_cover: "Phủ kín canvas (cover)",
    fit_fill: "Kéo giãn (stretch)",
    import_export: "Nhập / Xuất",
    export_json: "Xuất file JSON",
    import_json: "Nhập file JSON",
    download_zip: "Tải gói file ZIP",
    import_zip: "Nhập gói file ZIP",
    export_pdf: "Xuất tài liệu PDF / Slide",
    block_palette: "Thanh công cụ vật thể",
    no_questions: "Chưa có câu hỏi nào được thêm.",
    elements_in_q: "Các vật thể trong câu hỏi:",
    save_draft: "Lưu Nháp",
    load_drafts: "Tải Bản Nháp",
    close_drafts: "Đóng",
    host_now: "Bắt đầu Host",
    brush_mode: "Chế độ cọ vẽ",
    brush_normal: "Vẽ tự do",
    brush_fill: "Tô màu nền",
    brush_color: "Màu cọ vẽ",
    brush_size: "Kích thước cọ",
    blank_text: "Chữ điền đúng",
    placeholder_text: "Chữ gợi ý",
    target_val: "Giá trị nhắm",
    allowed_margin: "Dung sai cho phép",
    min_val: "Tối thiểu",
    max_val: "Tối đa",
    step_val: "Bước nhảy",
    correct_value: "Giá trị đúng",
    labels_type: "Kiểu nhãn",
    labels_numbers: "Số",
    labels_custom: "Danh sách tùy chỉnh (cách nhau bằng dấu phẩy)",
    shape_type: "Kiểu hình khối",
    shape_rect: "Hình chữ nhật",
    shape_circle: "Hình tròn",
    shape_triangle: "Hình tam giác",
    cover_text: "Chữ che phủ",
    movable_by_player: "Người chơi di chuyển được",
    text_content: "Nội dung chữ",
    font_size: "Cỡ chữ",
    preset_overlay_trap: "Cạm bẫy che phủ",
    preset_microscopic: "Truy tìm siêu nhỏ",
    preset_gauge: "Đo lường ước lượng",
    quick_paste: "Dán nhanh danh sách câu hỏi",
    quick_paste_instructions: "Dán câu hỏi và các lựa chọn A. B. C. D. cách nhau bởi dòng ---.",
    no_drafts_desc: "Chưa có bản nháp nào. Bấm 💾 Save để lưu nháp.",
    ai_creator: "🤖 Tạo bằng AI",
    tools_header: "🧱 CÔNG CỤ",

    // Palette items
    "palette_pan_label": "Di chuyển",
    "palette_pan_desc": "Kéo để di chuyển · Cuộn để thu phóng",
    "palette_draw-target_label": "Vùng đáp án",
    "palette_draw-target_desc": "Vẽ vùng đáp án đúng (tự do hoặc hình chữ nhật)",
    "palette_draw-brush_label": "Bút vẽ",
    "palette_draw-brush_desc": "Vẽ tự do trên canvas · chọn màu sắc và kích thước dưới đây",
    "palette_place-text_label": "Khối chữ",
    "palette_place-text_desc": "Nhấp canvas để đặt nhãn văn bản cố định",
    "palette_place-answer_label": "Khối che",
    "palette_place-answer_desc": "Đặt khối che phủ di chuyển được mà người chơi phải dời đi để xem đáp án",
    "palette_place-shape_label": "Hình vẽ",
    "palette_place-shape_desc": "Nhấp canvas để đặt các hình vẽ tay (chữ nhật, tròn, tam giác)",
    "palette_place-gauge_label": "Thước đo",
    "palette_place-gauge_desc": "Nhấp canvas để đặt thanh trượt số hoặc danh sách tùy chỉnh",
    "palette_place-blank_label": "Chỗ trống",
    "palette_place-blank_desc": "Nhấp canvas để đặt ô nhập từ trống",

    // RoomPage
    spectating_host: "Đang theo dõi dưới vai trò Host 👑",
    waiting_host: "⏳ Đang chờ host bắt đầu vòng chơi...",
    round_ended_waiting: "Vòng chơi kết thúc. Đang chờ câu hỏi tiếp theo...",
    round_label: "Vòng",
    leave: "Thoát",
    spectator_arena: "Đấu trường quan sát 🏟️",
    active_players: "Người chơi đang chạy",
    start_quiz_btn: "🚀 Bắt đầu Quiz Room",
    end_room_btn: "🏁 Kết thúc phòng & Lưu trữ",
    end_room_plain: "🏁 Kết thúc phòng",
    next_question_in: "⏭ Câu hỏi tiếp theo trong",
    waiting_next_question: "Đang chờ câu hỏi tiếp theo...",
    view_canvas: "👁 Xem đáp án",
    close_btn: "❌ Đóng",
    correct_answers_title: "👁 Xem Đáp Án Câu Hỏi",
    submitting_pill: "⏳ Hết giờ! Đang lưu kết quả...",
    bankrupt_title: "PHÁ SẢN!",
    bankrupt_desc: "Bạn đã hết xu và bị loại khỏi cuộc chơi.",
    bankrupt_spectate: "Theo dõi các vòng chơi còn lại.",
    bankrupt_view_canvas: "👁 Xem Canvas & Đáp án",
    submitted_waiting_overlay: "📥 ĐÃ GỬI BÀI LÀM!",
    waiting_opponents: "Đang chờ đối thủ hoàn thành...",
    timeout_in: "Hết giờ sau",
    lobby_title: "Brain Kingdom - Phòng chờ",
    quiz_room: "Phòng chơi:",
    players_joined: "Người chơi đã vào:",
    bet_label: "Mức đặt cược",
    start_game_prompt: "Bắt đầu trò chơi khi mọi người đã vào phòng!",
    waiting_host_to_start: "Đang chờ host bắt đầu trò chơi...",
    submitted_pill: "📥 ĐÃ GỬI BÀI!",
    timeout_pill: "⏰ HẾT GIỜ!",
    final_scorecard: "🏆 Bảng điểm chung cuộc",
    round_scorecard: "📊 Bảng điểm vòng đấu",
    correct: "CHÍNH XÁC!",
    incorrect: "SAI RỒI!",
    win_coins: "Bạn nhận được",
    lose_coins: "Bạn bị trừ",
    current_balance: "Số dư:",
    coins_unit: "xu",
    play_again: "Chơi lại",
    enter_name_modal: "Nhập tên",
    choose_avatar: "Chọn nhân vật của bạn",
    confirm_name: "Xác nhận",
    spectating_spectator: "Đang quan sát...",
    running_status: "Đang chạy",
    jumping_status: "Đang nhảy",
    crashed_status: "Va chạm",
    eliminated_status: "Bị loại",
    submitted_status: "Đã nộp",
    waiting_status: "Đang chờ",
    host_controls: "Quản lý của Host",
    next_round_auto: "Vòng tiếp theo sẽ tự động bắt đầu sau {sec}s...",
    quiz_completed_spectate: "Bộ câu hỏi hoàn thành! Xem bảng xếp hạng chung cuộc.",
    status: "Trạng thái",
    prev: "Trước",
    next: "Sau",
    question_label: "Câu hỏi",
    setup_character: "Thiết lập Nhân vật 🎨",
    enter_name_placeholder: "Biệt danh của bạn...",
    choose_avatar_desc: "👉 Chọn con vật đại diện của bạn (36 lựa chọn):",
  }
};

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState("en");

  // set language manually (stores in local storage)
  function setLang(newLang) {
    setLangState(newLang);
    localStorage.setItem("cutequiz:lang", newLang);
    localStorage.setItem("cutequiz:lang_manually_set", "true");
  }

  useEffect(() => {
    // 1. Check local storage
    const stored = localStorage.getItem("cutequiz:lang");
    if (stored) {
      setLangState(stored);
      return;
    }

    // 2. Check browser language navigator.language
    const navLang = navigator.language || "";
    if (navLang.toLowerCase().includes("vi")) {
      setLangState("vi");
      return;
    }

    // 3. Fallback/lookup by IP country
    async function fetchCountry() {
      try {
        const res = await fetch("https://freeipapi.com/api/json");
        const data = await res.json();
        const country = data.countryCode || data.country_code || "";
        if (country === "VN") {
          setLangState("vi");
          localStorage.setItem("cutequiz:lang", "vi");
        }
      } catch (err) {
        console.warn("Failed to check country IP", err);
      }
    }
    fetchCountry();
  }, []);

  // helper to translate keys
  function t(key) {
    const translation = translations[lang]?.[key];
    if (translation !== undefined) return translation;
    return translations["en"]?.[key] || key;
  }

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return context;
}

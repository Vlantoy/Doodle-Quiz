# noob.md — Cute Quiz PvP

## Rules
- Monorepo npm workspaces: `apps/web` (Next.js 14 App Router, "use client") + `apps/server` (Express + Zod + vitest, ESM `"type": "module"`).
- Test server: `cd apps/server && npx vitest run` → kỳ vọng 25/25 pass (game.test.js 22 + utils.test.js 3).
- Dev: `npm run dev:server` (Express, watch mode) và `npm run dev:web` (Next dev). Chạy ở 2 terminal riêng.
- Build all: `npm run build` (web + server). Start prod server: `npm start`.
- Server LÀ authority chấm điểm. Client KHÔNG BAO GIỜ gửi `isWin`; chỉ gửi `{click:{rx,ry}, gaugeValue, completionMs, bet, playerToken}`. Server re-hit-test bằng `hitTestQuestion` trên payload gốc.
- Mọi tọa độ qua mạng dùng ratio `[0,1]` (rx/ry, x_ratio/w_ratio, points_ratio). KHÔNG gửi pixel — zoom/pan client/server không đồng bộ pixel.
- `submitRoundSchema` BẮT BUỘC `bet: int ≥ 1`. Client phải clamp `Math.max(1, Math.min(balance, bet))` trước khi submit, nếu không server trả 400.
- `stripAnswersFromQuiz` PHẢI chạy trước khi trả bootstrap. Strip: `targetZones`, `gauge.correctMin/correctMax`, elements `PRECISION_TARGET`, elements `FREEFORM_ZONE` với `role==="CORRECT_ANSWER"`. Đừng thêm field đáp án mới mà quên cập nhật strip.
- HMAC `playerToken = roomCode|playerId|sha256(SERVER_SECRET, "roomCode|playerId")`. Verify bằng constant-time compare. Set env `SERVER_SECRET` ở production, KHÔNG commit.
- Hit-test order: duyệt `elements` từ cuối lên đầu (topmost-wins khi vùng chồng), sauđó, sau đó fallback các `targetZones` legacy.
- Creator: FREEFORM_ZONE vẽ bằng `draw-freeform` trong `DoodleCanvas` ở **pen mode** — click để thêm đỉnh, click gần điểm đầu (<0.018 ratio) hoặc Enter để close (≥3 đỉnh), Backspace = undo đỉnh cuối, Esc = hủy. Commit tạo `{type:"FREEFORM_ZONE", role:"CORRECT_ANSWER", points_ratio, isHidden:true}`. PRECISION_TARGET vẫn vẽ kéo-thả bằng `draw-target` → `{type:"PRECISION_TARGET", x_ratio, y_ratio, w_ratio, h_ratio, isHidden:true}`. Mọi element đáp án PHẢI `isHidden:true`.
- Template IDs trong `QUICK_TEMPLATES` phải static (SSR-safe). KHÔNG gọi `crypto.randomUUID()` ở module scope của file Next.js — chỉ gọi trong event handler / useEffect.
- Element ratio luôn clamp `Math.max(0.02, Math.min(1, v))` trong creator để tránh zero-size hoặc tràn canvas.
- `DoodleCanvas` container (`.doodle-board`) PHẢI có `height: C_H` inline để `getBoundingClientRect()` khớp transform wrapper + viewBox `0 0 C_W C_H`. CSS `.doodle-board` có `min-height: 320px` co giãn — nếu không ép height, ratio từ `getHitCoords` sẽ lệch (đỉnh nhích lên trên so với con trỏ).
- Host validate quiz: chỉ cần MỖI question có ít nhất 1 `PRECISION_TARGET` HOẶC 1 `FREEFORM_ZONE` (role CORRECT_ANSWER, ≥3 đỉnh). Không bắt buộc cả hai.
- Web cần env `NEXT_PUBLIC_API_BASE_URL` trỏ tới domain server (xem `apps/web/src/lib/api.js`). Server bật CORS cho origin của web qua env `CORS_ORIGIN` (Express + `cors`).
- Anti double-submit: server check `submit_mask` bitmask theo `roundIndex` + `deadline_at`. Đừng cho phép submit sau deadline.
- RNG payout: win → uniform `[1.20, 3.00]`, loss → `1.0`. Tính server-side qua `computeRngFactor`.

## Notes
- Routes server (đúng theo code hiện tại): `POST /api/rooms/host`, `POST /api/rooms/join` (trả `playerToken`), `GET /api/rooms/:code/bootstrap`, `POST /api/rounds/start` (host-only, header `x-host-secret`), `POST /api/submit-round`, `POST /api/rooms/cleanup` (host-only, header `x-host-secret`), `GET /api/health`, `GET /api/leaderboard`.
- Server listen port mặc định 4000 (`config.port`). Smoke-test: `node -e "fetch('http://localhost:4000/api/health').then(r=>r.json()).then(console.log)"` → `{ok:true, service:'cute-quiz-referee'}`.
- Dev server foreground sẽ block — luôn chạy background. Start prod: `cd apps/server; node src/index.js`.
- Flow: host tạo room → players join nhận `playerToken` → bootstrap (quiz đã strip) → host start-round → players submit → server chấm + cập nhật balance.
- `roomCode` 6 ký tự (nanoid), share để player join.
- Element types đang hỗ trợ: `PRECISION_TARGET`, `FREEFORM_ZONE` (role: CORRECT_ANSWER | DECOY), `DRAWING_STROKE`, `IMAGE_BLOCK`, `GAUGE_BLOCK`, `TEXT_BLOCK`, `ANSWER_BLOCK`.
- GAUGE_BLOCK có `correctMin/correctMax` ở question-level (`question.gauge`), không phảiở element. Khi strip, GAUGE_BLOCK giữ nguyên (không phải answer-revealing).
- `liveElements` trong DoodleCanvas = state local trước commit; `commitElements` mới ghi vào draft/quiz.
- Creator draft lưu localStorage theo UUID, xem `lib/storage.js`.
- Supabase optional: nếu set `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` thì lưu lịch sử room, không thì in-memory.
- Deploy: web → Vercel/Netlify (set `NEXT_PUBLIC_API_BASE_URL`). Server → Railway/Render/Fly (set `SERVER_SECRET`, `PORT`, `CORS_ORIGIN`, optional Supabase env).
- Windows dev: `run_command` chạy PowerShell — dùng `;` thay `&&` để chain lệnh.
- Phase room (client): `lobby` → `active` → `won_waiting`/`submitting` → `results` → loop hoặc `bankrupt`.
- Host xem như presenter, `canvasDisabled` khi `isHost === true` — host không click canvas.

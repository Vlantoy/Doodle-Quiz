# Cute Hand-Drawn Local-First PVP Quiz

Quiz đa người chơi cơ chế Microsoft Whiteboard: host vẽ vùng đáp án (rect/polygon), player click trúng → đúng, click sai → fail. Chấm điểm server-side, anti-cheat bằng HMAC token + strip đáp án ở `/bootstrap`.

Monorepo:
- `apps/web` — Next.js 14 App Router (Vercel-ready)
- `apps/server` — Express referee API (Render/Railway/Fly-ready)
- `supabase/schema.sql` — optional: PostgreSQL tables + RPC + RLS

## Tính năng

- Canvas vẽ tay style hand-drawn (rough.js), zoom/pan, palette công cụ.
- Creator hỗ trợ 2 loại vùng đáp án ẩn:
  - `PRECISION_TARGET` — hình chữ nhật (mode `draw-target`).
  - `FREEFORM_ZONE` — đa giác tự do (mode `draw-freeform`).
- Host tạo room → chia sẻ mã 6 ký tự → nhiều player join cùng lúc.
- Chấm điểm authoritative trên server: client chỉ gửi tọa độ click ratio `[0,1]`, server tự hit-test.
- HMAC `playerToken` chống giả mạo submit.
- Anti double-submit qua bitmask `submit_mask` + deadline cứng.
- RNG payout server-side: win → `[1.20, 3.00]×bet`, loss → `−bet`.
- REST-only (GET/POST), không WebSocket.

## Quick Start (local)

```bash
npm install
```

Tạo env:

`apps/web/.env.local`
```bash
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
```

`apps/server/.env`
```bash
PORT=4000
CORS_ORIGIN=http://localhost:3000
SERVER_SECRET=replace-with-32-byte-random-hex
# Optional — bỏ trống thì server chạy in-memory
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

Sinh `SERVER_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Chạy 2 terminal:
```bash
npm run dev:server   # http://localhost:4000
npm run dev:web      # http://localhost:3000
```

Health check:
```bash
curl http://localhost:4000/api/health
# {"ok":true,"service":"cute-quiz-referee"}
```

## Test

```bash
cd apps/server
npx vitest run
# 25/25 pass (game.test.js 22 + utils.test.js 3)
```

## REST API

| Method | Route | Mô tả |
|---|---|---|
| GET  | `/api/health` | Liveness |
| POST | `/api/rooms/host` | Tạo room, trả `roomCode`, `hostSecret`, `playerToken` |
| POST | `/api/rooms/join` | Join bằng `roomCode`, trả `playerToken` |
| GET  | `/api/rooms/:code/bootstrap` | Lấy quiz (đã strip đáp án) + danh sách player |
| POST | `/api/rounds/start` | Host-only, header `x-host-secret`, set deadline |
| POST | `/api/submit-round` | Player submit `{click:{rx,ry}, gaugeValue?, bet, playerToken}` |
| POST | `/api/rooms/cleanup` | Host-only, header `x-host-secret`, archive leaderboard |
| GET  | `/api/leaderboard` | Top 100 |

Client KHÔNG BAO GIỜ gửi `isWin` — server tự chấm.

## Deploy production (multi-user)

### 1) Server → Render / Railway / Fly

Root directory: `apps/server`. Build: `npm install`. Start: `node src/index.js` (hoặc `npm start`).

Env bắt buộc:
- `SERVER_SECRET` — chuỗi hex ≥32 byte, KHÔNG commit. Đổi giá trị sẽ invalidate mọi `playerToken` đang sống.
- `CORS_ORIGIN` — origin chính xác của web app, ví dụ `https://your-app.vercel.app`.
- `PORT` — platform thường tự set.

Env optional (Supabase persistence):
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — service role key (KHÔNG dùng anon key). Chạy `supabase/schema.sql` trước.

### 2) Web → Vercel / Netlify

Root directory: `apps/web`. Framework preset: Next.js.

Env bắt buộc:
- `NEXT_PUBLIC_API_BASE_URL` — URL server đã deploy, ví dụ `https://quiz-referee.onrender.com`.

Sau khi web có domain, quay lại server set `CORS_ORIGIN` đúng domain đó rồi redeploy.

### 3) Smoke test sau deploy

```bash
curl https://<server-domain>/api/health
```

Mở web, tạo quiz, host room, share mã 6 ký tự cho người khác join từ thiết bị khác.

## Kiến trúc & Anti-cheat

- Mọi tọa độ qua mạng là ratio `[0,1]` — client/server không cần đồng bộ pixel/zoom.
- `/bootstrap` chạy `stripAnswersFromQuiz`: xoá `targetZones`, `gauge.correctMin/Max`, mọi element `PRECISION_TARGET`, và `FREEFORM_ZONE` có `role==="CORRECT_ANSWER"`.
- Hit-test duyệt `elements` từ cuối lên đầu (topmost-wins), fallback `targetZones` legacy.
- `playerToken = roomCode|playerId|HMAC_SHA256(SERVER_SECRET, "roomCode|playerId")`, verify constant-time.
- Submit bị reject nếu: token sai, sai `roundIndex`, quá deadline, đã submit, `bet > balance`, player bankrupt.

## Cấu trúc repo

```
apps/
  web/      Next.js 14 (App Router, "use client")
  server/   Express + Zod + vitest (ESM)
supabase/   schema.sql (optional persistence)
noob.md     project memory cho agent
```

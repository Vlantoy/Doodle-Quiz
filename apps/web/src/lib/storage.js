const KEY_USER = "cutequiz:user";
const KEY_DRAFTS = "cutequiz:drafts";
const KEY_ROOM_STATE_PREFIX = "cutequiz:room:";

export function randomUUID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for non-HTTPS / older browsers
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

export function getOrCreateUser() {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY_USER);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.playerId) {
        return parsed;
      }
    }
  } catch (e) {
    console.error("Failed to parse user profile from localStorage:", e);
  }

  const user = {
    playerId: randomUUID(),
    username: "",
    avatarSeed: ""
  };
  try {
    localStorage.setItem(KEY_USER, JSON.stringify(user));
  } catch (e) {}
  return user;
}

export function saveUser(user) {
  localStorage.setItem(KEY_USER, JSON.stringify(user));
}

export function listDrafts() {
  if (typeof window === "undefined") return [];
  return JSON.parse(localStorage.getItem(KEY_DRAFTS) || "[]");
}

export function saveDraft(draft) {
  const drafts = listDrafts();
  const idx = drafts.findIndex((d) => d.id === draft.id);
  if (idx >= 0) {
    drafts[idx] = draft;
  } else {
    drafts.unshift(draft);
  }
  localStorage.setItem(KEY_DRAFTS, JSON.stringify(drafts));
}

export function saveRoomState(roomCode, state) {
  const existing = getRoomState(roomCode);
  localStorage.setItem(`${KEY_ROOM_STATE_PREFIX}${roomCode}`, JSON.stringify({ ...existing, ...state }));
}

export function getRoomState(roomCode) {
  return JSON.parse(localStorage.getItem(`${KEY_ROOM_STATE_PREFIX}${roomCode}`) || "{}");
}

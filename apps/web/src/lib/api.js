const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";

async function send(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    cache: "no-store"
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "REQUEST_FAILED");
  }
  return data;
}

export async function healthCheck() {
  return send("/api/health", { method: "GET" });
}

export async function hostRoom(payload) {
  return send("/api/rooms/host", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function joinRoom(payload) {
  return send("/api/rooms/join", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function getBootstrap(roomCode) {
  return send(`/api/rooms/${roomCode}/bootstrap`, { method: "GET" });
}

export async function startRound(payload, hostSecret = "") {
  return send("/api/rounds/start", {
    method: "POST",
    headers: hostSecret ? { "x-host-secret": hostSecret } : {},
    body: JSON.stringify(payload)
  });
}

export async function submitRound(payload) {
  return send("/api/submit-round", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function cleanupRoom(payload, hostSecret = "") {
  return send("/api/rooms/cleanup", {
    method: "POST",
    headers: hostSecret ? { "x-host-secret": hostSecret } : {},
    body: JSON.stringify(payload)
  });
}

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getOrCreateUser, saveUser } from "lib/storage";
import { healthCheck } from "lib/api";
import { isMockMode } from "lib/supabaseClient";


export default function HomePage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [apiStatus, setApiStatus] = useState("checking");

  useEffect(() => {
    const user = getOrCreateUser();
    setUsername(user?.username || "");
    healthCheck().then(() => setApiStatus("online")).catch(() => setApiStatus("offline"));
  }, []);

  function continueToRoom() {
    if (!username.trim() || !roomCode.trim()) return;
    const user = getOrCreateUser();
    saveUser({ ...user, username: username.trim() });
    router.push(`/room/${roomCode.trim().toUpperCase()}`);
  }

  function handleUsernameChange(val) {
    setUsername(val);
    const user = getOrCreateUser();
    saveUser({ ...user, username: val.trim() });
  }

  function saveNameOnly() {
    if (!username.trim()) return;
    const user = getOrCreateUser();
    saveUser({ ...user, username: username.trim() });
  }

  return (
    <main className="app-shell grid" style={{ gap: 22 }}>
      <section className="card">
        <h1 className="title">Doodle Quiz Duel</h1>
        <p className="subtitle">Local-first trap puzzles, one-way REST sync, and cute chaos.</p>
        <div className="row">
          <span className="badge">Language: English</span>
          <span className="badge">Realtime: Turn-batch only</span>
          <span className="badge">Database: {isMockMode ? "Local Sandbox (localStorage) 📴" : "Supabase Direct ⚡"}</span>
          <span className="badge">API: {apiStatus}</span>
        </div>
      </section>

      <section className="grid grid-2">
        <article className="card grid">
          <h2 style={{ margin: 0 }}>Profile</h2>
          <input
            className="input"
            placeholder="Enter username"
            value={username}
            onChange={(e) => handleUsernameChange(e.target.value)}
          />
          <div className="row">
            <button type="button" className="btn" onClick={saveNameOnly}>Save Username</button>
            <Link className="btn secondary" href="/create">Create Quiz Set</Link>
          </div>
        </article>

        <article className="card grid">
          <h2 style={{ margin: 0 }}>Join Room</h2>
          <input
            className="input"
            placeholder="6-character code"
            value={roomCode}
            maxLength={6}
            onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
          />
          <button type="button" className="btn warn" onClick={continueToRoom}>Enter Match</button>
        </article>
      </section>
    </main>
  );
}

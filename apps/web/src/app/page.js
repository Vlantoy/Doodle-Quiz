"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getOrCreateUser, saveUser } from "lib/storage";
import { healthCheck, cleanupStaleData } from "lib/api";
import { isMockMode } from "lib/supabaseClient";
import { useI18n } from "components/I18nProvider";

export default function HomePage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [apiStatus, setApiStatus] = useState("checking");
  const { lang, setLang, t } = useI18n();

  useEffect(() => {
    const user = getOrCreateUser();
    setUsername(user?.username || "");
    healthCheck().then(() => setApiStatus("online")).catch(() => setApiStatus("offline"));
    // Clean up stale rooms/players left from crashed sessions
    cleanupStaleData();

    // Expose window.toandz() to console
    window.toandz = () => {
      const current = localStorage.getItem("cutequiz:admin_mode") === "true";
      const next = !current;
      localStorage.setItem("cutequiz:admin_mode", next ? "true" : "false");
      console.log(`[SYSTEM] Admin Mode (Slideshow) ${next ? "ENABLED" : "DISABLED"}`);
      alert(`[SYSTEM] Admin Mode (Slideshow) ${next ? "ENABLED" : "DISABLED"}`);
    };

    let keyBuffer = "";
    function handleKeyDown(e) {
      if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) {
        return;
      }
      keyBuffer = (keyBuffer + e.key).slice(-15);
      if (keyBuffer.includes("toandz")) {
        window.toandz();
        keyBuffer = "";
      }
    }
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      delete window.toandz;
    };
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
      {/* Floating Language Toggle */}
      <div style={{ display: "flex", justifyContent: "flex-end", margin: "-10px 0" }}>
        <button
          type="button"
          className="btn secondary"
          style={{ padding: "5px 12px", fontSize: "0.85rem", display: "flex", alignItems: "center", gap: 5 }}
          onClick={() => setLang(lang === "en" ? "vi" : "en")}
        >
          {t("lang_btn")}
        </button>
      </div>

      <section className="card">
        <h1 className="title">{t("game_title")}</h1>
        <p className="subtitle">{t("game_subtitle")}</p>
      </section>

      <section className="grid grid-2">
        <article className="card grid">
          <h2 style={{ margin: 0 }}>{t("profile")}</h2>
          <input
            className="input"
            placeholder={t("enter_username")}
            value={username}
            onChange={(e) => handleUsernameChange(e.target.value)}
          />
          <div className="row">
            <button type="button" className="btn" onClick={saveNameOnly}>{t("save_username")}</button>
            <Link className="btn secondary" href="/create">{t("create_quiz_set")}</Link>
          </div>
        </article>

        <article className="card grid">
          <h2 style={{ margin: 0 }}>{t("join_room")}</h2>
          <input
            className="input"
            placeholder={t("room_code_placeholder")}
            value={roomCode}
            maxLength={6}
            onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
          />
          <button type="button" className="btn warn" onClick={continueToRoom}>{t("enter_match")}</button>
        </article>
      </section>
    </main>
  );
}

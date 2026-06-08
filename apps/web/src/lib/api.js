import { supabase, isMockMode } from "./supabaseClient";

function generateRoomCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

export async function healthCheck() {
  if (isMockMode) {
    return { ok: true, service: "localstorage-mock" };
  }
  // Simple database connectivity check
  const { data, error } = await supabase.from("rooms").select("count", { count: "exact", head: true });
  if (error) throw error;
  return { ok: true, service: "supabase-direct" };
}

export async function hostRoom(payload) {
  // payload: { hostPlayerId, hostUsername, roundDurationSec, quiz }
  const code = generateRoomCode();
  const cutoffMs = Date.now() - 6 * 60 * 60 * 1000; // 6 hours threshold
  
  if (isMockMode) {
    // Clean up expired rooms and players from localStorage
    const rooms = JSON.parse(localStorage.getItem("cutequiz:mock_rooms") || "[]");
    const activeRooms = rooms.filter(r => new Date(r.created_at).getTime() > cutoffMs);
    
    const activeRoomCodes = activeRooms.map(r => r.code);
    const players = JSON.parse(localStorage.getItem("cutequiz:mock_players") || "[]");
    const activePlayers = players.filter(p => activeRoomCodes.includes(p.room_code));
    
    localStorage.setItem("cutequiz:mock_players", JSON.stringify(activePlayers));

    const newRoom = {
      code,
      host_id: payload.hostPlayerId,
      host_username: payload.hostUsername,
      round_duration: payload.roundDurationSec,
      quiz_data: payload.quiz,
      current_round: 0,
      round_deadline: null,
      created_at: new Date().toISOString()
    };
    activeRooms.push(newRoom);
    localStorage.setItem("cutequiz:mock_rooms", JSON.stringify(activeRooms));

    return {
      roomCode: code,
      hostPlayerId: payload.hostPlayerId,
      hostSecret: "mock-host-secret",
      playerToken: "mock-player-token",
      roundDurationSec: payload.roundDurationSec
    };
  }

  // Clean up expired rooms (created > 6 hours ago) in Supabase database
  const cutoffIso = new Date(cutoffMs).toISOString();
  try {
    await supabase.from("rooms").delete().lt("created_at", cutoffIso);
  } catch (err) {
    // Fail silently to not block hosting flow if delete fails
  }

  const { error } = await supabase.from("rooms").insert({
    code,
    host_id: payload.hostPlayerId,
    host_username: payload.hostUsername,
    round_duration: payload.roundDurationSec,
    quiz_data: payload.quiz,
    current_round: 0,
    round_deadline: null
  });

  if (error) throw error;

  return {
    roomCode: code,
    hostPlayerId: payload.hostPlayerId,
    hostSecret: "supabase-host-secret",
    playerToken: "supabase-player-token",
    roundDurationSec: payload.roundDurationSec
  };
}

export async function joinRoom(payload) {
  // payload: { roomCode, playerId, username }
  const roomCode = String(payload.roomCode).toUpperCase();
  
  if (isMockMode) {
    const rooms = JSON.parse(localStorage.getItem("cutequiz:mock_rooms") || "[]");
    const roomExists = rooms.some(r => r.code === roomCode);
    if (!roomExists) throw new Error("ROOM_NOT_FOUND");

    const players = JSON.parse(localStorage.getItem("cutequiz:mock_players") || "[]");
    const existing = players.find(p => p.room_code === roomCode && p.id === payload.playerId);

    if (existing) {
      return {
        roomCode,
        playerId: payload.playerId,
        seatIndex: 0,
        avatarSeed: "P",
        playerToken: "mock-player-token",
        rejoined: true
      };
    }

    const newPlayer = {
      id: payload.playerId,
      room_code: roomCode,
      username: payload.username,
      balance: 10,
      is_bankrupt: false,
      last_submitted_round: -1,
      created_at: new Date().toISOString()
    };
    players.push(newPlayer);
    localStorage.setItem("cutequiz:mock_players", JSON.stringify(players));

    return {
      roomCode,
      playerId: payload.playerId,
      seatIndex: 0,
      avatarSeed: "P",
      playerToken: "mock-player-token",
      rejoined: false
    };
  }

  // Check if player already exists in the room
  const { data: existing, error: checkError } = await supabase
    .from("players")
    .select("*")
    .eq("room_code", roomCode)
    .eq("id", payload.playerId)
    .maybeSingle();

  if (checkError) throw checkError;

  if (existing) {
    return {
      roomCode,
      playerId: payload.playerId,
      seatIndex: 0,
      avatarSeed: "P",
      playerToken: "supabase-player-token",
      rejoined: true
    };
  }

  // Insert new player
  const { error: insertError } = await supabase.from("players").insert({
    id: payload.playerId,
    room_code: roomCode,
    username: payload.username,
    balance: 10,
    is_bankrupt: false,
    last_submitted_round: -1
  });

  if (insertError) throw insertError;

  return {
    roomCode,
    playerId: payload.playerId,
    seatIndex: 0,
    avatarSeed: "P",
    playerToken: "supabase-player-token",
    rejoined: false
  };
}

export async function getBootstrap(roomCode) {
  const code = String(roomCode).toUpperCase();

  if (isMockMode) {
    const rooms = JSON.parse(localStorage.getItem("cutequiz:mock_rooms") || "[]");
    const room = rooms.find(r => r.code === code);
    if (!room) throw new Error("ROOM_NOT_FOUND");

    const players = JSON.parse(localStorage.getItem("cutequiz:mock_players") || "[]");
    const roomPlayers = players.filter(p => p.room_code === code);

    return {
      room: {
        code: room.code,
        host_player_id: room.host_id,
        host_username: room.host_username,
        round_duration_sec: room.round_duration,
        quiz_payload: room.quiz_data,
        current_round_index: room.current_round,
        round_started_at: room.created_at,
        round_deadline_at: room.round_deadline,
        is_active: true
      },
      players: roomPlayers.map(p => ({
        player_id: p.id,
        username: p.username,
        avatar_seed: "P",
        seat_index: 0,
        balance: p.balance,
        is_bankrupt: p.is_bankrupt,
        last_round_submitted: p.last_submitted_round
      }))
    };
  }

  // Fetch room details
  const { data: room, error: roomError } = await supabase
    .from("rooms")
    .select("*")
    .eq("code", code)
    .maybeSingle();

  if (roomError) throw roomError;
  if (!room) throw new Error("ROOM_NOT_FOUND");

  // Fetch players list
  const { data: players, error: playersError } = await supabase
    .from("players")
    .select("*")
    .eq("room_code", code);

  if (playersError) throw playersError;

  return {
    room: {
      code: room.code,
      host_player_id: room.host_id,
      host_username: room.host_username,
      round_duration_sec: room.round_duration,
      quiz_payload: room.quiz_data,
      current_round_index: room.current_round,
      round_started_at: room.created_at,
      round_deadline_at: room.round_deadline,
      is_active: true
    },
    players: (players || []).map(p => ({
      player_id: p.id,
      username: p.username,
      avatar_seed: "P",
      seat_index: 0,
      balance: p.balance,
      is_bankrupt: p.is_bankrupt,
      last_round_submitted: p.last_submitted_round
    }))
  };
}

export async function startRound(payload, hostSecret = "") {
  // payload: { roomCode, hostPlayerId, roundIndex }
  const code = String(payload.roomCode).toUpperCase();

  if (isMockMode) {
    const rooms = JSON.parse(localStorage.getItem("cutequiz:mock_rooms") || "[]");
    const roomIdx = rooms.findIndex(r => r.code === code);
    if (roomIdx === -1) throw new Error("ROOM_NOT_FOUND");

    const durationSec = rooms[roomIdx].round_duration || 20;
    const deadlineAt = new Date(Date.now() + durationSec * 1000).toISOString();

    rooms[roomIdx].current_round = payload.roundIndex;
    rooms[roomIdx].round_deadline = deadlineAt;
    localStorage.setItem("cutequiz:mock_rooms", JSON.stringify(rooms));

    // Reset players cược state for the new round
    const players = JSON.parse(localStorage.getItem("cutequiz:mock_players") || "[]");
    const updatedPlayers = players.map(p => {
      if (p.room_code === code) {
        return { ...p, last_submitted_round: -1 };
      }
      return p;
    });
    localStorage.setItem("cutequiz:mock_players", JSON.stringify(updatedPlayers));

    return {
      started: {
        round_index: payload.roundIndex,
        round_deadline_at: deadlineAt
      }
    };
  }

  // Get round duration first
  const { data: room, error: fetchError } = await supabase
    .from("rooms")
    .select("round_duration")
    .eq("code", code)
    .single();

  if (fetchError) throw fetchError;

  const durationSec = room.round_duration || 20;
  const deadlineAt = new Date(Date.now() + durationSec * 1000).toISOString();

  // Update room with round index and deadline
  const { error: updateError } = await supabase
    .from("rooms")
    .update({
      current_round: payload.roundIndex,
      round_deadline: deadlineAt
    })
    .eq("code", code);

  if (updateError) throw updateError;

  // Reset players cược state for the new round
  const { error: resetPlayersError } = await supabase
    .from("players")
    .update({
      last_submitted_round: -1 // Reset cược submission indicator for the new round
    })
    .eq("room_code", code);

  if (resetPlayersError) throw resetPlayersError;

  return {
    started: {
      round_index: payload.roundIndex,
      round_deadline_at: deadlineAt
    }
  };
}

export async function submitRound(payload) {
  // Dummy submitRound since cược results are validated and uploaded directly upon timer end
  return { result: {} };
}

// Client-side helper to write computed balances directly to the players table
export async function updatePlayerBalance(playerId, roomCode, newBalance, isBankrupt, roundIndex) {
  const code = String(roomCode).toUpperCase();

  if (isMockMode) {
    const players = JSON.parse(localStorage.getItem("cutequiz:mock_players") || "[]");
    const playerIdx = players.findIndex(p => p.id === playerId && p.room_code === code);
    if (playerIdx === -1) throw new Error("PLAYER_NOT_FOUND");

    players[playerIdx].balance = newBalance;
    players[playerIdx].is_bankrupt = isBankrupt;
    players[playerIdx].last_submitted_round = roundIndex;
    localStorage.setItem("cutequiz:mock_players", JSON.stringify(players));

    return { success: true };
  }

  const { error } = await supabase
    .from("players")
    .update({
      balance: newBalance,
      is_bankrupt: isBankrupt,
      last_submitted_round: roundIndex
    })
    .eq("id", playerId)
    .eq("room_code", code);

  if (error) throw error;
  return { success: true };
}

export async function cleanupRoom(payload, hostSecret = "") {
  // payload: { roomCode, hostPlayerId }
  const code = String(payload.roomCode).toUpperCase();

  if (isMockMode) {
    const rooms = JSON.parse(localStorage.getItem("cutequiz:mock_rooms") || "[]");
    const filteredRooms = rooms.filter(r => r.code !== code);
    localStorage.setItem("cutequiz:mock_rooms", JSON.stringify(filteredRooms));

    const players = JSON.parse(localStorage.getItem("cutequiz:mock_players") || "[]");
    const filteredPlayers = players.filter(p => p.room_code !== code);
    localStorage.setItem("cutequiz:mock_players", JSON.stringify(filteredPlayers));

    return { cleaned: true };
  }

  // Delete room row (cascades and deletes players automatically)
  const { error } = await supabase
    .from("rooms")
    .delete()
    .eq("code", code);

  if (error) throw error;

  return { cleaned: true };
}

export async function deletePlayer(playerId, roomCode) {
  const code = String(roomCode).toUpperCase();
  if (isMockMode) {
    const players = JSON.parse(localStorage.getItem("cutequiz:mock_players") || "[]");
    const filtered = players.filter(p => !(p.id === playerId && p.room_code === code));
    localStorage.setItem("cutequiz:mock_players", JSON.stringify(filtered));
    return { success: true };
  }

  const { error } = await supabase
    .from("players")
    .delete()
    .eq("id", playerId)
    .eq("room_code", code);

  if (error) throw error;
  return { success: true };
}



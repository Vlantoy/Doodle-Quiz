create extension if not exists pgcrypto;

create table if not exists public.temporary_rooms (
  code char(6) primary key,
  host_player_id uuid not null,
  host_username text not null,
  round_duration_sec integer not null check (round_duration_sec >= 5 and round_duration_sec <= 180),
  quiz_payload jsonb not null,
  current_round_index integer not null default 0,
  round_started_at timestamptz,
  round_deadline_at timestamptz,
  submit_mask bit(64) not null default B'0000000000000000000000000000000000000000000000000000000000000000',
  win_mask bit(64) not null default B'0000000000000000000000000000000000000000000000000000000000000000',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.room_players (
  room_code char(6) not null references public.temporary_rooms(code) on delete cascade,
  player_id uuid not null,
  username text not null,
  avatar_seed text not null,
  seat_index smallint not null check (seat_index >= 0 and seat_index < 64),
  balance integer not null default 10 check (balance >= 0),
  is_bankrupt boolean not null default false,
  last_round_submitted integer not null default -1,
  created_at timestamptz not null default now(),
  primary key (room_code, player_id),
  unique (room_code, seat_index)
);

create table if not exists public.round_submissions (
  room_code char(6) not null references public.temporary_rooms(code) on delete cascade,
  round_index integer not null,
  player_id uuid not null,
  seat_index smallint not null,
  submitted_at timestamptz not null default now(),
  is_win_claimed boolean not null,
  is_win_final boolean not null,
  completion_ms integer,
  bet integer not null,
  rng_factor numeric(6,2),
  delta integer not null,
  resulting_balance integer not null,
  anti_cheat boolean not null default false,
  is_late boolean not null default false,
  primary key (room_code, round_index, player_id)
);

create table if not exists public.final_leaderboard (
  id bigserial primary key,
  room_code char(6) not null,
  player_id uuid not null,
  username text not null,
  avatar_seed text not null,
  final_balance integer not null,
  total_rounds integer not null,
  ended_at timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_temporary_rooms on public.temporary_rooms;
create trigger trg_touch_temporary_rooms
before update on public.temporary_rooms
for each row execute procedure public.touch_updated_at();

create or replace function public.submit_round_rpc(
  p_room_code char(6),
  p_player_id uuid,
  p_round_index integer,
  p_is_win boolean,
  p_completion_ms integer,
  p_bet integer
)
returns table (
  resulting_balance integer,
  resulting_is_win boolean,
  rng_factor numeric,
  anti_cheat boolean,
  is_late boolean,
  bankrupt boolean
)
language plpgsql
security definer
as $$
declare
  v_room public.temporary_rooms%rowtype;
  v_player public.room_players%rowtype;
  v_now timestamptz := now();
  v_is_late boolean := false;
  v_anti_cheat boolean := false;
  v_effective_win boolean := false;
  v_rng numeric(6,2) := null;
  v_delta integer := 0;
  v_new_balance integer := 0;
begin
  select * into v_room
  from public.temporary_rooms
  where code = p_room_code and is_active = true
  for update;

  if not found then
    raise exception 'ROOM_NOT_FOUND_OR_INACTIVE';
  end if;

  select * into v_player
  from public.room_players
  where room_code = p_room_code and player_id = p_player_id
  for update;

  if not found then
    raise exception 'PLAYER_NOT_FOUND';
  end if;

  if p_round_index <> v_room.current_round_index then
    raise exception 'ROUND_INDEX_MISMATCH';
  end if;

  if v_room.round_started_at is null or v_room.round_deadline_at is null then
    raise exception 'ROUND_NOT_STARTED';
  end if;

  if v_now > v_room.round_deadline_at + interval '2 second' then
    v_is_late := true;
  end if;

  if v_player.is_bankrupt then
    v_effective_win := false;
    v_new_balance := 0;
  elsif p_bet < 1 or p_bet > v_player.balance then
    v_anti_cheat := true;
    v_effective_win := false;
    v_new_balance := 0;
  else
    v_effective_win := p_is_win and not v_is_late;

    if v_effective_win then
      v_rng := round((1.20 + random() * 1.80)::numeric, 2);
      v_delta := floor(p_bet * v_rng)::integer;
      v_new_balance := v_player.balance + v_delta;
    else
      v_delta := -p_bet;
      v_new_balance := greatest(0, v_player.balance + v_delta);
    end if;
  end if;

  update public.room_players
  set
    balance = v_new_balance,
    is_bankrupt = (v_new_balance <= 0),
    last_round_submitted = p_round_index
  where room_code = p_room_code and player_id = p_player_id;

  insert into public.round_submissions (
    room_code,
    round_index,
    player_id,
    seat_index,
    is_win_claimed,
    is_win_final,
    completion_ms,
    bet,
    rng_factor,
    delta,
    resulting_balance,
    anti_cheat,
    is_late
  ) values (
    p_room_code,
    p_round_index,
    p_player_id,
    v_player.seat_index,
    p_is_win,
    v_effective_win,
    p_completion_ms,
    p_bet,
    v_rng,
    v_delta,
    v_new_balance,
    v_anti_cheat,
    v_is_late
  )
  on conflict (room_code, round_index, player_id)
  do nothing;

  update public.temporary_rooms
  set
    submit_mask = set_bit(submit_mask, v_player.seat_index, 1),
    win_mask = set_bit(win_mask, v_player.seat_index, case when v_effective_win then 1 else 0 end)
  where code = p_room_code;

  return query
  select
    v_new_balance,
    v_effective_win,
    v_rng,
    v_anti_cheat,
    v_is_late,
    (v_new_balance <= 0);
end;
$$;

create or replace function public.start_round_rpc(
  p_room_code char(6),
  p_host_player_id uuid,
  p_round_index integer
)
returns table (
  round_started_at timestamptz,
  round_deadline_at timestamptz,
  round_index integer
)
language plpgsql
security definer
as $$
declare
  v_room public.temporary_rooms%rowtype;
  v_started timestamptz := now();
  v_deadline timestamptz;
begin
  select * into v_room
  from public.temporary_rooms
  where code = p_room_code and is_active = true
  for update;

  if not found then
    raise exception 'ROOM_NOT_FOUND_OR_INACTIVE';
  end if;

  if v_room.host_player_id <> p_host_player_id then
    raise exception 'ONLY_HOST_CAN_START';
  end if;

  if p_round_index < 0 then
    raise exception 'INVALID_ROUND_INDEX';
  end if;

  v_deadline := v_started + make_interval(secs => v_room.round_duration_sec);

  update public.temporary_rooms
  set
    current_round_index = p_round_index,
    round_started_at = v_started,
    round_deadline_at = v_deadline,
    submit_mask = B'0000000000000000000000000000000000000000000000000000000000000000',
    win_mask = B'0000000000000000000000000000000000000000000000000000000000000000'
  where code = p_room_code;

  return query select v_started, v_deadline, p_round_index;
end;
$$;

alter table public.temporary_rooms enable row level security;
alter table public.room_players enable row level security;
alter table public.round_submissions enable row level security;
alter table public.final_leaderboard enable row level security;

-- Basic permissive policy for demo/local dev with server-side service role.
-- In production, prefer restrictive policies and route all writes through server only.
drop policy if exists p_all_temp_rooms on public.temporary_rooms;
create policy p_all_temp_rooms on public.temporary_rooms for all using (true) with check (true);

drop policy if exists p_all_room_players on public.room_players;
create policy p_all_room_players on public.room_players for all using (true) with check (true);

drop policy if exists p_all_round_submissions on public.round_submissions;
create policy p_all_round_submissions on public.round_submissions for all using (true) with check (true);

drop policy if exists p_all_final_leaderboard on public.final_leaderboard;
create policy p_all_final_leaderboard on public.final_leaderboard for all using (true) with check (true);

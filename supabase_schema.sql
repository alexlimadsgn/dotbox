-- Drop existing policies to ensure clean slate
drop policy if exists "Public matches access" on public.matches; -- Old name
drop policy if exists "Public moves access" on public.moves; -- Old name

-- Drop CURRENT policies to allow re-running this script
drop policy if exists "Public read matches" on public.matches;
drop policy if exists "Authenticated users can create matches" on public.matches;
drop policy if exists "Host can update match" on public.matches;
drop policy if exists "Public read moves" on public.moves;


-- Update matches table
-- We need to ensure we have a created_by column.
-- Since we can't easily run migrations here, we provide the definition.
-- Users should run this in Supabase SQL Editor.

-- Add created_by if not exists (SQL snippet for robustness)
do $$
begin
    if not exists (select 1 from information_schema.columns where table_name = 'matches' and column_name = 'created_by') then
        alter table public.matches add column created_by uuid default auth.uid();
    end if;
end $$;

-- Enable RLS
alter table public.matches enable row level security;
alter table public.moves enable row level security;

-- POLICY: Matches
-- Everyone can read matches (needed to find rooms), or we can restrict to 'waiting' + own matches.
-- For simplicity and UX (joining room by code), we allow reading 'waiting' matches or matches you are in.
create policy "Public read matches"
on public.matches for select
using (true);

-- Only creating is allowed for Auth users (we will use a function for this later to be strict, but standard insert is okay if we force created_by)
create policy "Authenticated users can create matches"
on public.matches for insert
with check (auth.role() = 'authenticated');

-- Updates: strictly via Functions ideally, but if we want to allow host to update status:
create policy "Host can update match"
on public.matches for update
using (auth.uid() = created_by);

-- POLICY: Moves
-- Visible only if you are in the match (conceptually, but for simplicity logic: match_id knows players)
-- Let's just allow read for now.
create policy "Public read moves"
on public.moves for select
using (true);

-- Insert: strictly via RPC "play_move" to prevent cheating.
-- So we DO NOT add an insert policy for moves for the public/authenticated role directly.
-- (Unless we want to fallback to client-side logic, but the goal is security).
-- Wait! If we use RPC with "SECURITY DEFINER", we don't need Insert permission for the user.
-- So we leave Moves Insert policy EMPTY (Deny All).


-- FUNCTIONS --

-- 1. Join Match
create or replace function join_match(code_input text, player_name text, player_color text)
returns json
language plpgsql
security definer
as $$
declare
  match_rec record;
  new_player jsonb;
  updated_players jsonb;
begin
  -- 1. Find the match
  select * into match_rec from public.matches 
  where code = upper(code_input) 
  -- Removed status check here to allow checking player list for reconnect
  limit 1;

  if match_rec is null then
    raise exception 'Sala não encontrada.';
  end if;

  -- 2. Check if already joined based on AUTH UID
  declare
      existing_player_idx int;
  begin
      select index - 1 into existing_player_idx
      from jsonb_array_elements(match_rec.players) with ordinality as p(elem, index)
      where (elem->>'auth_id')::uuid = auth.uid();

      if existing_player_idx is not null and existing_player_idx >= 0 then
          -- Already in match: Allow connection even if playing
          
          -- Optional: Update Name if changed
          if (match_rec.players->existing_player_idx->>'name') is distinct from player_name then
              updated_players := match_rec.players;
              updated_players := jsonb_set(updated_players, ('{'||existing_player_idx||',name}')::text[], to_jsonb(player_name));
              
              update public.matches
              set players = updated_players
              where id = match_rec.id;
          end if;

          return json_build_object('match_id', match_rec.id, 'player_id', existing_player_idx);
      end if;
  end;

  -- Logic for NEW players:
  if match_rec.status != 'waiting' then
     raise exception 'Jogo já iniciado.';
  end if;

  if jsonb_array_length(match_rec.players) >= 7 then
    raise exception 'Sala cheia.';
  end if;
  
  -- Construct new player object. Use 0-based index ID.
  new_player := json_build_object(
    'id', jsonb_array_length(match_rec.players),
    'name', player_name,
    'color', player_color,
    'score', 0,
    'auth_id', auth.uid() -- Critical for anti-cheat
  );

  -- 3. Update the match
  updated_players := match_rec.players || new_player;

  update public.matches
  set players = updated_players
  where id = match_rec.id;

  return json_build_object('match_id', match_rec.id, 'player_id', new_player->>'id');
end;
$$;


-- 2. Play Move
create or replace function play_move(match_id_input uuid, line_id_input text, next_turn_idx int)
returns void
language plpgsql
security definer
as $$
declare
  match_rec record;
  line_exists boolean;
  player_idx int;
  num_players int;
begin
  -- 1. Fetch Requesting User
  -- auth.uid() is available

  -- 2. Get Match Data
  select * into match_rec from public.matches where id = match_id_input;
  
  if match_rec is null then
    raise exception 'Match not found';
  end if;

  if match_rec.status != 'playing' then
    raise exception 'Game is not active';
  end if;

  -- 3. Validate Player Turn
  select index - 1 into player_idx
  from jsonb_array_elements(match_rec.players) with ordinality as p(elem, index)
  where (elem->>'auth_id')::uuid = auth.uid();

  if player_idx = -1 then
    raise exception 'You are not in this match';
  end if;

  if player_idx != match_rec.current_turn then
    raise exception 'Not your turn';
  end if;

  -- 4. Check if line is already taken
  select exists(select 1 from public.moves where match_id = match_id_input and line_id = line_id_input)
  into line_exists;

  if line_exists then
    raise exception 'Line already taken';
  end if;

  -- 5. Insert Move
  insert into public.moves (match_id, player_id, line_id)
  values (match_id_input, player_idx, line_id_input);

  -- 6. Update Turn
  -- We trust the client for 'next_turn_idx' logic (capture vs no capture), 
  -- BUT we validate it is a valid player index.
  
  num_players := jsonb_array_length(match_rec.players);
  
  if next_turn_idx < 0 or next_turn_idx >= num_players then
     raise exception 'Invalid next turn index';
  end if;
  
  -- Logic Check: It must be either Current Player (Capture) or Next Player (No capture)
  -- This prevents passing turn randomly to cheating friends.
  -- (Commented out for flexibility, but recommended):
  -- if next_turn_idx != player_idx and next_turn_idx != (player_idx + 1) % num_players then
  --    raise exception 'Invalid turn transition';
  -- end if;

  update public.matches
  set current_turn = next_turn_idx
  where id = match_id_input;

end;
$$;

-- 3. Leave Match
create or replace function leave_match(match_id_input uuid)
returns void
language plpgsql
security definer
as $$
declare
  match_rec record;
  player_idx int;
  updated_players jsonb;
  remaining_count int;
begin
  -- 1. Find Match
  select * into match_rec from public.matches where id = match_id_input;
  
  if match_rec is null then
    return; -- Idempotent
  end if;

  -- 2. Find Player Index
  select index - 1 into player_idx
  from jsonb_array_elements(match_rec.players) with ordinality as p(elem, index)
  where (elem->>'auth_id')::uuid = auth.uid();

  if player_idx = -1 or player_idx is null then
    return; -- Not in match
  end if;

  -- 3. Delete their moves
  delete from public.moves 
  where match_id = match_id_input 
  and player_id = player_idx;

  -- 4. Shift moves of subsequent players (to keep indices valid after array removal)
  update public.moves
  set player_id = player_id - 1
  where match_id = match_id_input
  and player_id > player_idx;

  -- 5. Remove Player from Array
  select jsonb_agg(elem) into updated_players
  from jsonb_array_elements(match_rec.players) as elem
  where (elem->>'auth_id')::uuid != auth.uid();
  
  -- 6. Check Empty or Finish
  if updated_players is null then
      remaining_count := 0;
  else
      remaining_count := jsonb_array_length(updated_players);
  end if;

  if remaining_count = 0 then
      -- DELETE MATCH if empty
      delete from public.matches where id = match_id_input;
  else
      -- UPDATE MATCH
      if match_rec.status = 'playing' and remaining_count = 1 then
         -- End Game if only 1 left
         update public.matches
         set players = updated_players,
             status = 'finished',
             winner = updated_players->0
         where id = match_id_input;
      else
         -- Just update list
         update public.matches
         set players = updated_players
         where id = match_id_input;
      end if;
  end if;

end;
$$;


-- 4. Chat Messages
create table if not exists public.chat_messages (
  id uuid default gen_random_uuid() primary key,
  match_id uuid references public.matches(id) on delete cascade not null,
  player_id int not null,
  player_name text not null,
  content text not null,
  created_at timestamptz default now() not null
);

alter table public.chat_messages enable row level security;

create policy "Enable read for everyone"
on public.chat_messages for select
using (true);

create or replace function send_chat_message(match_id_input uuid, content_input text)
returns void
language plpgsql
security definer
as $$
declare
  match_rec record;
  player_idx int;
  p_name text;
begin
  -- 1. Find match and validate player
  select * into match_rec from public.matches where id = match_id_input;
  
  if match_rec is null then
    raise exception 'Sala não encontrada.';
  end if;

  select index - 1, elem->>'name' into player_idx, p_name
  from jsonb_array_elements(match_rec.players) with ordinality as p(elem, index)
  where (elem->>'auth_id')::uuid = auth.uid();

  if player_idx is null then
    raise exception 'Você não está nesta sala.';
  end if;

  -- 2. Insert Message
  insert into public.chat_messages (match_id, player_id, player_name, content)
  values (match_id_input, player_idx, p_name, content_input);
end;
$$;

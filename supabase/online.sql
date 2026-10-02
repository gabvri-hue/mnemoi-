-- Mnemoi · partite online, amici, livelli e punteggi
-- Da incollare nel SQL Editor di Supabase DOPO schema.sql. Si può rieseguire senza problemi.

-- ---------- Profili: esperienza, punteggi per variante, risultati online ----------
alter table public.profiles add column if not exists xp integer not null default 0;
alter table public.profiles add column if not exists ratings jsonb not null default '{}'::jsonb;
alter table public.profiles add column if not exists online_wins integer not null default 0;
alter table public.profiles add column if not exists online_losses integer not null default 0;
alter table public.profiles add column if not exists online_draws integer not null default 0;

-- ---------- Partite online ----------
create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  variant text not null,
  tc text not null,
  base_s integer not null,
  inc_s integer not null,
  white uuid references public.profiles(id) on delete set null,
  black uuid references public.profiles(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'finished', 'aborted')),
  result text,
  reason text,
  start_fen text not null,
  moves jsonb not null default '[]'::jsonb,
  ply integer not null default 0,
  white_ms integer not null,
  black_ms integer not null,
  last_move_at timestamptz not null default now(),
  draw_offer text check (draw_offer in ('w', 'b')),
  rated boolean not null default true,
  white_rating integer,
  black_rating integer,
  white_change integer,
  black_change integer,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists matches_white_idx on public.matches (white, created_at desc);
create index if not exists matches_black_idx on public.matches (black, created_at desc);
create index if not exists matches_active_idx on public.matches (status) where status = 'active';
alter table public.matches enable row level security;
drop policy if exists "partite online pubbliche" on public.matches;
create policy "partite online pubbliche" on public.matches for select using (true);

-- Casella della regina nascosta: la vede solo chi la possiede
create table if not exists public.match_secrets (
  match_id uuid not null references public.matches(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  color text not null check (color in ('w', 'b')),
  square integer not null,
  primary key (match_id, color)
);
alter table public.match_secrets enable row level security;
drop policy if exists "segreto personale" on public.match_secrets;
create policy "segreto personale" on public.match_secrets for select using (auth.uid() = user_id);

-- Coda per l'abbinamento
create table if not exists public.queue (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  variant text not null,
  tc text not null,
  rating integer not null,
  seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.queue enable row level security;
drop policy if exists "coda personale" on public.queue;
create policy "coda personale" on public.queue for select using (auth.uid() = user_id);

-- Sfide tra amici (e rivincite)
create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references public.profiles(id) on delete cascade,
  to_user uuid not null references public.profiles(id) on delete cascade,
  variant text not null,
  tc text not null,
  rematch_of uuid references public.matches(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  match_id uuid references public.matches(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists challenges_to_idx on public.challenges (to_user, status);
alter table public.challenges enable row level security;
drop policy if exists "sfide personali" on public.challenges;
create policy "sfide personali" on public.challenges for select
  using (auth.uid() = from_user or auth.uid() = to_user);

-- Amicizie: una riga per richiesta, "accepted" quando l'altro accetta
create table if not exists public.friendships (
  from_user uuid not null references public.profiles(id) on delete cascade,
  to_user uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  primary key (from_user, to_user),
  check (from_user <> to_user)
);
create index if not exists friendships_to_idx on public.friendships (to_user);
alter table public.friendships enable row level security;
drop policy if exists "amicizie personali" on public.friendships;
create policy "amicizie personali" on public.friendships for select
  using (auth.uid() = from_user or auth.uid() = to_user);

-- ---------- Amici ----------
create or replace function public.friend_request(p_username text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  other uuid;
  back public.friendships;
begin
  if me is null then raise exception 'Devi accedere'; end if;
  select id into other from profiles where lower(username) = lower(trim(p_username));
  if other is null then raise exception 'Nessun giocatore con questo nome'; end if;
  if other = me then raise exception 'Non puoi aggiungere te stesso'; end if;
  if exists (select 1 from friendships where from_user = me and to_user = other) then
    raise exception 'Hai già inviato la richiesta';
  end if;
  select * into back from friendships where from_user = other and to_user = me;
  if found then
    update friendships set status = 'accepted' where from_user = other and to_user = me;
    return jsonb_build_object('status', 'accepted');
  end if;
  if (select count(*) from friendships where from_user = me and status = 'pending') >= 50 then
    raise exception 'Troppe richieste in attesa';
  end if;
  insert into friendships (from_user, to_user) values (me, other);
  return jsonb_build_object('status', 'pending');
end $$;

create or replace function public.friend_respond(p_from uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Devi accedere'; end if;
  if p_accept then
    update friendships set status = 'accepted' where from_user = p_from and to_user = me;
  else
    delete from friendships where from_user = p_from and to_user = me and status = 'pending';
  end if;
end $$;

create or replace function public.friend_remove(p_other uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Devi accedere'; end if;
  delete from friendships where (from_user = me and to_user = p_other) or (from_user = p_other and to_user = me);
end $$;

-- ---------- Livelli: esperienza anche contro il computer ----------
create or replace function public.report_game(p_result text, p_level integer, p_moves integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  r public.profiles;
  today date := (now() at time zone 'Europe/Rome')::date;
  reward integer := 0;
  gain integer := 0;
  room integer;
  fresh boolean;
begin
  if me is null then raise exception 'Devi accedere'; end if;
  if p_result not in ('win', 'loss', 'draw') then raise exception 'Risultato non valido'; end if;
  if p_level not in (1, 2, 3) then raise exception 'Livello non valido'; end if;
  select * into r from profiles where id = me for update;
  if r.reward_day is distinct from today then
    r.coins_today := 0;
  end if;
  fresh := r.last_reward_at is null or r.last_reward_at < now() - interval '60 seconds';
  if p_moves >= 10 and fresh then
    gain := case p_result when 'win' then 10 + 5 * p_level when 'draw' then 8 else 4 end;
    if p_result = 'win' then
      reward := case p_level when 1 then 5 when 2 then 15 else 30 end;
      room := greatest(0, 300 - r.coins_today);
      reward := least(reward, room);
    end if;
  end if;
  update profiles set
    wins = wins + (p_result = 'win')::int,
    losses = losses + (p_result = 'loss')::int,
    draws = draws + (p_result = 'draw')::int,
    coins = coins + reward,
    xp = xp + gain,
    reward_day = today,
    coins_today = r.coins_today + reward,
    last_reward_at = case when p_moves >= 10 and fresh then now() else last_reward_at end
  where id = me returning * into r;
  insert into games (user_id, result, level, moves, coins) values (me, p_result, p_level, p_moves, reward);
  return jsonb_build_object('reward', reward, 'coins', r.coins, 'xp', r.xp, 'gain', gain);
end $$;

-- ---------- Funzioni interne usate solo dal server delle partite ----------

-- Chiude una partita: punteggio (Elo), esperienza, monete e statistiche.
-- p_result: '1-0', '0-1', '1/2-1/2' oppure 'aborted'
create or replace function public.finish_match(p_id uuid, p_result text, p_reason text)
returns public.matches language plpgsql security definer set search_path = public as $$
declare
  m public.matches;
  pw public.profiles;
  pb public.profiles;
  rw integer; rb integer;
  sw numeric; ew numeric;
  cw integer; cb integer;
  today date := (now() at time zone 'Europe/Rome')::date;
  counted boolean;
begin
  select * into m from matches where id = p_id for update;
  if not found or m.status <> 'active' then return m; end if;
  if p_result = 'aborted' then
    update matches set status = 'aborted', result = null, reason = p_reason, finished_at = now(), draw_offer = null
      where id = p_id returning * into m;
    return m;
  end if;
  if p_result not in ('1-0', '0-1', '1/2-1/2') then raise exception 'Risultato non valido'; end if;

  -- lock nello stesso ordine per evitare stalli
  if m.white < m.black then
    select * into pw from profiles where id = m.white for update;
    select * into pb from profiles where id = m.black for update;
  else
    select * into pb from profiles where id = m.black for update;
    select * into pw from profiles where id = m.white for update;
  end if;

  rw := coalesce((pw.ratings ->> m.variant)::int, 1200);
  rb := coalesce((pb.ratings ->> m.variant)::int, 1200);
  sw := case p_result when '1-0' then 1 when '0-1' then 0 else 0.5 end;
  ew := 1 / (1 + power(10, (rb - rw) / 400.0));
  cw := 0; cb := 0;
  if m.rated and pw.id is not null and pb.id is not null then
    cw := round(32 * (sw - ew));
    cb := -cw;
  end if;
  counted := m.ply >= 4;

  if pw.id is not null then
    perform public._online_reward(pw, m.variant, rw + cw, sw, counted, today);
  end if;
  if pb.id is not null then
    perform public._online_reward(pb, m.variant, rb + cb, 1 - sw, counted, today);
  end if;

  update matches set status = 'finished', result = p_result, reason = p_reason, finished_at = now(),
    draw_offer = null, white_rating = rw, black_rating = rb, white_change = cw, black_change = cb
    where id = p_id returning * into m;
  return m;
end $$;

-- score: 1 vittoria, 0.5 patta, 0 sconfitta
create or replace function public._online_reward(p public.profiles, p_variant text, p_rating integer,
  p_score numeric, p_counted boolean, p_today date)
returns void language plpgsql security definer set search_path = public as $$
declare
  gain integer := 0;
  reward integer := 0;
  used integer;
begin
  used := case when p.reward_day is distinct from p_today then 0 else p.coins_today end;
  if p_counted then
    gain := case when p_score = 1 then 50 when p_score = 0.5 then 25 else 15 end;
    reward := case when p_score = 1 then 20 when p_score = 0.5 then 10 else 0 end;
    reward := least(reward, greatest(0, 300 - used));
  end if;
  update profiles set
    ratings = ratings || jsonb_build_object(p_variant, greatest(100, p_rating)),
    online_wins = online_wins + (p_score = 1)::int,
    online_losses = online_losses + (p_score = 0)::int,
    online_draws = online_draws + (p_score = 0.5)::int,
    xp = xp + gain,
    coins = coins + reward,
    reward_day = p_today,
    coins_today = used + reward
  where id = p.id;
end $$;

-- Entra in coda (o rinnova la presenza) e prova ad abbinare con chi ha il punteggio più vicino.
-- Il server passa già una posizione iniziale pronta, usata solo se trova un avversario.
-- Restituisce l'id della partita oppure null se resta in attesa.
create or replace function public.queue_join(p_uid uuid, p_variant text, p_tc text, p_base integer,
  p_inc integer, p_fen text, p_hw integer, p_hb integer, p_coin boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  myrating integer;
  opp public.queue;
  mid uuid;
  w uuid; b uuid;
begin
  perform pg_advisory_xact_lock(hashtext('mnemoi-queue'));
  select coalesce((ratings ->> p_variant)::int, 1200) into myrating from profiles where id = p_uid;
  if myrating is null then raise exception 'Profilo mancante'; end if;
  delete from queue where seen_at < now() - interval '30 seconds';
  select * into opp from queue
    where variant = p_variant and tc = p_tc and user_id <> p_uid
    order by abs(rating - myrating), created_at limit 1;
  if not found then
    insert into queue (user_id, variant, tc, rating) values (p_uid, p_variant, p_tc, myrating)
      on conflict (user_id) do update set seen_at = now(),
        created_at = case when queue.variant = excluded.variant and queue.tc = excluded.tc then queue.created_at else now() end,
        variant = excluded.variant, tc = excluded.tc, rating = excluded.rating;
    return null;
  end if;
  delete from queue where user_id in (p_uid, opp.user_id);
  if p_coin then w := p_uid; b := opp.user_id; else w := opp.user_id; b := p_uid; end if;
  mid := public._create_match(p_variant, p_tc, p_base, p_inc, w, b, p_fen, p_hw, p_hb);
  return mid;
end $$;

create or replace function public._create_match(p_variant text, p_tc text, p_base integer, p_inc integer,
  p_white uuid, p_black uuid, p_fen text, p_hw integer, p_hb integer)
returns uuid language plpgsql security definer set search_path = public as $$
declare mid uuid;
begin
  insert into matches (variant, tc, base_s, inc_s, white, black, start_fen, white_ms, black_ms)
    values (p_variant, p_tc, p_base, p_inc, p_white, p_black, p_fen, p_base * 1000, p_base * 1000)
    returning id into mid;
  if p_hw is not null then
    insert into match_secrets (match_id, user_id, color, square) values (mid, p_white, 'w', p_hw), (mid, p_black, 'b', p_hb);
  end if;
  return mid;
end $$;

-- ---------- Scacchiera predefinita viola e legno gratuito ----------
update public.items set name = 'Mnemoi', data = '{"light":"#e9e1f7","dark":"#8b6cc9"}'::jsonb where id = 'board_classico';
insert into public.items (id, kind, name, price, data, sort)
values ('board_legno', 'board', 'Legno', 0, '{"light":"#f0d9b5","dark":"#b58863"}'::jsonb, 1)
on conflict (id) do update set name = excluded.name, price = excluded.price, data = excluded.data;

-- ---------- Permessi ----------
revoke all on function public.finish_match(uuid, text, text), public._online_reward(public.profiles, text, integer, numeric, boolean, date),
  public.queue_join(uuid, text, text, integer, integer, text, integer, integer, boolean),
  public._create_match(text, text, integer, integer, uuid, uuid, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.friend_request(text), public.friend_respond(uuid, boolean), public.friend_remove(uuid),
  public.report_game(text, integer, integer) from public, anon;
grant execute on function public.friend_request(text), public.friend_respond(uuid, boolean), public.friend_remove(uuid),
  public.report_game(text, integer, integer) to authenticated;

grant select on public.matches to anon, authenticated;
grant select on public.match_secrets, public.queue, public.challenges, public.friendships to authenticated;
revoke insert, update, delete, truncate on public.matches, public.match_secrets, public.queue, public.challenges,
  public.friendships from anon, authenticated;

-- ---------- Aggiornamenti in tempo reale ----------
do $$
declare t text;
begin
  foreach t in array array['matches', 'challenges', 'friendships'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

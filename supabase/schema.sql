-- Mnemoi: database per account, monete, negozio e ruota della fortuna.
-- Da incollare una volta in Supabase > SQL Editor > New query > Run.
-- Si può rieseguire senza perdere dati.

-- ---------- Profili ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique
    check (char_length(username) between 3 and 20 and username ~ '^[A-Za-z0-9_.]+$'),
  avatar_url text,
  coins integer not null default 50 check (coins >= 0),
  wins integer not null default 0,
  losses integer not null default 0,
  draws integer not null default 0,
  board_theme text not null default 'board_classico',
  piece_style text not null default 'pieces_classico',
  last_spin_day date,
  last_reward_at timestamptz,
  reward_day date,
  coins_today integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
drop policy if exists "profili pubblici" on public.profiles;
create policy "profili pubblici" on public.profiles for select using (true);
-- Nessuna scrittura diretta: si passa solo dalle funzioni qui sotto.

-- Crea il profilo alla registrazione, con il nome scelto (o uno automatico se già preso)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  wanted text := coalesce(new.raw_user_meta_data ->> 'username', '');
  final text;
begin
  if wanted !~ '^[A-Za-z0-9_.]{3,20}$' then
    wanted := 'giocatore';
  end if;
  final := wanted;
  while exists (select 1 from public.profiles where lower(username) = lower(final)) loop
    final := left(wanted, 15) || (floor(random() * 90000) + 10000)::int;
  end loop;
  insert into public.profiles (id, username) values (new.id, final);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Catalogo del negozio ----------
create table if not exists public.items (
  id text primary key,
  kind text not null check (kind in ('board', 'pieces')),
  name text not null,
  price integer not null check (price >= 0),
  data jsonb not null,
  sort integer not null default 0
);
alter table public.items enable row level security;
drop policy if exists "catalogo pubblico" on public.items;
create policy "catalogo pubblico" on public.items for select using (true);

insert into public.items (id, kind, name, price, data, sort) values
  ('board_classico', 'board', 'Classica',      0, '{"light":"#f0d9b5","dark":"#b58863"}', 0),
  ('board_torneo',   'board', 'Torneo',      100, '{"light":"#eeeed2","dark":"#769656"}', 1),
  ('board_oceano',   'board', 'Oceano',      150, '{"light":"#dee3e6","dark":"#8ca2ad"}', 2),
  ('board_lavanda',  'board', 'Lavanda',     200, '{"light":"#ece4f4","dark":"#9b7fbf"}', 3),
  ('board_ciliegio', 'board', 'Ciliegio',    250, '{"light":"#f6dcd6","dark":"#c46f6a"}', 4),
  ('board_notte',    'board', 'Notte',       300, '{"light":"#7d8796","dark":"#3a4250"}', 5),
  ('board_marmo',    'board', 'Marmo',       400, '{"light":"#efede8","dark":"#a7a199"}', 6),
  ('board_oro',      'board', 'Oro',        1000, '{"light":"#f8e9b0","dark":"#c79a1e"}', 7),
  ('pieces_classico','pieces','Classici',      0, '{"w":"#ffffff","ws":"0 0 2px #000, 0 0 1px #000, 0 1px 2px rgba(0,0,0,.5)","b":"#111111","bs":"0 1px 1px rgba(255,255,255,.25)"}', 0),
  ('pieces_legno',   'pieces','Legno',       150, '{"w":"#f3d9b1","ws":"0 0 2px #3b2410, 0 1px 2px rgba(0,0,0,.5)","b":"#5d3a1a","bs":"0 0 1px #000"}', 1),
  ('pieces_rubino',  'pieces','Rubino e zaffiro', 250, '{"w":"#ef5350","ws":"0 0 2px #4a0000, 0 1px 2px rgba(0,0,0,.5)","b":"#1e3a8a","bs":"0 0 2px #000"}', 2),
  ('pieces_smeraldo','pieces','Smeraldo',    250, '{"w":"#a5f3c4","ws":"0 0 2px #064e3b, 0 1px 2px rgba(0,0,0,.5)","b":"#065f46","bs":"0 0 2px #000"}', 3),
  ('pieces_ghiaccio','pieces','Ghiaccio',    350, '{"w":"#e0f7ff","ws":"0 0 6px #4fc3f7, 0 0 1px #01579b","b":"#0d47a1","bs":"0 0 6px #81d4fa"}', 4),
  ('pieces_neon',    'pieces','Neon',        500, '{"w":"#e0ffff","ws":"0 0 4px #00e5ff, 0 0 10px #00e5ff","b":"#2b0033","bs":"0 0 4px #ff00e5, 0 0 10px #ff00e5"}', 5),
  ('pieces_oro',     'pieces','Oro e argento', 800, '{"w":"#ffd54f","ws":"0 0 2px #6d4c00, 0 0 6px rgba(255,193,7,.6)","b":"#9e9e9e","bs":"0 0 2px #212121, 0 0 6px rgba(255,255,255,.4)"}', 6)
on conflict (id) do update set kind = excluded.kind, name = excluded.name, price = excluded.price,
  data = excluded.data, sort = excluded.sort;

-- ---------- Inventario ----------
create table if not exists public.inventory (
  user_id uuid not null references public.profiles (id) on delete cascade,
  item_id text not null references public.items (id),
  acquired_at timestamptz not null default now(),
  primary key (user_id, item_id)
);
alter table public.inventory enable row level security;
drop policy if exists "inventario personale" on public.inventory;
create policy "inventario personale" on public.inventory for select using (auth.uid() = user_id);

-- ---------- Storico partite e giri della ruota ----------
create table if not exists public.games (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  result text not null check (result in ('win', 'loss', 'draw')),
  level integer not null,
  moves integer not null,
  coins integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.games enable row level security;
drop policy if exists "partite personali" on public.games;
create policy "partite personali" on public.games for select using (auth.uid() = user_id);

create table if not exists public.spins (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  prize integer not null,
  created_at timestamptz not null default now()
);
alter table public.spins enable row level security;
drop policy if exists "giri personali" on public.spins;
create policy "giri personali" on public.spins for select using (auth.uid() = user_id);

-- ---------- Funzioni chiamate dal sito ----------

-- Cambia nome visualizzato e foto profilo
create or replace function public.update_profile(p_username text, p_avatar_url text)
returns public.profiles language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  r public.profiles;
begin
  if me is null then raise exception 'Devi accedere'; end if;
  if p_username !~ '^[A-Za-z0-9_.]{3,20}$' then
    raise exception 'Il nome deve avere da 3 a 20 caratteri tra lettere, numeri, punto e trattino basso';
  end if;
  if exists (select 1 from profiles where lower(username) = lower(p_username) and id <> me) then
    raise exception 'Nome già in uso';
  end if;
  if p_avatar_url is not null and p_avatar_url <> ''
     and p_avatar_url !~ ('/storage/v1/object/public/avatars/' || me::text || '/') then
    raise exception 'Immagine non valida';
  end if;
  update profiles set username = p_username, avatar_url = nullif(p_avatar_url, '')
    where id = me returning * into r;
  return r;
end $$;

-- Compra un oggetto
create or replace function public.buy_item(p_item text)
returns public.profiles language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  it public.items;
  r public.profiles;
begin
  if me is null then raise exception 'Devi accedere'; end if;
  select * into it from items where id = p_item;
  if not found then raise exception 'Oggetto inesistente'; end if;
  select * into r from profiles where id = me for update;
  if it.price = 0 or exists (select 1 from inventory where user_id = me and item_id = p_item) then
    raise exception 'Lo possiedi già';
  end if;
  if r.coins < it.price then raise exception 'Monete insufficienti'; end if;
  update profiles set coins = coins - it.price where id = me returning * into r;
  insert into inventory (user_id, item_id) values (me, p_item);
  return r;
end $$;

-- Usa un oggetto posseduto
create or replace function public.equip_item(p_item text)
returns public.profiles language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  it public.items;
  r public.profiles;
begin
  if me is null then raise exception 'Devi accedere'; end if;
  select * into it from items where id = p_item;
  if not found then raise exception 'Oggetto inesistente'; end if;
  if it.price > 0 and not exists (select 1 from inventory where user_id = me and item_id = p_item) then
    raise exception 'Prima devi comprarlo';
  end if;
  if it.kind = 'board' then
    update profiles set board_theme = p_item where id = me returning * into r;
  else
    update profiles set piece_style = p_item where id = me returning * into r;
  end if;
  return r;
end $$;

-- Registra la fine di una partita contro il computer e assegna le monete.
-- Limiti anti-abuso: almeno 10 mosse, una vittoria premiata al minuto, massimo 300 monete al giorno dalle partite.
create or replace function public.report_game(p_result text, p_level integer, p_moves integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  r public.profiles;
  today date := (now() at time zone 'Europe/Rome')::date;
  reward integer := 0;
  room integer;
begin
  if me is null then raise exception 'Devi accedere'; end if;
  if p_result not in ('win', 'loss', 'draw') then raise exception 'Risultato non valido'; end if;
  if p_level not in (1, 2, 3) then raise exception 'Livello non valido'; end if;
  select * into r from profiles where id = me for update;
  if r.reward_day is distinct from today then
    r.coins_today := 0;
  end if;
  if p_result = 'win' and p_moves >= 10
     and (r.last_reward_at is null or r.last_reward_at < now() - interval '60 seconds') then
    reward := case p_level when 1 then 5 when 2 then 15 else 30 end;
    room := greatest(0, 300 - r.coins_today);
    reward := least(reward, room);
  end if;
  update profiles set
    wins = wins + (p_result = 'win')::int,
    losses = losses + (p_result = 'loss')::int,
    draws = draws + (p_result = 'draw')::int,
    coins = coins + reward,
    reward_day = today,
    coins_today = r.coins_today + reward,
    last_reward_at = case when reward > 0 then now() else last_reward_at end
  where id = me returning * into r;
  insert into games (user_id, result, level, moves, coins) values (me, p_result, p_level, p_moves, reward);
  return jsonb_build_object('reward', reward, 'coins', r.coins);
end $$;

-- Ruota della fortuna: un giro al giorno (giorno di calendario, ora italiana).
-- Gli spicchi devono restare nello stesso ordine di WHEEL in account.js.
create or replace function public.spin_wheel()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  r public.profiles;
  today date := (now() at time zone 'Europe/Rome')::date;
  prizes integer[] := array[10, 50, 20, 100, 10, 30, 20, 500];
  weights integer[] := array[24, 8, 20, 4, 24, 10, 9, 1];
  total integer := 0;
  pick integer;
  acc integer := 0;
  idx integer := 1;
begin
  if me is null then raise exception 'Devi accedere'; end if;
  select * into r from profiles where id = me for update;
  if r.last_spin_day = today then raise exception 'Hai già girato la ruota oggi, torna domani'; end if;
  select sum(w) into total from unnest(weights) as w;
  pick := floor(random() * total)::int;
  for i in 1 .. array_length(weights, 1) loop
    acc := acc + weights[i];
    if pick < acc then idx := i; exit; end if;
  end loop;
  update profiles set coins = coins + prizes[idx], last_spin_day = today where id = me returning * into r;
  insert into spins (user_id, prize) values (me, prizes[idx]);
  return jsonb_build_object('index', idx - 1, 'prize', prizes[idx], 'coins', r.coins);
end $$;

-- Cancella il proprio account e tutti i dati collegati
create or replace function public.delete_account()
returns void language plpgsql security definer set search_path = public, auth, storage as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Devi accedere'; end if;
  delete from storage.objects where bucket_id = 'avatars' and (storage.foldername(name))[1] = me::text;
  delete from auth.users where id = me;
end $$;

revoke all on function public.update_profile(text, text), public.buy_item(text), public.equip_item(text),
  public.report_game(text, integer, integer), public.spin_wheel(), public.delete_account() from public, anon;
grant execute on function public.update_profile(text, text), public.buy_item(text), public.equip_item(text),
  public.report_game(text, integer, integer), public.spin_wheel(), public.delete_account() to authenticated;

-- ---------- Foto profilo ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 524288, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 524288,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "avatar: leggi il tuo" on storage.objects;
create policy "avatar: leggi il tuo" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatar: carica il tuo" on storage.objects;
create policy "avatar: carica il tuo" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatar: aggiorna il tuo" on storage.objects;
create policy "avatar: aggiorna il tuo" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatar: cancella il tuo" on storage.objects;
create policy "avatar: cancella il tuo" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- Permessi: lettura pubblica, scrittura solo tramite le funzioni ----------
grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.items to anon, authenticated;
grant select on public.inventory, public.games, public.spins to authenticated;
revoke insert, update, delete, truncate on public.profiles, public.items, public.inventory, public.games, public.spins
  from anon, authenticated;

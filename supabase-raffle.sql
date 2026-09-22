-- Raffle-based item distribution (trial version) — prevents macro/auto-clicker abuse by
-- replacing "first click wins" with "everyone who clicks during the window enters a pool,
-- server picks a random winner after the window closes."
--
-- Run this file once in Supabase Dashboard -> SQL Editor, on the SAME project already used
-- by the main reservation site (reuses its timer_admins allowlist for who can run rounds).
-- Requires supabase-timer.sql to already be applied (for public.timer_admins).

-- One row per raffle round. A round bundles every item open for raffle during one window.
-- mode: 'single'  = each IGN may hold only one undecided entry across the whole round (must
--                    wait for the round's draw before trying a different item)
--       'multi'   = an IGN may enter as many different items as they want in the round
create table if not exists public.raffle_rounds (
  id bigint generated always as identity primary key,
  mode text not null check (mode in ('single', 'multi')),
  window_seconds integer not null check (window_seconds > 0),
  status text not null default 'open' check (status in ('open', 'drawn')),
  opens_at timestamptz not null default clock_timestamp(),
  closes_at timestamptz not null,
  created_by text,
  drawn_at timestamptz
);

-- One row per raffle entry. A person can hold at most one entry per item per round (no
-- benefit to letting them submit the same item twice); the 'single' mode rule (one item per
-- round) is enforced in enter_raffle() below, not by a table constraint, since it depends on
-- the round's mode.
create table if not exists public.raffle_entries (
  id bigint generated always as identity primary key,
  round_id bigint not null references public.raffle_rounds(id) on delete cascade,
  item_id integer not null,
  ign text not null,
  entered_at timestamptz not null default clock_timestamp(),
  unique (round_id, item_id, ign)
);

-- One row per (round, item) once drawn — the winner.
create table if not exists public.raffle_winners (
  round_id bigint not null references public.raffle_rounds(id) on delete cascade,
  item_id integer not null,
  ign text not null,
  drawn_at timestamptz not null default clock_timestamp(),
  primary key (round_id, item_id)
);

-- Item board config for the trial site (prefix / total items / items per page), mirroring the
-- main site's config row. Single-row table.
create table if not exists public.raffle_config (
  id boolean primary key default true check (id),
  prefix text not null default '#',
  total_items integer not null default 20,
  items_per_page integer not null default 8
);
insert into public.raffle_config (id) values (true) on conflict (id) do nothing;

alter table public.raffle_rounds enable row level security;
alter table public.raffle_entries enable row level security;
alter table public.raffle_winners enable row level security;
alter table public.raffle_config enable row level security;
-- No policies on any of the four tables -> anon/authenticated get zero direct access; every
-- read and write goes through the security definer functions below (same pattern as
-- timer_admins in supabase-timer.sql).

create or replace function public.raffle_server_time_ms()
returns bigint
language sql
volatile
security definer
set search_path = public
as $$
  select floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
$$;

create or replace function public.get_raffle_config()
returns table(prefix text, total_items integer, items_per_page integer)
language sql
security definer
set search_path = public
as $$
  select prefix, total_items, items_per_page from public.raffle_config where id = true;
$$;

create or replace function public.set_raffle_config(p_prefix text, p_total_items integer, p_items_per_page integer, p_actor_ign text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_actor_ign is null or not exists (select 1 from public.timer_admins where ign = btrim(p_actor_ign)) then
    raise exception 'Only designated admins can change the item board.';
  end if;
  update public.raffle_config
  set prefix = coalesce(nullif(btrim(p_prefix), ''), prefix),
      total_items = greatest(1, coalesce(p_total_items, total_items)),
      items_per_page = greatest(1, coalesce(p_items_per_page, items_per_page))
  where id = true;
end;
$$;

-- Starts a new round. Admin-gated the same way start_page_timer is. Refuses to open a second
-- round while one is still open, so there's always at most one active round at a time.
create or replace function public.create_raffle_round(p_mode text, p_window_seconds integer, p_created_by text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  if p_created_by is null or not exists (select 1 from public.timer_admins where ign = btrim(p_created_by)) then
    raise exception 'Only designated admins can start a raffle round.';
  end if;
  if p_mode not in ('single', 'multi') then
    raise exception 'Invalid mode';
  end if;
  if p_window_seconds is null or p_window_seconds < 10 then
    raise exception 'Window must be at least 10 seconds';
  end if;
  if exists (select 1 from public.raffle_rounds where status = 'open') then
    raise exception 'A round is already open — draw or wait for it to close first.';
  end if;

  insert into public.raffle_rounds (mode, window_seconds, closes_at, created_by)
  values (p_mode, p_window_seconds, clock_timestamp() + make_interval(secs => p_window_seconds), btrim(p_created_by))
  returning id into v_id;

  return v_id;
end;
$$;

-- Enters p_ign into the raffle for p_item_id in p_round_id. This is the actual anti-macro
-- gate: unlike click-to-claim, being first here gets you nothing extra — the winner is chosen
-- randomly only after the window closes, so a macro clicking in 5ms has exactly the same odds
-- as a human clicking a second before the window shuts.
create or replace function public.enter_raffle(p_round_id bigint, p_item_id integer, p_ign text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round record;
  v_other_item integer;
begin
  if p_ign is null or btrim(p_ign) = '' then
    return 'invalid_ign';
  end if;

  select * into v_round from public.raffle_rounds where id = p_round_id;
  if v_round is null then
    return 'round_not_found';
  end if;
  if v_round.status <> 'open' or clock_timestamp() >= v_round.closes_at then
    return 'round_closed';
  end if;

  if v_round.mode = 'single' then
    select item_id into v_other_item
    from public.raffle_entries
    where round_id = p_round_id and ign = btrim(p_ign) and item_id <> p_item_id
    limit 1;

    if v_other_item is not null then
      return 'single_entry_limit';
    end if;
  end if;

  insert into public.raffle_entries (round_id, item_id, ign)
  values (p_round_id, p_item_id, btrim(p_ign))
  on conflict (round_id, item_id, ign) do nothing;

  if not found then
    return 'already_entered';
  end if;

  return 'entered';
end;
$$;

-- Draws winners for every item with at least one entry, once the window has actually closed.
-- Safe to call from any browser (there's no login on this site) and safe to call multiple
-- times / from multiple browsers at once — the guarded UPDATE below ensures only the first
-- caller to reach it actually performs the draw; everyone else gets a no-op.
create or replace function public.draw_raffle_round(p_round_id bigint)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round record;
  v_claimed integer;
begin
  select * into v_round from public.raffle_rounds where id = p_round_id for update;
  if v_round is null then
    return 'round_not_found';
  end if;
  if v_round.status = 'drawn' then
    return 'already_drawn';
  end if;
  if clock_timestamp() < v_round.closes_at then
    return 'not_closed_yet';
  end if;

  update public.raffle_rounds
  set status = 'drawn', drawn_at = clock_timestamp()
  where id = p_round_id and status = 'open';

  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    return 'already_drawn';
  end if;

  insert into public.raffle_winners (round_id, item_id, ign)
  select p_round_id, item_id, ign
  from (
    select item_id, ign,
           row_number() over (partition by item_id order by random()) as rn
    from public.raffle_entries
    where round_id = p_round_id
  ) picked
  where rn = 1
  on conflict (round_id, item_id) do nothing;

  return 'drawn';
end;
$$;

-- Everything the board UI needs for one round, scoped to the viewing IGN: how many people are
-- in each item's pool (no names — avoids revealing who else is competing) and whether *this*
-- IGN is one of them, plus the winner's name once drawn.
create or replace function public.get_raffle_board(p_round_id bigint, p_ign text)
returns table(item_id integer, entry_count bigint, my_entry boolean, winner_ign text)
language sql
security definer
set search_path = public
as $$
  select
    e.item_id,
    count(*) as entry_count,
    bool_or(e.ign = btrim(coalesce(p_ign, ''))) as my_entry,
    max(w.ign) as winner_ign
  from public.raffle_entries e
  left join public.raffle_winners w
    on w.round_id = e.round_id and w.item_id = e.item_id
  where e.round_id = p_round_id
  group by e.item_id;
$$;

create or replace function public.get_current_raffle_round()
returns table(id bigint, mode text, window_seconds integer, status text, opens_at timestamptz, closes_at timestamptz, drawn_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select id, mode, window_seconds, status, opens_at, closes_at, drawn_at
  from public.raffle_rounds
  order by id desc
  limit 1;
$$;

create or replace function public.list_raffle_rounds()
returns table(id bigint, mode text, window_seconds integer, status text, opens_at timestamptz, closes_at timestamptz, drawn_at timestamptz, created_by text)
language sql
security definer
set search_path = public
as $$
  select id, mode, window_seconds, status, opens_at, closes_at, drawn_at, created_by
  from public.raffle_rounds
  order by id desc;
$$;

grant execute on function public.raffle_server_time_ms() to anon, authenticated;
grant execute on function public.get_raffle_config() to anon, authenticated;
grant execute on function public.set_raffle_config(text, integer, integer, text) to anon, authenticated;
grant execute on function public.create_raffle_round(text, integer, text) to anon, authenticated;
grant execute on function public.enter_raffle(bigint, integer, text) to anon, authenticated;
grant execute on function public.draw_raffle_round(bigint) to anon, authenticated;
grant execute on function public.get_raffle_board(bigint, text) to anon, authenticated;
grant execute on function public.get_current_raffle_round() to anon, authenticated;
grant execute on function public.list_raffle_rounds() to anon, authenticated;

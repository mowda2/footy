-- Footy: sign-ups, self-reported e-transfers, waitlist and fair teams.
-- Everything goes through SECURITY DEFINER functions; the tables themselves
-- are locked (RLS on, no policies, no grants), so the public key can only
-- call the functions below.

create extension if not exists pgcrypto with schema extensions;

create table public.footy_settings (
  id int primary key default 1 check (id = 1),
  admin_pin_hash text,
  group_name text not null default 'Footy',
  updated_at timestamptz not null default now()
);
insert into public.footy_settings (id) values (1);

create table public.footy_matches (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  title text not null default 'Soccer',
  venue text not null check (char_length(venue) between 1 and 80),
  field text check (field is null or char_length(field) <= 40),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  price numeric(8,2) not null default 0 check (price >= 0),
  etransfer_to text check (etransfer_to is null or char_length(etransfer_to) <= 120),
  capacity int not null default 18 check (capacity between 2 and 60),
  team_count int not null default 2 check (team_count between 2 and 6),
  pay_by timestamptz,
  notes text check (notes is null or char_length(notes) <= 500),
  status text not null default 'open' check (status in ('open','closed','cancelled')),
  teams jsonb,
  teams_updated_at timestamptz,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table public.footy_signups (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.footy_matches(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  guest_of text check (guest_of is null or char_length(guest_of) between 1 and 40),
  paid boolean not null default false,
  paid_at timestamptz,
  owner_hash text,                 -- sha256 of the device token that added (or claimed) this name
  queued_at timestamptz not null default clock_timestamp(),  -- list order
  created_at timestamptz not null default now(),
  left_at timestamptz
);
create index footy_signups_active_idx on public.footy_signups (match_id, queued_at) where left_at is null;

create table public.footy_players (
  name_key text primary key,       -- lower-cased, single-spaced name
  display_name text not null,
  rating smallint not null default 3 check (rating between 1 and 5),
  updated_at timestamptz not null default now()
);

alter table public.footy_settings enable row level security;
alter table public.footy_matches  enable row level security;
alter table public.footy_signups  enable row level security;
alter table public.footy_players  enable row level security;
revoke all on public.footy_settings, public.footy_matches, public.footy_signups, public.footy_players from anon, authenticated;

-- ---------------------------------------------------------------- helpers
create function public.footy__hash(p text) returns text
language sql immutable set search_path = '' as $$
  select case when p is null or p = '' then null
         else encode(extensions.digest(p, 'sha256'), 'hex') end
$$;

create function public.footy__name_key(p text) returns text
language sql immutable set search_path = '' as $$
  select lower(regexp_replace(btrim(coalesce(p,'')), '\s+', ' ', 'g'))
$$;

create function public.footy__clean(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(regexp_replace(btrim(coalesce(p,'')), '\s+', ' ', 'g'), '')
$$;

create function public.footy__is_admin(p_pin text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare h text;
begin
  select admin_pin_hash into h from public.footy_settings where id = 1;
  if h is null or p_pin is null or p_pin = '' then return false; end if;
  return extensions.crypt(p_pin, h) = h;
end $$;

create function public.footy__require_admin(p_pin text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.footy__is_admin(p_pin) then
    raise exception 'Wrong organizer PIN' using errcode = 'P0001';
  end if;
end $$;

-- ------------------------------------------------------------ public RPCs
create function public.footy_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('has_pin', admin_pin_hash is not null, 'group_name', group_name)
  from public.footy_settings where id = 1
$$;

create function public.footy_check_pin(p_pin text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.footy__is_admin(p_pin)
$$;

-- First call sets the PIN; after that the current PIN is needed to change it.
create function public.footy_set_pin(p_new_pin text, p_old_pin text default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare h text;
begin
  if p_new_pin is null or char_length(p_new_pin) < 4 or char_length(p_new_pin) > 32 then
    raise exception 'PIN must be 4 to 32 characters' using errcode = 'P0001';
  end if;
  select admin_pin_hash into h from public.footy_settings where id = 1 for update;
  if h is not null and not public.footy__is_admin(p_old_pin) then
    raise exception 'Current PIN is wrong' using errcode = 'P0001';
  end if;
  update public.footy_settings
     set admin_pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 8)), updated_at = now()
   where id = 1;
  return true;
end $$;

create function public.footy_list_matches() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'slug', m.slug, 'title', m.title, 'venue', m.venue, 'field', m.field,
      'starts_at', m.starts_at, 'ends_at', m.ends_at, 'price', m.price, 'etransfer_to', m.etransfer_to,
      'capacity', m.capacity, 'team_count', m.team_count, 'status', m.status,
      'pay_by', m.pay_by, 'notes', m.notes,
      'confirmed', least(c.n_active, m.capacity),
      'waitlist', greatest(c.n_active - m.capacity, 0),
      'paid', c.n_paid_in
    ) order by m.starts_at desc), '[]'::jsonb)
  from public.footy_matches m
  cross join lateral (
    select count(*) as n_active,
           count(*) filter (where r.paid and r.rn <= m.capacity) as n_paid_in
    from (
      select s.paid, row_number() over (order by s.queued_at, s.created_at) rn
      from public.footy_signups s where s.match_id = m.id and s.left_at is null
    ) r
  ) c
  where m.ends_at > now() - interval '45 days'
$$;

create function public.footy_get_match(p_slug text, p_token text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare m public.footy_matches; th text := public.footy__hash(p_token); res jsonb;
begin
  select * into m from public.footy_matches where slug = p_slug;
  if not found then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'name', s.name, 'guest_of', s.guest_of, 'paid', s.paid, 'paid_at', s.paid_at,
      'joined_at', s.created_at, 'pos', s.rn, 'in', s.rn <= m.capacity,
      'mine', coalesce(th is not null and s.owner_hash = th, false),
      'claimed', s.owner_hash is not null
    ) order by s.rn), '[]'::jsonb)
  into res
  from (
    select x.*, row_number() over (order by x.queued_at, x.created_at) as rn
    from public.footy_signups x where x.match_id = m.id and x.left_at is null
  ) s;
  return jsonb_build_object('match', to_jsonb(m) - 'created_at', 'signups', res, 'server_now', now());
end $$;

create function public.footy_join(p_slug text, p_name text, p_token text, p_guest_of text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare m public.footy_matches; n text := public.footy__clean(p_name); g text := public.footy__clean(p_guest_of);
        new_id uuid; active_count int;
begin
  select * into m from public.footy_matches where slug = p_slug for update;
  if not found then raise exception 'Game not found' using errcode = 'P0001'; end if;
  if m.status = 'cancelled' then raise exception 'This game was cancelled' using errcode = 'P0001'; end if;
  if m.status = 'closed' then raise exception 'Sign-ups are closed for this game' using errcode = 'P0001'; end if;
  if m.ends_at < now() then raise exception 'This game is already over' using errcode = 'P0001'; end if;
  if n is null or char_length(n) > 40 then raise exception 'Enter a name (40 characters max)' using errcode = 'P0001'; end if;
  if g is not null and char_length(g) > 40 then raise exception 'Name is too long' using errcode = 'P0001'; end if;
  if p_token is null or char_length(p_token) < 16 then raise exception 'Missing device token' using errcode = 'P0001'; end if;
  if exists (select 1 from public.footy_signups s
             where s.match_id = m.id and s.left_at is null
               and public.footy__name_key(s.name) = public.footy__name_key(n)) then
    raise exception '% is already on the list', n using errcode = 'P0001';
  end if;
  select count(*) into active_count from public.footy_signups s where s.match_id = m.id and s.left_at is null;
  if active_count >= m.capacity + 30 then raise exception 'The waitlist is full' using errcode = 'P0001'; end if;
  insert into public.footy_signups (match_id, name, guest_of, owner_hash)
  values (m.id, n, g, public.footy__hash(p_token))
  returning id into new_id;
  return new_id;
end $$;

-- Names pasted in by the organizer have no owner; the real person taps "That's me".
create function public.footy_claim(p_signup_id uuid, p_token text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare s public.footy_signups; th text := public.footy__hash(p_token);
begin
  if th is null or char_length(p_token) < 16 then raise exception 'Missing device token' using errcode = 'P0001'; end if;
  select * into s from public.footy_signups where id = p_signup_id and left_at is null for update;
  if not found then raise exception 'That spot no longer exists' using errcode = 'P0001'; end if;
  if s.owner_hash = th then return true; end if;
  if s.owner_hash is not null then raise exception 'Someone already claimed this name' using errcode = 'P0001'; end if;
  update public.footy_signups set owner_hash = th where id = p_signup_id;
  return true;
end $$;

create function public.footy_set_paid(p_signup_id uuid, p_paid boolean, p_token text default null, p_pin text default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare s public.footy_signups;
begin
  select * into s from public.footy_signups where id = p_signup_id and left_at is null for update;
  if not found then raise exception 'That spot no longer exists' using errcode = 'P0001'; end if;
  if not (s.owner_hash is not null and s.owner_hash = public.footy__hash(p_token)) and not public.footy__is_admin(p_pin) then
    raise exception 'Only the person who added this name, or an organizer, can change it' using errcode = 'P0001';
  end if;
  update public.footy_signups set paid = p_paid, paid_at = case when p_paid then now() else null end
   where id = p_signup_id;
  return p_paid;
end $$;

create function public.footy_leave(p_signup_id uuid, p_token text default null, p_pin text default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare s public.footy_signups;
begin
  select * into s from public.footy_signups where id = p_signup_id and left_at is null for update;
  if not found then return true; end if;
  if not (s.owner_hash is not null and s.owner_hash = public.footy__hash(p_token)) and not public.footy__is_admin(p_pin) then
    raise exception 'Only the person who added this name, or an organizer, can remove it' using errcode = 'P0001';
  end if;
  update public.footy_signups set left_at = now() where id = p_signup_id;
  return true;
end $$;

-- --------------------------------------------------------- organizer RPCs
create function public.footy_save_match(p_pin text, p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p->>'id','')::uuid; v_slug text; v_start timestamptz := (p->>'starts_at')::timestamptz;
begin
  perform public.footy__require_admin(p_pin);
  if public.footy__clean(p->>'venue') is null then raise exception 'Add a venue' using errcode = 'P0001'; end if;
  if v_id is null then
    v_slug := lower(to_char(v_start at time zone 'America/Toronto', 'Dy-Mon-FMDD')) || '-' || substr(md5(gen_random_uuid()::text), 1, 4);
    insert into public.footy_matches (slug, title, venue, field, starts_at, ends_at, price, etransfer_to, capacity, team_count, pay_by, notes)
    values (v_slug,
      coalesce(public.footy__clean(p->>'title'), 'Soccer'),
      public.footy__clean(p->>'venue'),
      public.footy__clean(p->>'field'),
      v_start, (p->>'ends_at')::timestamptz,
      coalesce(nullif(p->>'price','')::numeric, 0),
      public.footy__clean(p->>'etransfer_to'),
      coalesce(nullif(p->>'capacity','')::int, 18),
      coalesce(nullif(p->>'team_count','')::int, 2),
      nullif(p->>'pay_by','')::timestamptz,
      public.footy__clean(p->>'notes'));
  else
    update public.footy_matches set
      title = coalesce(public.footy__clean(p->>'title'), 'Soccer'),
      venue = public.footy__clean(p->>'venue'),
      field = public.footy__clean(p->>'field'),
      starts_at = v_start, ends_at = (p->>'ends_at')::timestamptz,
      price = coalesce(nullif(p->>'price','')::numeric, 0),
      etransfer_to = public.footy__clean(p->>'etransfer_to'),
      capacity = coalesce(nullif(p->>'capacity','')::int, 18),
      team_count = coalesce(nullif(p->>'team_count','')::int, 2),
      pay_by = nullif(p->>'pay_by','')::timestamptz,
      notes = public.footy__clean(p->>'notes')
    where id = v_id
    returning slug into v_slug;
    if v_slug is null then raise exception 'Game not found' using errcode = 'P0001'; end if;
  end if;
  return v_slug;
end $$;

create function public.footy_set_match_status(p_pin text, p_match_id uuid, p_status text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform public.footy__require_admin(p_pin);
  update public.footy_matches set status = p_status where id = p_match_id;
  return found;
end $$;

create function public.footy_delete_match(p_pin text, p_match_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform public.footy__require_admin(p_pin);
  delete from public.footy_matches where id = p_match_id;
  return found;
end $$;

-- Add several names at once (e.g. pasted from the group chat). Returns how many were added.
create function public.footy_bulk_add(p_pin text, p_slug text, p_names text[]) returns int
language plpgsql security definer set search_path = '' as $$
declare m public.footy_matches; nm text; n text; added int := 0;
begin
  perform public.footy__require_admin(p_pin);
  select * into m from public.footy_matches where slug = p_slug for update;
  if not found then raise exception 'Game not found' using errcode = 'P0001'; end if;
  foreach nm in array coalesce(p_names, '{}') loop
    n := public.footy__clean(nm);
    continue when n is null or char_length(n) > 40;
    continue when exists (select 1 from public.footy_signups s
                          where s.match_id = m.id and s.left_at is null
                            and public.footy__name_key(s.name) = public.footy__name_key(n));
    insert into public.footy_signups (match_id, name) values (m.id, n);
    added := added + 1;
  end loop;
  return added;
end $$;

-- Push everyone holding a spot without paying behind the waitlist (keeps their order).
create function public.footy_bump_unpaid(p_pin text, p_match_id uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare cap int; n int;
begin
  perform public.footy__require_admin(p_pin);
  select capacity into cap from public.footy_matches where id = p_match_id for update;
  with ranked as (
    select id, paid, row_number() over (order by queued_at, created_at) rn
    from public.footy_signups where match_id = p_match_id and left_at is null
  ), targets as (
    select id, row_number() over (order by rn) k from ranked where rn <= cap and not paid
  )
  update public.footy_signups s
     set queued_at = clock_timestamp() + (t.k * interval '1 millisecond')
    from targets t where s.id = t.id;
  get diagnostics n = row_count;
  return n;
end $$;

create function public.footy_get_ratings(p_pin text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.footy__require_admin(p_pin);
  return coalesce((select jsonb_object_agg(name_key, rating) from public.footy_players), '{}'::jsonb);
end $$;

create function public.footy_set_rating(p_pin text, p_name text, p_rating int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare k text := public.footy__name_key(p_name);
begin
  perform public.footy__require_admin(p_pin);
  if k = '' then raise exception 'Missing name' using errcode = 'P0001'; end if;
  insert into public.footy_players (name_key, display_name, rating) values (k, public.footy__clean(p_name), p_rating)
  on conflict (name_key) do update set rating = excluded.rating, display_name = excluded.display_name, updated_at = now();
  return true;
end $$;

create function public.footy_save_teams(p_pin text, p_match_id uuid, p_teams jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform public.footy__require_admin(p_pin);
  update public.footy_matches
     set teams = p_teams, teams_updated_at = case when p_teams is null then null else now() end
   where id = p_match_id;
  return found;
end $$;

-- ------------------------------------------------------------- privileges
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.footy_status(), public.footy_check_pin(text), public.footy_set_pin(text, text),
  public.footy_list_matches(), public.footy_get_match(text, text),
  public.footy_join(text, text, text, text), public.footy_claim(uuid, text),
  public.footy_set_paid(uuid, boolean, text, text), public.footy_leave(uuid, text, text),
  public.footy_save_match(text, jsonb), public.footy_set_match_status(text, uuid, text),
  public.footy_delete_match(text, uuid), public.footy_bulk_add(text, text, text[]),
  public.footy_bump_unpaid(text, uuid),
  public.footy_get_ratings(text), public.footy_set_rating(text, text, int),
  public.footy_save_teams(text, uuid, jsonb)
to anon, authenticated;

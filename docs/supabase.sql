-- =====================================================================================================================
-- SoundBlue · Biblioteca en la nube (Supabase)
-- Pégalo COMPLETO en: SQL Editor → New query → Run. Se puede volver a ejecutar sin borrar datos.
-- Row Level Security: cada cuenta solo puede ver y cambiar SUS filas. La clave pública (anon / publishable) de la app no
-- puede leer nada sin una sesión iniciada.
-- =====================================================================================================================

-- ---- Utilidad: updated_at automático ----
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---- 1. profiles: un perfil por cuenta (se crea solo al registrarse) ----
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text,
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---- 2. playlists: las tuyas (creadas en la app o importadas de YouTube) ----
create table if not exists public.playlists (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  local_id   text not null,                 -- el id que tiene en el teléfono
  name       text not null,
  image      text,                          -- carátula (las importadas)
  source     text,                          -- id de la playlist de YouTube («PL…») si es importada
  position   integer not null default 0,    -- orden en Tu biblioteca
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint playlists_user_local unique (user_id, local_id)
);
-- La misma playlist de YouTube no se importa dos veces en una cuenta (la fusión la reconoce por aquí).
create unique index if not exists playlists_user_source on public.playlists (user_id, source) where source is not null;

-- ---- 3. playlist_songs: las canciones de cada playlist, en orden ----
create table if not exists public.playlist_songs (
  playlist_id uuid not null references public.playlists (id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  video_id    text not null,
  position    integer not null default 0,
  title       text not null default '',
  artist      text not null default '',
  artist_id   text,
  album       text,
  duration    integer,                      -- segundos
  artwork     text,
  yt_music    boolean not null default false,
  added_at    timestamptz not null default now(),
  primary key (playlist_id, video_id)       -- sin repetidas dentro de una playlist
);
create index if not exists playlist_songs_user on public.playlist_songs (user_id);
create index if not exists playlist_songs_order on public.playlist_songs (playlist_id, position);

-- ---- 4. likes: «Tus me gusta» ----
create table if not exists public.likes (
  user_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  video_id  text not null,
  title     text not null default '',
  artist    text not null default '',
  artist_id text,
  album     text,
  duration  integer,
  artwork   text,
  yt_music  boolean not null default false,
  liked_at  timestamptz not null default now(),
  primary key (user_id, video_id)           -- una canción, un «me gusta»
);
create index if not exists likes_user_recent on public.likes (user_id, liked_at desc);

-- ---- 5. history: historial de escucha (alimenta «Para ti», Tu Top 50 y la anti-repetición) ----
create table if not exists public.history (
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  video_id       text not null,
  title          text not null default '',
  artist         text not null default '',
  artist_id      text,
  album          text,
  duration       integer,
  artwork        text,
  yt_music       boolean not null default false,
  play_count     integer not null default 0, -- veces escuchada (30 s o más)
  skips          integer not null default 0, -- veces saltada antes de 30 s
  last_played_at timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (user_id, video_id)
);
create index if not exists history_user_recent on public.history (user_id, last_played_at desc);

-- ---- 6. saved_playlists: «Playlists guardadas» (las de YouTube que guardas con «+»; recomendada) ----
create table if not exists public.saved_playlists (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  browse_id  text not null,                 -- «VLPL…»
  title      text not null,
  subtitle   text not null default '',
  image      text,
  song_count integer,
  saved_at   timestamptz not null default now(),
  primary key (user_id, browse_id)
);

-- ---- updated_at ----
drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
drop trigger if exists playlists_updated_at on public.playlists;
create trigger playlists_updated_at before update on public.playlists
  for each row execute function public.set_updated_at();
drop trigger if exists history_updated_at on public.history;
create trigger history_updated_at before update on public.history
  for each row execute function public.set_updated_at();

-- ---- Row Level Security: cada cuenta, solo lo suyo ----
alter table public.profiles        enable row level security;
alter table public.playlists       enable row level security;
alter table public.playlist_songs  enable row level security;
alter table public.likes           enable row level security;
alter table public.history         enable row level security;
alter table public.saved_playlists enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert to authenticated
  with check ((select auth.uid()) = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

drop policy if exists "playlists_own" on public.playlists;
create policy "playlists_own" on public.playlists
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Una canción solo puede ir a una playlist TUYA.
drop policy if exists "playlist_songs_own" on public.playlist_songs;
create policy "playlist_songs_own" on public.playlist_songs
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.playlists p
      where p.id = playlist_songs.playlist_id and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "likes_own" on public.likes;
create policy "likes_own" on public.likes
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "history_own" on public.history;
create policy "history_own" on public.history
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "saved_playlists_own" on public.saved_playlists;
create policy "saved_playlists_own" on public.saved_playlists
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ---- Permisos: sin sesión (anon) no se toca nada; con sesión, solo por las políticas de arriba ----
revoke all on public.profiles, public.playlists, public.playlist_songs, public.likes, public.history, public.saved_playlists from anon;
grant select, insert, update, delete
  on public.profiles, public.playlists, public.playlist_songs, public.likes, public.history, public.saved_playlists
  to authenticated;

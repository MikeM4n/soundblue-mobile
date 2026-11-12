// Sincronización con la nube (Mi Cuenta). Tu música SIEMPRE se guarda primero en el teléfono (como siempre); además,
// con la sesión iniciada, cada cambio (me gusta, playlists y sus canciones, playlists guardadas, historial) se anota en
// una cola («soundblue:sync-pendiente», sobrevive a cerrar la app) y se sube a Supabase a los pocos segundos. Sin
// internet espera y reintenta: cada 30 s, al volver la conexión y al volver a la app.
// Los cambios se descubren comparando la biblioteca y el historial de antes y de después de cada cambio, así funciona
// con todo lo que ya los modifica (corazón, menú ⋮, importar, deshacer…), sin tocar cada botón.
import { listening, type ListenEntry } from '../data/history'
import { library, type LibraryState, type Playlist, type SavedPlaylist } from '../library/store'
import type { Track } from '../player/types'
import { CloudError, rest, selectAll } from './client'
import type { Rename, Snapshot } from './merge'

const OUTBOX_KEY = 'soundblue:sync-pendiente'
const PUSH_DELAY_MS = 2500 // junta los cambios seguidos (p. ej. varios corazones) en un solo envío
const RETRY_MS = 30_000
const CHUNK = 500 // filas por pedido
const ID_CHUNK = 100 // ids por borrado (van en la dirección)
const FULL_AFTER = 300 // si cambian más canciones que esto en una playlist, se sube entera
const HISTORY_ROWS = 400
// La playlist de esas canciones ya no existe en la nube (clave foránea / no es tuya): hay que volver a crearla.
const STALE_PLAYLIST = ['23503', '42501']

// ---- Filas de la nube ----

interface TrackColumns {
  title: string
  artist: string
  artist_id: string | null
  album: string | null
  duration: number | null
  artwork: string | null
  yt_music: boolean
}
interface LikeRow extends TrackColumns {
  video_id: string
  liked_at: string
}
interface PlaylistRow {
  id: string
  local_id: string
  name: string
  image: string | null
  source: string | null
  position: number
}
interface SongRow extends TrackColumns {
  playlist_id: string
  video_id: string
  position: number
}
interface HistoryRow extends TrackColumns {
  video_id: string
  play_count: number
  skips: number
  last_played_at: string
}
interface SavedRow {
  browse_id: string
  title: string
  subtitle: string
  image: string | null
  song_count: number | null
  saved_at: string
}

const columns = (t: Track): TrackColumns => ({
  title: t.title || '',
  artist: t.artist || '',
  artist_id: t.artistId || null,
  album: t.album || null,
  duration: typeof t.duration === 'number' && Number.isFinite(t.duration) && t.duration > 0 ? Math.round(t.duration) : null,
  artwork: t.artwork || null,
  yt_music: !!t.ytMusic,
})

function trackOf(row: TrackColumns, id: unknown): Track | null {
  if (typeof id !== 'string' || !id || typeof row.title !== 'string') return null
  const track: Track = { id, title: row.title, artist: typeof row.artist === 'string' ? row.artist : '' }
  if (row.artist_id) track.artistId = row.artist_id
  if (row.album) track.album = row.album
  if (typeof row.duration === 'number' && row.duration > 0) track.duration = row.duration
  if (row.yt_music) track.ytMusic = true
  if (row.artwork) track.artwork = row.artwork
  return track
}

const time = (iso: string) => {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : 0
}

// ---- Leer la nube ----

export interface CloudData {
  snapshot: Snapshot
  uuids: Map<string, string> // id local de cada playlist → su id en la nube
}

/** Toda tu música guardada en la nube (el historial: las 400 más recientes). */
export async function fetchCloud(): Promise<CloudData> {
  const [likes, lists, songs, history, saved] = await Promise.all([
    selectAll<LikeRow>('likes', 'select=video_id,title,artist,artist_id,album,duration,artwork,yt_music,liked_at&order=liked_at.desc,video_id.asc'),
    selectAll<PlaylistRow>('playlists', 'select=id,local_id,name,image,source,position&order=position.asc,created_at.asc,id.asc'),
    selectAll<SongRow>('playlist_songs', 'select=playlist_id,video_id,position,title,artist,artist_id,album,duration,artwork,yt_music&order=playlist_id.asc,position.asc,video_id.asc'),
    rest<HistoryRow[]>('GET', `history?select=video_id,title,artist,artist_id,album,duration,artwork,yt_music,play_count,skips,last_played_at&order=last_played_at.desc,video_id.asc&limit=${HISTORY_ROWS}`),
    selectAll<SavedRow>('saved_playlists', 'select=browse_id,title,subtitle,image,song_count,saved_at&order=saved_at.desc,browse_id.asc'),
  ])
  const tracksByList = new Map<string, Track[]>()
  for (const row of songs) {
    const track = trackOf(row, row.video_id)
    if (!track) continue
    const list = tracksByList.get(row.playlist_id) ?? []
    list.push(track)
    tracksByList.set(row.playlist_id, list)
  }
  const uuids = new Map<string, string>()
  const playlists: Playlist[] = []
  for (const row of lists) {
    if (typeof row.local_id !== 'string' || !row.local_id || uuids.has(row.local_id)) continue
    uuids.set(row.local_id, row.id)
    playlists.push({
      id: row.local_id,
      name: row.name || 'Mi playlist',
      tracks: tracksByList.get(row.id) ?? [],
      ...(row.image ? { image: row.image } : {}),
      ...(row.source ? { source: row.source } : {}),
    })
  }
  const favorites = likes.flatMap((row) => trackOf(row, row.video_id) ?? [])
  const entries: ListenEntry[] = (Array.isArray(history) ? history : []).flatMap((row) => {
    const track = trackOf(row, row.video_id)
    return track ? [{ track, count: row.play_count ?? 0, last: time(row.last_played_at), ...(row.skips ? { skips: row.skips } : {}) }] : []
  })
  const savedLists: SavedPlaylist[] = saved.flatMap((row) =>
    typeof row.browse_id === 'string' && row.browse_id
      ? [{ id: row.browse_id, title: row.title || 'Playlist', subtitle: row.subtitle || '', ...(row.image ? { image: row.image } : {}), ...(typeof row.song_count === 'number' ? { count: row.song_count } : {}) }]
      : [],
  )
  rememberUuids(uuids)
  return { snapshot: { library: { favorites, playlists, saved: savedLists }, history: entries }, uuids }
}

// ---- Lo que falta subir ----

interface Pair {
  up: Set<string>
  del: Set<string>
}
interface SongChanges extends Pair {
  full: boolean
}
interface Outbox {
  likes: Pair
  saved: Pair
  lists: Pair // datos de cada playlist (nombre, carátula, orden) y las borradas
  songs: Map<string, SongChanges> // canciones de cada playlist (por su id local)
  history: Set<string>
  renames: Map<string, string> // id en la nube → id local
}

const pair = (): Pair => ({ up: new Set(), del: new Set() })
const emptyOutbox = (): Outbox => ({ likes: pair(), saved: pair(), lists: pair(), songs: new Map(), history: new Set(), renames: new Map() })
const put = (p: Pair, id: string) => {
  p.up.add(id)
  p.del.delete(id)
}
const drop = (p: Pair, id: string) => {
  p.del.add(id)
  p.up.delete(id)
}
const songChanges = (box: Outbox, id: string) => {
  let changes = box.songs.get(id)
  if (!changes) box.songs.set(id, (changes = { ...pair(), full: false }))
  return changes
}

function pendingCount(box: Outbox): number {
  let total = box.likes.up.size + box.likes.del.size + box.saved.up.size + box.saved.del.size + box.lists.up.size + box.lists.del.size + box.history.size + box.renames.size
  for (const changes of box.songs.values()) total += changes.full ? 1 : changes.up.size + changes.del.size
  return total
}

/** Copia de `newer` con lo de `older` que no contradiga a `newer`. */
function combined(newer: Outbox, older: Outbox): Outbox {
  const box = emptyOutbox()
  mergeOutbox(box, newer)
  mergeOutbox(box, older)
  return box
}

/** Junta `from` en `into` (lo que no se pudo subir vuelve a la cola, sin pisar lo que llegó mientras tanto). */
function mergeOutbox(into: Outbox, from: Outbox) {
  const join = (target: Pair, source: Pair) => {
    source.up.forEach((id) => !target.del.has(id) && target.up.add(id))
    source.del.forEach((id) => !target.up.has(id) && target.del.add(id))
  }
  join(into.likes, from.likes)
  join(into.saved, from.saved)
  join(into.lists, from.lists)
  for (const [id, changes] of from.songs) {
    if (into.lists.del.has(id)) continue
    const target = songChanges(into, id)
    target.full ||= changes.full
    join(target, changes)
  }
  from.history.forEach((id) => into.history.add(id))
  from.renames.forEach((localId, uuid) => !into.renames.has(uuid) && into.renames.set(uuid, localId))
}

// Persistida (pequeña: solo ids) para no perder cambios si se cierra la app sin internet.
interface StoredOutbox {
  user: string
  likes: [string[], string[]]
  saved: [string[], string[]]
  lists: [string[], string[]]
  songs: [string, boolean, string[], string[]][]
  history: string[]
  renames: [string, string][]
}

function saveOutbox() {
  try {
    // Mientras se sube, también se guarda lo que va en camino: si la app se cierra a mitad, no se pierde.
    const box = inFlight ? combined(outbox, inFlight) : outbox
    if (!user || !pendingCount(box)) {
      localStorage.removeItem(OUTBOX_KEY)
      return
    }
    const p = (x: Pair): [string[], string[]] => [[...x.up], [...x.del]]
    const stored: StoredOutbox = {
      user,
      likes: p(box.likes),
      saved: p(box.saved),
      lists: p(box.lists),
      songs: [...box.songs].map(([id, c]) => [id, c.full, c.full ? [] : [...c.up], [...c.del]]),
      history: [...box.history],
      renames: [...box.renames],
    }
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(stored))
  } catch {
    /* sin espacio: la cola queda en memoria mientras la app esté abierta */
  }
}

function loadOutbox(forUser: string): Outbox {
  const box = emptyOutbox()
  try {
    const stored = JSON.parse(localStorage.getItem(OUTBOX_KEY) || 'null') as StoredOutbox | null
    if (!stored || stored.user !== forUser) return box
    const fill = (target: Pair, [up, del]: [string[], string[]]) => {
      up.forEach((id) => target.up.add(id))
      del.forEach((id) => target.del.add(id))
    }
    fill(box.likes, stored.likes)
    fill(box.saved, stored.saved)
    fill(box.lists, stored.lists)
    for (const [id, full, up, del] of stored.songs) box.songs.set(id, { full, up: new Set(up), del: new Set(del) })
    stored.history.forEach((id) => box.history.add(id))
    stored.renames.forEach(([uuid, localId]) => box.renames.set(uuid, localId))
  } catch {
    /* cola ilegible: se empieza de cero */
  }
  return box
}

// ---- Estado (para Ajustes → Mi Cuenta) ----

/** 'expired': la sesión venció (los cambios esperan en la cola hasta que vuelvas a entrar). */
export type SyncState = 'off' | 'synced' | 'syncing' | 'pending' | 'offline' | 'expired'
export interface SyncStatus {
  state: SyncState
  pending: number
  at: number // última vez que quedó todo subido (ms)
}

let status: SyncStatus = { state: 'off', pending: 0, at: 0 }
const statusListeners = new Set<() => void>()
function setStatus(state: SyncState) {
  const next = { state, pending: pendingCount(outbox), at: state === 'synced' ? Date.now() : status.at }
  if (next.state === status.state && next.pending === status.pending && next.at === status.at) return
  status = next
  statusListeners.forEach((listener) => listener())
}

export const syncStatus = {
  get: () => status,
  subscribe(listener: () => void) {
    statusListeners.add(listener)
    return () => {
      statusListeners.delete(listener)
    }
  },
}

// ---- Descubrir los cambios ----

let user: string | null = null // con la sesión lista; null = no se sincroniza
let outbox = emptyOutbox()
let inFlight: Outbox | null = null // lo que se está subiendo ahora
let lastLibrary: LibraryState = library.get()
let lastHistory: readonly ListenEntry[] = listening.entries()
let expired = false

library.subscribe(() => {
  const next = library.get()
  if (user && next !== lastLibrary) {
    diffLibrary(lastLibrary, next)
    changed()
  }
  lastLibrary = next
})

listening.watch(() => {
  const next = listening.entries()
  if (user && next !== lastHistory) {
    const before = new Map(lastHistory.map((e) => [e.track.id, e]))
    for (const entry of next) if (before.get(entry.track.id) !== entry) outbox.history.add(entry.track.id)
    // Las que salen del historial del teléfono (pasa de 400) se quedan en la nube: no se borran.
    changed()
  }
  lastHistory = next
})

function diffLibrary(prev: LibraryState, next: LibraryState) {
  if (prev.favorites !== next.favorites) {
    const before = new Set(prev.favorites.map((t) => t.id))
    const after = new Set(next.favorites.map((t) => t.id))
    after.forEach((id) => !before.has(id) && put(outbox.likes, id))
    before.forEach((id) => !after.has(id) && drop(outbox.likes, id))
  }
  if (prev.saved !== next.saved) {
    const before = new Map(prev.saved.map((p) => [p.id, p]))
    const after = new Set(next.saved.map((p) => p.id))
    next.saved.forEach((p) => before.get(p.id) !== p && put(outbox.saved, p.id))
    before.forEach((_, id) => !after.has(id) && drop(outbox.saved, id))
  }
  if (prev.playlists !== next.playlists) {
    const before = new Map(prev.playlists.map((p, index) => [p.id, { p, index }]))
    next.playlists.forEach((playlist, index) => {
      const old = before.get(playlist.id)
      if (!old) {
        put(outbox.lists, playlist.id)
        songChanges(outbox, playlist.id).full = true
        return
      }
      if (old.p === playlist && old.index === index) return
      if (old.index !== index || old.p.name !== playlist.name || old.p.image !== playlist.image || old.p.source !== playlist.source) put(outbox.lists, playlist.id)
      if (old.p.tracks !== playlist.tracks) diffTracks(songChanges(outbox, playlist.id), old.p.tracks, playlist.tracks)
    })
    const after = new Set(next.playlists.map((p) => p.id))
    before.forEach((_, id) => {
      if (after.has(id)) return
      drop(outbox.lists, id)
      outbox.songs.delete(id)
    })
  }
}

function diffTracks(changes: SongChanges, prev: readonly Track[], next: readonly Track[]) {
  const position = new Map<string, number>()
  prev.forEach((t, i) => !position.has(t.id) && position.set(t.id, i))
  const now = new Set<string>()
  next.forEach((t, i) => {
    if (now.has(t.id)) return // repetida en la lista: cuenta la primera
    now.add(t.id)
    if (position.get(t.id) !== i) put(changes, t.id)
  })
  position.forEach((_, id) => !now.has(id) && drop(changes, id))
  if (changes.up.size > FULL_AFTER) {
    changes.full = true
    changes.up.clear()
  }
}

// ---- Subir ----

let timer: number | undefined
let pushing: Promise<void> | null = null
let again = false

function changed() {
  saveOutbox()
  if (!expired) setStatus(status.state === 'offline' ? 'offline' : 'pending')
  schedule(PUSH_DELAY_MS)
}

function schedule(delay: number) {
  window.clearTimeout(timer)
  if (user && !expired) timer = window.setTimeout(() => void push(), delay)
}

/** Sube lo pendiente ya (una subida a la vez: si llegan cambios mientras tanto, va otra después). */
function push(): Promise<void> {
  if (pushing) {
    again = true
    return pushing
  }
  if (!user || expired || !pendingCount(outbox)) {
    if (user && !expired) setStatus('synced')
    return Promise.resolve()
  }
  const owner = user
  const work = outbox
  outbox = emptyOutbox()
  inFlight = work
  setStatus('syncing')
  pushing = upload(work, owner)
    .then(
      () => {
        inFlight = null
        if (user !== owner) return
        saveOutbox()
        setStatus(pendingCount(outbox) ? 'pending' : 'synced')
      },
      (error: unknown) => {
        inFlight = null
        if (user !== owner) return
        mergeOutbox(outbox, work) // lo que faltó vuelve a la cola
        saveOutbox()
        if (error instanceof CloudError && error.kind === 'auth') {
          expired = true
          setStatus('expired')
          sessionExpired()
          return
        }
        setStatus('offline')
        schedule(RETRY_MS)
      },
    )
    .finally(() => {
      pushing = null
      if (again) {
        again = false
        schedule(PUSH_DELAY_MS)
      }
    })
  return pushing
}

const uuidByLocal = new Map<string, string>()
let uuidsLoaded = false
function rememberUuids(uuids: ReadonlyMap<string, string>) {
  uuids.forEach((uuid, localId) => uuidByLocal.set(localId, uuid))
  uuidsLoaded = true
}

const inList = (ids: readonly string[]) => encodeURIComponent(`(${ids.map((id) => `"${id.replace(/["\\]/g, '')}"`).join(',')})`)
const chunks = <T,>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
const dedupe = <T,>(rows: readonly T[], key: (row: T) => string) => {
  const seen = new Set<string>()
  return rows.filter((row) => !seen.has(key(row)) && !!seen.add(key(row)))
}

/**
 * «Upsert» en bloques. Si el servidor rechaza un bloque (no por internet), se prueba fila por fila y solo se deja fuera
 * la que falla: una fila rara nunca traba la cola. `stopOn`: códigos de error que valen para todo el bloque (no se
 * prueba fila por fila: se avisa a quien llama).
 */
async function upsert<R = unknown>(table: string, conflict: string, rows: readonly object[], select?: string, stopOn: readonly string[] = []): Promise<R[]> {
  const out: R[] = []
  const send = (part: readonly object[]) =>
    rest<R[]>('POST', `${table}?on_conflict=${conflict}${select ? `&select=${select}` : ''}`, {
      body: part,
      prefer: `resolution=merge-duplicates,return=${select ? 'representation' : 'minimal'}`,
    })
  for (const part of chunks(rows, CHUNK)) {
    try {
      out.push(...((await send(part)) ?? []))
    } catch (error) {
      if (error instanceof CloudError && stopOn.includes(error.code)) throw error
      if (!(error instanceof CloudError) || error.retryable || part.length === 1) {
        if (error instanceof CloudError && !error.retryable) {
          console.warn(`[nube] ${table}: fila rechazada`, error.message)
          continue
        }
        throw error
      }
      for (const row of part) {
        try {
          out.push(...((await send([row])) ?? []))
        } catch (single) {
          if (!(single instanceof CloudError) || single.retryable) throw single
          console.warn(`[nube] ${table}: fila rechazada`, single.message)
        }
      }
    }
  }
  return out
}

/** Borrar (los que el servidor rechaza por otra cosa que internet se dan por hechos). */
async function remove(path: string) {
  try {
    await rest('DELETE', path, { prefer: 'return=minimal' })
  } catch (error) {
    if (!(error instanceof CloudError) || error.retryable) throw error
    console.warn('[nube] no se pudo borrar', path, error.message)
  }
}

async function upsertPlaylists(ids: readonly string[], owner: string, state: LibraryState) {
  const rows = ids.flatMap((id) => {
    const index = state.playlists.findIndex((p) => p.id === id)
    if (index < 0) return []
    const p = state.playlists[index]
    return [{ user_id: owner, local_id: p.id, name: p.name, image: p.image ?? null, source: p.source ?? null, position: index }]
  })
  // Las que no vienen de YouTube primero: si una deja libre un «source», la siguiente ya lo puede usar.
  rows.sort((a, b) => Number(a.source !== null) - Number(b.source !== null))
  const saved = await upsert<{ id: string; local_id: string }>('playlists', 'user_id,local_id', rows, 'id,local_id')
  saved.forEach((row) => uuidByLocal.set(row.local_id, row.id))
  // Rechazadas: casi siempre porque otra playlist de tu cuenta (de otro teléfono) ya viene de esa misma playlist de
  // YouTube («source» único). Se suben sin ese vínculo: las canciones quedan igual a salvo.
  const done = new Set(saved.map((row) => row.local_id))
  const retry = rows.filter((row) => !done.has(row.local_id) && row.source !== null).map((row) => ({ ...row, source: null }))
  if (retry.length) {
    const again = await upsert<{ id: string; local_id: string }>('playlists', 'user_id,local_id', retry, 'id,local_id')
    again.forEach((row) => uuidByLocal.set(row.local_id, row.id))
  }
}

async function uuidOf(localId: string): Promise<string | undefined> {
  if (!uuidByLocal.has(localId) && !uuidsLoaded) {
    const rows = await selectAll<{ id: string; local_id: string }>('playlists', 'select=id,local_id&order=created_at.asc,id.asc')
    rememberUuids(new Map(rows.map((r) => [r.local_id, r.id])))
  }
  return uuidByLocal.get(localId)
}

/** Sube `work` en orden; lo que ya subió se va quitando de `work` (si algo falla, solo vuelve lo que faltó). */
async function upload(work: Outbox, owner: string) {
  const state = library.get()
  const now = Date.now()

  for (const [uuid, localId] of [...work.renames]) {
    try {
      await rest('PATCH', `playlists?id=eq.${encodeURIComponent(uuid)}`, { body: { local_id: localId }, prefer: 'return=minimal' })
      uuidByLocal.set(localId, uuid)
    } catch (error) {
      if (!(error instanceof CloudError) || error.retryable) throw error
    }
    work.renames.delete(uuid)
  }

  // Playlists borradas (sus canciones se van con ellas).
  for (const ids of chunks([...work.lists.del], ID_CHUNK)) {
    await remove(`playlists?user_id=eq.${owner}&local_id=in.${inList(ids)}`)
    ids.forEach((id) => {
      work.lists.del.delete(id)
      uuidByLocal.delete(id)
    })
  }

  // Datos de las playlists (nombre, carátula, orden); las nuevas, antes que sus canciones.
  const lists = [...work.lists.up]
  if (lists.length) {
    await upsertPlaylists(lists, owner, state)
    lists.forEach((id) => work.lists.up.delete(id))
  }

  for (const [localId, changes] of [...work.songs]) {
    const playlist = state.playlists.find((p) => p.id === localId)
    if (!playlist) {
      work.songs.delete(localId)
      continue
    }
    let uuid = await uuidOf(localId)
    if (!uuid) {
      await upsertPlaylists([localId], owner, state)
      uuid = uuidByLocal.get(localId)
      changes.full = true
    }
    if (!uuid) {
      work.songs.delete(localId)
      continue
    }
    for (const ids of chunks([...changes.del], ID_CHUNK)) {
      await remove(`playlist_songs?playlist_id=eq.${uuid}&video_id=in.${inList(ids)}`)
      ids.forEach((id) => changes.del.delete(id))
    }
    const rowsFor = (listId: string, all: boolean) =>
      dedupe(
        playlist.tracks.map((t, position) => ({ t, position })),
        ({ t }) => t.id,
      )
        .filter(({ t }) => all || changes.full || changes.up.has(t.id))
        .map(({ t, position }) => ({ user_id: owner, playlist_id: listId, video_id: t.id, position, ...columns(t) }))
    try {
      await upsert('playlist_songs', 'playlist_id,video_id', rowsFor(uuid, false), undefined, STALE_PLAYLIST)
    } catch (error) {
      if (!(error instanceof CloudError) || !STALE_PLAYLIST.includes(error.code)) throw error
      uuidByLocal.delete(localId)
      await upsertPlaylists([localId], owner, state)
      const fresh = uuidByLocal.get(localId)
      if (fresh) await upsert('playlist_songs', 'playlist_id,video_id', rowsFor(fresh, true))
    }
    work.songs.delete(localId)
  }

  // Me gusta: el orden de la lista (la más reciente arriba) va en la hora.
  for (const ids of chunks([...work.likes.del], ID_CHUNK)) {
    await remove(`likes?user_id=eq.${owner}&video_id=in.${inList(ids)}`)
    ids.forEach((id) => work.likes.del.delete(id))
  }
  if (work.likes.up.size) {
    const rows = dedupe(
      state.favorites.map((t, index) => ({ t, index })),
      ({ t }) => t.id,
    )
      .filter(({ t }) => work.likes.up.has(t.id))
      .map(({ t, index }) => ({ user_id: owner, video_id: t.id, ...columns(t), liked_at: new Date(now - index * 1000).toISOString() }))
    await upsert('likes', 'user_id,video_id', rows)
    work.likes.up.clear()
  }

  for (const ids of chunks([...work.saved.del], ID_CHUNK)) {
    await remove(`saved_playlists?user_id=eq.${owner}&browse_id=in.${inList(ids)}`)
    ids.forEach((id) => work.saved.del.delete(id))
  }
  if (work.saved.up.size) {
    const rows = dedupe(
      state.saved.map((p, index) => ({ p, index })),
      ({ p }) => p.id,
    )
      .filter(({ p }) => work.saved.up.has(p.id))
      .map(({ p, index }) => ({
        user_id: owner,
        browse_id: p.id,
        title: p.title,
        subtitle: p.subtitle || '',
        image: p.image ?? null,
        song_count: typeof p.count === 'number' ? p.count : null,
        saved_at: new Date(now - index * 1000).toISOString(),
      }))
    await upsert('saved_playlists', 'user_id,browse_id', rows)
    work.saved.up.clear()
  }

  if (work.history.size) {
    const rows = listening
      .entries()
      .filter((e) => work.history.has(e.track.id))
      .map((e) => ({
        user_id: owner,
        video_id: e.track.id,
        ...columns(e.track),
        play_count: Math.max(0, Math.round(e.count)),
        skips: Math.max(0, Math.round(e.skips ?? 0)),
        last_played_at: new Date(e.last || now).toISOString(),
      }))
    await upsert('history', 'user_id,video_id', dedupe(rows, (r) => r.video_id))
    work.history.clear()
  }
}

// ---- Encender / apagar ----

let onExpired: () => void = () => {}
const sessionExpired = () => onExpired()

/** Lo que hace Mi Cuenta si la sesión vence mientras se sube algo. */
export function setExpiredHandler(handler: () => void) {
  onExpired = handler
}

/**
 * Empieza a sincronizar (sesión lista y tu música ya juntada con la nube): sube lo que quedó pendiente y, si se pasa
 * `queue`, TODO lo de esa copia (tras la fusión o la primera vez; sus `renames` van primero).
 */
export function startSync(owner: string, queue?: { snapshot: Snapshot; renames?: readonly Rename[] }) {
  if (user === owner && !expired) {
    if (queue) queueEverything(queue.snapshot, queue.renames)
    return
  }
  user = owner
  expired = false
  outbox = loadOutbox(owner)
  lastLibrary = library.get()
  lastHistory = listening.entries()
  if (queue) queueInto(queue.snapshot, queue.renames ?? [])
  saveOutbox()
  setStatus(pendingCount(outbox) ? 'pending' : 'synced')
  schedule(queue ? PUSH_DELAY_MS : 500)
}

/** Deja de sincronizar (cerrar sesión). La cola se descarta: al volver a entrar, la fusión lo sube todo. */
export function stopSync() {
  window.clearTimeout(timer)
  user = null
  expired = false
  outbox = emptyOutbox()
  inFlight = null
  uuidByLocal.clear()
  uuidsLoaded = false
  try {
    localStorage.removeItem(OUTBOX_KEY)
  } catch {
    /* nada que borrar */
  }
  setStatus('off')
}

/** La sesión venció (lo dijo el teléfono): se deja de subir hasta volver a entrar; la cola se conserva. */
export function pauseExpired() {
  if (!user) return
  expired = true
  window.clearTimeout(timer)
  setStatus('expired')
}

/** Anota para subir TODO lo de `snapshot` (tras la fusión o la primera vez). `renames` van primero. */
export function queueEverything(snapshot: Snapshot, renames: readonly Rename[] = []) {
  queueInto(snapshot, renames)
  changed()
}

function queueInto(snapshot: Snapshot, renames: readonly Rename[]) {
  for (const { uuid, localId } of renames) outbox.renames.set(uuid, localId)
  snapshot.library.favorites.forEach((t) => put(outbox.likes, t.id))
  snapshot.library.saved.forEach((p) => put(outbox.saved, p.id))
  snapshot.library.playlists.forEach((p) => {
    put(outbox.lists, p.id)
    songChanges(outbox, p.id).full = true
  })
  snapshot.history.forEach((e) => outbox.history.add(e.track.id))
}

/** Sube ya lo pendiente y espera (como mucho `timeoutMs`). True si quedó todo arriba. */
export async function pushNow(timeoutMs = 15_000): Promise<boolean> {
  if (!user || expired) return false
  window.clearTimeout(timer)
  const done = (async () => {
    for (let i = 0; i < 3 && pendingCount(outbox); i++) await push()
    if (pushing) await pushing
    return !pendingCount(outbox)
  })()
  return Promise.race([done, new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), timeoutMs))])
}

// Al volver internet o la app, se reintenta enseguida.
window.addEventListener('online', () => user && !expired && pendingCount(outbox) && schedule(1000))
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && user && !expired && pendingCount(outbox)) schedule(1500)
})

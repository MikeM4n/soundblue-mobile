// Fusión de dos copias de tu música (la del teléfono con la de la nube, o con una copia de seguridad). REGLA: lo de la
// primera («primary», el teléfono) queda TODO y en su orden; de la otra se suma solo lo que falta, sin repetir:
// - me gusta y playlists guardadas: por id (el videoId de YouTube / el id de la playlist);
// - playlists tuyas: la misma si tiene el mismo id o viene de la misma playlist de YouTube («source»); sus canciones se
//   juntan por videoId (las que faltan, al final);
// - historial: por videoId (veces escuchada y saltada: la mayor; última vez: la más reciente). Todo el del teléfono se
//   queda; de la otra entran las más recientes hasta llenar el historial (400).
import { HISTORY_MAX, parseHistory, type ListenEntry } from '../data/history'
import { parseLibrary, type LibraryState, type Playlist } from '../library/store'
import type { Track } from '../player/types'

export interface Snapshot {
  library: LibraryState
  history: ListenEntry[]
}

/** Cuánto hay en cada copia (para el aviso de «Fusionar» o «Mantener solo la nube»). */
export interface Counts {
  favorites: number
  playlists: number
  saved: number
  history: number
}

export const countsOf = ({ library, history }: Snapshot): Counts => ({
  favorites: library.favorites.length,
  playlists: library.playlists.length,
  saved: library.saved.length,
  history: history.length,
})

export const isEmpty = (snapshot: Snapshot) => Object.values(countsOf(snapshot)).every((n) => n === 0)

export const readLibrary = (text: string | null | undefined) => parseLibrary(text)
export const readHistory = (text: string | null | undefined) => parseHistory(text)

/** Una playlist de la nube que pasa a llamarse con el id que tiene en el teléfono (misma playlist de YouTube). */
export interface Rename {
  uuid: string
  localId: string
}

/**
 * Junta `secondary` en `primary` sin quitar nada de `primary`. `uuids`: id en la nube de cada playlist de `secondary`
 * (por su id local), para saber cuáles hay que renombrar allá.
 */
export function mergeData(primary: Snapshot, secondary: Snapshot, uuids?: ReadonlyMap<string, string>): { data: Snapshot; renames: Rename[] } {
  const renames: Rename[] = []
  const library: LibraryState = {
    favorites: unionTracks(primary.library.favorites, secondary.library.favorites),
    playlists: mergePlaylists(primary.library.playlists, secondary.library.playlists, uuids, renames),
    saved: unionBy(primary.library.saved, secondary.library.saved, (p) => p.id),
  }
  return { data: { library, history: mergeHistory(primary.history, secondary.history) }, renames }
}

const unionBy = <T,>(first: readonly T[], second: readonly T[], key: (item: T) => string): T[] => {
  const have = new Set(first.map(key))
  const extra = second.filter((item) => !have.has(key(item)) && !!have.add(key(item)))
  return extra.length ? [...first, ...extra] : [...first]
}

const unionTracks = (first: readonly Track[], second: readonly Track[]) => unionBy(first, second, (t) => t.id)

function mergePlaylists(primary: readonly Playlist[], secondary: readonly Playlist[], uuids: ReadonlyMap<string, string> | undefined, renames: Rename[]): Playlist[] {
  const byId = new Map(secondary.map((p, i) => [p.id, i]))
  const bySource = new Map(secondary.flatMap((p, i) => (p.source ? [[p.source, i] as const] : [])))
  const sources = new Set(primary.flatMap((p) => (p.source ? [p.source] : [])))
  const used = new Set<number>()
  const merged = primary.map((playlist) => {
    let index = byId.get(playlist.id)
    if (index === undefined || used.has(index)) index = playlist.source ? bySource.get(playlist.source) : undefined
    if (index === undefined || used.has(index)) return playlist
    used.add(index)
    const other = secondary[index]
    const uuid = uuids?.get(other.id)
    if (uuid && other.id !== playlist.id) renames.push({ uuid, localId: playlist.id })
    const tracks = unionTracks(playlist.tracks, other.tracks)
    // El origen de YouTube de la otra, si esta no tiene y ninguna otra playlist del teléfono lo usa.
    const source = playlist.source ?? (other.source && !sources.has(other.source) ? other.source : undefined)
    if (source) sources.add(source)
    const image = playlist.image ?? other.image
    return tracks.length === playlist.tracks.length && source === playlist.source && image === playlist.image ? playlist : { ...playlist, tracks, image, source }
  })
  const ids = new Set(merged.map((p) => p.id))
  for (const [index, other] of secondary.entries()) {
    if (used.has(index)) continue
    if (ids.has(other.id)) {
      // Mismo id que una del teléfono ya juntada con otra: sus canciones se suman a esa (no se pierde ninguna).
      const at = merged.findIndex((p) => p.id === other.id)
      merged[at] = { ...merged[at], tracks: unionTracks(merged[at].tracks, other.tracks) }
      continue
    }
    ids.add(other.id)
    // Dos playlists no pueden venir de la misma de YouTube: la que llega queda sin ese vínculo.
    const source = other.source && !sources.has(other.source) ? other.source : undefined
    if (source) sources.add(source)
    merged.push(source === other.source ? other : { ...other, source })
  }
  return merged
}

function mergeHistory(primary: readonly ListenEntry[], secondary: readonly ListenEntry[]): ListenEntry[] {
  const others = new Map(secondary.map((e) => [e.track.id, e]))
  const kept = primary.map((entry) => {
    const other = others.get(entry.track.id)
    if (!other) return entry
    others.delete(entry.track.id)
    const skips = Math.max(entry.skips ?? 0, other.skips ?? 0)
    return { track: entry.track, count: Math.max(entry.count, other.count), last: Math.max(entry.last, other.last), ...(skips ? { skips } : {}) }
  })
  const room = Math.max(0, HISTORY_MAX - kept.length)
  const extra = [...others.values()].sort((a, b) => b.last - a.last).slice(0, room)
  return [...kept, ...extra].sort((a, b) => b.last - a.last)
}

// Historial de escucha (en este navegador): qué canciones sonaron, cuántas veces y cuándo. Alimenta «Para ti».
// Una canción cuenta como escuchada a los 30 s (o al terminar, si es más corta), como en Spotify; si pasas a la
// siguiente antes, cuenta como saltada (los artistas que sueles saltar no se recomiendan).
// Se guarda en localStorage, como el resto de la biblioteca: son pocos datos (máx. 400 canciones).
import { isTrack, type Track } from '../player/types'

const KEY = 'soundblue:historial'
const MAX = 400
const SKIPS_TO_HIDE = 2 // saltado 2 veces o más, y más veces saltado que escuchado: no se recomienda

export interface ListenEntry {
  track: Track
  count: number // veces escuchada (30 s o más)
  last: number // última vez que empezó a sonar (ms)
  skips?: number // veces que pasaste a la siguiente antes de los 30 s
}

/** «Bad Bunny y Jhayco» → «badbunny» (el primer artista, sin tildes ni espacios): para comparar artistas. */
export const artistKey = (artist: string) =>
  artist
    .split(/,| y | & | x | feat\.? | ft\.? /i)[0]
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '')

let entries: ListenEntry[] = read()
const listeners = new Set<() => void>()

function read(): ListenEntry[] {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(saved) ? saved.filter((e) => isTrack(e?.track) && typeof e.count === 'number' && typeof e.last === 'number') : []
  } catch {
    return []
  }
}

function commit(next: ListenEntry[], notify: boolean) {
  entries = next.sort((a, b) => b.last - a.last).slice(0, MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(entries))
  } catch {
    /* sin almacenamiento: el historial dura mientras la app esté abierta */
  }
  if (notify) listeners.forEach((listener) => listener())
}

/** Solo lo que sirve para recomendar (sin datos del reproductor). */
const plain = (t: Track): Track => ({ id: t.id, title: t.title, artist: t.artist, artistId: t.artistId, album: t.album, duration: t.duration, ytMusic: t.ytMusic, artwork: t.artwork })

export const listening = {
  /** Empezó a sonar: se anota la hora (para no repetirla en «Para ti» durante 24 h). */
  started(track: Track) {
    const found = entries.find((e) => e.track.id === track.id)
    commit([{ ...found, track: plain(track), count: found?.count ?? 0, last: Date.now() }, ...entries.filter((e) => e !== found)], false)
  },
  /** Se escuchó de verdad (30 s o hasta el final): suma una reproducción y avisa para recalcular «Para ti». */
  counted(track: Track) {
    const found = entries.find((e) => e.track.id === track.id)
    commit([{ ...found, track: plain(track), count: (found?.count ?? 0) + 1, last: found?.last ?? Date.now() }, ...entries.filter((e) => e !== found)], true)
  },
  /** Pasaste a la siguiente antes de los 30 s. */
  skipped(track: Track) {
    const found = entries.find((e) => e.track.id === track.id)
    commit([{ track: plain(track), count: found?.count ?? 0, last: found?.last ?? Date.now(), skips: (found?.skips ?? 0) + 1 }, ...entries.filter((e) => e !== found)], false)
  },
  /** Artistas (artistKey) que sueles saltar: no se recomiendan. */
  skippedArtists(): Set<string> {
    const totals = new Map<string, { skips: number; count: number }>()
    for (const e of entries) {
      const key = artistKey(e.track.artist)
      const total = totals.get(key) ?? { skips: 0, count: 0 }
      totals.set(key, { skips: total.skips + (e.skips ?? 0), count: total.count + e.count })
    }
    return new Set([...totals].filter(([, t]) => t.skips >= SKIPS_TO_HIDE && t.skips > t.count).map(([key]) => key))
  },
  entries: () => entries,
  /** «Tu Top 50»: las más escuchadas (30 s o más), de más a menos; a igual cantidad, la más reciente primero. */
  top(limit = 50): ListenEntry[] {
    return entries
      .filter((e) => e.count > 0)
      .sort((a, b) => b.count - a.count || b.last - a.last)
      .slice(0, limit)
  },
  /**
   * Quitarla de «Tu Top 50» (deslizar a la derecha): se olvidan sus reproducciones (si la vuelves a escuchar mucho,
   * vuelve). Devuelve cómo deshacerlo.
   */
  forgetPlays(id: string): () => void {
    const found = entries.find((e) => e.track.id === id)
    if (!found || !found.count) return () => {}
    const count = found.count
    commit(entries.map((e) => (e === found ? { ...e, count: 0 } : e)), true)
    return () => commit(entries.map((e) => (e.track.id === id ? { ...e, count: e.count + count } : e)), true)
  },
  /** Ids de lo que empezó a sonar en las últimas `ms` (por defecto, 24 h). */
  playedWithin(ms = 24 * 3600 * 1000): Set<string> {
    const since = Date.now() - ms
    return new Set(entries.filter((e) => e.last >= since).map((e) => e.track.id))
  },
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

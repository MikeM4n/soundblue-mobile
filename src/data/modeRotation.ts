// Rotación de ritmos de los Modos (2.1.5): en vez de mezclar al azar, la cola va por bloques de cada género, en el orden
// de los géneros del modo. Con «Canciones por ritmo» en 2: Salsa 1, Salsa 2, Reggaetón 1, Reggaetón 2, Merengue 1,
// Merengue 2, Salsa 3… Si un género se acaba, siguen los demás. El reproductor recibe la cola ya en este orden
// (engine.playContext con `ordered`) y, si llegan más canciones mientras suena, sigue la rotación donde iba
// (engine.replanContext + continueRotation).
import { hashText, seededRandom } from '../lib/random'
import type { Track } from '../player/types'
import type { ModeTrack } from './genres'
import { capPerArtist } from './lists'

export interface RotationOptions {
  seed?: number // «Aleatorio»: dentro de cada género, al azar (el mismo orden para la misma semilla, aunque lleguen más)
  start?: { genre: string; used: number } // seguir una rotación empezada: el género que va y cuántas de él ya sonaron
}

/** Las canciones en rotación: `perGenre` de cada género, por turnos, en el orden de `genres` (los demás, al final). */
export function rotateByGenre(items: readonly ModeTrack[], perGenre: number, genres: readonly string[], { seed, start }: RotationOptions = {}): Track[] {
  const groups = new Map<string, Track[]>(genres.map((genre) => [genre, []]))
  for (const { track, genre } of items) {
    const group = groups.get(genre)
    if (group) group.push(track)
    else groups.set(genre, [track])
  }
  const keys = [...groups.keys()]
  const queues = keys.map((key) => {
    const list = groups.get(key)!
    if (seed === undefined) return list
    // Un número al azar fijo por canción (para esta semilla): lo que llega después no cambia el orden de las demás.
    const ranks = new Map(list.map((track) => [track.id, seededRandom(seed ^ hashText(track.id))()]))
    return [...list].sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!)
  })
  const n = Math.max(1, Math.round(perGenre))
  const taken = queues.map(() => 0)
  const out: Track[] = []
  let at = start && keys.includes(start.genre) ? keys.indexOf(start.genre) : 0
  let quota = start && keys.includes(start.genre) ? Math.max(0, n - start.used) : n
  while (out.length < items.length && queues.length) {
    const queue = queues[at]
    for (; quota > 0 && taken[at] < queue.length; quota--) out.push(queue[taken[at]++])
    at = (at + 1) % queues.length
    quota = n
  }
  return out
}

/**
 * Lo que sigue de una rotación que ya suena: las que faltan (`items` sin las de `played`), empezando donde iba. `played`
 * son las de la lista que ya sonaron, con la actual al final: si van 1 de 2 de salsa, sigue 1 más de salsa y después el
 * siguiente género.
 */
export function continueRotation(played: readonly Track[], items: readonly ModeTrack[], perGenre: number, genres: readonly string[], seed?: number): Track[] {
  const genreOf = new Map(items.map(({ track, genre }) => [track.id, genre]))
  const done = new Set(played.map((track) => track.id))
  const last = played.length ? genreOf.get(played[played.length - 1].id) : undefined
  let used = 0
  for (let i = played.length - 1; last && i >= 0 && genreOf.get(played[i].id) === last; i--) used++
  const rest = items.filter(({ track }) => !done.has(track.id))
  return rotateByGenre(rest, perGenre, genres, { seed, start: last ? { genre: last, used } : undefined })
}

/** Las de `first` (en su lugar) y detrás las nuevas de `more`: sin repetidas, como mucho 2 por artista, hasta `limit`. */
export function mergeModeTracks(first: readonly ModeTrack[], more: readonly ModeTrack[], limit: number): ModeTrack[] {
  const byId = new Map<string, ModeTrack>()
  for (const item of [...first, ...more]) if (!byId.has(item.track.id)) byId.set(item.track.id, item)
  return capPerArtist([...byId.values()].map((item) => item.track))
    .slice(0, limit)
    .map((track) => byId.get(track.id)!)
}

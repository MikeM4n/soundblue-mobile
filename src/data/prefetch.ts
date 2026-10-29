// Precarga de la bienvenida (pages/Onboarding.tsx): mientras eliges artistas y géneros, lo que Inicio va a pedir se trae
// en segundo plano, así Inicio abre ya lleno. Con cuidado de no saturar el teléfono:
// - Espera 1,5 s sin que elijas ni quites nada (cada toque reinicia la espera).
// - Solo los 5 primeros artistas y los 5 primeros géneros que elijas (5 de cada uno como mucho).
// - De a uno a la vez, en orden; si uno falla no se reintenta (Inicio lo pide igual).
// - Al tocar «Empezar a escuchar» se descarta lo que no empezó: Inicio pide lo suyo y no compiten.
// Qué se guarda: de cada artista, sus canciones más conocidas (data/artistTop.ts: localStorage 24 h, «Tus artistas»);
// del primero, además, la radio con la que arranca «Para ti». De cada género, las playlists de sus «Selecciones rápidas»
// (data/genres.ts). Al final, una vez, las tendencias. Esto último queda en la caché de YouTube Music (data/ytmusic.ts),
// que es la que lee Inicio.
import { artistTopSongs } from './artistTop'
import type { GenreKey } from './genreIndex'
import { INDEX_GENRES, prefetchSource } from './genres'
import { ytmHome, ytmRadioItems, type YtmCard } from './ytmusic'

const WAIT_MS = 1500
const LIMIT = 5

const artistsDone = new Set<string>()
const genresDone = new Set<GenreKey>()
let homeDone = false
const pending: (() => Promise<unknown>)[] = []
let running = false
let timer: number | undefined

/** Cada vez que eliges o quitas un artista o un género: dentro de 1,5 s sin más cambios, se precarga lo nuevo. */
export function schedulePrefetch(artists: readonly YtmCard[], genres: readonly GenreKey[]) {
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    timer = undefined
    artists.slice(0, LIMIT).forEach((artist, i) => {
      if (artistsDone.has(artist.id) || artistsDone.size >= LIMIT) return
      artistsDone.add(artist.id)
      pending.push(() => prefetchArtist(artist, i === 0))
    })
    genres.slice(0, LIMIT).forEach((genre) => {
      if (genresDone.has(genre) || genresDone.size >= LIMIT) return
      genresDone.add(genre)
      pending.push(() => prefetchSource(INDEX_GENRES[genre]))
    })
    if (!homeDone) {
      homeDone = true
      pending.push(ytmHome)
    }
    void drain()
  }, WAIT_MS)
}

/** «Empezar a escuchar»: lo que no empezó se descarta (lo que está en camino termina y queda guardado). */
export function cancelPrefetch() {
  window.clearTimeout(timer)
  timer = undefined
  pending.length = 0
}

async function prefetchArtist(artist: YtmCard, first: boolean) {
  const top = await artistTopSongs(artist)
  if (first && top.tracks[0]) await ytmRadioItems(top.tracks[0].id)
}

async function drain() {
  if (running) return
  running = true
  for (let job = pending.shift(); job; job = pending.shift()) await job().catch(() => {})
  running = false
}

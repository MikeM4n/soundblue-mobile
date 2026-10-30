// Radio dinámica (Buscar, «Iniciar radio», «Tus artistas» en Inicio, recomendadas y la cola infinita de cualquier
// lista, siempre a partir de la canción que suena): la cola se mantiene con 10 o más por sonar, con canciones del mismo
// artista y de otros artistas del MISMO GÉNERO O UNO PARECIDO, de cualquier año (reggaetón viejo y nuevo, dancehall…).
// NUNCA a partir del título: eso llenaba la cola de covers y de canciones que solo comparten palabras con el nombre.
//
// En «Próximas en sonar» llenan dos pestañas: «Recomendadas» y «Por Descubrir» (solo canciones que nunca sonaron aquí);
// la Fila Dinámica pasa de ahí a la cola las que hagan falta. En «Para ti», 10 recomendadas y luego de a 5 nuevas y
// recomendadas, alternando.
//
// De dónde salen (sin cuota: YouTube Music vía el intermediario):
//  - Mismo artista: las suyas que trae la radio y sus más conocidas (data/artistTop.ts).
//  - Mismo género: la radio de YouTube Music de esa canción («A continuación», a partir de su videoId). Cuando se acaba,
//    la radio de la última que sonó de otro artista.
//
// Género: YouTube no lo publica. Lo sabe el índice de géneros (data/genreIndex.ts: qué artistas aparecen en las
// playlists de cada género) y la matriz de géneros parecidos: si suena reggaetón, entran reggaetón, dancehall y trap
// latino; si suena salsa, salsa, merengue y bachata. Popular, ranchera y vallenato son una familia cerrada: entre ellos
// sí, pero nunca salsa, merengue, bachata ni urbano (ni un artista que también sea de esos géneros, ni uno que el índice
// no conoce). Fuera de esa familia, una canción de un artista que el índice no conoce entra (la radio de YouTube ya la
// trajo por parecida), salvo si está en escritura asiática (cuenta como K-Pop, J-Pop o Mandopop). Si el índice no
// conoce la canción que suena, su género es el de la mayoría de su radio; si tampoco así se sabe, no se filtra.
// En un Modo de ambiente el género no se adivina: es el del Modo (Tomar: popular, ranchera y vallenato), y los artistas
// de su lista cuentan como de ese género aunque el índice no los conozca.
//
// Filtros: solo audio o video oficial (fuera los subidos por usuarios: covers); fuera los «Canción – Otro Artista» de
// un intérprete distinto (covers); nada que comparta más del 40 % de las palabras del título de la semilla (covers,
// remix, en vivo); una sola versión de cada título (la más vieja, que suele ser la original); de otro género (ver
// arriba); fuera los artistas que sueles saltar (data/history.ts). Mezcla: en cada tanda, como mucho 1 de cada 5 del
// mismo artista (el 80 % de otros artistas) y como mucho 2 de cualquier otro artista. Orden al azar con una semilla
// por sesión. Nunca la misma canción dos veces, ni una que ya esté en la cola (`exclude`).
import { logDuplicate } from '../lib/duplicateLog'
import { hashText, seededRandom, sessionSeed, shuffle } from '../lib/random'
import type { Track } from '../player/types'
import { artistTopSongs } from './artistTop'
import { clashes, dominantGenres, genreIndex, genreIndexSoon, genreLabel, genreScope, genresOf, type GenreIndex, type GenreKey, type GenreScope } from './genreIndex'
import { artistKey, listening } from './history'
import { ytmRadioItems, ytmSearchArtists, type RadioItem } from './ytmusic'
import { favoriteGenres } from './favoriteGenres'

const SAME_ARTIST_SHARE = 0.2 // del mismo artista: 1 de cada 5 (el resto, otros artistas del mismo género)
const PER_ARTIST = 2 // de cualquier otro artista, como mucho 2 por tanda
const FIRST_BLOCK = 10 // «Recomendadas basadas en esta canción»
const BLOCK = 5 // después, bloques de 5: «Nuevas para ti» y recomendadas, alternando
const INDEX_WAIT_MS = 2500 // la primera vez el índice de géneros tarda en armarse: la radio no lo espera más que esto
const TITLE_OVERLAP = 0.4
const MAX_REFILLS = 6 // radios de respaldo como mucho
const OFFICIAL = new Set(['MUSIC_VIDEO_TYPE_ATV', 'MUSIC_VIDEO_TYPE_OMV', 'MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC'])
const LOG_KEY = 'soundblue:radio-diagnostico'
const STOPWORDS = new Set(
  'el la los las lo un una unos unas de del al a y e o u en con por para que mi mis tu tus te me se yo su sus le the of and to in on my you your i is it feat ft'.split(
    ' ',
  ),
)

type Reason = 'mismo artista' | 'mismo género'

interface Candidate {
  track: Track
  year?: number
  reason: Reason
}

/** Bloque de «Próximas en sonar» al que va una canción de la radio (con su encabezado). */
export interface QueueGroup {
  kind: 'recomendadas' | 'nuevas'
  seed: string // «Gasolina · Daddy Yankee»
}

export interface RadioPick {
  track: Track
  group: QueueGroup
}

/**
 * Las siguientes `count` canciones de la radio, sin ninguna de `exclude` (lo que ya está en la lista o en la cola). Con
 * `kind`, solo de ese bloque: 'recomendadas' (cualquiera de la radio) o 'nuevas' (solo las que nunca sonaron aquí, para
 * «Por Descubrir»); sin él, alternando como en «Para ti».
 */
export type RadioSource = (count: number, exclude?: ReadonlySet<string>, kind?: QueueGroup['kind']) => Promise<RadioPick[]>

export interface RadioOptions {
  artistTop?: boolean // sumar las más conocidas del artista (una consulta más; «Selecciones rápidas» no las usa)
  diagnostics?: boolean // anotarla como «última radio» en Ayuda
  genres?: readonly GenreKey[] // los de un Modo: la radio es de estos géneros (no se adivinan de la canción)
  trusted?: readonly Track[] // la lista del Modo: sus artistas cuentan como de esos géneros aunque el índice no los conozca
}

export interface RadioDiagnostics {
  at: number
  seed: string // «Gasolina · Daddy Yankee»
  seedYear?: number
  genres: string[] // géneros detectados de la semilla («Reggaetón»); vacío: no se conoce
  guessed?: boolean // la semilla no estaba en el índice: su género salió de la mayoría de su radio
  accepts: string[] // los que acepta la radio («Reggaetón», «Dancehall», «Trap latino»)
  filtered: Record<string, number> // descartadas, por motivo
  picks: { title: string; artist: string; year?: number; reason: Reason }[] // las últimas 10 que generó
}

const normalize = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
const words = (title: string) =>
  normalize(title)
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .split(/[^a-z0-9ñ]+/)
    .filter(Boolean)
/** «Ven Bailalo - Reggaeton Mix (con X)» → «ven bailalo»: para reconocer versiones del mismo título. */
const baseTitle = (title: string) => words(title.replace(/\s+[-–—]\s+.*$/, '')).join(' ')
/** Lo que va después de « – » en el título («La Gran Noche – Los Tucanes De Tijuana» → «Los Tucanes De Tijuana»). */
const titleSuffix = (title: string) => title.match(/\s[-–—]\s(.+)$/)?.[1]
/** «Bad Bunny y Jhayco» → «Bad Bunny» (el primer artista). */
const firstArtist = (artist: string) => artist.split(/,| y | & | x | feat\.? | ft\.? /i)[0].trim()

export function readRadioDiagnostics(): RadioDiagnostics | null {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY) ?? 'null')
  } catch {
    return null
  }
}

function writeRadioDiagnostics(diagnostics: RadioDiagnostics) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(diagnostics))
  } catch {
    /* sin almacenamiento: sin diagnóstico */
  }
}

/**
 * Crea la radio de `seed`. Devuelve una función que da las siguientes `count` canciones sin ninguna de `exclude` (lo
 * que ya está en la cola), cada una con su bloque; el motor la llama cuando quedan menos de 10 por sonar. Si ya no hay
 * más que cumplan las reglas, da menos (o ninguna) y la radio termina.
 */
export function createRadio(seed: Track, { artistTop = true, diagnostics: logDiagnostics = true, genres: fixedGenres, trusted = [] }: RadioOptions = {}): RadioSource {
  const served = new Set([seed.id])
  const skipped = listening.skippedArtists()
  const heard = new Set(listening.entries().map((entry) => entry.track.id)) // lo que ya sonó aquí alguna vez
  const seedLabel = `${seed.title} · ${seed.artist}`
  let given = 0 // cuántas dio ya: dice a qué bloque va la siguiente
  const titles = new Set([baseTitle(seed.title)])
  const seedWords = (() => {
    const all = words(seed.title)
    const meaningful = all.filter((word) => !STOPWORDS.has(word))
    return meaningful.length ? meaningful : all
  })()
  const seedArtist = artistKey(seed.artist)
  const random = seededRandom(sessionSeed() ^ hashText(seed.id))
  const same: Candidate[] = []
  const others: Candidate[] = []
  const filtered: Record<string, number> = {
    'no oficial (cover o subida por usuario)': 0,
    'cover (título con el nombre de otro artista)': 0,
    'título parecido a la semilla': 0,
    'otra versión del mismo título': 0,
    'de otro género': 0,
    'artista que el índice no conoce (popular, ranchera o vallenato)': 0,
    'artista que sueles saltar': 0,
  }
  const knownArtists = new Set([seedArtist]) // los artistas que aparecen en las radios (para reconocer covers)
  // Género: lo que acepta la radio (el de la semilla y los parecidos). Sin índice o semilla desconocida: no se filtra.
  let index: GenreIndex | null = null
  let scope: GenreScope = genreScope(new Set())
  // El artista principal (no los invitados: «Versión Mariachi — Camila Fernández y Morat» no vuelve ranchero a Morat).
  const vouched = new Set([seedArtist, ...trusted.map((track) => artistKey(track.artist))])
  const preferred = new Set(favoriteGenres.get())
  /** Por qué no cabe en el género de la radio (null: cabe). */
  const genreMiss = (track: Track) => {
    if (preferred.size) {
      if (!index) return 'de otro género'
      return [...genresOf(track, index)].some((genre) => preferred.has(genre)) ? null : 'de otro género'
    }
    if (!index || !scope.accepts.size) return null
    if (clashes(track, index, scope)) return 'de otro género'
    if (vouched.has(artistKey(track.artist))) return null // el mismo artista, o uno de la lista del Modo
    const genres = genresOf(track, index)
    if (genres.size) return [...genres].some((genre) => scope.accepts.has(genre)) ? null : 'de otro género'
    return scope.strict ? 'artista que el índice no conoce (popular, ranchera o vallenato)' : null
  }
  let lastOther: Track | null = null
  let refills = 0
  let ready: Promise<void> | null = null
  const diagnostics: RadioDiagnostics = { at: Date.now(), seed: seedLabel, genres: [], accepts: [], filtered, picks: [] }
  const writeDiagnostics = () => logDiagnostics && writeRadioDiagnostics(diagnostics)

  const sharesTitle = (title: string) => {
    const candidate = new Set(words(title))
    return seedWords.filter((word) => candidate.has(word)).length / seedWords.length > TITLE_OVERLAP
  }

  /** Pasa las candidatas por los filtros y las reparte: mismo artista u otros (cada tanda nueva, al azar). */
  const add = (items: RadioItem[], reason: Reason) => {
    for (const item of items) knownArtists.add(artistKey(item.track.artist))
    // «Canción – Otro Artista» de un intérprete distinto: un cover de la canción de ese otro artista.
    const coverOf = (track: Track) => {
      const suffix = titleSuffix(track.title)
      const key = suffix ? artistKey(suffix) : ''
      return !!key && knownArtists.has(key) && key !== artistKey(track.artist)
    }
    // Una sola versión de cada título: la más vieja (suele ser la original).
    const best = new Map<string, RadioItem>()
    for (const item of items) {
      const base = baseTitle(item.track.title)
      const previous = best.get(base)
      if (!previous || (item.year ?? 9999) < (previous.year ?? 9999)) best.set(base, item)
    }
    const accepted: Candidate[] = []
    for (const item of items) {
      const { track } = item
      if (served.has(track.id)) continue
      const base = baseTitle(track.title)
      const miss = genreMiss(track)
      if (item.videoType && !OFFICIAL.has(item.videoType)) filtered['no oficial (cover o subida por usuario)']++
      else if (coverOf(track)) filtered['cover (título con el nombre de otro artista)']++
      else if (sharesTitle(track.title)) filtered['título parecido a la semilla']++
      else if (titles.has(base) || best.get(base) !== item) filtered['otra versión del mismo título']++
      else if (miss) filtered[miss]++
      else if (skipped.has(artistKey(track.artist))) filtered['artista que sueles saltar']++
      else {
        titles.add(base)
        served.add(track.id) // ya no puede volver a entrar (está en la tanda)
        accepted.push({ track, year: item.year, reason: artistKey(track.artist) === seedArtist ? 'mismo artista' : reason })
      }
    }
    for (const candidate of shuffle(accepted, random)) (candidate.reason === 'mismo artista' ? same : others).push(candidate)
  }

  /** Con el índice: el género de la semilla (o el de la mayoría de su radio) y lo que acepta la radio. */
  const useIndex = (found: GenreIndex | null, radio: readonly RadioItem[]) => {
    index = found
    let seedGenres = fixedGenres ? new Set(fixedGenres) : index ? genresOf(seed, index) : new Set<GenreKey>()
    // Si el índice no conoce la canción que suena, su género es el de la mayoría de su radio de YouTube Music.
    const guessed = !!index && !seedGenres.size
    if (index && guessed) seedGenres = dominantGenres(radio.map((item) => item.track), index)
    scope = genreScope(seedGenres)
    Object.assign(diagnostics, {
      genres: [...seedGenres].map(genreLabel),
      guessed: guessed && seedGenres.size > 0,
      accepts: [...scope.accepts].map(genreLabel),
    })
  }

  /** Las que esperan turno pasan otra vez por el filtro de género (el índice llegó después de armarse la radio). */
  const refilter = () => {
    for (const pool of [same, others]) {
      for (let i = pool.length - 1; i >= 0; i--) {
        const miss = genreMiss(pool[i].track)
        if (!miss) continue
        filtered[miss]++
        pool.splice(i, 1)
      }
    }
  }

  const init = async () => {
    const [radio, found] = await Promise.all([ytmRadioItems(seed.id).catch(() => []), preferred.size ? genreIndex().catch(() => null) : genreIndexSoon(INDEX_WAIT_MS)])
    useIndex(found, radio)
    diagnostics.seedYear = radio.find((item) => item.track.id === seed.id)?.year
    // La primera vez el índice tarda en armarse y la radio no lo espera: en cuanto llega, se aplica a lo que falta (antes
    // la radio se quedaba sin filtro de género mientras durara).
    if (!found) {
      void genreIndex()
        .then((late) => {
          if (!late.size || index) return
          useIndex(late, radio)
          refilter()
          writeDiagnostics()
        })
        .catch(() => {})
    }
    add(radio, 'mismo género')
    if (artistTop) {
      const name = firstArtist(seed.artist)
      const id = seed.artistId ?? (await ytmSearchArtists(name).catch(() => []))[0]?.id
      if (id) {
        const top = await artistTopSongs({ id, kind: 'artist', title: name, subtitle: '' })
        add(
          top.tracks.map((track) => ({ track })),
          'mismo artista',
        )
      }
    }
    writeDiagnostics()
  }

  /** Más canciones de otros artistas: la radio de la última que sonó de otro artista (o de la primera en espera). */
  const refill = async () => {
    const from = lastOther ?? others[0]?.track
    if (!from || refills >= MAX_REFILLS) return false
    refills++
    const before = others.length
    add(await ytmRadioItems(from.id).catch(() => []), 'mismo género')
    return others.length > before
  }

  /** Bloque de la canción número `n` que da la radio: 10 recomendadas y luego 5 nuevas / 5 recomendadas, alternando. */
  const groupAt = (n: number): QueueGroup['kind'] =>
    n < FIRST_BLOCK || Math.floor((n - FIRST_BLOCK) / BLOCK) % 2 === 1 ? 'recomendadas' : 'nuevas'

  return async (count: number, exclude: ReadonlySet<string> = new Set(), kind?: QueueGroup['kind']) => {
    ready ??= init()
    await ready
    const batch: { candidate: Candidate; kind: QueueGroup['kind'] }[] = []
    const perArtist = new Map<string, number>()
    const sameLimit = Math.max(1, Math.round(count * SAME_ARTIST_SHARE))
    // La primera de `pool` que cabe en la tanda: las que ya están en la cola se descartan (y se busca otra); las de un
    // artista que ya llenó su cupo esperan a la próxima tanda.
    const take = (pool: Candidate[], onlyNew: boolean): Candidate | null => {
      for (let i = 0; i < pool.length; i++) {
        const { track } = pool[i]
        if (exclude.has(track.id)) {
          logDuplicate(track, 'radio (ya estaba en la cola)')
          pool.splice(i--, 1)
          continue
        }
        if (onlyNew && heard.has(track.id)) continue
        const key = artistKey(track.artist)
        const used = perArtist.get(key) ?? 0
        if (used >= (key === seedArtist ? sameLimit : PER_ARTIST)) continue
        perArtist.set(key, used + 1)
        return pool.splice(i, 1)[0]
      }
      return null
    }
    while (batch.length < count) {
      const wantNew = (kind ?? groupAt(given + batch.length)) === 'nuevas'
      let pick = !wantNew && random() < SAME_ARTIST_SHARE ? take(same, false) : null
      pick ??= take(others, wantNew)
      if (!pick && (await refill())) continue
      pick ??= take(same, wantNew)
      // Ya no quedan nuevas: una recomendada (salvo que se pidieran solo nuevas, para «Por Descubrir»).
      if (!pick && wantNew && !kind) pick = take(others, false) ?? take(same, false)
      if (!pick) break
      if (pick.reason !== 'mismo artista') lastOther = pick.track
      batch.push({ candidate: pick, kind: wantNew && !heard.has(pick.track.id) ? 'nuevas' : 'recomendadas' })
    }
    given += batch.length
    diagnostics.at = Date.now()
    diagnostics.picks = [
      ...diagnostics.picks,
      ...batch.map(({ candidate: { track, year, reason } }) => ({ title: track.title, artist: track.artist, year, reason })),
    ].slice(-10)
    writeDiagnostics()
    return batch.map(({ candidate, kind }) => ({ track: candidate.track, group: { kind, seed: seedLabel } }))
  }
}

// Géneros de Inicio («Selecciones rápidas» y «Muy sonadas») y Modos de ambiente (Rumba, Tomar, Relax).
// YouTube no publica el género de una canción: cada género sale de las playlists que arma YouTube Music para él (las
// «destacadas», no las de usuarios): las de su categoría de «Géneros» cuando la hay (Vallenato, Urbano, Música regional
// y popular…) y las de búsquedas como «salsa para fiesta» (región Colombia). De ahí se usan las que traen el género en
// el título, primero las que son solo de ese género («Salsa Mix» antes que «Clásicos de Salsa y Merengue»), y nunca las
// de temporada (Halloween, Navidad).
//
// A las canciones se les aplican los filtros de las recomendaciones: sin covers ni versiones (karaoke, instrumental,
// slowed…), sin artistas que sueles saltar, como mucho 2 por artista y ninguna repetida. El orden es al azar, el mismo
// durante la sesión. En el Modo Tomar, además, nada de salsa, merengue, bachata ni urbano (data/genreIndex.ts), aunque
// venga en una playlist de despecho.
import type { Track } from '../player/types'
import { hashText, seededRandom, sessionSeed, shuffle } from '../lib/random'
import { clashes, genreIndex, genreIndexSoon, genreScope, genresOf, type GenreKey } from './genreIndex'
import { favoriteGenres } from './favoriteGenres'
import { youtubePopularTracks } from './youtube'
import { artistKey, listening } from './history'
import { capPerArtist, interleave, unique } from './lists'
import { ytmCategoryPlaylists, ytmPage, ytmSearchPlaylists, type YtmCard } from './ytmusic'

/** Covers y versiones que no son la original (para listas que no pasan por la radio). */
export const NOT_ORIGINAL = /\b(cover|karaoke|instrumental|slowed|sped ?up|nightcore|8d)\b/i

const PLAYLISTS_PER_LIST = 2 // las canciones de un género o filtro salen de sus 2 primeras playlists
const INDEX_WAIT_MS = 20000 // la primera vez el índice de géneros tarda en armarse: la lista de un Modo lo espera
const SEASONAL = /halloween|navidad|navideñ|christmas|diciembre|decembrin/i
// Palabras de género: una playlist que nombra varios («Salsa y Merengue») va después de las de un solo género.
const GENRE_WORDS = [
  /salsa/i,
  /merengue/i,
  /regg?a?et[oó]n|perreo/i,
  /vallenat/i,
  /bachata/i,
  /cumbia/i,
  /popular|despecho/i,
  /ranch|mariachi/i,
  /balad/i,
  /bolero/i,
  /dance|electr/i,
]

export interface GenreSource {
  key: string
  label: string
  category?: string // categoría de «Géneros» de YouTube Music, si la hay («Vallenato», «Urbano»…)
  queries: string[] // búsquedas de playlists, como «salsa para fiesta»
  match: RegExp // sirven las playlists que traen esto en el título…
  avoid?: RegExp // …salvo las que traen esto
  genre?: GenreKey // el del índice de géneros, si no es `key` (Despecho → popular)
}

const SALSA: GenreSource = { key: 'salsa', label: 'Salsa', queries: ['salsa'], match: /salsa/i }
const REGGAETON: GenreSource = { key: 'reggaeton', label: 'Reggaetón', category: 'Urbano', queries: ['reggaeton'], match: /regg?a?et[oó]n|perreo/i }
const MERENGUE: GenreSource = { key: 'merengue', label: 'Merengue', queries: ['merengue'], match: /merengue/i }
const POPULAR: GenreSource = { key: 'popular', label: 'Popular', category: 'Música regional y popular', queries: ['música popular despecho'], match: /popular|despecho/i }
const VALLENATO: GenreSource = { key: 'vallenato', label: 'Vallenato', category: 'Vallenato', queries: ['vallenato'], match: /vallenat/i }
const COLOMBIANA: GenreSource = { key: 'colombiana', label: 'Música colombiana', queries: ['música colombiana'], match: /colombi/i }
// Los que solo tenían los Modos (Tomar y Relax).
const DESPECHO: GenreSource = { key: 'despecho', label: 'Despecho', category: 'Música regional y popular', queries: ['música para tomar despecho'], match: /despecho|popular/i, genre: 'popular' }
const RANCHERAS: GenreSource = { key: 'rancheras', label: 'Rancheras', category: 'Música regional y popular', queries: ['rancheras para tomar'], match: /ranch|mariachi|vicente/i, genre: 'regional' }
const CHILL: GenreSource = { key: 'chill', label: 'Chill', queries: ['chill latino', 'relajante'], match: /chill|relaj|calma|tranquil|cafecito/i, avoid: /house|jazz|nana|beb[eé]|rock/i }

/**
 * Géneros que reconoce la radio (data/genreIndex.ts): de las playlists de cada uno sale qué artistas son de qué género.
 * Van también los que nunca se recomiendan juntos (rock, electrónica, pop…), para reconocerlos y dejarlos fuera.
 */
export const INDEX_GENRES = {
  reggaeton: REGGAETON,
  dancehall: { key: 'dancehall', label: 'Dancehall', queries: ['dancehall'], match: /dancehall/i },
  trap: { key: 'trap', label: 'Trap latino', queries: ['trap latino'], match: /trap/i },
  salsa: SALSA,
  merengue: MERENGUE,
  bachata: { key: 'bachata', label: 'Bachata', category: 'Bachata', queries: ['bachata'], match: /bachata/i },
  vallenato: VALLENATO,
  cumbia: { key: 'cumbia', label: 'Cumbia', category: 'Cumbia', queries: ['cumbia'], match: /cumbia/i },
  popular: POPULAR,
  regional: {
    key: 'regional',
    label: 'Regional mexicano',
    category: 'Música regional y popular',
    queries: ['rancheras', 'regional mexicano'],
    match: /ranch|mariachi|corrido|banda|mexican|regional/i,
  },
  pop: { key: 'pop', label: 'Pop latino', category: 'Pop Latino', queries: ['pop latino'], match: /pop/i, avoid: /k-?pop|j-?pop|turk|popular/i },
  baladas: { key: 'baladas', label: 'Baladas', queries: ['baladas en español'], match: /balad/i },
  boleros: { key: 'boleros', label: 'Boleros', queries: ['boleros'], match: /bolero/i },
  electronica: { key: 'electronica', label: 'Electrónica', category: 'Dance y electrónica', queries: ['electrónica'], match: /dance|electr|edm|house/i },
  rock: { key: 'rock', label: 'Rock en español', category: 'Rock en español', queries: ['rock en español'], match: /rock/i },
  // Para reconocerlos y dejarlos fuera de las radios latinas (una de salsa llegó a traer K-Pop).
  kpop: { key: 'kpop', label: 'K-Pop', category: 'K-Pop', queries: ['k-pop'], match: /k-?pop|korea|corea/i },
  jpop: { key: 'jpop', label: 'J-Pop', category: 'Pop japonés', queries: ['j-pop'], match: /j-?pop|jap[oó]n|japan|anime/i },
  cpop: { key: 'cpop', label: 'Mandopop', category: 'Mandopop y cantopop', queries: ['mandopop'], match: /mandopop|cantopop|c-?pop|chin/i },
  colombiana: COLOMBIANA,
} satisfies Record<string, GenreSource>

/** «Selecciones rápidas»: canciones por género. Con «+» se eligen cuáles (por defecto, los 4 primeros). */
export const QUICK_PICK_OPTIONS: GenreSource[] = [
  SALSA,
  REGGAETON,
  MERENGUE,
  POPULAR,
  VALLENATO,
  INDEX_GENRES.bachata,
  INDEX_GENRES.cumbia,
  INDEX_GENRES.regional,
  INDEX_GENRES.pop,
  INDEX_GENRES.baladas,
  INDEX_GENRES.boleros,
  INDEX_GENRES.trap,
  INDEX_GENRES.dancehall,
  INDEX_GENRES.electronica,
  INDEX_GENRES.rock,
  INDEX_GENRES.kpop,
  INDEX_GENRES.jpop,
  INDEX_GENRES.cpop,
  COLOMBIANA,
]
export const QUICK_PICK_DEFAULT = [SALSA, REGGAETON, MERENGUE, POPULAR].map((genre) => genre.key)
/** «Muy sonadas»: playlists por género. */
export const POPULAR_GENRES = [SALSA, REGGAETON, MERENGUE, POPULAR, VALLENATO, COLOMBIANA]

export interface Mode {
  key: 'rumba' | 'tomar' | 'relax'
  label: string
  note: string
  // Si los tiene, su radio es de estos géneros (no se adivinan de cada canción) y su lista no trae nada que choque con
  // ellos. Sin esto (Rumba, Relax), la radio sigue el género de la canción que suena. Si personalizas el modo, son los
  // de los géneros que elegiste (customMode).
  genres?: GenreKey[]
  filters: GenreSource[] // subfiltros (los géneros del modo, por defecto); «Todo» los mezcla
}

export const MODES: Mode[] = [
  {
    key: 'rumba',
    label: 'Modo Rumba',
    note: 'Para la fiesta',
    filters: [
      { key: 'salsa', label: 'Salsa', queries: ['salsa para fiesta', 'salsa mix'], match: /salsa/i },
      { key: 'reggaeton', label: 'Reggaetón', category: 'Urbano', queries: ['reggaeton para fiesta', 'perreo'], match: /regg?a?et[oó]n|perreo/i, avoid: /triste/i },
      { key: 'merengue', label: 'Merengue', queries: ['merengue para bailar'], match: /merengue/i, avoid: /rom[aá]ntic/i },
    ],
  },
  {
    key: 'tomar',
    label: 'Modo Tomar',
    note: 'Despecho, rancheras y vallenato',
    genres: ['popular', 'regional', 'vallenato'],
    filters: [DESPECHO, RANCHERAS, { key: 'vallenato', label: 'Vallenato', category: 'Vallenato', queries: ['vallenato para tomar'], match: /vallenat/i }],
  },
  {
    key: 'relax',
    label: 'Modo Relax',
    note: 'Para bajar el ritmo',
    filters: [INDEX_GENRES.baladas, INDEX_GENRES.boleros, CHILL],
  },
]

/**
 * Todos los géneros de la app, para personalizar cualquier Modo (agregar o quitar). En su propio modo, un género usa la
 * búsqueda de ese modo («salsa para fiesta» en Rumba); en otro, la de aquí.
 */
export const MODE_GENRES: GenreSource[] = [
  SALSA,
  REGGAETON,
  MERENGUE,
  INDEX_GENRES.bachata,
  INDEX_GENRES.cumbia,
  VALLENATO,
  POPULAR,
  DESPECHO,
  RANCHERAS,
  INDEX_GENRES.regional,
  COLOMBIANA,
  INDEX_GENRES.pop,
  INDEX_GENRES.baladas,
  INDEX_GENRES.boleros,
  CHILL,
  INDEX_GENRES.trap,
  INDEX_GENRES.dancehall,
  INDEX_GENRES.electronica,
  INDEX_GENRES.rock,
  INDEX_GENRES.kpop,
  INDEX_GENRES.jpop,
  INDEX_GENRES.cpop,
]

/** Los géneros por defecto de un modo (Rumba: salsa, reggaetón y merengue). */
export const defaultModeGenres = (mode: Mode) => mode.filters.map((source) => source.key)

/**
 * El modo con los géneros que elegiste, en ese orden: son sus subfiltros y, en Tomar, también los de su radio (así
 * agregar salsa a Tomar no la deja fuera por chocar con el despecho).
 */
export function customMode(mode: Mode, keys: readonly string[]): Mode {
  const filters = keys
    .map((key) => mode.filters.find((source) => source.key === key) ?? MODE_GENRES.find((source) => source.key === key))
    .filter((source) => source !== undefined)
  if (!filters.length) return mode
  const genres = [...new Set(filters.map((source) => source.genre ?? (Object.hasOwn(INDEX_GENRES, source.key) ? (source.key as GenreKey) : null)))].filter((genre) => genre !== null)
  return { ...mode, filters, genres: mode.genres && genres.length ? genres : undefined }
}

/** Lo que dice el modo debajo de su nombre: su nota de siempre o, si lo personalizaste, sus géneros («Salsa y Popular»). */
export function modeNote(mode: Mode, keys: readonly string[]): string {
  if (keys.join() === defaultModeGenres(mode).join()) return mode.note
  const labels = customMode(mode, keys).filters.map((source) => source.label)
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} y ${labels.at(-1)}` : (labels[0] ?? mode.note)
}

const mixes = (title: string) => GENRE_WORDS.filter((word) => word.test(title)).length

/** Las playlists de YouTube Music de un género (o subfiltro), de la que más se ajusta a la que menos. */
export async function sourcePlaylists(source: GenreSource): Promise<YtmCard[]> {
  const lists = await Promise.all([
    source.category ? ytmCategoryPlaylists(source.category).catch(() => []) : [],
    ...source.queries.map((q) => ytmSearchPlaylists(q).catch(() => [])),
  ])
  const found = unique(lists.flat()).filter((card) => !SEASONAL.test(card.title) && !source.avoid?.test(card.title))
  const fitting = found.filter((card) => source.match.test(card.title))
  // Sort estable: entre las que nombran la misma cantidad de géneros, se respeta el orden de YouTube Music.
  return fitting.length ? [...fitting].sort((a, b) => mixes(a.title) - mixes(b.title)) : found.slice(0, PLAYLISTS_PER_LIST)
}

/** Canciones de un género o subfiltro: las de sus 2 primeras playlists, al azar (el mismo orden en la sesión), filtradas. */
export async function sourceTracks(source: GenreSource, limit = 40): Promise<Track[]> {
  const playlists = (await sourcePlaylists(source)).slice(0, PLAYLISTS_PER_LIST)
  const pages = await Promise.all(playlists.map((playlist) => ytmPage(playlist.id).catch(() => null)))
  const random = seededRandom(sessionSeed() ^ hashText(source.key + source.queries.join()))
  const tracks = strictFilter(interleave(pages.map((page) => shuffle(page?.tracks ?? [], random))), limit * 2)
  const selected = favoriteGenres.get()
  if (!selected.length) return tracks.slice(0, limit)
  const index = await genreIndex()
  const accepted = new Set(selected)
  return tracks.filter((track) => [...genresOf(track, index)].some((genre) => accepted.has(genre))).slice(0, limit)
}

/**
 * Para la precarga de la bienvenida (data/prefetch.ts): trae lo que `sourceTracks` va a leer (sus playlists y las 2
 * primeras), que queda en la caché de YouTube Music. No espera al índice de géneros: ese se arma aparte.
 */
export async function prefetchSource(source: GenreSource): Promise<void> {
  const playlists = (await sourcePlaylists(source)).slice(0, PLAYLISTS_PER_LIST)
  await Promise.all(playlists.map((playlist) => ytmPage(playlist.id).catch(() => null)))
}

/** Canciones de un modo: un subfiltro, o todos mezclados («Todo»), sin las de un género que choca con el del modo. */
export async function modeTracks(mode: Mode, filterKey: string | null, limit = 50): Promise<Track[]> {
  const sources = filterKey ? mode.filters.filter((f) => f.key === filterKey) : mode.filters
  const selected = favoriteGenres.get()
  const [lists, index, globalIndex] = await Promise.all([
    Promise.all(sources.map((source) => tracksForMode(mode, source, limit).catch(() => []))),
    mode.genres ? genreIndexSoon(INDEX_WAIT_MS) : null,
    selected.length ? genreIndex().catch(() => null) : null,
  ])
  const scope = genreScope(new Set(mode.genres))
  const fits = (track: Track) => (!index || !clashes(track, index, scope)) && (!selected.length || (!!globalIndex && [...genresOf(track, globalIndex)].some((genre) => selected.includes(genre))))
  return strictFilter(interleave(lists.map((list) => list.filter(fits))), limit)
}

/** Rumba prioriza videos populares; si no hay Data API, falla o no encuentra pistas, usa playlists de YouTube Music. */
async function tracksForMode(mode: Mode, source: GenreSource, limit: number): Promise<Track[]> {
  if (mode.key !== 'rumba') return strictFilter(await sourceTracks(source), limit)
  try {
    const popular = strictFilter(await youtubePopularTracks(source.queries[0]), limit)
    if (popular.length) return popular
  } catch {
    // La API oficial es opcional; el modo sigue con el catálogo normal de YouTube Music.
  }
  return strictFilter(await sourceTracks(source), limit)
}

/** Los filtros de las recomendaciones: sin covers, sin artistas que sueles saltar, 2 por artista y sin repetidas. */
function strictFilter(tracks: Track[], limit: number): Track[] {
  const skipped = listening.skippedArtists()
  return capPerArtist(tracks.filter((track) => !NOT_ORIGINAL.test(track.title) && !skipped.has(artistKey(track.artist)))).slice(0, limit)
}

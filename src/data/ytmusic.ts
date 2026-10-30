// YouTube Music: búsqueda y listas (inicio, explorar, playlists, álbumes, artistas y radio) con la API interna
// de su web («InnerTube»), la misma que usan InnerTune, OuterTune y SimpMusic. Solo se usan los DATOS: la música
// suena siempre en el reproductor oficial de YouTube.
// Ojo: no es una API publicada. Puede cambiar sin aviso y usarla va contra los términos de YouTube.
// El navegador no puede llamarla directamente (CORS), así que pasa por un intermediario: al probar, el propio
// servidor de Vite (/ytm-api, ver vite.config.ts); publicada, la dirección de VITE_YTM_PROXY.
import { countYtmRequest } from '../lib/apiUsage'
import type { Track } from '../player/types'

// Las respuestas de InnerTube son estructuras profundas que cambian a menudo: se leen con «?.» y se descarta lo que no encaje.
type Json = any

const ENDPOINT = (import.meta.env.VITE_YTM_PROXY?.trim() || '/ytm-api').replace(/\/$/, '')
const CLIENT = { clientName: 'WEB_REMIX', clientVersion: '1.20251015.01.00', hl: 'es', gl: 'CO' }

// Filtros de búsqueda de YouTube Music (los mismos de InnerTune).
const FILTER = {
  songs: 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D',
  albums: 'EgWKAQIYAWoKEAkQChAFEAMQBA%3D%3D',
  artists: 'EgWKAQIgAWoKEAkQChAFEAMQBA%3D%3D',
  featuredPlaylists: 'EgeKAQQoADgBagwQDhAKEAMQBRAJEAQ%3D',
  communityPlaylists: 'EgeKAQQoAEABagwQDhAKEAMQBRAJEAQ%3D',
}
const SEARCH_PLAYLISTS = 12 // playlists en Buscar (primero las de YouTube Music, después las de la comunidad)
// Una consulta que no responde en este tiempo falla (y se reintenta después). Sin límite, una conexión que se cae a
// mitad (p. ej. al pasar de wifi a datos con la pantalla apagada) dejaba la consulta esperando para siempre, y la Fila
// Dinámica, que pide de a una, no volvía a pedir canciones: la música se detenía al acabarse la cola.
const REQUEST_TIMEOUT_MS = 20_000

/** Playlist, álbum o artista: se abre en su propia página (/ytm/:id). */
export interface YtmCard {
  id: string // browseId
  kind: 'playlist' | 'album' | 'artist'
  title: string
  subtitle: string
  image?: string
}

/** Un estante: canciones en lista o tarjetas en fila. */
export interface YtmSection {
  title: string
  tracks: Track[]
  cards: YtmCard[]
}

export interface YtmPage {
  kind: string // «Álbum • 2020», «Playlist», «Artista»
  title: string
  subtitle: string
  image?: string
  tracks: Track[] // playlist o álbum
  sections: YtmSection[] // artista
}

export interface YtmSearchResults {
  songs: Track[]
  albums: YtmCard[]
  artists: YtmCard[]
  playlists: YtmCard[] // de YouTube Music y de la comunidad: se pueden guardar en Tu biblioteca
}

// La app de Android de YouTube Music: es la que recibe la letra con tiempos (para el karaoke).
const ANDROID_CLIENT = { clientName: 'ANDROID_MUSIC', clientVersion: '7.27.52', androidSdkVersion: 30, hl: 'es', gl: 'CO' }

async function call(endpoint: string, body: object, visitorData?: string, client: object = CLIENT): Promise<Json> {
  countYtmRequest() // para el diagnóstico de Ayuda (YouTube Music no tiene cuota)
  const response = await fetch(`${ENDPOINT}/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ context: { client: { ...client, visitorData } }, ...body }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`YouTube Music respondió ${response.status}`)
  return response.json()
}

// ---- Lectura de las respuestas ----

interface Run {
  text: string
  navigationEndpoint?: Json
}

const runsOf = (text: Json): Run[] => text?.runs ?? []
const plain = (text: Json): string => runsOf(text).map((run) => run.text).join('')
const joined = (runs: Run[]): string => runs.map((run) => run.text).join('')
const pageType = (endpoint: Json): string | undefined =>
  endpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType
const lastThumb = (thumbnail: Json): string | undefined => thumbnail?.thumbnails?.at(-1)?.url
const notEmpty = <T>(value: T | null | undefined): value is T => value != null

/** Solo portadas de YouTube Music (cuadradas); las miniaturas de video (i.ytimg.com) se arman aparte. */
const squareArt = (url: string | undefined) => (url && /googleusercontent\.com/.test(url) ? url : undefined)

// «(Official Video)», «[Video Oficial]», «(Lyric Video)», «| Audio Oficial»…: es la etiqueta del video, no parte del
// nombre de la canción. Se quita al mostrarla («(Remix)», «(En Vivo)» o «(feat. …)» se quedan).
const VIDEO_TAG =
  /^(?:official\s+|oficial\s+)?(?:con\s+)?(?:(?:music|lyric|4k|hd)\s+)*(?:video(?:clip)?|vídeo|audio|visuali[sz]er|lyrics?|letra)(?:\s+(?:oficial|official|lyrics?))?(?:\s+(?:4k|hd))?$/i

function cleanTitle(title: string): string {
  const cleaned = title
    .replace(/\s*[([]([^()[\]]+)[)\]]/g, (whole, inner: string) => (VIDEO_TAG.test(inner.trim()) ? '' : whole))
    .replace(/\s+\|\s+([^|]+)$/, (whole, tail: string) => (VIDEO_TAG.test(tail.trim()) ? '' : whole))
    .trim()
  return cleaned || title
}

/** «3:26» o «1:02:03» → segundos. */
function seconds(text: string | undefined): number | undefined {
  if (!text || !/^\d+(:\d{2})+$/.test(text)) return undefined
  return text.split(':').reduce((total, part) => total * 60 + Number(part), 0)
}

/** «Bad Bunny y Jhayco • EL ÚLTIMO TOUR DEL MUNDO • 3:26» → grupos separados por « • ». */
function groups(text: Json): Run[][] {
  const result: Run[][] = [[]]
  for (const run of runsOf(text)) {
    if (run.text.trim() === '•') result.push([])
    else result[result.length - 1].push(run)
  }
  return result.filter((group) => group.length)
}

const KINDS: Record<string, YtmCard['kind']> = {
  MUSIC_PAGE_TYPE_PLAYLIST: 'playlist',
  MUSIC_PAGE_TYPE_ALBUM: 'album',
  MUSIC_PAGE_TYPE_ARTIST: 'artist',
}

interface Defaults {
  album?: string
  artist?: string
  artistId?: string
  artwork?: string
}

/** Canción de una lista (búsqueda, «Selecciones rápidas», playlist o álbum). */
function fromListItem(r: Json, defaults: Defaults = {}): Track | null {
  const videoId: string | undefined =
    r?.playlistItemData?.videoId ?? r?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId
  const columns: Json[] = (r?.flexColumns ?? []).map((column: Json) => column?.musicResponsiveListItemFlexColumnRenderer?.text)
  const title = plain(columns[0])
  if (!videoId || !title) return null
  const line = groups(columns[1])
  const artistGroup = line.find((group) => group.some((run) => pageType(run.navigationEndpoint) === 'MUSIC_PAGE_TYPE_ARTIST')) ?? line[0]
  const albumRun = columns.slice(1).flatMap(runsOf).find((run) => pageType(run.navigationEndpoint) === 'MUSIC_PAGE_TYPE_ALBUM')
  const durationText = plain(r?.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text) || joined(line.at(-1) ?? [])
  return {
    id: videoId,
    title: cleanTitle(title),
    artist: (artistGroup && joined(artistGroup)) || defaults.artist || 'YouTube Music',
    artistId: artistIdOf(artistGroup ?? []) ?? defaults.artistId,
    album: albumRun?.text ?? defaults.album,
    duration: seconds(durationText),
    artwork: squareArt(lastThumb(r?.thumbnail?.musicThumbnailRenderer?.thumbnail)) ?? defaults.artwork,
    ytMusic: true,
  }
}

/** Canción de la radio («A continuación»). */
function fromPanelItem(r: Json): Track | null {
  if (!r?.videoId || !plain(r.title)) return null
  const line = groups(r.longBylineText)
  return {
    id: r.videoId,
    title: cleanTitle(plain(r.title)),
    artist: joined(line[0] ?? []) || 'YouTube Music',
    artistId: artistIdOf(line[0] ?? []),
    album: runsOf(r.longBylineText).find((run) => pageType(run.navigationEndpoint) === 'MUSIC_PAGE_TYPE_ALBUM')?.text,
    duration: seconds(plain(r.lengthText)),
    artwork: squareArt(lastThumb(r.thumbnail)),
    ytMusic: true,
  }
}

/** Canción de la radio con lo que hace falta para filtrarla: año del álbum y tipo de video. */
export interface RadioItem {
  track: Track
  year?: number // del álbum («Daddy Yankee • Barrio Fino • 2004»)
  // ATV = audio oficial (canal «Artista - Topic»), OMV = video oficial, UGC = subido por un usuario (covers…)
  videoType?: string
}

function radioItemOf(r: Json): RadioItem | null {
  const track = fromPanelItem(r)
  if (!track) return null
  const last = joined(groups(r.longBylineText).at(-1) ?? []).trim()
  return {
    track,
    year: /^\d{4}$/.test(last) ? Number(last) : undefined,
    videoType: r.navigationEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType,
  }
}

/** Tarjeta de un resultado en lista (búsqueda de álbumes o artistas). */
function cardFromListItem(r: Json): YtmCard | null {
  const endpoint = r?.navigationEndpoint
  const kind = KINDS[pageType(endpoint) ?? '']
  const title = plain(r?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text)
  if (!kind || !endpoint.browseEndpoint.browseId || !title) return null
  return {
    id: endpoint.browseEndpoint.browseId,
    kind,
    title,
    subtitle: cardSubtitle(r.flexColumns[1]?.musicResponsiveListItemFlexColumnRenderer?.text),
    image: lastThumb(r.thumbnail?.musicThumbnailRenderer?.thumbnail),
  }
}

/** Subtítulo de una tarjeta sin la etiqueta «YouTube Music» («YouTube Music • 60 canciones» → «60 canciones»). */
const cardSubtitle = (text: Json): string =>
  plain(text)
    .split(' • ')
    .filter((part) => part.trim() !== 'YouTube Music')
    .join(' • ')

/** Tarjeta de un estante (playlist, álbum o artista) o, si es una canción suelta, la canción. */
function fromTwoRow(r: Json): YtmCard | Track | null {
  const title = plain(r?.title)
  const image = lastThumb(r?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail)
  const watch = r?.navigationEndpoint?.watchEndpoint
  if (watch?.videoId && title) {
    const line = groups(r.subtitle)
    const artistGroup = line.find((group) => group.some((run) => pageType(run.navigationEndpoint) === 'MUSIC_PAGE_TYPE_ARTIST')) ?? line.at(-1)
    return { id: watch.videoId, title: cleanTitle(title), artist: joined(artistGroup ?? []) || 'YouTube Music', artistId: artistIdOf(artistGroup ?? []), artwork: squareArt(image), ytMusic: true }
  }
  const kind = KINDS[pageType(r?.navigationEndpoint) ?? '']
  const id = r?.navigationEndpoint?.browseEndpoint?.browseId
  if (!kind || !id || !title) return null
  return { id, kind, title, subtitle: cardSubtitle(r.subtitle), image }
}

const isTrack = (item: YtmCard | Track): item is Track => !('kind' in item)

/** Id del primer artista enlazado en una línea («Bad Bunny y Jhayco • …»). */
const artistIdOf = (runs: Run[]): string | undefined =>
  runs.find((run) => pageType(run.navigationEndpoint) === 'MUSIC_PAGE_TYPE_ARTIST')?.navigationEndpoint.browseEndpoint.browseId

function sectionsOf(contents: Json[] | undefined): YtmSection[] {
  return (contents ?? []).flatMap((content: Json) => {
    const shelf = content?.musicCarouselShelfRenderer ?? content?.musicShelfRenderer
    if (!shelf) return []
    const section: YtmSection = { title: plain(shelf.header?.musicCarouselShelfBasicHeaderRenderer?.title ?? shelf.title), tracks: [], cards: [] }
    for (const item of shelf.contents ?? []) {
      if (item.musicResponsiveListItemRenderer) {
        const track = fromListItem(item.musicResponsiveListItemRenderer)
        if (track) section.tracks.push(track)
      } else if (item.musicTwoRowItemRenderer) {
        const entry = fromTwoRow(item.musicTwoRowItemRenderer)
        if (entry && isTrack(entry)) section.tracks.push(entry)
        else if (entry) section.cards.push(entry)
      }
    }
    return section.title && (section.tracks.length || section.cards.length) ? [section] : []
  })
}

const sectionListOf = (json: Json) => json?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer

/** Los resultados de una búsqueda filtrada (canciones, álbumes, artistas o videos). */
const searchShelf = (json: Json): Json[] =>
  json?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.find((c: Json) => c?.musicShelfRenderer)
    ?.musicShelfRenderer?.contents ?? []

// ---- Consultas (se guardan en memoria durante la sesión) ----

const memo = new Map<string, Promise<unknown>>()
function remember<T>(key: string, load: () => Promise<T>, shouldCache: (value: T) => boolean = () => true): Promise<T> {
  if (!memo.has(key)) {
    const storageKey = `soundblue:cache:ytm:${key}`
    let cached: { at: number; value: T } | null = null
    try { cached = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') } catch { /* caché opcional */ }
    const promise = cached && Date.now() - cached.at < 30 * 60 * 1000 ? Promise.resolve(cached.value) : load().then((value) => {
      try { sessionStorage.setItem(storageKey, JSON.stringify({ at: Date.now(), value })) } catch { /* caché opcional */ }
      if (!shouldCache(value)) {
        try { sessionStorage.removeItem(storageKey) } catch { /* optional cache */ }
        memo.delete(key)
      }
      return value
    })
    promise.catch(() => memo.delete(key)) // si falló, se reintenta la próxima vez
    memo.set(key, promise)
  }
  return memo.get(key) as Promise<T>
}

/** Inicio: «Selecciones rápidas», playlists por género y, de Explorar, lanzamientos y listas. */
export function ytmHome(): Promise<YtmSection[]> {
  return remember('inicio', async () => {
    const [home, explore] = await Promise.all([call('browse', { browseId: 'FEmusic_home' }), call('browse', { browseId: 'FEmusic_explore' }).catch(() => null)])
    const list = sectionListOf(home)
    const sections = sectionsOf(list?.contents)
    // Más estantes del inicio, si YouTube Music los da sin iniciar sesión.
    const token = list?.continuations?.[0]?.nextContinuationData?.continuation
    if (token) {
      const more = await call('browse', { continuation: token }, home?.responseContext?.visitorData).catch(() => null)
      sections.push(...sectionsOf(more?.continuationContents?.sectionListContinuation?.contents))
    }
    sections.push(...sectionsOf(sectionListOf(explore)?.contents))
    return sections
  })
}

/** Búsqueda como en YouTube Music: canciones, álbumes, artistas y playlists. */
export function ytmSearch(query: string): Promise<YtmSearchResults> {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ')
  // v3 invalida resultados anteriores; las consultas vacías tampoco se conservan en caché.
  return remember(`buscar:v3:${q}`, async () => {
    const [songs, albums, artists, featured, community] = await Promise.all([
      call('search', { query: q, params: FILTER.songs }),
      call('search', { query: q, params: FILTER.albums }).catch(() => null),
      call('search', { query: q, params: FILTER.artists }).catch(() => null),
      call('search', { query: q, params: FILTER.featuredPlaylists }).catch(() => null),
      call('search', { query: q, params: FILTER.communityPlaylists }).catch(() => null),
    ])
    const cards = (json: Json) => searchShelf(json).map((item) => cardFromListItem(item.musicResponsiveListItemRenderer)).filter(notEmpty)
    const seen = new Set<string>()
    return {
      songs: searchShelf(songs).map((item) => fromListItem(item.musicResponsiveListItemRenderer)).filter(notEmpty),
      albums: cards(albums),
      artists: cards(artists),
      playlists: [...cards(featured), ...cards(community)]
        .filter((card) => card.kind === 'playlist' && !seen.has(card.id) && !!seen.add(card.id))
        .slice(0, SEARCH_PLAYLISTS),
    }
  }, (result) => !!(result.songs.length || result.albums.length || result.artists.length || result.playlists.length))
}

/** Solo artistas (una consulta): para elegir tus gustos. */
export function ytmSearchArtists(query: string): Promise<YtmCard[]> {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ')
  return remember(`artistas:${q}`, async () => {
    const json = await call('search', { query: q, params: FILTER.artists })
    return searchShelf(json)
      .map((item) => cardFromListItem(item.musicResponsiveListItemRenderer))
      .filter((card): card is YtmCard => card?.kind === 'artist')
  })
}

/**
 * Playlists que arma el propio YouTube Music («destacadas»; no las de usuarios) para una búsqueda, p. ej. «salsa para
 * fiesta»: así salen los géneros y los modos de Inicio (YouTube no publica el género de una canción).
 */
export function ytmSearchPlaylists(query: string): Promise<YtmCard[]> {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ')
  return remember(`playlists:${q}`, async () => {
    const json = await call('search', { query: q, params: FILTER.featuredPlaylists })
    return searchShelf(json)
      .map((item) => cardFromListItem(item.musicResponsiveListItemRenderer))
      .filter((card): card is YtmCard => card?.kind === 'playlist')
  })
}

/**
 * Playlists de una categoría de «Estados de ánimo y géneros» de YouTube Music (p. ej. «Vallenato» o «Música regional y
 * popular»): solo las que arma YouTube Music (se salta el estante de la comunidad).
 */
export function ytmCategoryPlaylists(name: string): Promise<YtmCard[]> {
  return remember(`categoria:${name}`, async () => {
    const moods = await call('browse', { browseId: 'FEmusic_moods_and_genres' })
    const buttons: Json[] = (sectionListOf(moods)?.contents ?? []).flatMap((section: Json) => section?.gridRenderer?.items ?? [])
    const endpoint = buttons.map((item) => item?.musicNavigationButtonRenderer).find((button) => plain(button?.buttonText) === name)?.clickCommand
      ?.browseEndpoint
    if (!endpoint?.browseId) return []
    const json = await call('browse', { browseId: endpoint.browseId, params: endpoint.params })
    return (sectionListOf(json)?.contents ?? [])
      .filter((content: Json) => {
        const shelf = content?.musicCarouselShelfRenderer ?? content?.gridRenderer
        return !/comunidad/i.test(plain(shelf?.header?.musicCarouselShelfBasicHeaderRenderer?.title ?? shelf?.header?.gridHeaderRenderer?.title))
      })
      .flatMap((content: Json) => content?.musicCarouselShelfRenderer?.contents ?? content?.gridRenderer?.items ?? [])
      .map((item: Json) => item?.musicTwoRowItemRenderer && fromTwoRow(item.musicTwoRowItemRenderer))
      .filter((entry: YtmCard | Track | null): entry is YtmCard => !!entry && !isTrack(entry) && entry.kind === 'playlist')
  })
}

/** Artistas parecidos («Puede que también te guste» en la página del artista). */
export async function ytmSimilarArtists(artistId: string): Promise<YtmCard[]> {
  const page = await ytmPage(artistId)
  return page.sections.flatMap((section) => section.cards.filter((card) => card.kind === 'artist' && card.id !== artistId))
}

/** Página de una playlist, un álbum o un artista. */
export function ytmPage(browseId: string): Promise<YtmPage> {
  return remember(`pagina:${browseId}`, async () => {
    const json = await call('browse', { browseId })
    const two = json?.contents?.twoColumnBrowseResultsRenderer
    if (two) {
      const first = two.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
      const header = first?.musicResponsiveHeaderRenderer ?? first?.musicEditablePlaylistDetailHeaderRenderer?.header?.musicResponsiveHeaderRenderer
      const title = plain(header?.title)
      const artist = plain(header?.straplineTextOne)
      const image = lastThumb(header?.thumbnail?.musicThumbnailRenderer?.thumbnail)
      const shelf = two.secondaryContents?.sectionListRenderer?.contents?.[0]
      const items: Json[] = (shelf?.musicPlaylistShelfRenderer ?? shelf?.musicShelfRenderer)?.contents ?? []
      // En un álbum las canciones no traen portada ni álbum: son los del propio álbum.
      const defaults = browseId.startsWith('MPRE') ? { album: title, artist, artistId: artistIdOf(runsOf(header?.straplineTextOne)), artwork: squareArt(image) } : {}
      return {
        kind: plain(header?.subtitle) || 'Playlist',
        title,
        subtitle: [artist, plain(header?.secondSubtitle)].filter((part) => part && part !== 'YouTube Music').join(' • '),
        image,
        tracks: items.map((item) => fromListItem(item.musicResponsiveListItemRenderer, defaults)).filter(notEmpty),
        sections: [],
      }
    }
    const header = json?.header?.musicImmersiveHeaderRenderer ?? json?.header?.musicVisualHeaderRenderer
    return {
      kind: 'Artista',
      title: plain(header?.title),
      subtitle: '',
      image: lastThumb((header?.thumbnail ?? header?.foregroundThumbnail)?.musicThumbnailRenderer?.thumbnail),
      tracks: [],
      sections: sectionsOf(sectionListOf(json)?.contents),
    }
  })
}

const VIDEOS_FILTER = 'EgWKAQIQAWoKEAkQChAFEAMQBA%3D%3D'
const simplify = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim()

/**
 * Otras versiones de la misma canción (video oficial, con letra…), por si la original no se deja incrustar.
 * Solo las que llevan el título de la canción; como mucho 3.
 */
export function ytmAlternatives(track: Track): Promise<string[]> {
  return remember(`versiones:${track.id}`, async () => {
    const artist = track.artist.split(/,| y | & /)[0]
    const json = await call('search', { query: `${track.title} ${artist}`, params: VIDEOS_FILTER })
    const wanted = simplify(track.title)
    return searchShelf(json)
      .map((item) => fromListItem(item.musicResponsiveListItemRenderer))
      .filter((video): video is Track => !!video && video.id !== track.id && simplify(video.title).includes(wanted))
      .slice(0, 3)
      .map((video) => video.id)
  })
}

/**
 * Radio de una canción: lo que YouTube Music pone en «A continuación» a partir de ella (de su videoId, no de su
 * título), con el año y el tipo de video de cada una. Suelen ser unas 50, del mismo género.
 */
export function ytmRadioItems(videoId: string): Promise<RadioItem[]> {
  return remember(`radio:${videoId}`, async () => {
    const json = await call('next', { videoId, playlistId: `RDAMVM${videoId}`, isAudioOnly: true })
    const tabs = json?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs ?? []
    const items: Json[] = tabs[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents ?? []
    return items
      .map((item) => radioItemOf(item.playlistPanelVideoRenderer ?? item.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer))
      .filter(notEmpty)
  })
}

/** Radio de una canción: solo las canciones (ver ytmRadioItems). */
export const ytmRadio = (videoId: string): Promise<Track[]> => ytmRadioItems(videoId).then((items) => items.map((item) => item.track))

/** Letra de una canción con su fuente («Fuente: Musixmatch»). */
export interface YtmLyrics {
  text: string
  source: string
}

/**
 * Letra de la pestaña «Letra» de YouTube Music (la que licencia con Musixmatch o LyricFind): «A continuación» de la
 * canción da el id de esa pestaña (MPLY…) y con él se pide el texto. Null si YouTube Music no la tiene.
 */
export function ytmLyrics(videoId: string): Promise<YtmLyrics | null> {
  return remember(`letra:${videoId}`, async () => {
    const next = await call('next', { videoId, isAudioOnly: true })
    const tabs: Json[] = next?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs ?? []
    const browseId: string | undefined = tabs.map((tab) => tab?.tabRenderer?.endpoint?.browseEndpoint?.browseId).find((id) => id?.startsWith('MPLY'))
    if (!browseId) return null
    const json = await call('browse', { browseId })
    const shelf = json?.contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer
    const text = plain(shelf?.description).trim()
    return text ? { text, source: plain(shelf?.footer).trim() } : null
  })
}

/** Una línea de la letra con el segundo en que empieza. */
export interface TimedLine {
  time: number
  text: string
}

/**
 * Letra CON TIEMPOS de YouTube Music (la que muestra su app de Android, sincronizada con esa misma grabación): la pide
 * como esa app. Null si no la tiene.
 */
export function ytmTimedLyrics(videoId: string): Promise<{ lines: TimedLine[]; source: string } | null> {
  return remember(`letra-tiempos:${videoId}`, async () => {
    const next = await call('next', { videoId }, undefined, ANDROID_CLIENT)
    const browseId = JSON.stringify(next).match(/"(MPLY[^"]+)"/)?.[1]
    if (!browseId) return null
    const json = await call('browse', { browseId }, undefined, ANDROID_CLIENT)
    const data = json?.contents?.elementRenderer?.newElement?.type?.componentType?.model?.timedLyricsModel?.lyricsData
    const lines: TimedLine[] = (data?.timedLyricsData ?? [])
      .map((line: Json) => ({ time: Number(line?.cueRange?.startTimeMilliseconds) / 1000, text: String(line?.lyricLine ?? '') }))
      .filter((line: TimedLine) => Number.isFinite(line.time))
    return lines.length ? { lines, source: String(data?.sourceMessage ?? '') } : null
  })
}

/**
 * El id de una playlist en un enlace de YouTube o YouTube Music («…?list=PL…», «music.youtube.com/browse/VLPL…») o
 * pegado tal cual. Null si no hay. Las mezclas automáticas («Mix», RD…) no son playlists guardadas: también null.
 */
export function playlistIdFrom(text: string): string | null {
  const value = text.trim()
  const id = value.match(/[?&]list=([\w-]+)/)?.[1] ?? value.match(/\/browse\/VL([\w-]+)/)?.[1] ?? (/^(VL)?(PL|OLAK5uy_|RDCLAK)[\w-]{10,}$/.test(value) ? value : null)
  const clean = id?.replace(/^VL/, '') ?? null
  return clean && (!clean.startsWith('RD') || clean.startsWith('RDCLAK')) ? clean : null
}

const IMPORT_MAX = 1000 // canciones como mucho al importar una playlist

/** Una playlist COMPLETA (de a 100, siguiendo las páginas), para importarla. */
export async function ytmPlaylist(playlistId: string): Promise<{ title: string; image?: string; tracks: Track[] }> {
  const json = await call('browse', { browseId: `VL${playlistId}` })
  const two = json?.contents?.twoColumnBrowseResultsRenderer
  const first = two?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]
  const header = first?.musicResponsiveHeaderRenderer ?? first?.musicEditablePlaylistDetailHeaderRenderer?.header?.musicResponsiveHeaderRenderer
  const shelf = two?.secondaryContents?.sectionListRenderer?.contents?.[0]?.musicPlaylistShelfRenderer
  if (!shelf) throw new Error('No se encontró la playlist')
  const tracks: Track[] = []
  // Las canciones de una página y, si hay más, la marca para pedir la siguiente (su último elemento).
  const take = (items: Json[]): string | undefined => {
    tracks.push(...items.map((item) => fromListItem(item?.musicResponsiveListItemRenderer)).filter(notEmpty))
    return items.at(-1)?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
  }
  let token = take(shelf.contents ?? [])
  while (token && tracks.length < IMPORT_MAX) {
    const more = await call('browse', { continuation: token })
    token = take(more?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems ?? [])
  }
  const seen = new Set<string>()
  return {
    title: plain(header?.title) || 'Playlist',
    image: lastThumb(header?.thumbnail?.musicThumbnailRenderer?.thumbnail),
    tracks: tracks.filter((track) => !seen.has(track.id) && !!seen.add(track.id)).slice(0, IMPORT_MAX),
  }
}

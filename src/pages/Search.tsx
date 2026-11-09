import { Capacitor } from '@capacitor/core'
import { AudioWaveform, Search as SearchIcon, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { usePlayer } from '../player/usePlayer'
import { useLibrary } from '../library/store'
import { listening } from '../data/history'
import { Link } from 'react-router'
import { SavePlaylistButton } from '../components/library/SavePlaylistButton'
import { TrackList } from '../components/tracks/TrackList'
import { Cover } from '../components/ui/Cover'
import { YtmCardRow } from '../components/ui/YtmShelf'
import { categories } from '../data/categories'
import { createRadio } from '../data/radio'
import { KeyError, QuotaError, youtubeSearch, youtubeSearchEnabled, type YouTubeResults } from '../data/youtube'
import { ytmSearch, type YtmCard, type YtmSearchResults } from '../data/ytmusic'
import { player } from '../player/engine'
import { NewPipe } from '../player/newPipe'
import type { Track } from '../player/types'
import { useNowPlaying } from '../player/useNowPlaying'

// Música, sin ningún filtro de popularidad (lo que escribes es lo que buscas, aunque tenga pocas vistas):
// 1) YouTube Music (su API interna, ver data/ytmusic.ts): canciones, videos, álbumes, artistas y playlists.
// 2) En la app de Android, a la vez, la búsqueda normal de YouTube con NewPipe: cualquier video (van en «Videos») y las
//    playlists públicas de cualquier usuario (van en «Playlists», después de las de YouTube Music).
// 3) Fuera de Android, si YouTube Music no trae nada y hay clave: la YouTube Data API oficial (data/youtube.ts).
// «Solo populares» (apagado por defecto) deja solo lo que pasa de 1 millón de vistas.
// Si todas las fuentes fallan, se muestra un aviso sin inventar resultados.

interface MusicResults {
  query: string
  songs: Track[]
  videos: Track[] // videos de YouTube (también los de pocas vistas o subidos por usuarios)
  albums: YtmCard[]
  artists: YtmCard[]
  playlists: YtmCard[] // con «+» para guardarlas en Tu biblioteca
  source: 'ytm' | 'api'
  notice: string | null // por qué se usó un respaldo
}

const QUOTA_MESSAGE = 'Se acabaron por hoy las búsquedas en YouTube. Vuelve a intentarlo mañana.'
const POPULAR_VIEWS = 1_000_000 // «Solo populares»
const isAndroid = Capacitor.getPlatform() === 'android'
const isPopular = (track: Track) => (track.viewCount ?? 0) >= POPULAR_VIEWS

function youtubeErrorMessage(error: unknown): string {
  if (error instanceof QuotaError) return QUOTA_MESSAGE
  if (error instanceof KeyError) return error.message
  return 'No se pudo buscar en YouTube. Revisa tu conexión.'
}

const MAX_PLAYLISTS = 24 // en Buscar: las de YouTube Music y, después, las públicas de YouTube

/**
 * Junta YouTube Music y la búsqueda de YouTube, sin repetidas (una canción que ya está en «Canciones» no va en «Videos»;
 * una playlist que ya trajo YouTube Music no se repite).
 */
function combine(query: string, ytm: YtmSearchResults | null, api: YouTubeResults | null, notice: string | null, publicLists: YtmCard[] = []): MusicResults {
  const songs = ytm?.songs.length ? ytm.songs : (api?.songs ?? [])
  const taken = new Set(songs.map((track) => track.id))
  const fromApi = api ? (songs === api.songs ? api.videos : [...api.videos, ...api.songs]) : []
  const videos = [...(ytm?.videos ?? []), ...fromApi].filter((track) => !taken.has(track.id) && !!taken.add(track.id))
  const seenLists = new Set<string>()
  const playlists = [...(ytm?.playlists ?? []), ...publicLists].filter((card) => !seenLists.has(card.id) && !!seenLists.add(card.id)).slice(0, MAX_PLAYLISTS)
  return { query, songs, videos, albums: ytm?.albums ?? [], artists: ytm?.artists ?? [], playlists, source: ytm ? 'ytm' : 'api', notice }
}

/** Playlists públicas de YouTube (NewPipe, solo Android) como tarjetas que abren su página (/ytm/VL…). */
async function publicPlaylists(query: string): Promise<YtmCard[]> {
  if (!isAndroid) return []
  const { results } = await NewPipe.searchPlaylists({ query })
  return results.map((list) => ({
    id: `VL${list.id}`,
    kind: 'playlist' as const,
    title: list.title,
    subtitle: [list.uploader, list.count > 0 ? (list.count === 1 ? '1 canción' : `${list.count} canciones`) : ''].filter(Boolean).join(' • '),
    image: list.image || undefined,
  }))
}

/**
 * Busca en todas las fuentes. La búsqueda explícita del usuario no hereda los filtros de la radio (géneros, vistas).
 * `onPartial`: en Android, lo de YouTube Music se muestra en cuanto llega, sin esperar a NewPipe.
 */
async function searchMusic(query: string, onPartial?: (results: MusicResults) => void): Promise<MusicResults> {
  const youtube = isAndroid ? youtubeSearch(query) : null
  youtube?.catch(() => {}) // el error se lee abajo
  const lists = publicPlaylists(query).catch(() => [] as YtmCard[])
  const ytm = await ytmSearch(query).catch(() => null)
  const empty = !ytm || (!ytm.songs.length && !ytm.videos.length && !ytm.albums.length && !ytm.artists.length && !ytm.playlists.length)
  let api: YouTubeResults | null = null
  let notice: string | null = null
  if (youtube) {
    if (ytm && !empty) onPartial?.(combine(query, ytm, null, null))
    try {
      api = await youtube
    } catch (error) {
      if (empty) notice = youtubeErrorMessage(error)
    }
  } else if (empty && youtubeSearchEnabled) {
    try {
      api = await youtubeSearch(query)
    } catch (error) {
      notice = youtubeErrorMessage(error)
    }
  }
  const found = await lists
  if (!ytm && !api && !found.length) notice ??= 'No se pudo conectar con el catálogo. Revisa tu conexión.'
  return combine(query, ytm, api, notice, found)
}

/** Buscar: canciones, álbumes, artistas y playlists (que se pueden guardar con «+») de YouTube Music, como en Spotify. */
export function Search() {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [music, setMusic] = useState<MusicResults | null>(null)
  const [popularOnly, setPopularOnly] = useState(false) // «Solo populares»: apagado, sale todo
  const { open } = useNowPlaying()
  const playerState = usePlayer()
  const libraryState = useLibrary()

  // Espera a que dejes de escribir antes de buscar.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 400)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    if (!debounced) return
    let alive = true
    searchMusic(debounced, (partial) => alive && setMusic(partial))
      .then((results) => alive && setMusic(results))
      .catch((error) => alive && setMusic({ query: debounced, songs: [], videos: [], albums: [], artists: [], playlists: [], source: 'ytm', notice: youtubeErrorMessage(error) }))
    return () => {
      alive = false
    }
  }, [debounced])

  const q = query.trim()
  const fromMusic = music?.query === q ? music : null
  const searching = !!q && !fromMusic

  const normalize = (value: string) => value.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
  const normalizedQuery = normalize(q)
  const localTracks = q ? [
    playerState.current,
    ...playerState.queue,
    ...playerState.upcoming,
    ...libraryState.favorites,
    ...libraryState.playlists.flatMap((playlist) => playlist.tracks),
    ...listening.entries().map((entry) => entry.track),
  ].filter((track): track is Track => !!track) : []
  const localMatches = [...new Map(localTracks
    .filter((track) => normalizedQuery.length > 0 && `${normalize(track.title)} ${normalize(track.artist)}`.includes(normalizedQuery))
    .map((track) => [track.id, track])).values()]
  const allRemote = [...(fromMusic?.songs ?? []), ...(fromMusic?.videos ?? [])]
  const keep = (track: Track) => !popularOnly || isPopular(track)
  const hidden = popularOnly ? allRemote.filter((track) => !isPopular(track)).length : 0
  const remoteSongs = (fromMusic?.songs ?? []).filter(keep)
  const songs = [...localMatches, ...remoteSongs.filter((track) => !localMatches.some((local) => local.id === track.id))]
  const videos = (fromMusic?.videos ?? []).filter(keep).filter((track) => !localMatches.some((local) => local.id === track.id))
  const results = [...songs, ...videos] // en este orden sigue sonando al terminar cada una

  // Suena la elegida y después su radio (mismo artista y mismo género o parecido; ver data/radio.ts). Antes seguían los
  // demás resultados de la búsqueda, que solo comparten palabras con lo que escribiste (covers, otras canciones).
  const play = (index: number) => {
    const track = results[index]
    if (!track) return
    open() // primero «Sonando ahora», así el video aparece ya en su sitio
    player.playRadio(`Radio de «${track.title}»`, track, createRadio(track))
  }

  const lists = [
    { title: 'Canciones', tracks: songs, offset: 0 },
    { title: 'Videos', tracks: videos, offset: songs.length },
  ]
  const nothing = !searching && results.length === 0 && !fromMusic?.albums.length && !fromMusic?.artists.length && !fromMusic?.playlists.length

  return (
    <div className="pt-6 pb-10">
      <div className="px-4 md:px-6">
        <h1 className="text-2xl font-bold md:text-3xl">Buscar</h1>
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault() // Enter busca sin esperar
            setDebounced(q)
          }}
        >
          <label className="relative mt-4 block max-w-xl">
            <span className="sr-only">Buscar canciones, álbumes o artistas</span>
            <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-texto-sec" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="¿Qué quieres escuchar?"
              enterKeyHint="search"
              className="h-12 w-full rounded-full bg-tarjeta pr-11 pl-12 text-texto ring-1 ring-contraste/10 outline-none placeholder:text-texto-sec focus:ring-2 focus:ring-acento [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                aria-label="Borrar búsqueda"
                onClick={() => setQuery('')}
                className="absolute top-1/2 right-3 grid size-7 -translate-y-1/2 place-items-center rounded-full text-texto-sec hover:text-texto"
              >
                <X className="size-4" />
              </button>
            )}
          </label>
        </form>
        <div className="mt-2 flex max-w-xl items-center justify-between gap-3">
          <p className="min-w-0 text-xs text-texto-sec">Canciones, videos, álbumes, artistas y playlists.</p>
          {/* Sin filtro de vistas por defecto: solo si lo pides. */}
          <button
            type="button"
            aria-pressed={popularOnly}
            onClick={() => setPopularOnly((on) => !on)}
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold transition-colors ${popularOnly ? 'bg-acento text-white' : 'bg-contraste/10 text-texto hover:bg-contraste/15'}`}
          >
            {popularOnly ? '✓ ' : ''}Solo populares
          </button>
        </div>
      </div>

      {q ? (
        <div className="mt-2">
          {lists.slice(0, 1).map(({ title, tracks, offset }) => tracks.length > 0 && <ResultList key={title} title={title} tracks={tracks} onPlay={(i) => play(offset + i)} />)}
          {!!fromMusic?.artists.length && (
            <section aria-label="Artistas" className="mt-4">
              <ListTitle title="Artistas" />
              <YtmCardRow cards={fromMusic.artists} />
            </section>
          )}
          {!!fromMusic?.albums.length && (
            <section aria-label="Álbumes" className="mt-4">
              <ListTitle title="Álbumes" />
              <YtmCardRow cards={fromMusic.albums} />
            </section>
          )}
          {!!fromMusic?.playlists.length && (
            <section aria-label="Playlists" className="mt-4">
              <ListTitle title="Playlists" />
              <PlaylistResults cards={fromMusic.playlists} />
            </section>
          )}
          {lists.slice(1).map(({ title, tracks, offset }) => tracks.length > 0 && <ResultList key={title} title={title} tracks={tracks} onPlay={(i) => play(offset + i)} />)}
          <div className="mt-3 space-y-1 px-4 text-sm text-texto-sec md:px-6">
            {searching && <p>Buscando…</p>}
            {fromMusic?.notice && <p role="status">{fromMusic.notice}</p>}
            {hidden > 0 && <p>Solo populares (más de 1 millón de vistas): {hidden === 1 ? 'se ocultó 1 resultado' : `se ocultaron ${hidden} resultados`}.</p>}
          </div>
          {nothing && <p className="mt-6 px-4 text-texto-sec md:px-6">No encontramos «{q}».</p>}
        </div>
      ) : (
        <div className="px-4 md:px-6">
          <h2 className="mt-8 mb-4 text-xl font-bold">Explorar todo</h2>
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {categories.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setQuery(c.name)}
                  className="relative h-28 w-full overflow-hidden rounded-lg p-4 text-left text-lg font-bold text-white transition hover:brightness-110"
                  style={{ backgroundColor: c.color }}
                >
                  {c.name}
                  <AudioWaveform className="absolute -right-3 -bottom-3 size-20 rotate-[25deg] text-white/25" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function ListTitle({ title }: { title: string }) {
  return <h2 className="px-4 pb-1 text-lg font-bold md:px-6">{title}</h2>
}

/** Playlists encontradas: tocarla abre su página; «+» la guarda en Tu biblioteca («Playlists guardadas»). */
function PlaylistResults({ cards }: { cards: readonly YtmCard[] }) {
  return (
    <ul className="px-2 md:px-4">
      {cards.map((card) => (
        <li key={card.id} className="flex items-center gap-2 pr-2">
          <Link to={`/ytm/${encodeURIComponent(card.id)}`} className="flex h-16 min-w-0 flex-1 items-center gap-3 rounded-md pl-2 hover:bg-tarjeta md:pl-4">
            <Cover seed={card.id} src={card.image} className="size-12 shrink-0 rounded" />
            <span className="min-w-0">
              <span className="block truncate">{card.title}</span>
              <span className="block truncate text-sm text-texto-sec">{card.subtitle || 'Playlist'}</span>
            </span>
          </Link>
          <SavePlaylistButton playlist={{ id: card.id, title: card.title, subtitle: card.subtitle, image: card.image }} />
        </li>
      ))}
    </ul>
  )
}

function ResultList({ title, tracks, onPlay }: { title: string; tracks: Track[]; onPlay: (index: number) => void }) {
  return (
    <section aria-label={title} className="mt-4">
      <ListTitle title={title} />
      <TrackList tracks={tracks} numbered={false} onPlay={onPlay} />
    </section>
  )
}

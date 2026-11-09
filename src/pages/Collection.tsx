import { ChevronLeft, Shuffle } from 'lucide-react'
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ImportButton, ImportPlaylistDialog } from '../components/library/ImportPlaylistDialog'
import { playlistCover } from '../components/library/LibraryList'
import { DownloadListButton } from '../components/offline/Downloads'
import { TrackList } from '../components/tracks/TrackList'
import type { RemoveAction } from '../components/tracks/trackActions'
import { Cover } from '../components/ui/Cover'
import { IconButton } from '../components/ui/IconButton'
import { FavoritesCover, TopCover } from '../components/ui/LibraryItem'
import { PlayButton } from '../components/ui/PlayButton'
import { listening } from '../data/history'
import { library, useLibrary } from '../library/store'
import { player } from '../player/engine'
import { coverSources, type Track } from '../player/types'
import { useNowPlaying } from '../player/useNowPlaying'

interface CollectionData {
  kind: string
  name: string
  note?: string // debajo del nombre, en vez de «N canciones»
  cover: ReactNode
  tracks: readonly Track[]
  removeAction?: (index: number) => RemoveAction
  empty?: string // qué decir si no tiene canciones
  swipe?: 'cola' // «Tu Top 50»: izquierda = a continuación, derecha = quitar (las demás: izquierda = a la cola, derecha = ⋮)
}

/** Vista de una lista guardada, «Tus me gusta» o una playlist tuya. */
export function Collection() {
  const { tipo = '', id = '' } = useParams()
  const navigate = useNavigate()
  const { favorites, playlists } = useLibrary()
  const { open } = useNowPlaying()
  const [importing, setImporting] = useState(false)
  useSyncExternalStore(listening.subscribe, listening.entries) // «Tu Top 50» cambia al quitar una o al escuchar más
  const data = resolve(tipo, id, favorites, playlists)

  if (!data) {
    return (
      <div className="p-8 text-center text-texto-sec">
        Esta lista ya no existe.
        <button type="button" onClick={() => navigate('/biblioteca')} className="ml-1 text-acento-texto hover:underline">
          Ir a Tu biblioteca
        </button>
      </div>
    )
  }

  const count = data.tracks.length
  // Reproducir abre «Sonando ahora» en pantalla completa (antes de reproducir: así el video aparece ya en su sitio).
  const play = (index = 0) => {
    open()
    player.playContext(data.name, data.tracks, index)
  }
  const shuffle = () => {
    open()
    player.shuffleContext(data.name, data.tracks)
  }
  return (
    <div className="pb-10">
      <header className="bg-linear-to-b from-acento/35 to-transparent px-4 pt-4 pb-4 md:px-6">
        <IconButton label="Volver" onClick={() => navigate(-1)} className="-ml-2">
          <ChevronLeft className="size-6" />
        </IconButton>
        <div className="mt-2 flex flex-col items-center gap-4 text-center md:flex-row md:items-end md:text-left">
          {data.cover}
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-wider text-texto-sec uppercase">{data.kind}</p>
            <h1 className="mt-1 text-3xl font-bold break-words md:text-5xl">{data.name}</h1>
            <p className="mt-2 text-sm text-texto-sec">{data.note ?? (count === 1 ? '1 canción' : `${count} canciones`)}</p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <PlayButton label={`Reproducir ${data.name}`} onClick={() => play()} className={count ? '' : 'pointer-events-none opacity-40'} />
          <IconButton label={`Reproducir ${data.name} en aleatorio`} disabled={!count} onClick={shuffle}>
            <Shuffle className="size-6" />
          </IconButton>
          {/* En «Tus me gusta»: traer las canciones de una playlist de YouTube. */}
          {tipo === 'favoritos' && <ImportButton onClick={() => setImporting(true)} />}
          {/* Descargar toda la lista para escuchar sin conexión (Android). */}
          <DownloadListButton tracks={data.tracks} name={data.name} />
        </div>
      </header>

      {count === 0 ? (
        <p className="px-6 text-texto-sec">{data.empty ?? 'Todavía no hay canciones. Usa el menú ⋮ de cualquier canción para agregarlas.'}</p>
      ) : (
        <TrackList tracks={data.tracks} onPlay={play} removeAction={data.removeAction} swipe={data.swipe} downloads />
      )}
      {/* Abierto desde «Tus me gusta»: la casilla de agregar también ahí viene marcada. */}
      {importing && <ImportPlaylistDialog toFavorites onClose={() => setImporting(false)} />}
    </div>
  )
}

function resolve(tipo: string, id: string, favorites: Track[], playlists: ReturnType<typeof library.get>['playlists']): CollectionData | null {
  const bigCover = 'size-44 shrink-0 rounded-md shadow-2xl shadow-black/50 md:size-52'
  if (tipo === 'favoritos') {
    return {
      kind: 'Playlist',
      name: 'Tus me gusta',
      cover: <FavoritesCover className={bigCover} />,
      tracks: favorites,
      removeAction: (i) => ({ listName: 'Tus me gusta', remove: () => library.removeFavoriteAt(i) }),
    }
  }
  if (tipo === 'top') {
    const top = listening.top(50)
    return {
      kind: 'Playlist',
      name: 'Tu Top 50',
      note: top.length ? `Las ${top.length} que más escuchaste aquí, de más a menos` : undefined,
      cover: <TopCover className={bigCover} />,
      tracks: top.map((entry) => entry.track),
      // Quitarla olvida sus reproducciones (con Deshacer): si la vuelves a escuchar mucho, vuelve.
      removeAction: (i) => ({ listName: 'Tu Top 50', remove: () => listening.forgetPlays(top[i].track.id) }),
      swipe: 'cola',
      empty: 'Todavía no hay canciones en tu Top: cuentan las que escuchas 30 segundos o más.',
    }
  }
  if (tipo === 'playlist') {
    const playlist = playlists.find((p) => p.id === id)
    if (!playlist) return null
    const first = playlist.tracks[0]
    return {
      kind: playlist.source ? 'Playlist importada de YouTube' : 'Playlist',
      name: playlist.name,
      cover: <Cover seed={playlist.id} src={playlistCover(playlist.image, first ? coverSources(first, 'large') : [])} className={bigCover} />,
      tracks: playlist.tracks,
      removeAction: (i) => ({ listName: playlist.name, remove: () => library.removeFromPlaylistAt(playlist.id, i) }),
    }
  }
  return null
}

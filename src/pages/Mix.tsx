import { ChevronLeft, Shuffle } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { playlistCover } from '../components/library/LibraryList'
import { Cover } from '../components/ui/Cover'
import { IconButton } from '../components/ui/IconButton'
import { FavoritesCover, MixCover, TopCover } from '../components/ui/LibraryItem'
import { listening } from '../data/history'
import { unique } from '../data/lists'
import { savedTracks } from '../library/savedPlaylists'
import { useLibrary } from '../library/store'
import { player } from '../player/engine'
import { coverSources, type Track } from '../player/types'
import { useNowPlaying } from '../player/useNowPlaying'

const SELECTION_KEY = 'soundblue:mix-seleccion' // las playlists que elegiste la última vez (en este navegador)
const MIX_NAME = 'Mix personalizado'

/** Una playlist de Tu biblioteca para el mix. `tracks`: undefined mientras se leen; null si nunca se leyeron (guardada sin abrir). */
interface MixSource {
  id: string
  title: string
  kind: string
  cover: ReactNode
  tracks: readonly Track[] | null | undefined
}

const count = (n: number) => (n === 1 ? '1 canción' : `${n} canciones`)

function readSelection(): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? '[]')
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveSelection(ids: ReadonlySet<string>) {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify([...ids]))
  } catch {
    /* almacenamiento bloqueado: la selección vale mientras la página esté abierta */
  }
}

/**
 * «Modo Mix Personalizado» (desde Tu biblioteca): eliges una o varias de tus playlists (Tus me gusta, Tu Top 50, las tuyas
 * y las de YouTube que guardaste) y «Reproducir Mix» pone en la cola SOLO sus canciones (sin repetidas), en aleatorio. No
 * busca nada nuevo en YouTube: la lista es cerrada (engine `closed`), así que ni la Fila Dinámica ni el reproductor nativo
 * agregan otras canciones al acabarse. La selección se recuerda para la próxima vez.
 */
export function MixPage() {
  const navigate = useNavigate()
  const { open } = useNowPlaying()
  const { favorites, playlists, saved } = useLibrary()
  useSyncExternalStore(listening.subscribe, listening.entries) // «Tu Top 50» cambia al escuchar más
  const [chosen, setChosen] = useState<Set<string>>(readSelection)
  const [savedLists, setSavedLists] = useState<Record<string, Track[] | null>>({}) // las guardadas, de IndexedDB

  useEffect(() => {
    let alive = true
    void Promise.all(saved.map(async (playlist) => [playlist.id, await savedTracks(playlist.id)] as const)).then((entries) => {
      if (alive) setSavedLists(Object.fromEntries(entries))
    })
    return () => {
      alive = false
    }
  }, [saved])

  const cover = 'size-12 shrink-0 rounded-md'
  const sources: MixSource[] = [
    { id: 'favoritos', title: 'Tus me gusta', kind: 'Playlist', cover: <FavoritesCover className="size-12" />, tracks: favorites },
    { id: 'top', title: 'Tu Top 50', kind: 'Playlist', cover: <TopCover className="size-12" />, tracks: listening.top(50).map((entry) => entry.track) },
    ...playlists.map((p) => ({
      id: `playlist:${p.id}`,
      title: p.name,
      kind: p.source ? 'Importada de YouTube' : 'Playlist',
      cover: <Cover seed={p.id} src={playlistCover(p.image, p.tracks[0] ? coverSources(p.tracks[0]) : [])} className={cover} />,
      tracks: p.tracks,
    })),
    ...saved.map((p) => ({
      id: `guardada:${p.id}`,
      title: p.title,
      kind: 'Playlist guardada',
      cover: <Cover seed={p.id} src={p.image} className={cover} />,
      tracks: p.id in savedLists ? savedLists[p.id] : undefined,
    })),
  ]
  const usable = sources.filter((source) => !!source.tracks?.length)
  const picked = usable.filter((source) => chosen.has(source.id))
  const mix = unique(picked.flatMap((source) => [...(source.tracks ?? [])]))

  const update = (next: Set<string>) => {
    setChosen(next)
    saveSelection(next)
  }
  const toggle = (id: string) => {
    const next = new Set(chosen)
    if (!next.delete(id)) next.add(id)
    update(next)
  }
  const allPicked = usable.length > 0 && picked.length === usable.length
  const play = () => {
    if (!mix.length) return
    open() // primero «Sonando ahora», así el video aparece ya en su sitio
    // Solo estas canciones, en aleatorio, reemplazando la cola; `closed`: al acabarse no se agrega nada de YouTube.
    player.shuffleContext(MIX_NAME, mix, { replaceQueue: true, closed: true })
  }

  return (
    <div className="pb-10">
      <header className="bg-linear-to-b from-violet-600/60 to-transparent px-4 pt-4 pb-4 md:px-6">
        <IconButton label="Volver" onClick={() => navigate(-1)} className="-ml-2">
          <ChevronLeft className="size-6" />
        </IconButton>
        <div className="mt-2 flex items-end gap-4">
          <MixCover className="size-20" />
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-wider text-texto-sec uppercase">Tu biblioteca</p>
            <h1 className="text-3xl font-bold md:text-5xl">Modo Mix Personalizado</h1>
          </div>
        </div>
        <p className="mt-3 text-sm text-texto-sec">Elige una o varias de tus playlists: suenan solo sus canciones, mezcladas al azar.</p>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            disabled={!mix.length}
            onClick={play}
            className="flex h-12 items-center gap-2 rounded-full bg-acento px-6 font-bold text-white shadow-lg shadow-black/40 transition enabled:hover:scale-105 enabled:hover:bg-acento-hover disabled:opacity-40"
          >
            <Shuffle className="size-5" aria-hidden="true" />
            Reproducir Mix
          </button>
          <p className="text-sm text-texto-sec" aria-live="polite">
            {picked.length ? `${count(mix.length)} de ${picked.length === 1 ? '1 playlist' : `${picked.length} playlists`}` : 'Elige al menos una playlist'}
          </p>
        </div>
      </header>

      <div className="flex items-center justify-between px-4 pt-2 md:px-6">
        <h2 className="text-lg font-bold">Tus playlists</h2>
        {usable.length > 1 && (
          <button
            type="button"
            onClick={() => update(allPicked ? new Set() : new Set(usable.map((source) => source.id)))}
            className="text-sm font-semibold text-acento-texto hover:underline"
          >
            {allPicked ? 'Quitar todas' : 'Elegir todas'}
          </button>
        )}
      </div>
      <ul className="mt-1 px-2 md:px-4">
        {sources.map((source) => {
          const disabled = !source.tracks?.length
          const detail =
            source.tracks === undefined
              ? 'Leyendo…'
              : source.tracks === null
                ? 'Ábrela una vez para poder mezclarla'
                : source.tracks.length
                  ? count(source.tracks.length)
                  : 'Sin canciones'
          return (
            <li key={source.id}>
              <label className={`flex items-center gap-3 rounded-md p-2 transition-colors ${disabled ? 'opacity-50' : 'cursor-pointer hover:bg-tarjeta'}`}>
                <input
                  type="checkbox"
                  checked={!disabled && chosen.has(source.id)}
                  disabled={disabled}
                  onChange={() => toggle(source.id)}
                  className="size-5 shrink-0 accent-acento"
                />
                {source.cover}
                <span className="min-w-0">
                  <span className="block truncate">{source.title}</span>
                  <span className="block truncate text-sm text-texto-sec">
                    {source.kind} · {detail}
                  </span>
                </span>
              </label>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

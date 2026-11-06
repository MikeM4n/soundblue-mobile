import { CloudDownload, Download, LoaderCircle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { importPlaylist } from '../../data/playlistImport'
import { IMPORT_MAX, isPrivateAutoPlaylist, playlistIdFrom } from '../../data/ytmusic'
import { library } from '../../library/store'
import { offlineCache } from '../../player/offlineCache'
import { coverSources, type Track } from '../../player/types'
import { onlyInYouTubeMusic } from '../../player/unavailable'
import { showToast } from '../../ui/toast'
import { Cover } from '../ui/Cover'
import { IconButton } from '../ui/IconButton'

type Found = { title: string; image?: string; tracks: Track[] }

const PREVIEW = 200 // filas que se dibujan en la vista previa

/** «Importar playlist»: en «Tu biblioteca» y en «Tus me gusta». */
export function ImportButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-2 rounded-full bg-contraste/10 px-4 py-2 text-sm font-semibold hover:bg-contraste/15">
      <Download className="size-4" aria-hidden="true" />
      Importar playlist
    </button>
  )
}

/**
 * «Importar playlist» (solo YouTube y YouTube Music): pegas el enlace, se ve qué canciones trae y «Agregar todas a Me
 * gusta». Sirve cualquier playlist pública o no listada, de cualquier usuario: se lee de YouTube Music y, en Android,
 * también con NewPipe (data/playlistImport.ts), hasta 5000 canciones. Las que ya se sabe que no suenan aquí no se
 * agregan. Una playlist privada no se puede leer.
 */
export function ImportPlaylistDialog({ onClose }: { onClose: () => void }) {
  const [link, setLink] = useState('')
  const [state, setState] = useState<{ loading: true } | { error: string } | { found: Found } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, []) // solo al abrir

  const search = async (text = link) => {
    const id = playlistIdFrom(text)
    if (!id) {
      setState({ error: 'Pega el enlace de una playlist de YouTube o YouTube Music (el que lleva «list=…»). Las mezclas automáticas («Mix») no se pueden importar.' })
      return
    }
    if (isPrivateAutoPlaylist(id)) {
      setState({ error: 'Esa lista es privada de tu cuenta («Tus me gusta», «Ver más tarde»): YouTube no deja leerla. Crea una playlist pública o no listada con esas canciones y pega su enlace.' })
      return
    }
    setState({ loading: true })
    try {
      const found = await importPlaylist(id)
      const tracks = found.tracks.filter((track) => !onlyInYouTubeMusic.has(track.id))
      setState(tracks.length ? { found: { ...found, tracks } } : { error: 'Esa playlist no tiene canciones que se puedan escuchar aquí.' })
    } catch {
      setState({ error: navigator.onLine ? 'No se pudo abrir esa playlist. Revisa que sea pública o «no listada» (las privadas no se pueden leer).' : 'Sin conexión. Inténtalo de nuevo.' })
    }
  }

  const addAll = (found: Found) => {
    const { added, undo } = library.addFavorites(found.tracks)
    const already = found.tracks.length - added
    showToast(
      added ? `${added === 1 ? '1 canción agregada' : `${added} canciones agregadas`} a Tus me gusta${already ? ` (${already} ya estaban)` : ''}` : 'Todas ya estaban en Tus me gusta',
      added ? { label: 'Deshacer', run: undo } : undefined,
    )
    onClose()
  }

  // «Agregar y descargar»: a Tus me gusta y, además, a las descargas (para escuchar sin conexión).
  const addAndDownload = (found: Found) => {
    const { added, undo } = library.addFavorites(found.tracks)
    offlineCache.download(found.tracks)
    const status = offlineCache.get()
    const wait = !status.online ? ' (cuando vuelva internet)' : status.wifiOnly && !status.wifi ? ' (al conectarte a Wi-Fi)' : ''
    showToast(
      `${added ? `${added === 1 ? '1 canción agregada' : `${added} canciones agregadas`} a Tus me gusta` : 'Ya estaban en Tus me gusta'} · se descargan${wait}`,
      added ? { label: 'Deshacer', run: undo } : undefined,
      5000,
    )
    onClose()
  }

  const found = state && 'found' in state ? state.found : null
  return createPortal(
    // flex (no grid): con grid, los títulos largos de la lista ensanchaban el diálogo más que la pantalla.
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="importar-titulo"
        className="flex max-h-[85dvh] w-full max-w-md min-w-0 flex-col rounded-xl bg-panel p-4 shadow-2xl ring-1 ring-contraste/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id="importar-titulo" className="text-lg font-bold">
            Importar playlist
          </h2>
          <IconButton label="Cerrar" onClick={onClose}>
            <X className="size-5" />
          </IconButton>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void search()
          }}
          className="flex gap-2"
        >
          <label className="sr-only" htmlFor="importar-enlace">
            Enlace de la playlist de YouTube o YouTube Music
          </label>
          <input
            id="importar-enlace"
            ref={inputRef}
            value={link}
            inputMode="url"
            onChange={(e) => setLink(e.target.value)}
            // Al pegar, se busca enseguida.
            onPaste={(e) => {
              const text = e.clipboardData.getData('text')
              if (playlistIdFrom(text)) window.setTimeout(() => void search(text), 0)
            }}
            placeholder="Pega el enlace de YouTube o YouTube Music"
            className="h-10 min-w-0 flex-1 rounded-md bg-tarjeta px-3 text-texto ring-1 ring-contraste/10 outline-none placeholder:text-texto-sec focus:ring-2 focus:ring-acento"
          />
          <button
            type="submit"
            disabled={!link.trim() || (state !== null && 'loading' in state)}
            className="h-10 shrink-0 rounded-md bg-contraste/10 px-3 text-sm font-semibold enabled:hover:bg-contraste/15 disabled:opacity-40"
          >
            Buscar
          </button>
        </form>
        <p className="mt-2 text-xs text-texto-sec">En YouTube o YouTube Music: Compartir → Copiar vínculo. Solo playlists de YouTube.</p>

        {state && 'loading' in state && (
          <p className="mt-4 flex items-center gap-2 text-sm text-texto-sec">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            Leyendo la playlist… (las grandes tardan unos segundos)
          </p>
        )}
        {state && 'error' in state && (
          <p role="alert" className="mt-4 text-sm text-red-300">
            {state.error}
          </p>
        )}
        {found && (
          <>
            <div className="mt-4 flex items-center gap-3">
              <Cover seed={found.title} src={found.image ?? (found.tracks[0] && coverSources(found.tracks[0]))} className="size-14 shrink-0 rounded" />
              <div className="min-w-0">
                <p className="truncate font-bold">{found.title}</p>
                <p className="text-sm text-texto-sec">
                  {found.tracks.length === 1 ? '1 canción' : `${found.tracks.length} canciones`}
                  {found.tracks.length >= IMPORT_MAX && ` (el máximo: ${IMPORT_MAX})`}
                </p>
              </div>
            </div>
            <ol aria-label="Canciones de la playlist" className="scroll-fino mt-3 min-h-0 flex-1 overflow-y-auto">
              {/* Se ven las primeras 200 (dibujar miles de filas trabaría el teléfono); se agregan todas. */}
              {found.tracks.slice(0, PREVIEW).map((track) => (
                <li key={track.id} className="flex items-center gap-3 py-1.5">
                  <Cover seed={track.id} src={coverSources(track)} className="size-10 shrink-0 rounded" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{track.title}</span>
                    <span className="block truncate text-xs text-texto-sec">{track.artist}</span>
                  </span>
                </li>
              ))}
              {found.tracks.length > PREVIEW && <li className="py-2 text-sm text-texto-sec">…y {found.tracks.length - PREVIEW} más</li>}
            </ol>
            <button
              type="button"
              onClick={() => addAll(found)}
              className="mt-3 h-12 shrink-0 rounded-full bg-acento px-6 font-bold text-white shadow-lg shadow-acento/30 hover:bg-acento-hover"
            >
              Agregar todas a Me gusta
            </button>
            {/* También descargarlas para escuchar sin conexión (Android). */}
            {offlineCache.enabled && (
              <button
                type="button"
                onClick={() => addAndDownload(found)}
                className="mt-2 inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-contraste/10 px-6 text-sm font-semibold hover:bg-contraste/15"
              >
                <CloudDownload className="size-4" aria-hidden="true" />
                Agregar y descargar
              </button>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

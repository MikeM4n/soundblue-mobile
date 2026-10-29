import { AudioLines, EllipsisVertical, ListEnd, ListStart, Trash, X } from 'lucide-react'
import { useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { formatDuration } from '../../lib/format'
import { coverSources, type Track } from '../../player/types'
import { onlyInYouTubeMusic } from '../../player/unavailable'
import { Cover } from '../ui/Cover'
import { TrackMenu } from './TrackMenu'
import { addToSiguientes, playNext, removeWithUndo, type RemoveAction } from './trackActions'
import { useSwipe } from './useSwipe'

const SNAP_BACK_MS = 200 // lo que tarda la fila en volver a su lugar: el menú se abre después, junto a su «⋮»

export interface TrackRowProps {
  track: Track
  onPlay: () => void
  position?: number // número a la izquierda (listas con encabezado)
  isCurrent?: boolean
  isPlaying?: boolean
  duration?: number
  removeAction?: RemoveAction // «Eliminar de…» / «Quitar de la cola» en el menú
  trailing?: ReactNode // p. ej. el asa para reordenar en la cola
  style?: CSSProperties
  // 'lista' (Buscar, playlists, álbumes, modos…): izquierda la agrega al final de la cola, derecha abre el
  // menú «⋮». 'cola' («En Cola»): izquierda la pone a sonar a continuación, derecha la quita (`removeAction`).
  // 'sugerencia' («Recomendadas», «Por Descubrir»): izquierda la agrega a la cola, derecha la descarta (`removeAction`).
  swipe?: 'lista' | 'cola' | 'sugerencia'
  // Sin gestos de deslizar (carruseles de Inicio): deslizar de lado mueve el carrusel. Queda el ▶ y el menú «⋮».
  plain?: boolean
}

/**
 * Fila de canción como en Spotify: portada pequeña, título, artista y menú «⋮» (Reproducir, Agregar a la cola, Me
 * gusta…). En el celular, deslizar a la IZQUIERDA es la acción rápida y nunca abre un menú (en las listas y las
 * recomendaciones, agregar a la cola; en «En Cola», que suene a continuación). A la DERECHA: en «Próximas en
 * sonar» la quita de la cola o descarta la recomendación (con «Deshacer»); en las listas abre el menú. Tocar «⋮» siempre
 * abre el menú.
 */
export function TrackRow({ track, onPlay, position, isCurrent, isPlaying, duration, removeAction, trailing, style, swipe: mode = 'lista', plain = false }: TrackRowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const openMenu = () => window.setTimeout(() => setMenuOpen(true), SNAP_BACK_MS)
  const inQueue = mode === 'cola'
  const removes = mode !== 'lista' // a la derecha quita (cola) o descarta (recomendación): nunca abre el menú
  // A la derecha solo si se puede quitar (la que suena no).
  const onRight = removes ? removeAction && (() => removeWithUndo(removeAction)) : openMenu
  const swipe = useSwipe(plain ? {} : { onLeft: () => (inQueue ? playNext(track) : addToSiguientes(track)), onRight })
  const shownDuration = duration ?? track.duration
  // YouTube no deja reproducirla fuera de sus apps: se avisa antes de tocarla (al tocarla se ofrece abrirla allá).
  const onlyInYtm = useSyncExternalStore(onlyInYouTubeMusic.subscribe, onlyInYouTubeMusic.get).has(track.id)
  const grow = `size-6 transition-transform ${swipe.armed ? 'scale-125' : ''}`
  // Ya se sabe que YouTube no la deja reproducir aquí (falló ella y sus otras versiones): no se muestra en ninguna lista.
  // Solo queda a la vista si es la que está sonando (con su aviso en «Sonando ahora»).
  if (onlyInYtm && !isCurrent) return null

  return (
    <li data-id={track.id} className="relative overflow-hidden rounded-md" style={style}>
      {/* Fondo que aparece mientras se desliza: lo que pasa al soltar */}
      {swipe.dx < 0 && (
        <div className="absolute inset-0 flex items-center justify-end gap-2 bg-acento pr-5 text-sm font-semibold text-white">
          {inQueue ? (
            <>
              <span>A continuación</span>
              <ListStart className={grow} aria-hidden="true" />
            </>
          ) : (
            <>
              <span>A la cola</span>
              <ListEnd className={grow} aria-hidden="true" />
            </>
          )}
        </div>
      )}
      {swipe.dx > 0 &&
        (removes ? (
          <div className="absolute inset-0 flex items-center justify-start gap-2 bg-red-600 pl-5 text-sm font-semibold text-white">
            {inQueue ? <Trash className={grow} aria-hidden="true" /> : <X className={grow} aria-hidden="true" />}
            <span>{inQueue ? 'Quitar' : 'Descartar'}</span>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-start gap-2 bg-tarjeta-claro pl-5 text-sm font-semibold text-texto">
            <EllipsisVertical className={grow} aria-hidden="true" />
            <span>Opciones</span>
          </div>
        ))}

      <div
        ref={swipe.ref}
        {...swipe.handlers}
        className={`group relative flex h-16 items-center gap-3 bg-panel pr-1 pl-2 select-none hover:bg-tarjeta md:pl-4 ${plain ? '' : 'touch-pan-y'}`}
        style={{ transform: `translateX(${swipe.dx}px)`, transition: swipe.active ? 'none' : 'transform 200ms ease-out' }}
      >
        {position !== undefined && (
          <span className="hidden w-6 shrink-0 text-center text-texto-sec tabular-nums md:block" aria-hidden="true">
            {isPlaying ? <AudioLines className="mx-auto size-4 text-acento-texto" /> : <span className={isCurrent ? 'text-acento-texto' : ''}>{position}</span>}
          </span>
        )}
        <button type="button" onClick={onPlay} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label={`Reproducir ${track.title}, de ${track.artist}`}>
          <Cover seed={track.id} src={coverSources(track)} className="size-12 shrink-0 rounded" />
          <span className="min-w-0">
            <span className={`flex items-center gap-1.5 truncate ${isCurrent ? 'text-acento-texto' : 'text-texto'}`}>
              {isPlaying && <AudioLines className="size-3.5 shrink-0 md:hidden" aria-hidden="true" />}
              <span className="truncate">{track.title}</span>
            </span>
            <span className="flex items-center gap-1.5 text-sm text-texto-sec">
              {/* Solo se marca la que no suena aquí (al tocarla se ofrece abrirla en la app de YouTube Music). */}
              {onlyInYtm && (
                <span className="shrink-0 rounded bg-red-500/20 px-1 text-[10px] leading-4 font-semibold tracking-wide text-red-200 uppercase">No disponible aquí</span>
              )}
              <span className="truncate">
                {track.artist}
                {track.album && ` · ${track.album}`}
              </span>
            </span>
          </span>
        </button>
        {shownDuration ? <span className="hidden w-12 shrink-0 text-right text-sm text-texto-sec tabular-nums md:block">{formatDuration(shownDuration)}</span> : null}
        <TrackMenu track={track} removeAction={removeAction} onPlay={onPlay} open={menuOpen} onOpenChange={setMenuOpen} />
        {trailing}
      </div>
    </li>
  )
}

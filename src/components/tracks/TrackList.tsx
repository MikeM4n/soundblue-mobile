import { Clock3 } from 'lucide-react'
import type { Track } from '../../player/types'
import { usePlayer } from '../../player/usePlayer'
import type { RemoveAction } from './trackActions'
import { TrackRow } from './TrackRow'

interface TrackListProps {
  tracks: readonly Track[]
  onPlay: (index: number) => void
  removeAction?: (index: number) => RemoveAction // si la lista permite eliminar (playlist propia, favoritos)
  numbered?: boolean // encabezado y números, como un álbum o playlist
  plain?: boolean // sin gestos de deslizar (carruseles de Inicio): ver TrackRow
  swipe?: 'lista' | 'cola' // 'cola' («Tu Top 50»): izquierda = a continuación, derecha = quitar (ver TrackRow)
  downloads?: boolean // lista con «Descargar»: cada fila muestra si está descargada, en camino o no (ver TrackRow)
}

/** Lista de canciones con gestos y menú. Marca la que está sonando. */
export function TrackList({ tracks, onPlay, removeAction, numbered = true, plain = false, swipe, downloads = false }: TrackListProps) {
  const { current, status, durations } = usePlayer()
  const playing = status === 'playing' || status === 'buffering' || status === 'loading'
  const keys = stableKeys(tracks)

  return (
    <div className="px-2 md:px-4">
      {numbered && (
        <div className="hidden items-center gap-3 border-b border-contraste/10 pr-1 pb-2 pl-4 text-sm text-texto-sec md:flex">
          <span className="w-6 text-center">#</span>
          <span className="flex-1">Título</span>
          <Clock3 className="mr-[2.75rem] size-4" aria-label="Duración" />
        </div>
      )}
      <ol className="mt-1">
        {tracks.map((track, i) => (
          <TrackRow
            key={keys[i]}
            track={track}
            position={numbered ? i + 1 : undefined}
            isCurrent={current?.id === track.id}
            isPlaying={playing && current?.id === track.id}
            duration={durations[track.id]}
            onPlay={() => onPlay(i)}
            removeAction={removeAction?.(i)}
            plain={plain}
            swipe={swipe}
            downloads={downloads}
          />
        ))}
      </ol>
    </div>
  )
}

/** Claves estables aunque una canción se repita (id + número de aparición). */
export function stableKeys(tracks: readonly Track[]): string[] {
  const seen = new Map<string, number>()
  return tracks.map((t) => {
    const n = seen.get(t.id) ?? 0
    seen.set(t.id, n + 1)
    return `${t.id}#${n}`
  })
}

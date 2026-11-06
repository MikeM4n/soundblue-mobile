import { CircleCheck, Cloud, CloudDownload, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { offlineCache, useDownloadState, useListDownload, type DownloadState } from '../../player/offlineCache'
import type { Track } from '../../player/types'
import { showToast } from '../../ui/toast'

/** El ícono de cada estado: ✓ verde (descargada), flecha girando (en camino) o nube vacía (no descargada). */
export function DownloadStateIcon({ state, className = 'size-3.5' }: { state: DownloadState; className?: string }) {
  if (state === 'done') return <CircleCheck className={`${className} shrink-0 text-green-500`} aria-label="Descargada" />
  if (state === 'pending') return <RefreshCw className={`${className} shrink-0 animate-spin text-acento-texto`} aria-label="Descargando" />
  return <Cloud className={`${className} shrink-0 text-texto-sec/70`} aria-label="No descargada" />
}

/**
 * Estado de descarga en la fila de una canción. `full` (listas con «Descargar»): los tres estados. Si no (Buscar,
 * Inicio…), solo el ✓ de las descargadas. Fuera de la app de Android no se muestra.
 */
export function DownloadBadge({ id, full }: { id: string; full: boolean }) {
  const state = useDownloadState(id)
  if (!offlineCache.enabled || (!full && state !== 'done')) return null
  return <DownloadStateIcon state={state} />
}

/**
 * «Descargar» en la cabecera de una lista (Tus me gusta, tus playlists, cualquier playlist o álbum de YouTube):
 *  - Faltan: las descarga todas (`load`: para traer primero la lista completa, p. ej. una playlist de YouTube que solo
 *    muestra sus primeras 100).
 *  - Descargando: muestra cuántas van; tocarlo cancela las que faltan.
 *  - Todas descargadas: ✓ verde; tocarlo pregunta si quitar las descargas de la lista.
 */
export function DownloadListButton({ tracks, name, load }: { tracks: readonly Track[]; name: string; load?: () => Promise<readonly Track[]> }) {
  // La lista completa, si hubo que traerla (`load`): desde ahí cuenta, cancela y quita sobre TODAS, no solo las visibles.
  const [full, setFull] = useState<readonly Track[] | null>(null)
  const list = full ?? tracks
  const { done, pending, total } = useListDownload(list)
  const [loading, setLoading] = useState(false)
  if (!offlineCache.enabled || !total) return null
  const complete = done === total && !loading
  const busy = pending > 0 || loading

  const onClick = async () => {
    if (loading) return
    if (busy) {
      offlineCache.cancel(list.filter((track) => offlineCache.stateOf(track.id) === 'pending').map((track) => track.id))
      showToast('Descarga cancelada')
      return
    }
    if (complete) {
      if (!window.confirm(`¿Quitar las ${total === 1 ? 'canción descargada' : `${total} canciones descargadas`} de «${name}»? Se podrán volver a descargar.`)) return
      offlineCache.remove(list.map((track) => track.id))
      showToast('Descargas quitadas')
      return
    }
    let wanted = list
    if (load && !full) {
      setLoading(true)
      wanted = await load().catch(() => list)
      setFull(wanted)
      setLoading(false)
    }
    if (!offlineCache.download(wanted)) showToast('Ya está todo descargado o en camino')
  }

  const label = loading ? 'Leyendo la lista…' : busy ? `${done} de ${total}` : complete ? 'Descargada' : done ? `Descargar (${done}/${total})` : 'Descargar'
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      aria-label={busy ? `Cancelar la descarga de ${name} (${done} de ${total})` : complete ? `${name} está descargada: quitar las descargas` : `Descargar ${name} para escuchar sin conexión`}
      className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${complete ? 'bg-green-500/15 text-green-500 hover:bg-green-500/25' : 'bg-contraste/10 hover:bg-contraste/15'}`}
    >
      {busy ? (
        <RefreshCw className="size-4 animate-spin text-acento-texto" aria-hidden="true" />
      ) : complete ? (
        <CircleCheck className="size-4" aria-hidden="true" />
      ) : (
        <CloudDownload className="size-4" aria-hidden="true" />
      )}
      {label}
    </button>
  )
}

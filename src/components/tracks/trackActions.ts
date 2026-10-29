// Acciones sobre una canción, compartidas por el menú «⋮» y los gestos de deslizar.
import { createRadio } from '../../data/radio'
import { library } from '../../library/store'
import { player, type RecsKind } from '../../player/engine'
import { sheetState } from '../../player/stage'
import type { Track } from '../../player/types'
import { showToast } from '../../ui/toast'

/** Cómo quitar una canción de la lista donde aparece (playlist propia, favoritos o cola). */
export interface RemoveAction {
  listName: string // para el aviso y el menú: «Eliminada de …», «Eliminar de …»
  remove: () => () => void // quita y devuelve la función para deshacer
  notice?: string // otro aviso («Descartada»: en «Recomendadas» y «Por Descubrir»)
}

/** Al final de «Siguiente en la cola» (deslizar a la izquierda o «Agregar a la cola»). */
export function addToSiguientes(track: Track) {
  const result = player.addToQueue(track)
  showToast(
    result === 'no-disponible'
      ? NOT_HERE
      : result === 'repetida'
        ? 'Ya está en siguientes'
        : result === 'lista'
          ? 'Lista para sonar: toca ▶ para escucharla'
          : 'Agregada a siguientes',
  )
}

const NOT_HERE = 'Esta canción no está disponible aquí (YouTube no la deja reproducir fuera de sus apps)'

/** Al principio de la cola: suena justo después de la actual. */
export function playNext(track: Track) {
  const result = player.playNext(track)
  showToast(
    result === 'no-disponible' ? NOT_HERE : result === 'repetida' ? 'Ya está sonando' : result === 'lista' ? 'Lista para sonar: toca ▶ para escucharla' : 'Sonará a continuación',
  )
}

export function removeFromQueue(track: Track) {
  const undo = player.removeFromQueue(track.id)
  if (undo) showToast('Quitada de la cola', { label: 'Deshacer', run: undo })
}

export function toggleFavorite(track: Track) {
  const added = library.toggleFavorite(track)
  showToast(added ? 'Agregada a Tus me gusta' : 'Quitada de Tus me gusta')
}

/**
 * «Iniciar radio»: suena la canción y la cola se va llenando con el mismo artista y el mismo género o uno parecido, de
 * cualquier año (ver data/radio.ts). `open` abre «Sonando ahora» (si ya está abierta, no se vuelve a abrir).
 */
export function startRadio(track: Track, open: () => void) {
  if (sheetState.get() !== 'open') open()
  player.playRadio(`Radio de «${track.title}»`, track, createRadio(track))
}

/** Deslizar a la derecha / «Eliminar de…»: quita y ofrece «Deshacer» durante 4 s. */
export function removeWithUndo(action: RemoveAction) {
  const undo = action.remove()
  showToast(action.notice ?? `Eliminada de ${action.listName}`, { label: 'Deshacer', run: undo })
}

/** «Reproducir a continuación» de «Recomendadas» o «Por Descubrir»: todas, justo después de la que suena. */
export function playRecommendationsNext(kind: RecsKind) {
  const count = player.playRecommendationsNext(kind)
  if (count) showToast(count === 1 ? 'Sonará a continuación' : `${count} canciones sonarán a continuación`)
}

/**
 * Vibración muy corta (Android): al soltar un gesto de deslizar (agregar a la cola, quitar…) y al dar ▶ o ⏸. En iPhone
 * no existe y no pasa nada.
 */
export function vibrate() {
  try {
    navigator.vibrate?.(10)
  } catch {
    /* sin vibración */
  }
}

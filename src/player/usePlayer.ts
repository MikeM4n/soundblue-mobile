import { useSyncExternalStore } from 'react'
import { player } from './engine'

/** Estado del reproductor para los componentes; se vuelve a dibujar cuando cambia. */
export function usePlayer() {
  return useSyncExternalStore(player.subscribe, player.getSnapshot)
}

/** Segundos de la canción, 4 veces por segundo mientras suena: para la barra de progreso y la letra. */
export function usePlaybackTime() {
  return useSyncExternalStore(player.subscribeTime, player.getTimeSnapshot)
}

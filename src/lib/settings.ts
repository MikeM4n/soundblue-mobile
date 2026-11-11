// Ajustes de la app, guardados en este navegador.
import { useSyncExternalStore } from 'react'
import { youtubeView } from '../player/stage'

const KEY = 'soundblue:ajustes'

/** Tema: el del teléfono (por defecto), claro u oscuro (AMOLED). Ver src/lib/theme.ts. */
export type ThemeChoice = 'sistema' | 'claro' | 'oscuro'

export interface Settings {
  hideViewToggle: boolean // ocultar «Canción | Letra» en «Sonando ahora» (queda siempre la carátula)
  dynamicQueue: boolean // Fila Dinámica: la cola nunca baja de 10 (pasan canciones de «Recomendadas»)
  // Transición suave: los últimos 10 s de cada canción se mezclan con el inicio de la siguiente (lo hace el reproductor
  // nativo de Android, también con la pantalla bloqueada; ver PlaybackService). Apagada por defecto.
  crossfade: boolean
  theme: ThemeChoice
}

const DEFAULTS: Settings = { hideViewToggle: false, dynamicQueue: true, crossfade: false, theme: 'oscuro' }

function read(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

let current = read()
const listeners = new Set<() => void>()

export const settings = {
  get: () => current,
  set(next: Partial<Settings>) {
    current = { ...current, ...next }
    // Sin el selector no se podría volver de «Letra»: queda la carátula.
    if (current.hideViewToggle) youtubeView.set('cancion')
    try {
      localStorage.setItem(KEY, JSON.stringify(current))
    } catch {
      /* sin almacenamiento: dura mientras la app esté abierta */
    }
    listeners.forEach((listener) => listener())
  },
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

export const useSettings = () => useSyncExternalStore(settings.subscribe, settings.get)

// Estado visual de «Sonando ahora» y sus zonas de interfaz.
import { useCallback } from 'react'

export type SlotKind = 'pantalla' | 'barra'

function createStore<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return
      value = next
      listeners.forEach((listener) => listener())
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const slots = new Map<HTMLElement, SlotKind>()
const slotListeners = new Set<() => void>()
const notify = () => slotListeners.forEach((listener) => listener())

export const stageSlots = {
  /** El espacio visible de mayor prioridad: la pantalla completa gana a la barra. */
  pick(): { el: HTMLElement; kind: SlotKind } | null {
    let best: { el: HTMLElement; kind: SlotKind } | null = null
    for (const [el, kind] of slots) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue // oculto (p. ej. la barra del celular en el PC)
      if (!best || (kind === 'pantalla' && best.kind === 'barra')) best = { el, kind }
    }
    return best
  },
  subscribe(listener: () => void) {
    slotListeners.add(listener)
    return () => {
      slotListeners.delete(listener)
    }
  },
}

/** Ref para marcar un elemento como espacio del video. */
export function useStageSlot(kind: SlotKind) {
  return useCallback(
    (el: HTMLElement | null) => {
      if (!el) return
      slots.set(el, kind)
      notify()
      return () => {
        slots.delete(el)
        notify()
      }
    },
    [kind],
  )
}

/** Aviso de que algo se está animando (abrir/cerrar «Sonando ahora»): el video lo sigue cuadro a cuadro. */
const pulseListeners = new Set<() => void>()
export const stagePulse = {
  emit: () => pulseListeners.forEach((listener) => listener()),
  subscribe(listener: () => void) {
    pulseListeners.add(listener)
    return () => {
      pulseListeners.delete(listener)
    }
  },
}

export interface StageBox {
  kind: SlotKind
  top: number
  left: number
  width: number
  height: number
}

/** Dónde está el video ahora (o null si no se ve), para que avisos y menús nunca se dibujen encima. */
export const stageBox = createStore<StageBox | null>(null)

/** «Sonando ahora» en pantalla completa: 'open' abierta · 'closing' bajando · 'closed' minimizada. */
export const sheetState = createStore<'open' | 'closing' | 'closed'>('closed')

/**
 * Qué se ve en «Sonando ahora»: la carátula o la letra tipo karaoke. Se recuerda en este navegador.
 */
export type YouTubeView = 'cancion' | 'letra'
const VIEW_KEY = 'soundblue:vista-youtube'

function readView(): YouTubeView {
  try {
    return ['letra', 'video'].includes(localStorage.getItem(VIEW_KEY) ?? '') ? 'letra' : 'cancion'
  } catch {
    return 'cancion'
  }
}

export const youtubeView = createStore<YouTubeView>(readView())
youtubeView.subscribe(() => {
  try {
    localStorage.setItem(VIEW_KEY, youtubeView.get())
  } catch {
    /* sin almacenamiento: se usa la carátula al volver a abrir */
  }
})

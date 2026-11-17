// Caché de los Modos de ambiente (2.1.5): las primeras 20 canciones de cada lista (por modo, subfiltro y géneros
// elegidos), con su género y cuándo se armó. Al volver a entrar se muestran al instante (ya se les puede dar ▶) mientras
// llegan más en segundo plano. Si la lista tiene más de 24 h, se buscan canciones nuevas, también en segundo plano.
// «Actualizar lista» la ignora y busca nuevas. Solo datos de las canciones (videoId, título, artista, portada…), en este
// navegador (localStorage).
import { isTrack } from '../player/types'
import type { ModeTrack } from './genres'

const KEY = 'soundblue:modos-cache'
const MAX_LISTS = 15 // las más recientes; las demás se olvidan
export const CACHE_TRACKS = 20
export const CACHE_FRESH_MS = 24 * 60 * 60 * 1000

export interface CachedModeList {
  at: number // cuándo se armó (ms)
  items: ModeTrack[]
}

function readAll(): Record<string, CachedModeList> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return value && typeof value === 'object' ? (value as Record<string, CachedModeList>) : {}
  } catch {
    return {}
  }
}

export const modeCache = {
  /** La lista guardada de `key` (null si no hay o está dañada). */
  read(key: string): CachedModeList | null {
    const saved = readAll()[key]
    if (!saved || typeof saved.at !== 'number' || !Array.isArray(saved.items)) return null
    const items = saved.items.filter((item): item is ModeTrack => !!item && isTrack(item.track) && typeof item.genre === 'string')
    return items.length ? { at: saved.at, items } : null
  },
  /** Guarda las primeras 20 de `items` como la lista de `key`, con la hora de ahora. */
  write(key: string, items: readonly ModeTrack[]) {
    if (!items.length) return
    try {
      const all = { ...readAll(), [key]: { at: Date.now(), items: items.slice(0, CACHE_TRACKS) } }
      const recent = Object.entries(all)
        .sort(([, a], [, b]) => (b?.at ?? 0) - (a?.at ?? 0))
        .slice(0, MAX_LISTS)
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(recent)))
    } catch {
      /* almacenamiento lleno o bloqueado: el modo funciona igual, solo que la próxima vez carga desde internet */
    }
  },
  /** ¿Es de las últimas 24 h? Si no, al entrar se buscan canciones nuevas. */
  isFresh: (list: CachedModeList) => Date.now() - list.at < CACHE_FRESH_MS,
}

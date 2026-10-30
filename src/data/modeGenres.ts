import { useSyncExternalStore } from 'react'
import { defaultModeGenres, MODE_GENRES, MODES, type Mode } from './genres'

// Géneros de cada Modo de ambiente (Personalizar, en su página): cualquiera de la app, en el orden en que los elegiste y
// al menos uno por modo. Sin personalizar, los del modo (Rumba: salsa, reggaetón y merengue). Se guardan en este navegador.
const KEY = 'soundblue:modos-generos'
const known = new Set(MODE_GENRES.map((source) => source.key))
const listeners = new Set<() => void>()

type Saved = Partial<Record<Mode['key'], string[]>>

function read(): Saved {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    if (!value || typeof value !== 'object') return {}
    const saved: Saved = {}
    for (const mode of MODES) {
      const keys = (value as Record<string, unknown>)[mode.key]
      const valid = Array.isArray(keys) ? [...new Set(keys.filter((key): key is string => typeof key === 'string' && known.has(key)))] : []
      if (valid.length) saved[mode.key] = valid
    }
    return saved
  } catch {
    return {}
  }
}

let current = read()

export const modeGenres = {
  get: () => current,
  /** Los géneros de `mode`: los que elegiste o, si no lo personalizaste, los suyos. */
  of: (mode: Mode, saved: Saved = current): string[] => saved[mode.key] ?? defaultModeGenres(mode),
  /** Guarda los de `mode`. False si quedaría sin ninguno (no se guarda: cada modo necesita al menos uno). */
  set(mode: Mode, keys: readonly string[]): boolean {
    const valid = [...new Set(keys.filter((key) => known.has(key)))]
    if (!valid.length) return false
    current = { ...current, [mode.key]: valid }
    try {
      localStorage.setItem(KEY, JSON.stringify(current))
    } catch {
      /* almacenamiento bloqueado: vale mientras la app esté abierta */
    }
    listeners.forEach((listener) => listener())
    return true
  },
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

export const useModeGenres = () => useSyncExternalStore(modeGenres.subscribe, modeGenres.get)

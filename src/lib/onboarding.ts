// Bienvenida (pages/Onboarding.tsx): sale la primera vez que abres la app, antes de Inicio, y otra vez si la pides en
// Ajustes → «Ver la bienvenida otra vez».
import { readTastes } from '../data/tastes'

const KEY = 'soundblue:hasSeenOnboarding' // 'true': ya la vio · 'false': la pidió otra vez

const listeners = new Set<() => void>()
let seen = read()

function read(): boolean {
  try {
    const value = localStorage.getItem(KEY)
    if (value === 'true') return true
    if (value === 'false') return false
    // Quien usaba la app antes de que existiera (ya pasó por «¿Qué artistas te gustan?») no la ve.
    if (readTastes() === null) return false
    localStorage.setItem(KEY, 'true')
    return true
  } catch {
    return true // sin almacenamiento no se podría recordar: no se muestra en cada arranque (Inicio pide los artistas)
  }
}

function set(value: boolean) {
  seen = value
  try {
    localStorage.setItem(KEY, String(value))
  } catch {
    /* sin almacenamiento: vale mientras la app esté abierta */
  }
  listeners.forEach((listener) => listener())
}

/** Para useSyncExternalStore en App: true cuando ya se vio (o se terminó) la bienvenida. */
export const onboarding = {
  seen: () => seen,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  /** «Empezar a escuchar». */
  finish: () => set(true),
  /** Ajustes → «Ver la bienvenida otra vez»: sale enseguida, sin recargar la app (la música sigue sonando). */
  replay: () => set(false),
}

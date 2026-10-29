// Bienvenida (pages/Onboarding.tsx): sale una sola vez, la primera vez que abres la app, antes de Inicio.
import { readTastes } from '../data/tastes'

const KEY = 'soundblue:hasSeenOnboarding'

/** Ya la vio. Quien usaba la app antes de que existiera (ya pasó por «¿Qué artistas te gustan?») tampoco la ve. */
export function hasSeenOnboarding(): boolean {
  try {
    if (localStorage.getItem(KEY) === 'true') return true
    if (readTastes() === null) return false
    localStorage.setItem(KEY, 'true')
    return true
  } catch {
    return true // sin almacenamiento no se podría recordar: no se muestra en cada arranque (Inicio pide los artistas)
  }
}

export function markOnboardingSeen() {
  try {
    localStorage.setItem(KEY, 'true')
  } catch {
    /* sin almacenamiento: vale mientras la app esté abierta */
  }
}

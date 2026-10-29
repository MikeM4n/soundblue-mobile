// Canciones que YouTube no deja reproducir fuera de sus apps (ni ellas ni otra versión de la misma): se recuerdan
// para no volver a intentarlo, saltarlas al avanzar y no mostrarlas en ninguna lista.
const KEY = 'soundblue:solo-youtube-music'
const MAX = 500

const listeners = new Set<() => void>()
let ids = read()

function read(): Set<string> {
  try {
    // Los bloqueos guardados correspondían a la reproducción con iframe; el backend de audio usa otra ruta.
    localStorage.removeItem(KEY)
  } catch {
    /* almacenamiento bloqueado */
  }
  return new Set()
}

export const onlyInYouTubeMusic = {
  has: (id: string) => ids.has(id),
  add(id: string) {
    if (ids.has(id)) return
    ids = new Set([...ids, id].slice(-MAX))
    try {
      localStorage.setItem(KEY, JSON.stringify([...ids]))
    } catch {
      /* sin almacenamiento: vale mientras la app esté abierta */
    }
    listeners.forEach((listener) => listener())
  },
  /** Para useSyncExternalStore: cambia de objeto cuando se agrega una. */
  get: () => ids,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

// Mi Cuenta: iniciar sesión con tu correo (código de 6 dígitos), juntar tu música con la de la nube y mantenerla al día.
// ⚠️ REGLA DE ORO: tus me gusta, playlists e historial del teléfono NUNCA se borran por iniciar o cerrar sesión.
// Al iniciar sesión (migración segura):
//  1. Copia de seguridad de tu música (cloud/backup.ts). Si no se puede guardar, no se sigue: la nube ni se lee.
//  2. Se lee tu cuenta. ¿Está vacía? Se sube lo del teléfono (que queda igual). ¿El teléfono está vacío? Se trae lo de
//     la cuenta. ¿Hay en los dos? Tú eliges (MergeDialog): «Fusionar» (se juntan sin repetir; no se borra nada) o
//     «Mantener solo la nube» (el teléfono queda como tu cuenta; justo antes se hace otra copia, que no se borra nunca).
//  3. Desde ahí, cada cambio se guarda en el teléfono y en la nube (cloud/sync.ts).
// Cerrar sesión deja tu música en el teléfono, tal cual.
import { useSyncExternalStore } from 'react'
import { listening } from '../data/history'
import { library } from '../library/store'
import { showToast } from '../ui/toast'
import { saveBackup } from './backup'
import { CloudError, cloudEnabled, endSession, onAuthStatus, retrySignOut, startClient, verifyCode } from './client'
import { countsOf, isEmpty, mergeData, type Counts, type Rename, type Snapshot } from './merge'
import { fetchCloud, pauseExpired, pushNow, setExpiredHandler, startSync, stopSync, syncStatus, type CloudData } from './sync'

const KEY = 'soundblue:cuenta'
const LIBRARY_KEY = 'soundblue:biblioteca'
const HISTORY_KEY = 'soundblue:historial'
const CLOUD_FRESH_MS = 5 * 60_000 // si tardas más en elegir, se vuelve a leer la nube
const BACKUP_TRIES = 3

export interface Account {
  id: string
  email: string
  ready: boolean // ya se juntó tu música con la nube: los cambios se sincronizan
  upload?: boolean // falta terminar de subir TODO (la primera vez o tras fusionar): se retoma al abrir la app
}

export type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; message: string; modal?: boolean }
  | { kind: 'choose'; local: Counts; cloud: Counts; open: boolean }
  | { kind: 'error'; message: string }

interface AccountState {
  account: Account | null
  phase: Phase
  expired: boolean // la sesión venció: hay que volver a entrar (tu música sigue en el teléfono)
}

let state: AccountState = { account: readAccount(), phase: { kind: 'idle' }, expired: false }
const listeners = new Set<() => void>()
let pendingCloud: { data: CloudData; at: number } | null = null
let generation = 0 // cada migración o elección nueva deja sin efecto a las anteriores que sigan en curso
let signingOut = false
let booted = false

function readAccount(): Account | null {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null') as Account | null
    return saved && typeof saved.id === 'string' && typeof saved.email === 'string'
      ? { id: saved.id, email: saved.email, ready: saved.ready === true, ...(saved.upload ? { upload: true } : {}) }
      : null
  } catch {
    return null
  }
}

function set(patch: Partial<AccountState>) {
  state = { ...state, ...patch }
  if ('account' in patch) {
    try {
      if (state.account) localStorage.setItem(KEY, JSON.stringify(state.account))
      else localStorage.removeItem(KEY)
    } catch {
      /* sin almacenamiento: la sesión dura mientras la app esté abierta */
    }
  }
  listeners.forEach((listener) => listener())
}

const setPhase = (phase: Phase) => set({ phase })
const snapshot = (): Snapshot => ({ library: library.get(), history: [...listening.entries()] })

/**
 * ¿El teléfono no tiene música? Se mira también el texto guardado: si existe pero no se pudo leer, NO cuenta como vacío
 * (así nunca se pisa con lo de la nube sin preguntarte).
 */
function phoneIsEmpty(local: Snapshot): boolean {
  if (!isEmpty(local)) return false
  try {
    const raw = (key: string) => localStorage.getItem(key)
    const library = JSON.parse(raw(LIBRARY_KEY) || '{}') as Record<string, unknown>
    const history = JSON.parse(raw(HISTORY_KEY) || '[]') as unknown
    const emptyList = (value: unknown) => value === undefined || (Array.isArray(value) && value.length === 0)
    return emptyList(library.favorites) && emptyList(library.playlists) && emptyList(library.saved) && emptyList(history)
  } catch {
    return false
  }
}

/** Pone tu música del teléfono igual a `data` (todo o nada). False si no cabe en el teléfono. */
function applyLocal(data: Snapshot): boolean {
  if (!library.replaceAll(data.library)) return false
  listening.replaceAll(data.history)
  return true
}

function errorMessage(error: unknown): string {
  if (error instanceof CloudError) {
    if (error.kind === 'network') return 'Sin conexión con tu cuenta. Revisa tu internet e inténtalo de nuevo.'
    if (error.kind === 'auth') return 'Tu sesión venció. Vuelve a iniciar sesión.'
    return `El servidor respondió: ${error.message}`
  }
  return error instanceof Error && error.message ? error.message : 'Algo falló. Inténtalo de nuevo.'
}

/** Tu música quedó juntada con la nube: desde ahora cada cambio se sincroniza (y, si hace falta, se sube TODO). */
function finish(current: Account, queue?: Snapshot, renames?: readonly Rename[]) {
  pendingCloud = null
  // Primero queda anotado que falta subir todo: si la app se cierra antes, se retoma al abrirla.
  set({ account: { id: current.id, email: current.email, ready: true, ...(queue ? { upload: true } : {}) }, phase: { kind: 'idle' }, expired: false })
  startSync(current.id, queue ? { snapshot: queue, renames } : undefined)
}

// Cuando todo quedó arriba, ya no hace falta retomar la subida completa.
syncStatus.subscribe(() => {
  const { state: sync, pending } = syncStatus.get()
  if (sync === 'synced' && !pending && state.account?.upload) set({ account: { ...state.account, upload: undefined } })
})

/** Paso 2 de la migración segura (el paso 1, la copia, va primero). */
async function migrate() {
  const current = state.account
  if (!current) return
  const run = ++generation
  const stale = () => run !== generation || state.account?.id !== current.id
  try {
    setPhase({ kind: 'working', message: 'Guardando una copia de seguridad de tu música…' })
    const saved = await saveBackup(current.email)
    if (stale()) return
    if (!saved) {
      setPhase({ kind: 'error', message: 'No se pudo guardar la copia de seguridad de tu música, así que no se tocó la nube. Libera espacio en el teléfono e inténtalo de nuevo.' })
      return
    }
    setPhase({ kind: 'working', message: 'Revisando tu cuenta…' })
    const cloud = await fetchCloud()
    if (stale()) return
    // Desde aquí, sin esperas: lo que se decide es con el teléfono tal como está en este instante.
    const local = snapshot()
    if (isEmpty(cloud.snapshot)) {
      // Cuenta nueva: se sube lo del teléfono, que queda igual.
      finish(current, local)
      showToast(isEmpty(local) ? 'Sesión iniciada' : 'Sesión iniciada: tu música se está guardando en tu cuenta', undefined, 4000)
      return
    }
    if (phoneIsEmpty(local)) {
      if (!applyLocal(cloud.snapshot)) {
        setPhase({ kind: 'error', message: 'No hay espacio en el teléfono para traer tu música de la nube. Libera espacio e inténtalo de nuevo.' })
        return
      }
      finish(current)
      showToast('Sesión iniciada: trajimos tu música de la nube', undefined, 4000)
      return
    }
    pendingCloud = { data: cloud, at: Date.now() }
    setPhase({ kind: 'choose', local: countsOf(local), cloud: countsOf(cloud.snapshot), open: true })
  } catch (error) {
    if (stale()) return
    if (error instanceof CloudError && error.kind === 'auth') set({ expired: true })
    setPhase({ kind: 'error', message: errorMessage(error) })
  }
}

export const account = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  /** Al abrir la app: si había sesión, sigue sincronizando (o termina la migración o la subida que quedaron a medias). */
  start() {
    if (!cloudEnabled || booted) return
    booted = true
    onAuthStatus((status, userId) => {
      const current = state.account
      if (!current || signingOut) return
      // El teléfono dice que la sesión ya no existe: se avisa (la música queda; los cambios esperan en la cola).
      if (status === 'signed-out' && !state.expired) {
        set({ expired: true })
        pauseExpired()
      }
      // Volvió la sesión de esta misma cuenta (el SDK la renovó): se sigue sin pedir el código otra vez.
      if (status === 'signed-in' && state.expired && current.ready && userId === current.id) {
        set({ expired: false })
        startSync(current.id)
      }
    })
    setExpiredHandler(() => set({ expired: true }))
    const current = state.account
    if (!current) {
      void retrySignOut() // un «Cerrar sesión» sin internet que quedó a medias
      return
    }
    // Los cambios se anotan desde ya, aunque falte internet. Si quedó a medias la subida completa, se retoma.
    if (current.ready) startSync(current.id, current.upload ? { snapshot: snapshot() } : undefined)
    void startClient().then(
      (status) => {
        if (state.account?.id !== current.id) return
        if (status === 'signed-out') {
          set({ expired: true })
          pauseExpired()
          return
        }
        if (!current.ready) void migrate()
      },
      () => {
        /* el SDK no arrancó: se reintenta al subir o al entrar */
      },
    )
  },

  /** Código validado (pantalla de inicio de sesión): empieza la migración segura. */
  async signIn(email: string, code: string) {
    const user = await verifyCode(email, code)
    const previous = state.account
    if (previous && previous.id === user.id && previous.ready) {
      // La misma cuenta tras vencer la sesión: se sube lo que quedó en la cola, sin volver a preguntar.
      set({ account: { ...previous, email: user.email }, expired: false, phase: { kind: 'idle' } })
      startSync(user.id, previous.upload ? { snapshot: snapshot() } : undefined)
      showToast('Sesión iniciada', undefined, 3000)
      return
    }
    if (previous) stopSync() // otra cuenta: lo pendiente de la anterior no se mezcla
    pendingCloud = null
    set({ account: { id: user.id, email: user.email, ready: false }, expired: false })
    void migrate()
  },

  /** «Reintentar» (sin internet, sin espacio para la copia…). */
  retry() {
    void migrate()
  },

  /** Volver a mostrar «Fusionar / Mantener solo la nube» (si elegiste «Decidir después»). */
  reopenChoice() {
    if (state.phase.kind === 'choose') setPhase({ ...state.phase, open: true })
    else if (state.account && !state.account.ready) void migrate()
  },

  /** «Decidir después»: no se sincroniza hasta que elijas. */
  postponeChoice() {
    if (state.phase.kind === 'choose') setPhase({ ...state.phase, open: false })
  },

  /** Lo que elegiste en el aviso: juntar las dos, o dejar el teléfono como tu cuenta. */
  async choose(choice: 'merge' | 'cloud') {
    const current = state.account
    if (!current || !pendingCloud || state.phase.kind !== 'choose') return
    const back: Phase = { ...state.phase, open: true }
    const run = ++generation
    const stale = () => run !== generation || state.account?.id !== current.id
    setPhase({ kind: 'working', message: choice === 'merge' ? 'Juntando tu música…' : 'Trayendo tu música de la nube…', modal: true })
    try {
      // 1. La nube, al día (si pasó mucho desde que se leyó).
      if (Date.now() - pendingCloud.at > CLOUD_FRESH_MS) pendingCloud = { data: await fetchCloud(), at: Date.now() }
      if (stale()) return
      const cloud = pendingCloud.data
      // 2. Copia con lo último del teléfono, y comprobar que nada cambió mientras se guardaba (una canción que suena,
      //    un corazón desde la notificación…). Si cambió, otra copia. La de «solo la nube» no se borra nunca.
      let backedUp = false
      for (let attempt = 0; attempt < BACKUP_TRIES && !backedUp; attempt++) {
        const lib = library.get()
        const history = listening.entries()
        if (!(await saveBackup(current.email, { pinned: choice === 'cloud' }))) break
        if (stale()) return
        backedUp = library.get() === lib && listening.entries() === history
      }
      if (!backedUp) {
        setPhase({ kind: 'error', message: 'No se pudo guardar la copia de seguridad de tu música, así que no se cambió nada. Inténtalo de nuevo.' })
        return
      }
      // 3. Sin esperas entre la comprobación y el cambio: nada puede colarse en medio.
      if (choice === 'merge') {
        const { data, renames } = mergeData(snapshot(), cloud.snapshot, cloud.uuids)
        if (!applyLocal(data)) {
          setPhase(back)
          showToast('No hay espacio en el teléfono para juntar las dos. Libera espacio e inténtalo de nuevo.', undefined, 5000)
          return
        }
        finish(current, data, renames)
        showToast('Listo: juntamos tu música sin repetir nada. Se está guardando en tu cuenta.', undefined, 4500)
        return
      }
      if (!applyLocal(cloud.snapshot)) {
        setPhase(back)
        showToast('No hay espacio en el teléfono para traer tu música de la nube.', undefined, 5000)
        return
      }
      finish(current)
      showToast('Listo: este teléfono quedó igual que tu cuenta. Lo de antes está en la copia de seguridad.', undefined, 5000)
    } catch (error) {
      if (stale()) return
      setPhase({ kind: 'error', message: errorMessage(error) })
    }
  },

  /** «Cerrar sesión»: sube lo pendiente (si hay internet) y olvida la sesión. Tu música se queda en el teléfono. */
  async signOut() {
    signingOut = true
    generation++ // una migración en curso ya no aplica
    setPhase({ kind: 'working', message: 'Cerrando sesión…' })
    try {
      await pushNow(8000).catch(() => false)
      stopSync()
      pendingCloud = null
      set({ account: null, expired: false, phase: { kind: 'idle' } })
      await endSession()
    } finally {
      signingOut = false
    }
  },
}

export function useAccount() {
  return useSyncExternalStore(account.subscribe, account.get)
}

/** «120 me gusta · 5 playlists · 2 guardadas · 300 en el historial». */
export function describeCounts(c: Counts): string {
  const parts = [
    c.favorites === 1 ? '1 me gusta' : `${c.favorites.toLocaleString('es-CO')} me gusta`,
    c.playlists === 1 ? '1 playlist' : `${c.playlists.toLocaleString('es-CO')} playlists`,
  ]
  if (c.saved) parts.push(c.saved === 1 ? '1 guardada' : `${c.saved} guardadas`)
  parts.push(`${c.history.toLocaleString('es-CO')} en el historial`)
  return parts.join(' · ')
}

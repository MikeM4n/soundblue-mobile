// Copia de seguridad de tu música ANTES de tocar la nube (Mi Cuenta): en cada inicio de sesión, antes de leer o escribir
// nada en Supabase, y otra justo antes de «Mantener solo la nube». Si no se puede guardar, no se sigue.
// Qué guarda: copia exacta (el texto tal cual) de tus datos de SoundBlue en localStorage (biblioteca: me gusta, playlists
// y playlists guardadas; historial; ajustes; gustos). Sin cachés.
// Dónde:
// - IndexedDB «soundblue-respaldo»: las copias completas. No le quita espacio a tu biblioteca (localStorage tiene un
//   límite chico y una copia ahí podría impedir guardar tus próximos cambios). Se guardan las 5 últimas y, además,
//   TODAS las hechas antes de «Mantener solo la nube» (esas nunca se borran: son lo único que queda de lo de antes).
//   Si nada cambió desde la última copia, no se repite.
// - localStorage «soundblue_backup_pre_login»: un resumen (fecha, cuenta, cuántas canciones) que apunta a la copia de
//   IndexedDB. Si IndexedDB no funciona, aquí va la copia completa.
// «Recuperar copia de seguridad» (Ajustes → Mi Cuenta) SUMA lo de todas las copias a lo que tienes: nunca borra nada.
import { HISTORY_MAX, listening } from '../data/history'
import { library, type LibraryState } from '../library/store'
import { countsOf, mergeData, readHistory, readLibrary, type Counts, type Snapshot } from './merge'

export const BACKUP_KEY = 'soundblue_backup_pre_login'
const PREFIX = 'soundblue:'
// Lo que se vuelve a armar solo (cachés, diagnósticos) no hace falta en la copia.
const SKIP = [/^soundblue:cache:/, /^soundblue:busquedas-youtube$/, /^soundblue:indice-generos$/, /^soundblue:radio-diagnostico$/, /^soundblue:uso-api$/, /^soundblue:duplicados$/, /^soundblue:duraciones$/, /^soundblue:sync-/, /^soundblue:cuenta/]
const DB = 'soundblue-respaldo'
const STORE = 'respaldos'
const KEEP = 5 // copias normales (las fijadas no cuentan)

interface Backup {
  version: 1
  savedAt: string // ISO
  email: string // la cuenta con la que se inició sesión
  appVersion: string
  keys: Record<string, string> // clave de localStorage → su texto, sin cambios (en orden alfabético)
  pinned?: boolean // hecha antes de «Mantener solo la nube»: no se borra nunca
}

/** El resumen que queda en localStorage cuando la copia completa está en IndexedDB. */
interface BackupNote {
  version: 1
  savedAt: string
  email: string
  where: 'indexeddb'
  counts: Counts
}

/**
 * Guarda una copia de lo que hay ahora. `pinned`: antes de «Mantener solo la nube» (no se borra nunca). True si quedó
 * guardada (o ya había una idéntica).
 */
export async function saveBackup(email: string, { pinned = false } = {}): Promise<boolean> {
  const keys: Record<string, string> = {}
  try {
    const names: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(PREFIX) && !SKIP.some((pattern) => pattern.test(key))) names.push(key)
    }
    for (const key of names.sort()) {
      const value = localStorage.getItem(key)
      if (value !== null) keys[key] = value
    }
  } catch {
    return false
  }
  const backup: Backup = { version: 1, savedAt: new Date().toISOString(), email, appVersion: __APP_VERSION__, keys, ...(pinned ? { pinned } : {}) }
  const counts = countsOf(snapshotOf(backup))
  if (await saveToDb(backup)) {
    const note: BackupNote = { version: 1, savedAt: backup.savedAt, email, where: 'indexeddb', counts }
    try {
      localStorage.setItem(BACKUP_KEY, JSON.stringify(note)) // pequeño: no le quita espacio a tu biblioteca
    } catch {
      /* el resumen es opcional: la copia ya está en IndexedDB */
    }
    return true
  }
  // Sin IndexedDB: la copia completa va a localStorage (si cabe).
  try {
    const text = JSON.stringify(backup)
    localStorage.setItem(BACKUP_KEY, text)
    return localStorage.getItem(BACKUP_KEY) === text
  } catch {
    return false
  }
}

/** ¿Hay alguna copia para recuperar? (sin leerlas enteras) */
export async function hasBackup(): Promise<boolean> {
  try {
    const local = JSON.parse(localStorage.getItem(BACKUP_KEY) || 'null') as unknown
    if (isBackup(local)) return true
  } catch {
    /* se miran las de IndexedDB */
  }
  return (await countDb()) > 0
}

/**
 * «Recuperar copia de seguridad»: suma a tu biblioteca y a tu historial lo que tengan las copias y ya no esté (me gusta,
 * playlists, canciones de cada playlist, playlists guardadas). No quita nada. Devuelve cuánto agregó, o null si no
 * cabe en el teléfono (entonces no cambia nada).
 */
export async function restoreBackups(): Promise<{ favorites: number; playlists: number; songs: number; saved: number } | null> {
  const backups = await readBackups()
  const before: Snapshot = { library: library.get(), history: [...listening.entries()] }
  let merged: Snapshot = before
  for (const backup of backups) merged = mergeData(merged, snapshotOf(backup)).data
  if (!library.replaceAll(merged.library)) return null
  listening.replaceAll(merged.history.slice(0, HISTORY_MAX))
  return countAdded(before, merged)
}

const snapshotOf = (backup: Backup): Snapshot => ({ library: readLibrary(backup.keys['soundblue:biblioteca']), history: readHistory(backup.keys['soundblue:historial']) })

function countAdded(before: Snapshot, after: Snapshot) {
  const songs = (state: LibraryState) => state.playlists.reduce((total, p) => total + p.tracks.length, 0)
  return {
    favorites: after.library.favorites.length - before.library.favorites.length,
    playlists: after.library.playlists.length - before.library.playlists.length,
    songs: songs(after.library) - songs(before.library),
    saved: after.library.saved.length - before.library.saved.length,
  }
}

/** Todas las copias (IndexedDB y, si hubo que usarla, la completa de localStorage), de la más reciente a la más vieja. */
async function readBackups(): Promise<Backup[]> {
  const found = await readDb()
  try {
    const local = JSON.parse(localStorage.getItem(BACKUP_KEY) || 'null') as unknown
    if (isBackup(local) && !found.some((b) => b.savedAt === local.savedAt)) found.push(local)
  } catch {
    /* copia ilegible: quedan las de IndexedDB */
  }
  return found.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

const isBackup = (value: unknown): value is Backup =>
  !!value && typeof value === 'object' && (value as Backup).version === 1 && typeof (value as Backup).savedAt === 'string' && !!(value as Backup).keys && typeof (value as Backup).keys === 'object'

const sameKeys = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(a) === JSON.stringify(b)

// ---- IndexedDB (base de datos aparte: la de las playlists guardadas no se toca) ----

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { autoIncrement: true })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Guarda la copia (o fija la última si es idéntica) y borra las normales que pasen de 5. */
async function saveToDb(backup: Backup): Promise<boolean> {
  try {
    const db = await openDb()
    return await new Promise<boolean>((resolve) => {
      const transaction = db.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      const newest = store.openCursor(null, 'prev')
      newest.onsuccess = () => {
        const cursor = newest.result
        const last = cursor?.value as unknown
        if (cursor && isBackup(last) && sameKeys(last.keys, backup.keys)) {
          // Nada cambió desde la última copia: no se repite (si hace falta fijarla, se fija).
          if (backup.pinned && !last.pinned) cursor.update({ ...last, pinned: true })
          return
        }
        store.add(backup)
        const keys = store.getAllKeys()
        keys.onsuccess = () => {
          const values = store.getAll()
          values.onsuccess = () => {
            const normal = (keys.result as IDBValidKey[]).filter((_, i) => !(values.result[i] as Backup | undefined)?.pinned)
            normal.slice(0, Math.max(0, normal.length - KEEP)).forEach((key) => store.delete(key))
          }
        }
      }
      transaction.oncomplete = () => resolve(true)
      transaction.onerror = () => resolve(false)
      transaction.onabort = () => resolve(false)
    })
  } catch {
    return false
  }
}

async function readDb(): Promise<Backup[]> {
  try {
    const db = await openDb()
    return await new Promise<Backup[]>((resolve) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
      request.onsuccess = () => resolve((request.result as unknown[]).filter(isBackup))
      request.onerror = () => resolve([])
    })
  } catch {
    return []
  }
}

async function countDb(): Promise<number> {
  try {
    const db = await openDb()
    return await new Promise<number>((resolve) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).count()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(0)
    })
  } catch {
    return 0
  }
}

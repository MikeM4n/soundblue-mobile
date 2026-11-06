// «Playlists guardadas» (Tu biblioteca): playlists de YouTube que guardas con «+» en Buscar o en su página. Sus datos
// (título, portada…) van en la biblioteca (library/store.ts); sus canciones, en IndexedDB (pueden ser cientos y no caben
// bien en localStorage). Así abren al instante, también sin conexión; al abrirlas se actualizan desde YouTube Music.
import { importPlaylist } from '../data/playlistImport'
import { isTrack, type Track } from '../player/types'
import { showToast } from '../ui/toast'
import { library, type SavedPlaylist } from './store'

const DB = 'soundblue'
const STORE = 'playlists-guardadas'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Una operación sobre el almacén (sin IndexedDB, p. ej. en una ventana privada, no hace nada). */
async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  try {
    const db = await openDb()
    return await new Promise((resolve) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

/** Las canciones guardadas de una playlist (null si todavía no se leyeron). */
export async function savedTracks(id: string): Promise<Track[] | null> {
  const tracks = await withStore<unknown>('readonly', (store) => store.get(id))
  return Array.isArray(tracks) ? tracks.filter(isTrack) : null
}

/** Lee la playlist completa (YouTube Music y, en Android, NewPipe), guarda sus canciones y actualiza cuántas son. */
export async function refreshSaved(id: string): Promise<Track[]> {
  const { tracks } = await importPlaylist(id.replace(/^VL/, ''))
  if (library.savedPlaylist(id)) {
    await withStore('readwrite', (store) => store.put(tracks, id))
    library.updateSaved(id, { count: tracks.length })
  }
  return tracks
}

/** «+»: la guarda (y en segundo plano trae todas sus canciones). «✓»: la quita. Con aviso y «Deshacer». */
export function toggleSavedPlaylist(playlist: SavedPlaylist) {
  if (library.savedPlaylist(playlist.id)) {
    const before = library.savedPlaylist(playlist.id)!
    library.removeSaved(playlist.id)
    void withStore('readwrite', (store) => store.delete(playlist.id))
    showToast('Quitada de Tu biblioteca', { label: 'Deshacer', run: () => save(before) })
    return
  }
  save(playlist)
  showToast('Guardada en Tu biblioteca', { label: 'Deshacer', run: () => toggleSavedPlaylist(playlist) })
}

function save(playlist: SavedPlaylist) {
  library.addSaved(playlist)
  void refreshSaved(playlist.id).catch(() => {}) // sin conexión: se leen al abrirla
}

// Tu biblioteca: favoritos («Tus me gusta»), tus playlists y las playlists de YouTube que guardaste, en este navegador
// (localStorage). De las guardadas aquí van sus datos; sus canciones, en IndexedDB (library/savedPlaylists.ts).
import { useSyncExternalStore } from 'react'
import { isTrack, newId, type Track } from '../player/types'

export interface Playlist {
  id: string
  name: string
  tracks: Track[]
  image?: string // carátula (la de la playlist importada); si no, la de su primera canción
  source?: string // id de la playlist de YouTube de la que se importó («PL…»): importarla otra vez la actualiza
}

/** Playlist de YouTube guardada desde Buscar o desde su página («Playlists guardadas»). */
export interface SavedPlaylist {
  id: string // browseId de YouTube Music («VLPL…»): abre su página (/ytm/:id)
  title: string
  subtitle: string
  image?: string
  count?: number // canciones (cuando ya se leyó la lista completa)
}

interface LibraryState {
  favorites: Track[]
  playlists: Playlist[]
  saved: SavedPlaylist[] // la más reciente primero
}

const isSaved = (p: SavedPlaylist) => !!p && typeof p.id === 'string' && typeof p.title === 'string'

const KEY = 'soundblue:biblioteca'
const listeners = new Set<() => void>()
let state: LibraryState = load()

function load(): LibraryState {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null')
    return {
      favorites: Array.isArray(saved?.favorites) ? saved.favorites.filter(isTrack) : [],
      playlists: Array.isArray(saved?.playlists)
        ? saved.playlists
            .filter((p: Playlist) => p && typeof p.id === 'string' && Array.isArray(p.tracks))
            .map((p: Playlist) => ({
              id: p.id,
              name: String(p.name || 'Mi playlist'),
              tracks: p.tracks.filter(isTrack),
              image: typeof p.image === 'string' && p.image ? p.image : undefined,
              source: typeof p.source === 'string' && p.source ? p.source : undefined,
            }))
        : [],
      saved: Array.isArray(saved?.saved) ? saved.saved.filter(isSaved) : [],
    }
  } catch {
    return { favorites: [], playlists: [], saved: [] }
  }
}

/** Guarda y avisa. False si el navegador no la pudo guardar (almacenamiento lleno): queda solo mientras la app esté abierta. */
function commit(next: LibraryState): boolean {
  state = next
  let stored = true
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    stored = false // almacenamiento lleno o bloqueado
  }
  listeners.forEach((listener) => listener())
  return stored
}

const insertAt = <T,>(list: T[], index: number, item: T) => {
  const copy = [...list]
  copy.splice(Math.min(index, copy.length), 0, item)
  return copy
}

export const library = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  isFavorite: (id: string) => state.favorites.some((t) => t.id === id),

  /** Agrega o quita de favoritos. Devuelve true si quedó en favoritos. */
  toggleFavorite(track: Track): boolean {
    if (library.isFavorite(track.id)) {
      commit({ ...state, favorites: state.favorites.filter((t) => t.id !== track.id) })
      return false
    }
    commit({ ...state, favorites: [track, ...state.favorites] })
    return true
  },

  /**
   * Importar: agrega a favoritos las que falten, arriba y en su orden. Devuelve cuántas agregó y una función para
   * deshacerlo (quita solo esas).
   */
  addFavorites(tracks: readonly Track[]): { added: number; undo: () => void } {
    const have = new Set(state.favorites.map((t) => t.id))
    const fresh = tracks.filter((t) => !have.has(t.id) && !!have.add(t.id))
    if (fresh.length) commit({ ...state, favorites: [...fresh, ...state.favorites] })
    const ids = new Set(fresh.map((t) => t.id))
    return { added: fresh.length, undo: () => commit({ ...state, favorites: state.favorites.filter((t) => !ids.has(t.id)) }) }
  },

  /** Quita el favorito de esa posición. Devuelve una función para deshacer. */
  removeFavoriteAt(index: number): () => void {
    const removed = state.favorites[index]
    if (!removed) return () => {}
    commit({ ...state, favorites: state.favorites.filter((_, i) => i !== index) })
    return () => {
      if (!library.isFavorite(removed.id)) commit({ ...state, favorites: insertAt(state.favorites, index, removed) })
    }
  },

  playlist: (id: string) => state.playlists.find((p) => p.id === id) ?? null,

  // ---- Playlists de YouTube guardadas (sus canciones las maneja library/savedPlaylists.ts) ----
  savedPlaylist: (id: string) => state.saved.find((p) => p.id === id) ?? null,
  addSaved(playlist: SavedPlaylist) {
    commit({ ...state, saved: [playlist, ...state.saved.filter((p) => p.id !== playlist.id)] })
  },
  updateSaved(id: string, patch: Partial<SavedPlaylist>) {
    commit({ ...state, saved: state.saved.map((p) => (p.id === id ? { ...p, ...patch } : p)) })
  },
  removeSaved(id: string) {
    commit({ ...state, saved: state.saved.filter((p) => p.id !== id) })
  },

  /**
   * «Importar playlist»: la guarda como playlist TUYA en Tu biblioteca (nombre, carátula y canciones), para abrirla,
   * reproducirla o descargarla. Si ya la habías importado (mismo origen), se actualiza en vez de duplicarse. Null si no
   * cabe en el almacenamiento del navegador (entonces no queda nada a medias).
   */
  importPlaylist(name: string, tracks: readonly Track[], { image, source }: { image?: string; source?: string }): { playlist: Playlist; updated: boolean } | null {
    const before = state
    const existing = source ? state.playlists.find((p) => p.source === source) : undefined
    const playlist: Playlist = { id: existing?.id ?? newId(), name: name.trim() || 'Playlist importada', tracks: [...tracks], image, source }
    const playlists = existing ? state.playlists.map((p) => (p.id === existing.id ? playlist : p)) : [...state.playlists, playlist]
    if (!commit({ ...state, playlists })) {
      commit(before)
      return null
    }
    return { playlist, updated: !!existing }
  },

  createPlaylist(name: string): Playlist {
    const playlist = { id: newId(), name: name.trim() || 'Mi playlist', tracks: [] }
    commit({ ...state, playlists: [...state.playlists, playlist] })
    return playlist
  },

  /** Devuelve false si la canción ya estaba en esa playlist. */
  addToPlaylist(playlistId: string, track: Track): boolean {
    const playlist = library.playlist(playlistId)
    if (!playlist || playlist.tracks.some((t) => t.id === track.id)) return false
    updatePlaylist(playlistId, (tracks) => [...tracks, track])
    return true
  },

  /** Quita la canción de esa posición de la playlist. Devuelve una función para deshacer. */
  removeFromPlaylistAt(playlistId: string, index: number): () => void {
    const removed = library.playlist(playlistId)?.tracks[index]
    if (!removed) return () => {}
    updatePlaylist(playlistId, (tracks) => tracks.filter((_, i) => i !== index))
    return () => updatePlaylist(playlistId, (tracks) => insertAt(tracks, index, removed))
  },
}

function updatePlaylist(id: string, change: (tracks: Track[]) => Track[]) {
  commit({ ...state, playlists: state.playlists.map((p) => (p.id === id ? { ...p, tracks: change(p.tracks) } : p)) })
}

/** ¿Está guardada esta playlist de YouTube? (para los botones «+» / «✓»). */
export const useSavedPlaylist = (id: string) => useLibrary().saved.some((p) => p.id === id)

export function useLibrary() {
  return useSyncExternalStore(library.subscribe, library.get)
}

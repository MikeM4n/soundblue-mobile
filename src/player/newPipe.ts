import { registerPlugin } from '@capacitor/core'

// android/app/src/main/java/com/soundblue/mobile/NewPipePlugin.java
export interface NewPipeVideo {
  id: string
  title: string
  artist: string
  duration: number
  artwork: string
  ytMusic: boolean
  viewCount?: number // vistas públicas de YouTube (-1 o ausente: no se sabe)
}

/** Una playlist pública de YouTube, completa (NewPipe sigue sus páginas). */
export interface NewPipePlaylist {
  title: string
  image: string
  count: number // cuántas dice YouTube que tiene (-1: no lo dice)
  tracks: NewPipeVideo[]
}

/** Una playlist pública de YouTube encontrada en Buscar (de cualquier usuario). */
export interface NewPipePlaylistResult {
  id: string // «PL…» (sin «VL»)
  title: string
  uploader: string
  image: string
  count: number // canciones (-1: no lo dice)
}

interface NewPipePlugin {
  /** Búsqueda normal de YouTube: cualquier video, sin importar sus vistas. */
  searchVideos(options: { query: string }): Promise<{ results: NewPipeVideo[] }>
  /** Playlists públicas de YouTube que coinciden con la búsqueda (sin «Mix»). */
  searchPlaylists(options: { query: string }): Promise<{ results: NewPipePlaylistResult[] }>
  /** Una playlist pública o no listada de cualquier usuario, hasta `max` canciones (como mucho 5000). */
  getPlaylist(options: { id: string; max: number }): Promise<NewPipePlaylist>
  getAudioStream(options: { videoId: string }): Promise<{
    audioUrl: string
    title: string
    artist: string
    duration: number
    artwork: string
    mimeType: string
  }>
}

export const NewPipe = registerPlugin<NewPipePlugin>('NewPipe')

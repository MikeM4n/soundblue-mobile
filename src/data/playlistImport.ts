// Importar una playlist pública (o no listada) de YouTube o YouTube Music, de cualquier usuario: «Importar playlist» y
// «Playlists guardadas». Se lee de dos lados a la vez:
//  - YouTube Music (data/ytmusic.ts): trae artista, álbum y portada cuadrada, pero a veces no abre una playlist de
//    usuario o se salta canciones.
//  - En la app de Android, NewPipe (NewPipePlugin.getPlaylist): lee cualquier playlist pública de YouTube, completa.
// Gana la que trae más canciones; si es la de NewPipe, cada canción que YouTube Music también trajo usa sus datos.
import { Capacitor } from '@capacitor/core'
import { NewPipe } from '../player/newPipe'
import type { Track } from '../player/types'
import { IMPORT_MAX, ytmPlaylist } from './ytmusic'

export interface ImportedPlaylist {
  title: string
  image?: string
  tracks: Track[]
}

const fromNewPipe = (id: string): Promise<ImportedPlaylist> =>
  NewPipe.getPlaylist({ id, max: IMPORT_MAX }).then((found) => ({
    title: found.title,
    image: found.image || undefined,
    tracks: found.tracks.map((video) => ({
      id: video.id,
      title: video.title,
      artist: video.artist,
      duration: video.duration || undefined,
      ytMusic: video.ytMusic,
      viewCount: video.viewCount !== undefined && video.viewCount >= 0 ? video.viewCount : undefined,
    })),
  }))

/** La playlist completa (hasta 5000). Falla solo si ni YouTube Music ni NewPipe la pudieron leer. */
export async function importPlaylist(id: string): Promise<ImportedPlaylist> {
  // RDCLAK… (las arma YouTube Music): NewPipe las toma por «Mix» (sin fin), así que solo se leen de YouTube Music.
  if (Capacitor.getPlatform() !== 'android' || id.startsWith('RD')) return ytmPlaylist(id)
  const [ytm, newPipe] = await Promise.allSettled([ytmPlaylist(id), fromNewPipe(id)])
  const music = ytm.status === 'fulfilled' ? ytm.value : null
  const full = newPipe.status === 'fulfilled' ? newPipe.value : null
  if (!music && !full) throw ytm.status === 'rejected' ? ytm.reason : new Error('No se pudo leer la playlist')
  if (!full || (music && music.tracks.length >= full.tracks.length)) return music!
  if (!music) return full
  const known = new Map(music.tracks.map((track) => [track.id, track]))
  return {
    title: music.title !== 'Playlist' ? music.title : full.title,
    image: music.image ?? full.image,
    tracks: full.tracks.map((track) => known.get(track.id) ?? track),
  }
}

// «Me gusta» desde el widget de Android y desde la notificación (también en la pantalla bloqueada). Tus me gusta viven
// aquí (library/store.ts): el corazón le pide al reproductor nativo marcar o desmarcar la que suena, él lo cambia al
// instante y lo pasa a la app, que lo guarda (si la app estaba cerrada, se lo pasa al abrirla); de vuelta, la app le dice
// si la que suena ya te gusta, para pintar el corazón lleno o vacío. (▶ con la app cerrada lo resuelve el nativo solo.)
import { Capacitor } from '@capacitor/core'
import { library } from '../library/store'
import { player } from './engine'

let started = false

export function startNativeWidget() {
  if (started || Capacitor.getPlatform() !== 'android') return
  started = true
  let sent = '' // «id:sí/no» que ya tiene el nativo

  const sync = () => {
    const current = player.getSnapshot().current
    if (!current) return
    const liked = library.isFavorite(current.id)
    const key = `${current.id}:${liked}`
    if (key === sent || !player.audio.setLiked(current.id, liked)) return
    sent = key
  }

  player.subscribe(sync) // cambió la canción
  library.subscribe(sync) // la marcaste o desmarcaste aquí o desde el widget
  player.audio.onLikeToggle(({ id, liked, title, artist, artwork }) => {
    const current = player.getSnapshot().current
    const known = current?.id === id ? current : player.audio.trackFor(id)
    const track = known ?? (title ? { id, title, artist: artist ?? '', artwork: artwork || undefined } : undefined)
    if (!track) return
    // Queda como lo dejó el corazón (con la app cerrada pudo tocarse varias veces: cuenta cómo quedó).
    if ((liked ?? !library.isFavorite(id)) !== library.isFavorite(id)) library.toggleFavorite(track)
    player.audio.setLiked(track.id, library.isFavorite(track.id)) // el nativo ya cambió el corazón: se le confirma
  })
  sync()
}

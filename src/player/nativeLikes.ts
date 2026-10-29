// «Me gusta» desde el widget de Android. Tus me gusta viven aquí (library/store.ts): el corazón del widget le pide al
// reproductor nativo marcar o desmarcar la que suena y él lo pasa a la app, que lo guarda; de vuelta, la app le dice
// si la que suena ya te gusta, para pintar el corazón lleno o vacío.
import { Capacitor } from '@capacitor/core'
import { library } from '../library/store'
import { player } from './engine'

let started = false

export function startNativeLikes() {
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
  player.audio.onLikeToggle((id) => {
    const current = player.getSnapshot().current
    const track = current?.id === id ? current : player.audio.trackFor(id)
    if (!track) return
    library.toggleFavorite(track)
    player.audio.setLiked(track.id, library.isFavorite(track.id)) // el nativo ya cambió el corazón: se le confirma
  })
  sync()
}

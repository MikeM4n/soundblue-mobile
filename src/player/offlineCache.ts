// Caché offline (solo en la app de Android): el audio de canciones de «Selecciones rápidas» guardado en el teléfono.
// Sin internet, el reproductor nativo las pone a sonar una tras otra (modo offline) hasta que vuelve la conexión, y
// entonces sigue tu cola donde iba (PlaybackService). Aquí solo se le ofrecen canciones y se lee o limpia la caché.
// Las reglas (cuántas, 24 h, «Descargar solo con Wi-Fi») están en android/app/src/main/java/com/soundblue/mobile/OfflineCache.java.
import { Capacitor, registerPlugin } from '@capacitor/core'
import { sizedArtwork, thumbnail, type Track } from './types'

export interface OfflineStatus {
  count: number // canciones guardadas
  bytes: number // lo que ocupan
  target: number // cuántas guarda como mucho (lo eliges en Ajustes: LIMIT_OPTIONS)
  stale: number // cuántas tienen más de 24 h (se cambian por nuevas)
  online: boolean // hay internet
  wifi: boolean // la red es Wi-Fi (sin límite de datos)
  wifiOnly: boolean // «Descargar solo con Wi-Fi» (encendido por defecto)
  waiting: boolean // hay canciones esperando red para descargarse (siguen solas al llegar)
  downloading: boolean
  oldest: number // cuándo se guardó la más vieja (ms; 0 si no hay)
  newest: number
}

interface OfflineCachePlugin {
  offer(options: { tracks: { id: string; title: string; artist: string; album: string; artwork: string }[] }): Promise<void>
  status(): Promise<OfflineStatus>
  setLimit(options: { limit: number }): Promise<OfflineStatus>
  setWifiOnly(options: { enabled: boolean }): Promise<OfflineStatus>
  clear(): Promise<OfflineStatus>
}

const OfflineCache = registerPlugin<OfflineCachePlugin>('OfflineCache')
const OFFER_DELAY_MS = 8000 // se espera a que Inicio termine de cargar antes de empezar a descargar
const EMPTY: OfflineStatus = { count: 0, bytes: 0, target: 50, stale: 0, online: false, wifi: false, wifiOnly: true, waiting: false, downloading: false, oldest: 0, newest: 0 }

/** Cuántas canciones guardar (Ajustes). 50 por defecto. */
export const LIMIT_OPTIONS = [15, 30, 50, 100] as const
/** Lo que ocupa una canción guardada, más o menos (audio de unos 130 kbps): para mostrar el espacio en Ajustes. */
export const MB_PER_SONG = 3.5

const enabled = Capacitor.getPlatform() === 'android'
let last: OfflineStatus = EMPTY
let pending = new Map<string, Track>()
let timer: number | undefined
const listeners = new Set<() => void>()

function publish(status: OfflineStatus) {
  last = status
  listeners.forEach((listener) => listener())
}

export const offlineCache = {
  enabled,

  /** Canciones de «Selecciones rápidas» recién cargadas: en segundo plano se guardan las que falten. */
  offer(tracks: readonly Track[]) {
    if (!enabled || !tracks.length) return
    for (const track of tracks) if (!pending.has(track.id)) pending.set(track.id, track)
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      const batch = [...pending.values()]
      pending = new Map()
      void OfflineCache.offer({
        tracks: batch.map((track) => ({
          id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album ?? '',
          artwork: track.artwork ? sizedArtwork(track.artwork, 544) : thumbnail(track.id, 'hq'),
        })),
      })
        .then(() => offlineCache.refresh())
        .catch(() => {})
    }, OFFER_DELAY_MS)
  },

  /** ¿Le faltan canciones (para el límite) o hay de más de 24 h para renovar? */
  needsMore: (status: OfflineStatus) => enabled && (status.count < status.target || status.stale > 0),

  /** ¿Se puede descargar ahora? Con internet y, si es «solo con Wi-Fi», en Wi-Fi. */
  canDownload: (status: OfflineStatus) => status.online && (status.wifi || !status.wifiOnly),

  /** Faltan canciones pero toca esperar el Wi-Fi («Descargar solo con Wi-Fi» y con datos móviles). */
  waitingForWifi: (status: OfflineStatus) => enabled && status.online && status.wifiOnly && !status.wifi && (status.waiting || status.count < status.target),

  /** Lo último que se supo (para avisos rápidos, sin esperar al teléfono). */
  get: () => last,

  async refresh(): Promise<OfflineStatus> {
    if (!enabled) return last
    const status = await OfflineCache.status().catch(() => last)
    publish(status)
    return status
  },

  /** Cuántas guardar (Ajustes). Si eliges menos de las que hay, las más viejas se borran al momento. */
  async setLimit(limit: number): Promise<OfflineStatus> {
    if (!enabled) return last
    publish({ ...last, target: limit }) // el selector cambia al instante
    const status = await OfflineCache.setLimit({ limit }).catch(() => last)
    publish(status)
    return status
  },

  /** «Descargar solo con Wi-Fi» (Ajustes). Al apagarlo, lo que esperaba Wi-Fi empieza ya con datos móviles. */
  async setWifiOnly(wifiOnly: boolean): Promise<OfflineStatus> {
    if (!enabled) return last
    publish({ ...last, wifiOnly }) // el interruptor cambia al instante
    const status = await OfflineCache.setWifiOnly({ enabled: wifiOnly }).catch(() => last)
    publish(status)
    return status
  },

  /** «Limpiar caché offline» (Ajustes). */
  async clear(): Promise<OfflineStatus> {
    if (!enabled) return last
    pending = new Map()
    window.clearTimeout(timer)
    const status = await OfflineCache.clear().catch(() => ({ ...EMPTY, target: last.target, wifiOnly: last.wifiOnly }))
    publish(status)
    return status
  },

  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

if (enabled) void offlineCache.refresh()

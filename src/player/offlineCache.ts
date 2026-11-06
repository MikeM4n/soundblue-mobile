// Descargas para escuchar sin conexión (solo en la app de Android), como en Spotify:
//  - «Descargar» en una lista (Tus me gusta, tus playlists, cualquier playlist o álbum) o en el menú ⋮ de una canción.
//  - Respaldo automático: hasta 50 de «Selecciones rápidas», si caben (se renuevan cada 24 h).
// Una descargada suena desde el teléfono, con o sin internet. Sin internet, la cola salta las que no están descargadas y,
// si no queda ninguna, suenan todas en bucle hasta que vuelve la conexión (PlaybackService).
// Límite global (Ajustes): de 50 a 1000 canciones, guardado aquí (localStorage) y en el teléfono. Si lo que pides no cabe,
// se borran primero las del respaldo y después las tuyas que menos escuchas (según tu historial). Las reglas están en
// android/app/src/main/java/com/soundblue/mobile/OfflineCache.java.
import { Capacitor, registerPlugin } from '@capacitor/core'
import { useSyncExternalStore } from 'react'
import { listening } from '../data/history'
import { showToast } from '../ui/toast'
import { sizedArtwork, thumbnail, type Track } from './types'

export interface OfflineStatus {
  count: number // canciones guardadas (tuyas y del respaldo)
  manual: number // las que descargaste tú
  auto: number // las del respaldo automático
  bytes: number // lo que ocupan
  target: number // el límite global (MIN_LIMIT a MAX_LIMIT)
  autoTarget: number // cuántas guarda el respaldo como mucho
  stale: number // del respaldo, cuántas tienen más de 24 h (se renuevan)
  queued: number // tuyas en cola
  online: boolean // hay internet
  wifi: boolean // la red es Wi-Fi (sin límite de datos)
  wifiOnly: boolean // «Descargar solo con Wi-Fi» (encendido por defecto)
  waiting: boolean // hay pendientes esperando red (siguen solas al llegar)
  downloading: boolean
  oldest: number
  newest: number
}

/** Una canción: descargada, en camino (en cola o descargándose) o no descargada. */
export type DownloadState = 'done' | 'pending' | 'none'

type NativeTrack = { id: string; title: string; artist: string; album: string; artwork: string }
type Plays = Record<string, [number, number]> // id → [veces escuchada, última vez]

interface OfflineCachePlugin {
  offer(options: { tracks: NativeTrack[] }): Promise<void>
  download(options: { tracks: NativeTrack[]; plays: Plays }): Promise<void>
  cancel(options: { ids: string[] }): Promise<void>
  remove(options: { ids: string[] }): Promise<OfflineStatus>
  status(): Promise<OfflineStatus>
  list(): Promise<{ downloaded: string[]; manual: string[]; pending: string[] }>
  setLimit(options: { limit: number; plays: Plays }): Promise<OfflineStatus>
  setWifiOnly(options: { enabled: boolean }): Promise<OfflineStatus>
  clear(): Promise<OfflineStatus>
  addListener(event: 'track', listener: (event: { id: string; state: 'queued' | 'downloading' | 'done' | 'failed' | 'removed' }) => void): Promise<unknown>
  addListener(event: 'evicted', listener: (event: { count: number }) => void): Promise<unknown>
  addListener(event: 'full', listener: (event: { skipped: number }) => void): Promise<unknown>
}

const OfflineCache = registerPlugin<OfflineCachePlugin>('OfflineCache')

export const MIN_LIMIT = 50
export const MAX_LIMIT = 1000
export const DEFAULT_LIMIT = 200
/** Lo que ocupa una canción descargada, más o menos (audio de unos 130 kbps): para mostrar el espacio en Ajustes. */
export const MB_PER_SONG = 3.5
const LIMIT_KEY = 'soundblue:offline-limite'
const OFFER_DELAY_MS = 8000 // el respaldo espera a que Inicio termine de cargar antes de empezar a descargar
const NOTICE_MS = 1500 // los avisos de varias canciones se juntan en uno

const enabled = Capacitor.getPlatform() === 'android'
const EMPTY: OfflineStatus = {
  count: 0,
  manual: 0,
  auto: 0,
  bytes: 0,
  target: DEFAULT_LIMIT,
  autoTarget: 50,
  stale: 0,
  queued: 0,
  online: false,
  wifi: false,
  wifiOnly: true,
  waiting: false,
  downloading: false,
  oldest: 0,
  newest: 0,
}

const clampLimit = (value: number) => Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.round(value)))

function readLimit(): number | null {
  try {
    const saved = Number(localStorage.getItem(LIMIT_KEY))
    return saved ? clampLimit(saved) : null
  } catch {
    return null
  }
}

function writeLimit(limit: number) {
  try {
    localStorage.setItem(LIMIT_KEY, String(limit))
  } catch {
    /* sin almacenamiento: queda en el teléfono */
  }
}

let status: OfflineStatus = { ...EMPTY, target: readLimit() ?? DEFAULT_LIMIT }
const downloaded = new Set<string>()
const pending = new Set<string>()
const listeners = new Set<() => void>()
let offered = new Map<string, Track>()
let offerTimer: number | undefined
let statusTimer: number | undefined

function emit() {
  listeners.forEach((listener) => listener())
}

/** El estado de Ajustes se pide de nuevo poco después de cada cambio (juntando varios). */
function refreshSoon() {
  window.clearTimeout(statusTimer)
  statusTimer = window.setTimeout(() => void offlineCache.refresh(), 400)
}

function nativeTrack(track: Track): NativeTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album ?? '',
    artwork: track.artwork ? sizedArtwork(track.artwork, 544) : thumbnail(track.id, 'hq'),
  }
}

/** El historial de escucha, para decidir qué se borra primero si no cabe (las que menos escuchas). */
function plays(): Plays {
  return Object.fromEntries(listening.entries().map((entry) => [entry.track.id, [entry.count, entry.last]]))
}

/** Avisos que se juntan: «Se borraron 12 canciones antiguas…» en vez de doce avisos. */
function collector(show: (total: number) => void) {
  let total = 0
  let timer: number | undefined
  return (count: number) => {
    total += count
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      show(total)
      total = 0
    }, NOTICE_MS)
  }
}

const noteEvicted = collector((n) => showToast(`Se borraron ${n === 1 ? '1 canción antigua' : `${n} canciones antiguas`} para hacer espacio`, undefined, 4000))
const noteFull = collector((n) =>
  showToast(`No ${n === 1 ? 'cupo 1 canción' : `cupieron ${n} canciones`}: sube el límite en Ajustes → Modo sin conexión`, undefined, 5000),
)
const noteFailed = collector((n) => showToast(`${n === 1 ? '1 canción no se pudo' : `${n} canciones no se pudieron`} descargar`))

async function load() {
  // La foto de lo descargado se aplica en cuanto llega (si esperara a otra consulta, un aviso «lista» que llegara en medio
  // quedaría pisado y la canción seguiría girando).
  const list = await OfflineCache.list().catch(() => null)
  if (list) {
    downloaded.clear()
    pending.clear()
    list.downloaded.forEach((id) => downloaded.add(id))
    list.pending.forEach((id) => pending.add(id))
    emit()
  }
  await offlineCache.refresh()
  // El límite vive aquí (localStorage) y en el teléfono. La primera vez se toma el del teléfono (el de la 1.9.x sube a 50).
  const saved = readLimit()
  if (saved === null) writeLimit(status.target)
  else if (saved !== status.target) await offlineCache.setLimit(saved)
}

export const offlineCache = {
  enabled,

  /** Lo último que se supo del teléfono (cuántas, límite, red…). */
  get: () => status,

  stateOf(id: string): DownloadState {
    return downloaded.has(id) ? 'done' : pending.has(id) ? 'pending' : 'none'
  },

  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  async refresh(): Promise<OfflineStatus> {
    if (!enabled) return status
    status = await OfflineCache.status().catch(() => status)
    emit()
    return status
  },

  /**
   * «Descargar»: las que faltan van a la cola, en orden (las que ya están en camino no se repiten). Devuelve cuántas
   * se pidieron. Si toca esperar el Wi-Fi o internet, avisa.
   */
  download(tracks: readonly Track[]): number {
    if (!enabled) return 0
    const seen = new Set<string>()
    const wanted = tracks.filter((track) => !seen.has(track.id) && !!seen.add(track.id) && !pending.has(track.id))
    if (!wanted.length) return 0
    const fresh = wanted.filter((track) => !downloaded.has(track.id)).length
    for (const track of wanted) if (!downloaded.has(track.id)) pending.add(track.id)
    emit()
    // Las ya descargadas también van: si eran del respaldo, pasan a ser tuyas (no se renuevan ni se borran primero).
    void OfflineCache.download({ tracks: wanted.map(nativeTrack), plays: plays() }).catch(() => {})
    if (fresh) {
      if (!status.online) showToast('Sin conexión: se descargarán cuando vuelva internet')
      else if (status.wifiOnly && !status.wifi) showToast('Esperando conexión Wi-Fi para descargar (o desactiva «Descargar solo con Wi-Fi» en Ajustes)', undefined, 4500)
      else showToast(fresh === 1 ? 'Descargando 1 canción' : `Descargando ${fresh} canciones`)
    }
    refreshSoon()
    return fresh
  },

  /** Cancela las que estaban en camino. */
  cancel(ids: readonly string[]) {
    if (!enabled || !ids.length) return
    ids.forEach((id) => pending.delete(id))
    emit()
    void OfflineCache.cancel({ ids: [...ids] }).catch(() => {})
    refreshSoon()
  },

  /** «Quitar descarga»: de una canción o de una lista (también cancela las que estaban en camino). */
  remove(ids: readonly string[]) {
    if (!enabled || !ids.length) return
    ids.forEach((id) => {
      downloaded.delete(id)
      pending.delete(id)
    })
    emit()
    void OfflineCache.remove({ ids: [...ids] })
      .then((next) => {
        status = next
        emit()
      })
      .catch(() => {})
  },

  /** El respaldo automático: canciones de «Selecciones rápidas» (se guardan las que falten, si caben). */
  offer(tracks: readonly Track[]) {
    if (!enabled || !tracks.length) return
    for (const track of tracks) if (!offered.has(track.id)) offered.set(track.id, track)
    window.clearTimeout(offerTimer)
    offerTimer = window.setTimeout(() => {
      const batch = [...offered.values()]
      offered = new Map()
      void OfflineCache.offer({ tracks: batch.map(nativeTrack) })
        .then(refreshSoon)
        .catch(() => {})
    }, OFFER_DELAY_MS)
  },

  /** ¿Al respaldo le faltan canciones (si caben) o hay de más de 24 h para renovar? */
  needsMore: (s: OfflineStatus) => enabled && ((s.auto < s.autoTarget && s.count < s.target) || s.stale > 0),

  /** ¿Se puede descargar ahora? Con internet y, si es «solo con Wi-Fi», en Wi-Fi. */
  canDownload: (s: OfflineStatus) => s.online && (s.wifi || !s.wifiOnly),

  /** Hay algo por descargar pero toca esperar el Wi-Fi («Descargar solo con Wi-Fi» y con datos móviles). */
  waitingForWifi: (s: OfflineStatus) =>
    enabled && s.online && s.wifiOnly && !s.wifi && (s.waiting || s.queued > 0 || (s.auto < s.autoTarget && s.count < s.target)),

  /** El límite global (Ajustes): se guarda aquí y en el teléfono. Si es menor que las que hay, se borran al momento. */
  async setLimit(limit: number): Promise<OfflineStatus> {
    const value = clampLimit(limit)
    writeLimit(value)
    status = { ...status, target: value }
    emit()
    if (!enabled) return status
    status = await OfflineCache.setLimit({ limit: value, plays: plays() }).catch(() => status)
    emit()
    return status
  },

  /** «Descargar solo con Wi-Fi» (Ajustes). Al apagarlo, lo que esperaba Wi-Fi empieza ya con datos móviles. */
  async setWifiOnly(wifiOnly: boolean): Promise<OfflineStatus> {
    status = { ...status, wifiOnly }
    emit()
    if (!enabled) return status
    status = await OfflineCache.setWifiOnly({ enabled: wifiOnly }).catch(() => status)
    emit()
    return status
  },

  /** «Borrar todas las descargas» (Ajustes): las tuyas y las del respaldo. */
  async clear(): Promise<OfflineStatus> {
    if (!enabled) return status
    offered = new Map()
    window.clearTimeout(offerTimer)
    downloaded.clear()
    pending.clear()
    emit()
    status = await OfflineCache.clear().catch(() => ({ ...EMPTY, target: status.target, wifiOnly: status.wifiOnly }))
    emit()
    return status
  },
}

/** Estado de descarga de una canción (se vuelve a dibujar solo si cambia el de ESTA canción). */
export function useDownloadState(id: string): DownloadState {
  return useSyncExternalStore(offlineCache.subscribe, () => offlineCache.stateOf(id))
}

/** De una lista: cuántas están descargadas y cuántas en camino. */
export function useListDownload(tracks: readonly Track[]): { done: number; pending: number; total: number } {
  const summary = useSyncExternalStore(offlineCache.subscribe, () => {
    let done = 0
    let inFlight = 0
    for (const track of tracks) {
      const state = offlineCache.stateOf(track.id)
      if (state === 'done') done++
      else if (state === 'pending') inFlight++
    }
    return `${done}|${inFlight}`
  })
  const [done, inFlight] = summary.split('|').map(Number)
  return { done, pending: inFlight, total: tracks.length }
}

/** Estado del teléfono (cuántas, límite, red…) para Ajustes. */
export function useOfflineStatus(): OfflineStatus {
  return useSyncExternalStore(offlineCache.subscribe, offlineCache.get)
}

if (enabled) {
  void OfflineCache.addListener('track', ({ id, state }) => {
    if (state === 'done') {
      downloaded.add(id)
      pending.delete(id)
    } else if (state === 'queued' || state === 'downloading') {
      pending.add(id)
    } else {
      if (state === 'failed') noteFailed(1)
      downloaded.delete(id)
      pending.delete(id)
    }
    emit()
    refreshSoon()
  })
  void OfflineCache.addListener('evicted', ({ count }) => noteEvicted(count))
  void OfflineCache.addListener('full', ({ skipped }) => noteFull(skipped))
  void load()
}

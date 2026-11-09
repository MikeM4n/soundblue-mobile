// Descargas para escuchar sin conexión (solo en la app de Android), como en Spotify. Solo lo que TÚ descargas:
// «Descargar» en una lista (Tus me gusta, tus playlists, cualquier playlist o álbum) o en el menú ⋮ de una canción.
// Cola real: de a UNA canción, en el orden en que las pediste (una lista entera antes que la siguiente). Cada canción está
// descargada, descargándose (solo una a la vez), en cola (esperando su turno) o sin descargar.
// Una descargada suena desde el teléfono, con o sin internet. Sin internet, la cola salta las que no están descargadas y,
// si no queda ninguna, suenan tus descargas en bucle hasta que vuelve la conexión (PlaybackService).
// Límite global (Ajustes): de 50 a 10 000 canciones o «Sin límite», guardado aquí (localStorage) y en el teléfono. El otro
// límite es el espacio del teléfono (siempre quedan 300 MB libres). Si lo que pides no cabe, se borran las que menos
// escuchas (según tu historial). Las reglas están en
// android/app/src/main/java/com/soundblue/mobile/OfflineCache.java.
import { Capacitor, registerPlugin } from '@capacitor/core'
import { useSyncExternalStore } from 'react'
import { listening } from '../data/history'
import { showToast } from '../ui/toast'
import { sizedArtwork, thumbnail, type Track } from './types'

export interface OfflineStatus {
  count: number // canciones descargadas
  bytes: number // lo que ocupan
  target: number // el límite global (MIN_LIMIT a MAX_LIMIT, o UNLIMITED)
  free: number // espacio libre en el teléfono (bytes)
  queued: number // en cola, esperando su turno (sin contar la que se descarga)
  downloading: boolean // hay una descargándose ahora
  online: boolean // hay internet
  wifi: boolean // la red es Wi-Fi (sin límite de datos)
  wifiOnly: boolean // «Descargar solo con Wi-Fi» (encendido por defecto)
  waiting: boolean // la cola está en pausa esperando red (sigue sola al llegar)
  oldest: number
  newest: number
}

/** Una canción: descargada, descargándose ahora, en cola (esperando su turno) o sin descargar. */
export type DownloadState = 'done' | 'downloading' | 'queued' | 'none'

type NativeTrack = { id: string; title: string; artist: string; album: string; artwork: string }
type Plays = Record<string, [number, number]> // id → [veces escuchada, última vez]
type TrackEvent = { id: string; state: 'queued' | 'downloading' | 'done' | 'failed' | 'removed' }

interface OfflineCachePlugin {
  download(options: { tracks: NativeTrack[]; plays: Plays; priority?: boolean }): Promise<void>
  cancel(options: { ids: string[] }): Promise<void>
  remove(options: { ids: string[] }): Promise<OfflineStatus>
  status(): Promise<OfflineStatus>
  list(): Promise<{ downloaded: string[]; queued: string[]; current?: string }>
  setLimit(options: { limit: number; plays: Plays }): Promise<OfflineStatus>
  setWifiOnly(options: { enabled: boolean }): Promise<OfflineStatus>
  clear(): Promise<OfflineStatus>
  addListener(event: 'track', listener: (event: TrackEvent) => void): Promise<unknown>
  addListener(event: 'evicted', listener: (event: { count: number }) => void): Promise<unknown>
  addListener(event: 'full', listener: (event: { skipped: number; storage?: boolean }) => void): Promise<unknown>
}

const OfflineCache = registerPlugin<OfflineCachePlugin>('OfflineCache')

export const MIN_LIMIT = 50
export const MAX_LIMIT = 10_000
export const UNLIMITED = 0 // «Sin límite»: solo cuenta el espacio del teléfono
export const DEFAULT_LIMIT = 200
/** Las posiciones del slider de Ajustes (más finas al principio); la última es «Sin límite». */
export const LIMIT_STEPS = [50, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10_000, UNLIMITED] as const
/** Lo que ocupa una canción descargada, más o menos (audio de unos 130 kbps): para mostrar el espacio en Ajustes. */
export const MB_PER_SONG = 3.5
const LIMIT_KEY = 'soundblue:offline-limite'
const NOTICE_MS = 1500 // los avisos de varias canciones se juntan en uno

const enabled = Capacitor.getPlatform() === 'android'
const EMPTY: OfflineStatus = {
  count: 0,
  bytes: 0,
  target: DEFAULT_LIMIT,
  free: 0,
  queued: 0,
  downloading: false,
  online: false,
  wifi: false,
  wifiOnly: true,
  waiting: false,
  oldest: 0,
  newest: 0,
}

const clampLimit = (value: number) => (value <= UNLIMITED ? UNLIMITED : Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.round(value))))

function readLimit(): number | null {
  try {
    const raw = localStorage.getItem(LIMIT_KEY)
    const saved = raw === null ? NaN : Number(raw)
    return Number.isFinite(saved) ? clampLimit(saved) : null // «0» es «Sin límite», no «sin guardar»
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
const queued = new Set<string>() // esperan su turno
let current: string | null = null // la que se descarga ahora (una sola)
const listeners = new Set<() => void>()
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
const noteNoSpace = collector((n) =>
  showToast(`No hay más espacio en el teléfono: ${n === 1 ? 'no se descargó 1 canción' : `no se descargaron ${n} canciones`}`, undefined, 5000),
)
const noteFailed = collector((n) => showToast(`${n === 1 ? '1 canción no se pudo' : `${n} canciones no se pudieron`} descargar`))

/** Sale de la cola y de «descargando». */
function forget(id: string) {
  queued.delete(id)
  if (current === id) current = null
}

async function load() {
  // La foto de lo descargado se aplica en cuanto llega (si esperara a otra consulta, un aviso «lista» que llegara en medio
  // quedaría pisado y la canción seguiría girando).
  const list = await OfflineCache.list().catch(() => null)
  if (list) {
    downloaded.clear()
    queued.clear()
    list.downloaded.forEach((id) => downloaded.add(id))
    list.queued.forEach((id) => queued.add(id))
    current = list.current ?? null
    emit()
  }
  await offlineCache.refresh()
  // El límite vive aquí (localStorage) y en el teléfono. La primera vez se toma el del teléfono.
  const saved = readLimit()
  if (saved === null) writeLimit(status.target)
  else if (saved !== status.target) await offlineCache.setLimit(saved)
}

export const offlineCache = {
  enabled,

  /** Lo último que se supo del teléfono (cuántas, límite, cola, red…). */
  get: () => status,

  stateOf(id: string): DownloadState {
    if (downloaded.has(id)) return 'done'
    if (current === id) return 'downloading'
    return queued.has(id) ? 'queued' : 'none'
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
   * «Descargar»: las que faltan van al FINAL de la cola, en orden (esperan a que termine lo que pediste antes). Con
   * `priority` (el botón de «Sonando ahora»), al PRINCIPIO: se bajan en cuanto termine la que se está descargando (también
   * si ya esperaban en la cola). Las que ya están descargadas no se repiten. Devuelve cuántas entraron. Si toca esperar
   * el Wi-Fi o internet, avisa.
   */
  download(tracks: readonly Track[], { priority = false }: { priority?: boolean } = {}): number {
    if (!enabled) return 0
    const seen = new Set<string>()
    const wanted = tracks.filter((track) => {
      const state = offlineCache.stateOf(track.id)
      const fresh = !seen.has(track.id) && (state === 'none' || (priority && state === 'queued'))
      seen.add(track.id)
      return fresh
    })
    if (!wanted.length) return 0
    const wantedIds = new Set(wanted.map((track) => track.id))
    const busy = current !== null || [...queued].some((id) => !wantedIds.has(id)) // hay otras antes en la cola
    wanted.forEach((track) => queued.add(track.id))
    emit()
    void OfflineCache.download({ tracks: wanted.map(nativeTrack), plays: plays(), priority }).catch(() => {})
    const count = wanted.length === 1 ? (priority ? `«${wanted[0].title}»` : '1 canción') : `${wanted.length} canciones`
    if (!status.online) showToast(`${count} en cola: se descargará${wanted.length === 1 ? '' : 'n'} cuando vuelva internet`)
    else if (status.wifiOnly && !status.wifi) showToast(`${count} en cola: esperando conexión Wi-Fi (o desactiva «Descargar solo con Wi-Fi» en Ajustes)`, undefined, 4500)
    else if (priority) showToast(current ? `${count} se descarga en cuanto termine la que va` : `Descargando ${count}`)
    else showToast(busy ? `${count} en cola: se descargan cuando termine lo anterior` : `Descargando ${count}`)
    refreshSoon()
    return wanted.length
  },

  /** Cancela las que estaban en la cola (y la que se descarga, si es una de ellas). */
  cancel(ids: readonly string[]) {
    if (!enabled || !ids.length) return
    ids.forEach(forget)
    emit()
    void OfflineCache.cancel({ ids: [...ids] }).catch(() => {})
    refreshSoon()
  },

  /** «Quitar descarga»: de una canción o de una lista (también cancela las que estaban en la cola). */
  remove(ids: readonly string[]) {
    if (!enabled || !ids.length) return
    ids.forEach((id) => {
      downloaded.delete(id)
      forget(id)
    })
    emit()
    void OfflineCache.remove({ ids: [...ids] })
      .then((next) => {
        status = next
        emit()
      })
      .catch(() => {})
  },

  /** Hay descargas pendientes pero toca esperar el Wi-Fi («Descargar solo con Wi-Fi» y con datos móviles). */
  waitingForWifi: (s: OfflineStatus) => enabled && s.online && s.wifiOnly && !s.wifi && (s.waiting || s.queued > 0 || s.downloading),

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

  /** «Borrar todas las descargas» (Ajustes), también la cola. */
  async clear(): Promise<OfflineStatus> {
    if (!enabled) return status
    downloaded.clear()
    queued.clear()
    current = null
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

/** De una lista: cuántas están descargadas, si una se está descargando ahora y cuántas esperan en la cola. */
export function useListDownload(tracks: readonly Track[]): { done: number; downloading: boolean; queued: number; total: number } {
  const summary = useSyncExternalStore(offlineCache.subscribe, () => {
    let done = 0
    let active = 0
    let waiting = 0
    for (const track of tracks) {
      const state = offlineCache.stateOf(track.id)
      if (state === 'done') done++
      else if (state === 'downloading') active++
      else if (state === 'queued') waiting++
    }
    return `${done}|${active}|${waiting}`
  })
  const [done, active, waiting] = summary.split('|').map(Number)
  return { done, downloading: active > 0, queued: waiting, total: tracks.length }
}

/** Estado del teléfono (cuántas, límite, cola, red…) para Ajustes. */
export function useOfflineStatus(): OfflineStatus {
  return useSyncExternalStore(offlineCache.subscribe, offlineCache.get)
}

if (enabled) {
  void OfflineCache.addListener('track', ({ id, state }) => {
    if (state === 'done') {
      forget(id)
      downloaded.add(id)
    } else if (state === 'downloading') {
      queued.delete(id)
      current = id
    } else if (state === 'queued') {
      if (current === id) current = null // se pausó (sin red): vuelve a esperar su turno
      queued.add(id)
    } else {
      if (state === 'failed') noteFailed(1)
      forget(id)
      downloaded.delete(id)
    }
    emit()
    refreshSoon()
  })
  void OfflineCache.addListener('evicted', ({ count }) => noteEvicted(count))
  void OfflineCache.addListener('full', ({ skipped, storage }) => (storage ? noteNoSpace(skipped) : noteFull(skipped)))
  void load()
}

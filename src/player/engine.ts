// Motor de reproducción de SoundBlue, con la cola de Spotify:
// - «Siguiente en la cola»: las canciones que agregas tú, en el orden en que las agregaste. Suenan primero.
// - «Siguiente de: …»: el resto de la lista, álbum o búsqueda desde donde diste play.
// Usa el backend de audio y recuerda la sesión.
import { isGenreKey, type GenreKey } from '../data/genreIndex'
import { listening } from '../data/history'
import { createRadio, type QueueGroup, type RadioPick, type RadioSource } from '../data/radio'
import { logDuplicate } from '../lib/duplicateLog'
import { settings } from '../lib/settings'
import { showToast } from '../ui/toast'
import { setupMediaSession, updateMetadata, updatePlaybackState, updatePosition } from './mediaSession'
import { isTrack, type BackendState, type MediaBackend, type Neighbors, type PlaybackFailure, type Repeat, type Status, type Track, type TrackChange } from './types'
import { NativePlayerBackend } from './nativePlayer'

const SESSION_KEY = 'soundblue:reproductor'
const DURATIONS_KEY = 'soundblue:duraciones'
/** Foto del estado que leen los componentes (inmutable: cambia de objeto en cada actualización). */
export interface PlayerSnapshot {
  current: Track | null
  fromQueue: boolean // la canción actual vino de «Siguiente en la cola»
  nextTrack: Track | null // la que sonaría con «siguiente» (para el carrusel de la barra)
  prevTrack: Track | null // la que sonaría con «anterior»
  contextName: string | null
  queue: readonly Track[] // «Siguiente en la cola»
  upcoming: readonly Track[] // «Siguiente de: contextName»
  upcomingGroups: readonly (QueueGroup | null)[] // de cada una de `upcoming`: la agregó la Fila Dinámica (null: de la lista)
  recommended: readonly Track[] // pestaña «Recomendadas» (no suenan hasta que pasan a la cola)
  discover: readonly Track[] // pestaña «Por Descubrir»: de la misma radio, solo las que nunca sonaron aquí
  recsSeed: string | null // de qué canción salen («Gasolina · Daddy Yankee»)
  recsLoading: boolean
  status: Status
  time: number
  duration: number
  shuffle: boolean
  repeat: Repeat
  volume: number
  muted: boolean
  error: string | null
  durations: Readonly<Record<string, number>>
}

// 'lista': no sonaba nada, así que quedó como canción actual, en pausa (los gestos no reproducen solos).
// 'no-disponible': YouTube no la deja reproducir aquí (ya falló antes): no se agrega.
export type QueueResult = 'agregada' | 'repetida' | 'lista' | 'no-disponible'

/** Pestañas de recomendaciones en «Próximas en sonar»: «Recomendadas» y «Por Descubrir». */
export type RecsKind = QueueGroup['kind']
const RECS_KINDS: readonly RecsKind[] = ['recomendadas', 'nuevas'] // la Fila Dinámica toma primero de «Recomendadas»

interface Context {
  name: string
  tracks: Track[]
  groups?: Record<string, QueueGroup> // las que agregó la radio, por id: su bloque en «Próximas en sonar»
  genres?: GenreKey[] // lista de un Modo: su radio es de estos géneros (PlayOptions)
}

/** Una canción que ya sonó, con lo necesario para volver a ella con «anterior». */
interface Step {
  track: Track
  fromQueue: boolean
  pos: number
}

/**
 * `replaceQueue`: lo que tocas reemplaza tu cola (Inicio). `genres`: la lista es de un Modo (Tomar): las
 * recomendaciones que siguen son solo de esos géneros, con los artistas de la lista como del género.
 */
export interface PlayOptions {
  replaceQueue?: boolean
  genres?: readonly GenreKey[]
}

const HISTORY_LIMIT = 50
const MIN_UPCOMING = 10 // con la Fila Dinámica, en la cola siempre hay al menos 10 por sonar
const POOL_SIZE = 10 // «Recomendadas» y «Por Descubrir» muestran hasta 10 cada una…
const POOL_LOW = 6 // …y se reponen (en tanda, para variar artistas) cuando les quedan menos de 6
const SKIP_SECONDS = 30 // pasar a la siguiente antes de esto cuenta como saltada (data/history.ts)
const MAX_FAILURES = 10 // canciones seguidas que no se pueden reproducir antes de detenerse
// El reproductor nativo encadena solo estas canciones (aunque la app esté dormida en segundo plano).
const NATIVE_AHEAD = 15 // próximas
const NATIVE_BEHIND = 5 // las que ya sonaron, para «anterior» desde la notificación, los audífonos o el reloj

const OFFLINE = 'Sin conexión: la música sigue en cuanto vuelva internet.'
const SKIPPED = 'No se pudo reproducir esta canción, pasando a la siguiente'

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))
const range = (n: number) => Array.from({ length: n }, (_, i) => i)

function shuffled<T>(list: T[]): T[] {
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

function move<T>(list: T[], from: number, to: number) {
  const [item] = list.splice(from, 1)
  list.splice(to, 0, item)
}

export class PlayerEngine {
  readonly audio: NativePlayerBackend
  private context: Context | null = null
  private order: number[] = [] // índices de context.tracks en orden de reproducción
  private pos = -1 // posición en `order` de la canción de la lista que va sonando
  private queue: Track[] = []
  private current: Track | null = null
  private fromQueue = false
  private history: Step[] = [] // lo que ya sonó, para «anterior» (como en Spotify)
  private shuffle = false
  private repeat: Repeat = 'off'
  private volume = 1
  private muted = false
  private status: Status = 'idle'
  private time = 0
  private duration = 0
  private error: string | null = null
  private durations: Record<string, number> = {}
  private loadedId: string | null = null // canción que tiene cargada el elemento de audio
  private failures = 0 // errores seguidos, para no saltar sin fin
  // Para el historial de escucha: una vez por canción cargada.
  private startedId: string | null = null
  private countedId: string | null = null
  private ticker: number | undefined
  private saveTimer: number | undefined
  private userPaused = false
  private radioMore: RadioSource | null = null // la radio de la canción que suena (playRadio o la de extendRadio)
  private radioOwn = new Set<string>() // la semilla de esa radio y lo que dio (si suena otra, se arma su radio)
  // «Recomendadas» y «Por Descubrir»: lo que da esa radio. No suenan hasta que pasan a la cola (tú o la Fila Dinámica).
  private pools: Record<RecsKind, Track[]> = { recomendadas: [], nuevas: [] }
  private poolsDone = new Set<RecsKind>() // la radio ya no tiene más de ese bloque
  private poolsLoading: Promise<void> | null = null // pedido en curso (uno a la vez)
  private poolSeed: string | null = null
  private discarded = new Set<string>() // descartadas en las pestañas: esta radio no las vuelve a dar
  private resumeWhenOnline = false // falló por falta de internet: al volver la conexión, suena sola
  private playingWhenOffline = false // sonaba cuando se fue internet
  private lastSave = 0
  private listeners = new Set<() => void>()
  private snapshot: PlayerSnapshot

  constructor() {
    this.audio = new NativePlayerBackend({
      onState: (state) => this.current && this.onBackendState(state),
      onTrack: (id, reason, state) => this.onNativeTrack(id, reason, state),
      onFailed: (failure) => this.onNativeFailure(failure),
    })
    this.restore()
    this.applyVolume() // queda guardado: se aplica al cargar la primera canción
    this.snapshot = this.buildSnapshot()
    setupMediaSession(this)
    window.addEventListener('pagehide', () => this.saveNow())
    // Sin internet: ninguna canción está guardada en el teléfono (el reproductor de YouTube no lo permite), así que no
    // se salta nada; al volver la conexión sigue la misma lista donde iba.
    window.addEventListener('offline', () => this.onOffline())
    window.addEventListener('online', () => this.onOnline())
    // Al encender la Fila Dinámica, la cola se completa enseguida.
    settings.subscribe(() => void this.extendRadio())
  }

  // ---- Suscripción para React (useSyncExternalStore) ----
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = () => this.snapshot

  // ---- Reproducir listas ----

  /**
   * Reproduce una lista (álbum, playlist, búsqueda…) desde `start`. Tu cola se conserva, como en Spotify, salvo con
   * `replaceQueue` (Inicio: lo que tocas reemplaza la cola). Sin repetidas (mismo videoId): cada canción de la lista
   * va una sola vez y no entra la que ya esté en tu cola; la que tocaste sale de tu cola porque suena ya.
   */
  playContext(name: string, tracks: readonly Track[], start = 0, options: PlayOptions = {}) {
    this.startContext(name, tracks, start, options, null)
  }

  /**
   * Radio (data/radio.ts): suena `seed` y lo que dé `more` llena «Recomendadas» y «Por Descubrir»; con la Fila Dinámica,
   * la cola se completa desde ahí hasta tener 10 por sonar, y se rellena a medida que suenan o las quitas. Nunca entra
   * una canción que ya esté en la lista o en tu cola.
   */
  playRadio(name: string, seed: Track, more: RadioSource, options: PlayOptions = {}) {
    this.startContext(name, [seed], 0, options, more)
  }

  // `radio`: la lista es una radio; se pone antes de sonar para que las pestañas las llene ella y no una nueva.
  private startContext(name: string, tracks: readonly Track[], start: number, { replaceQueue = false, genres }: PlayOptions, radio: RadioSource | null) {
    if (!tracks.length) return
    const chosen = tracks[clamp(start, 0, tracks.length - 1)]
    if (radio) this.startRecommendations(chosen, radio)
    else this.stopRecommendations() // al sonar, extendRadio arma la radio de la elegida
    this.queue = replaceQueue ? [] : this.queue.filter((track) => track.id !== chosen.id)
    const queued = new Set(this.queue.map((track) => track.id))
    const seen = new Set<string>()
    const list = tracks.filter((track) => {
      const where = seen.has(track.id) ? 'repetida en la lista' : queued.has(track.id) ? 'ya estaba en tu cola' : null
      if (where) {
        logDuplicate(track, where)
        return false
      }
      seen.add(track.id)
      return true
    })
    const first = list.findIndex((track) => track.id === chosen.id)
    this.context = { name, tracks: list, genres: genres?.length ? [...genres] : undefined }
    this.history = [] // «anterior» se mueve dentro de la nueva lista
    if (this.shuffle) {
      this.order = [first, ...shuffled(range(list.length).filter((i) => i !== first))]
      this.pos = 0
    } else {
      this.order = range(list.length)
      this.pos = first
    }
    this.playTrack(this.contextTrack(this.pos), false)
  }

  /**
   * La radio de la canción que suena llena «Recomendadas» y «Por Descubrir» (hasta 10 cada una) y, con la Fila Dinámica
   * encendida, pasa de ahí a la cola las que falten para que siempre haya 10 por sonar (tu cola + la lista; también al
   * quitar una), así la música no se detiene. La semilla es SIEMPRE la canción que suena: si la radio actual la trajo,
   * sigue esa radio; si no (es de la lista que elegiste, de tu cola o la agregó alguien en la Jam), las que la Fila
   * Dinámica había agregado se quitan y se arma la radio de esa canción (1 de cada 5 del mismo artista, el resto de su
   * género o uno parecido, de cualquier año). Con «repetir» activado no se arma ninguna (la lista vuelve a empezar).
   */
  private extendRadio(): Promise<void> {
    const context = this.context
    const seed = this.current
    // Suena una que la radio no trajo: las recomendaciones que venían (de otra canción) se cambian por las de esta.
    if (context && seed && this.repeat === 'off' && !this.radioOwn.has(seed.id)) {
      this.restartRadio(seed)
      this.changed()
    }
    this.topUp()
    return this.fillPools()
  }

  /**
   * Fila Dinámica: si quedan menos de 10 por sonar, pasan al final de la cola las primeras de «Recomendadas» (o, si ya no
   * hay, de «Por Descubrir»). Apagada, la cola no se rellena: queda como la dejaste.
   */
  private topUp() {
    const context = this.context
    if (!context || !this.current || !settings.get().dynamicQueue) return
    const added: RadioPick[] = []
    for (let remaining = this.queue.length + (this.order.length - this.pos - 1); remaining < MIN_UPCOMING; remaining++) {
      const kind = RECS_KINDS.find((k) => this.pools[k].length)
      if (!kind) break
      added.push({ track: this.pools[kind].shift()!, group: { kind, seed: this.poolSeed ?? '' } })
    }
    if (!added.length) return
    const start = context.tracks.length
    context.tracks.push(...added.map(({ track }) => track))
    context.groups = { ...context.groups, ...Object.fromEntries(added.map(({ track, group }) => [track.id, group])) }
    this.order.push(...added.map((_, i) => start + i))
    this.changed()
  }

  /**
   * Repone «Recomendadas» y «Por Descubrir» cuando les quedan menos de 6 (pide hasta 10 de cada una, de a una pestaña).
   * Un solo pedido a la vez; si mientras tanto cambió la canción (otra radio), lo que llega se descarta.
   */
  private fillPools(): Promise<void> {
    const more = this.radioMore
    const low = () => RECS_KINDS.filter((kind) => this.pools[kind].length < POOL_LOW && !this.poolsDone.has(kind))
    if (!more || !this.context) return Promise.resolve()
    if (this.poolsLoading) return this.poolsLoading
    const kinds = low()
    if (!kinds.length) return Promise.resolve()
    let progress = false
    const request: Promise<void> = (async () => {
      for (const kind of kinds) {
        const picks = await more(POOL_SIZE - this.pools[kind].length, this.inUse(), kind)
        if (this.radioMore !== more) return
        const have = this.inUse()
        const fresh = picks.filter(({ track }) => {
          if (have.has(track.id)) {
            logDuplicate(track, 'radio')
            return false
          }
          have.add(track.id)
          return true
        })
        if (!fresh.length) this.poolsDone.add(kind) // esta radio no tiene más que cumplan sus reglas
        progress ||= fresh.length > 0
        for (const { track } of fresh) this.radioOwn.add(track.id)
        this.pools[kind].push(...fresh.map(({ track }) => track))
        this.topUp()
        this.changed()
      }
    })()
      .catch(() => {}) // sin conexión: se intenta otra vez con la siguiente canción o al volver internet
      .finally(() => {
        if (this.poolsLoading !== request) return
        this.poolsLoading = null
        this.emit()
        // La Fila Dinámica pudo tomar de ellas mientras llegaban: otra tanda si hace falta (y si esta sirvió).
        if (progress && this.radioMore === more && low().length) void this.fillPools()
      })
    this.poolsLoading = request
    this.emit()
    return request
  }

  /** Radio nueva a partir de `seed`: «Recomendadas» y «Por Descubrir» vuelven a empezar (las llena fillPools). */
  private startRecommendations(seed: Track, radio: RadioSource) {
    this.radioMore = radio
    this.radioOwn = new Set([seed.id])
    this.pools = { recomendadas: [], nuevas: [] }
    this.poolsDone = new Set()
    this.poolsLoading = null
    this.discarded = new Set()
    this.poolSeed = `${seed.title} · ${seed.artist}`
  }

  private stopRecommendations() {
    this.radioMore = null
    this.radioOwn = new Set()
    this.pools = { recomendadas: [], nuevas: [] }
    this.poolsLoading = null
    this.poolSeed = null
  }

  /** La radio de `seed` con las reglas de la lista: en un Modo, sus géneros, y los artistas de su lista cuentan como del género. */
  private radioFor(seed: Track, context: Context): RadioSource {
    const groups = context.groups ?? {}
    const trusted = context.genres && context.tracks.filter((track) => !groups[track.id])
    return createRadio(seed, { genres: context.genres, trusted })
  }

  /** Cero duplicados: la que suena, la lista, tu cola, las dos pestañas y las descartadas. */
  private inUse(): Set<string> {
    const tracks = [...(this.context?.tracks ?? []), ...this.queue, ...this.pools.recomendadas, ...this.pools.nuevas]
    const ids = new Set([...tracks.map((track) => track.id), ...this.discarded])
    if (this.current) ids.add(this.current.id)
    return ids
  }

  /** Lo que pasó a sonar o a la cola por cualquier camino (Buscar, la Jam…) sale de las pestañas. True si quitó algo. */
  private prunePools(): boolean {
    const playing = new Set([this.current?.id, ...this.queue.map((track) => track.id), ...this.upcomingIndexes().map((i) => this.context!.tracks[i].id)])
    let pruned = false
    for (const kind of RECS_KINDS) {
      const kept = this.pools[kind].filter((track) => !playing.has(track.id))
      pruned ||= kept.length !== this.pools[kind].length
      this.pools[kind] = kept
    }
    return pruned
  }

  // ---- «Recomendadas» y «Por Descubrir» ----

  /** Al abrir «Próximas en sonar» sin radio (recién abierta la app): se arma la de la que suena, sin tocar la cola. */
  ensureRecommendations() {
    const context = this.context
    const seed = this.current
    if (this.radioMore || !context || !seed || this.repeat !== 'off') return
    this.startRecommendations(seed, this.radioFor(seed, context))
    for (const id of Object.keys(context.groups ?? {})) this.radioOwn.add(id) // lo que ya agregó la Fila Dinámica sigue
    void this.fillPools()
  }

  /** «Reproducir a continuación»: todas las de la pestaña, en su orden, justo después de la que suena. Devuelve cuántas. */
  playRecommendationsNext(kind: RecsKind): number {
    const tracks = this.pools[kind]
    if (!tracks.length || !this.current) return 0
    const ids = new Set(tracks.map((track) => track.id))
    this.queue = [...tracks, ...this.queue.filter((track) => !ids.has(track.id))]
    this.pools[kind] = []
    this.changed()
    void this.fillPools()
    return tracks.length
  }

  /** Deslizar a la derecha en una pestaña: la descarta (esta radio no la vuelve a dar). Devuelve cómo deshacerlo. */
  discardRecommendation(kind: RecsKind, index: number): () => void {
    const [track] = this.pools[kind].splice(index, 1)
    if (!track) return () => {}
    const radio = this.radioMore
    this.discarded.add(track.id)
    this.changed()
    void this.fillPools()
    return () => {
      if (this.radioMore !== radio) return // ya suena otra canción: sus recomendaciones son otras
      this.discarded.delete(track.id)
      if (this.inUse().has(track.id)) return
      this.pools[kind].splice(Math.min(index, this.pools[kind].length), 0, track)
      this.changed()
    }
  }

  /** Tocar una de las pestañas: suena ya (como tocar una de tu cola) y las recomendaciones pasan a salir de ella. */
  playRecommendation(kind: RecsKind, index: number) {
    const [track] = this.pools[kind].splice(index, 1)
    if (!track) return
    this.queue.unshift(track)
    this.jumpToQueue(0)
  }

  /** Activa aleatorio y reproduce la lista empezando por una canción al azar. */
  shuffleContext(name: string, tracks: readonly Track[], options: PlayOptions = {}) {
    this.shuffle = true
    this.playContext(name, tracks, Math.floor(Math.random() * tracks.length), options)
  }

  // ---- Controles ----
  toggle() {
    if (this.status === 'playing') this.pause()
    else this.play()
  }

  play() {
    const track = this.current
    if (!track) return
    if (this.loadedId !== track.id || this.status === 'error') {
      this.loadCurrent(true, this.status === 'ended' ? 0 : this.time)
      return
    }
    if (this.status === 'ended') this.backend.seek(0)
    this.backend.play()
    this.emit()
  }

  pause() {
    this.userPaused = true
    this.backend.pause()
  }

  /**
   * Pasa a la siguiente: primero tu cola, después la lista (con aleatorio y repetir). False si no hay más.
   * Se salta las que ya se sabe que solo suenan en la app de YouTube Music (sin esperar el error del reproductor).
   */
  next(): boolean {
    this.noteSkip()
    const before = { pos: this.pos, queue: this.queue }
    let target = this.peekNext()
    if (!target) {
      ;({ pos: this.pos, queue: this.queue } = before) // no quedó ninguna que suene: todo sigue como estaba
      return false
    }
    if (target.fromQueue) this.queue.shift()
    this.pushHistory()
    this.pos = target.pos
    this.playTrack(target.track, target.fromQueue)
    return true
  }

  /**
   * Pasaste a la siguiente antes de los 30 s, con la canción sonando o en pausa: cuenta como saltada (su artista deja de
   * recomendarse si lo saltas seguido). No cuenta al terminar sola ni si no se pudo reproducir.
   */
  private noteSkip() {
    const track = this.current
    const live = this.status === 'playing' || this.status === 'paused' || this.status === 'buffering'
    if (track && live && this.countedId !== track.id && this.currentTime() < SKIP_SECONDS) listening.skipped(track)
  }

  /** Vuelve directamente a la canción que sonó antes (deslizar la barra a la derecha). False si no hay. */
  previous(): boolean {
    const target = this.peekPrevious()
    if (!target) return false
    if (target.fromHistory) this.history.pop()
    if (this.current && this.fromQueue) this.queue.unshift(this.current) // la actual vuelve a ser la siguiente
    this.pos = target.pos
    this.playTrack(target.track, target.fromQueue)
    return true
  }

  // Botón «anterior», como en Spotify: si la canción lleva más de 3 s, la reinicia; si no, va a la anterior. Con la
  // canción cargada lo decide el reproductor nativo con su propio reloj (el de aquí se congela en segundo plano) y el
  // cambio vuelve por onNativeTrack, igual que desde la notificación, los audífonos o el reloj.
  prev() {
    if (!this.current) return
    if (this.loadedId === this.current.id && this.status !== 'error') {
      this.backend.previous()
      return
    }
    if (this.currentTime() > 3 || !this.previous()) this.seek(0)
  }

  seek(seconds: number) {
    const track = this.current
    if (!track) return
    const d = this.duration
    this.time = Math.max(0, d ? Math.min(seconds, d - 0.5) : seconds)
    if (this.loadedId === track.id) this.backend.seek(this.time)
    updatePosition(this.duration, this.time)
    this.changed()
  }

  seekBy(delta: number) {
    this.seek(this.currentTime() + delta)
  }

  // ---- Tu cola («Siguiente en la cola») ----

  /**
   * Agrega al final de tu cola. Si no suena nada, queda lista en pausa (no empieza a sonar sola). Si ya está sonando, en
   * tu cola o en lo que sigue de la lista, no se agrega otra vez.
   */
  addToQueue(track: Track): QueueResult {
    if (!this.current) {
      this.prepareTrack(track)
      return 'lista'
    }
    if (this.current.id === track.id || this.isQueued(track.id)) {
      logDuplicate(track, 'agregar a la cola')
      return 'repetida'
    }
    this.queue.push(track)
    this.changed()
    return 'agregada'
  }

  /** Pone la canción al principio de tu cola: suena justo después de la actual (si ya venía más adelante, se mueve). */
  playNext(track: Track): QueueResult {
    if (!this.current) {
      this.prepareTrack(track)
      return 'lista'
    }
    if (this.current.id === track.id) return 'repetida'
    const inUpcoming = this.upcomingIndexes().findIndex((i) => this.context!.tracks[i].id === track.id)
    if (inUpcoming >= 0) this.order.splice(this.pos + 1 + inUpcoming, 1)
    this.queue = [track, ...this.queue.filter((t) => t.id !== track.id)]
    this.changed()
    return 'agregada'
  }

  isQueued(id: string): boolean {
    return this.queue.some((t) => t.id === id) || this.upcomingIndexes().some((i) => this.context!.tracks[i].id === id)
  }

  /** Quita la canción de la cola (tuya o de la lista). Devuelve una función para deshacer, o null si no estaba. */
  removeFromQueue(id: string): (() => void) | null {
    const inQueue = this.queue.findIndex((t) => t.id === id)
    if (inQueue >= 0) return this.removeQueueAt(inQueue)
    const inUpcoming = this.upcomingIndexes().findIndex((i) => this.context!.tracks[i].id === id)
    return inUpcoming >= 0 ? this.removeUpcomingAt(inUpcoming) : null
  }

  removeQueueAt(index: number): () => void {
    const [removed] = this.queue.splice(index, 1)
    if (!removed) return () => {}
    this.changed()
    void this.extendRadio() // si quedaron menos de 10, la radio repone enseguida
    return () => {
      this.queue.splice(Math.min(index, this.queue.length), 0, removed)
      this.changed()
    }
  }

  removeUpcomingAt(index: number): () => void {
    const at = this.pos + 1 + index
    const [removed] = this.order.splice(at, 1)
    if (removed === undefined) return () => {}
    this.changed()
    void this.extendRadio() // si quedaron menos de 10, la radio repone enseguida
    return () => {
      this.order.splice(clamp(at, this.pos + 1, this.order.length), 0, removed)
      this.changed()
    }
  }

  moveQueue(from: number, to: number) {
    if (from === to || !this.queue[from] || to < 0 || to >= this.queue.length) return
    move(this.queue, from, to)
    this.changed()
  }

  moveUpcoming(from: number, to: number) {
    const base = this.pos + 1
    if (from === to || from < 0 || to < 0 || base + from >= this.order.length || base + to >= this.order.length) return
    move(this.order, base + from, base + to)
    this.changed()
  }

  clearQueue(): () => void {
    const removed = this.queue
    this.queue = []
    this.changed()
    void this.extendRadio()
    return () => {
      this.queue = [...removed, ...this.queue]
      this.changed()
    }
  }

  /** Salta a una canción de tu cola (las anteriores a ella se quitan, como en Spotify). */
  jumpToQueue(index: number) {
    const track = this.queue[index]
    if (!track) return
    this.queue.splice(0, index + 1)
    this.pushHistory()
    this.restartRadio(track)
    this.playTrack(track, true)
  }

  /** Salta a una canción de «Siguiente de: …». */
  jumpToUpcoming(index: number) {
    const at = this.pos + 1 + index
    if (!this.context || at >= this.order.length) return
    this.pushHistory()
    this.pos = at
    this.restartRadio(this.contextTrack(this.pos))
    this.playTrack(this.contextTrack(this.pos), false)
  }

  /**
   * Tocaste a mano otra canción: las que la Fila Dinámica había agregado (de la canción anterior) se quitan y la radio
   * vuelve a empezar desde esta: «Recomendadas» y «Por Descubrir» se llenan de nuevo (al sonar, playTrack las pide). Lo
   * de la lista que elegiste y tu cola se quedan. Con «repetir» activado no se toca nada.
   */
  private restartRadio(seed: Track) {
    const context = this.context
    if (!context || this.repeat !== 'off') return
    const groups = context.groups ?? {}
    this.order = [...this.order.slice(0, this.pos + 1), ...this.order.slice(this.pos + 1).filter((i) => !groups[context.tracks[i].id])]
    this.startRecommendations(seed, this.radioFor(seed, context))
  }

  // ---- Modos y volumen ----
  toggleShuffle() {
    this.shuffle = !this.shuffle
    if (this.context && this.pos >= 0) {
      const played = this.order.slice(0, this.pos + 1)
      const rest = this.order.slice(this.pos + 1)
      // Al quitar aleatorio, lo que falta vuelve al orden original de la lista.
      this.order = [...played, ...(this.shuffle ? shuffled(rest) : [...rest].sort((a, b) => a - b))]
    }
    this.changed()
  }

  cycleRepeat() {
    this.repeat = ({ off: 'all', all: 'one', one: 'off' } as const)[this.repeat]
    this.changed()
  }

  setVolume(value: number) {
    this.volume = clamp(value, 0, 1)
    this.muted = this.volume === 0
    this.applyVolume()
    this.changed()
  }

  toggleMute() {
    this.muted = !this.muted
    if (!this.muted && this.volume === 0) this.volume = 0.6
    this.applyVolume()
    this.changed()
  }

  // ---- Internos ----

  private get backend(): MediaBackend {
    return this.audio
  }

  private contextTrack(position: number): Track {
    return this.context!.tracks[this.order[position]]
  }

  private upcomingIndexes(): number[] {
    return this.context ? this.order.slice(this.pos + 1) : []
  }

  private hasNext(): boolean {
    return this.peekNext() !== null
  }

  /** Qué sonaría con «siguiente», sin cambiar nada. */
  private peekNext(): Step | null {
    if (this.queue.length) return { track: this.queue[0], fromQueue: true, pos: this.pos }
    if (!this.context) return null
    if (this.pos < this.order.length - 1) return { track: this.contextTrack(this.pos + 1), fromQueue: false, pos: this.pos + 1 }
    if (this.repeat === 'all' && this.order.length) return { track: this.contextTrack(0), fromQueue: false, pos: 0 }
    return null
  }

  /** Qué sonaría con «anterior»: lo último que sonó o, si no hay historial, la anterior de la lista. */
  private peekPrevious(): (Step & { fromHistory: boolean }) | null {
    const last = this.history[this.history.length - 1]
    if (last) return { ...last, fromHistory: true }
    if (!this.context || this.fromQueue) return null
    if (this.pos > 0) return { track: this.contextTrack(this.pos - 1), fromQueue: false, pos: this.pos - 1, fromHistory: false }
    if (this.repeat === 'all' && this.order.length > 1) {
      const lastPos = this.order.length - 1
      return { track: this.contextTrack(lastPos), fromQueue: false, pos: lastPos, fromHistory: false }
    }
    return null
  }

  private pushHistory() {
    if (!this.current || this.status === 'error') return // una canción que falló no vuelve con «anterior»
    this.history.push({ track: this.current, fromQueue: this.fromQueue, pos: this.pos })
    if (this.history.length > HISTORY_LIMIT) this.history.shift()
  }

  private playTrack(track: Track, fromQueue: boolean) {
    this.current = track
    this.fromQueue = fromQueue
    this.loadCurrent(true)
    void this.extendRadio() // si la lista es una radio y quedan 2 o menos, pide 5 más
  }

  /** Deja la canción como actual, en pausa, lista para tocar ▶. */
  private prepareTrack(track: Track) {
    this.current = track
    this.fromQueue = true
    this.loadCurrent(false)
  }

  private loadCurrent(autoplay: boolean, start = 0) {
    const track = this.current
    if (!track) return
    this.status = autoplay ? 'loading' : 'paused'
    this.userPaused = false
    this.error = null
    this.time = start
    this.startedId = this.countedId = null
    this.duration = this.durations[track.id] ?? track.duration ?? 0
    updateMetadata(track, this.context?.name)
    updatePlaybackState(this.status)
    this.changed()
    // Con sus vecinas: al terminar esta, el reproductor nativo sigue solo con la próxima (ya pre-cargada).
    this.loadedId = track.id
    this.backend.load(track, { autoplay, start, ...this.neighbors() }).catch((error: unknown) => {
      if (this.current !== track) return
      this.loadedId = null
      this.status = 'error'
      this.error = error instanceof Error ? error.message : 'No se pudo cargar el audio. Revisa tu conexión.'
      updatePlaybackState(this.status)
      this.emit()
    })
    this.syncNative() // «repetir una»
  }

  /**
   * El reproductor nativo pasó a otra canción por su cuenta: terminó la anterior, se tocó «siguiente» o «anterior» en la
   * notificación, los audífonos o el reloj, o saltó una que no se pudo reproducir. La cola de aquí se pone al día (pudo
   * avanzar varias mientras la app dormía en segundo plano). Si el cambio lo pidió la app, ya está al día.
   */
  private onNativeTrack(id: string, reason: TrackChange, state: BackendState) {
    const current = this.current
    if (!current || current.id === id) return
    const previous = this.peekPrevious()
    if (reason === 'seek' && previous?.track.id === id) {
      if (previous.fromHistory) this.history.pop()
      if (this.fromQueue) this.queue.unshift(current) // la actual vuelve a ser la siguiente
      this.pos = previous.pos
      this.adopt(previous.track, previous.fromQueue, state)
      return
    }
    const before = { pos: this.pos, queue: [...this.queue], history: [...this.history], fromQueue: this.fromQueue }
    if (reason === 'auto') {
      this.rememberDuration(true)
      this.countListen()
    } else if (reason === 'seek') {
      this.noteSkip()
    }
    for (let step = 0; step <= NATIVE_AHEAD; step++) {
      const target = this.peekNext()
      if (!target) break
      if (target.fromQueue) this.queue.shift()
      if (step > 0 || reason !== 'failed') this.pushHistory() // la que falló no vuelve con «anterior»
      this.pos = target.pos
      this.current = target.track
      this.fromQueue = target.fromQueue
      if (target.track.id === id) {
        this.adopt(target.track, target.fromQueue, state)
        return
      }
    }
    // No está en la cola de aquí (cambió mientras tanto): se respeta lo que suena y se le vuelve a mandar la cola.
    this.pos = before.pos
    this.queue = before.queue
    this.history = before.history
    this.current = current
    this.fromQueue = before.fromQueue
    const track = this.audio.trackFor(id)
    if (!track) return
    this.pushHistory()
    this.adopt(track, true, state)
  }

  /** Deja como actual la que ya suena en el reproductor nativo, sin volver a cargarla. */
  private adopt(track: Track, fromQueue: boolean, state: BackendState) {
    this.current = track
    this.fromQueue = fromQueue
    this.loadedId = track.id
    this.status = 'loading'
    this.userPaused = false
    this.error = null
    this.time = 0
    this.startedId = this.countedId = null
    this.duration = this.durations[track.id] ?? track.duration ?? 0
    updateMetadata(track, this.context?.name)
    void this.extendRadio() // como playTrack: la radio sigue desde la que suena
    this.onBackendState(state === 'playing' || state === 'paused' ? state : 'buffering')
  }

  /**
   * Lo que el reproductor nativo encadena solo: las próximas (tu cola, la lista y, con «repetir», la lista otra vez) y las
   * que alcanza «anterior» (lo último que sonó o, si no hay, la anterior de la lista).
   */
  private neighbors(): Neighbors {
    const upcoming = this.queue.slice(0, NATIVE_AHEAD)
    if (this.context) {
      const rest = range(this.order.length).slice(this.pos + 1)
      for (const position of this.repeat === 'all' ? [...rest, ...range(this.pos + 1)] : rest) {
        if (upcoming.length >= NATIVE_AHEAD) break
        upcoming.push(this.contextTrack(position))
      }
    }
    const previous = this.peekPrevious()
    const history = this.history.length ? this.history.slice(-NATIVE_BEHIND).map((step) => step.track) : previous ? [previous.track] : []
    return { history, upcoming, album: this.context?.name }
  }

  /** Cada cambio de la cola (agregar, quitar, mover, la Fila Dinámica, aleatorio, repetir) llega al reproductor nativo. */
  private syncNative() {
    const track = this.current
    if (track && this.loadedId === track.id) this.backend.sync(track, this.neighbors(), this.repeat === 'one')
  }

  private onBackendState(state: BackendState) {
    switch (state) {
      case 'playing':
        this.status = 'playing'
        this.userPaused = false
        this.failures = 0
        if (this.error === OFFLINE) this.error = null // volvió la conexión y el reproductor nativo siguió solo
        this.resumeWhenOnline = false
        this.syncTime()
        this.startTicker()
        if (this.current && this.startedId !== this.current.id) {
          this.startedId = this.current.id
          listening.started(this.current)
        }
        break
      case 'paused':
      case 'cued':
        this.status = 'paused'
        this.syncTime()
        this.stopTicker()
        break
      case 'buffering':
        this.status = 'buffering'
        break
      case 'ended':
        this.stopTicker()
        this.onEnded()
        return
      case 'unstarted':
        return // sigue en 'loading' hasta que YouTube empiece
      case 'error':
        return // el detalle llega por onNativeFailure
    }
    updatePlaybackState(this.status)
    updatePosition(this.duration, this.time)
    this.changed()
  }

  /** Suma una reproducción al historial (a los 30 s o al terminar), una vez por canción cargada. */
  private countListen() {
    if (!this.current || this.countedId === this.current.id) return
    this.countedId = this.current.id
    listening.counted(this.current)
  }

  // Al terminar pasa de inmediato a la siguiente, sin dejar ver las sugerencias de YouTube.
  private onEnded() {
    this.rememberDuration(true)
    this.countListen()
    if (this.repeat === 'one') {
      this.backend.seek(0)
      this.backend.play()
      return
    }
    if (this.next()) return
    this.status = 'ended'
    this.time = this.duration
    updatePlaybackState(this.status)
    this.changed()
    // Cola infinita: si la última terminó antes de que llegaran las siguientes, se sigue en cuanto lleguen.
    const ended = this.current
    void this.extendRadio().then(() => {
      if (this.status === 'ended' && this.current === ended) this.next()
    })
  }

  /**
   * Una canción no se pudo reproducir (p. ej. NewPipe no pudo extraerla). Sin internet no se salta nada: sigue sola al
   * volver la conexión. Si no, el reproductor nativo ya pasó a la siguiente (el cambio llega por onNativeTrack) o, si no
   * tenía otra, se sigue desde aquí.
   */
  private onNativeFailure({ id, network, skipped }: PlaybackFailure) {
    if (this.current?.id !== id) return
    this.stopTicker()
    if (network) {
      this.waitForNetwork()
      return
    }
    this.status = 'error' // así no vuelve con «anterior» (pushHistory)
    if (!skipped) {
      this.skipFailed()
      return
    }
    this.failures++
    showToast(SKIPPED)
    this.emit()
  }

  /** Sin internet: la canción queda esperando (ninguna está guardada en el teléfono) y suena sola al volver la conexión. */
  private waitForNetwork() {
    this.resumeWhenOnline = true
    this.status = 'error'
    this.error = OFFLINE
    updatePlaybackState('paused')
    this.emit()
  }

  private onOffline() {
    this.playingWhenOffline = this.status === 'playing' || this.status === 'buffering' || this.status === 'loading'
    if (this.current) showToast(OFFLINE)
  }

  /** Volvió internet: sigue la canción donde iba (si sonaba o quedó esperando) y la radio repone lo que falte. */
  private onOnline() {
    const resume = this.resumeWhenOnline || (this.playingWhenOffline && !this.userPaused && this.status !== 'playing')
    this.resumeWhenOnline = this.playingWhenOffline = false
    if (this.current && resume) {
      showToast('Volvió la conexión: sigue la música')
      this.loadCurrent(true, this.currentTime())
    } else if (this.error === OFFLINE) {
      this.error = null
      this.emit()
    }
    void this.extendRadio()
  }

  private skipFailed() {
    this.failures++
    // Si no se puede reproducir, salta a la siguiente con un aviso corto (máximo 10 seguidos).
    if (this.failures <= MAX_FAILURES && this.hasNext()) {
      // Todo queda dentro de SoundBlue: sin enlace a la app de YouTube Music.
      showToast(SKIPPED)
      this.next()
      return
    }
    this.status = 'error'
    this.error = 'No se pudo reproducir esta canción.'
    updatePlaybackState(this.status)
    this.emit()
  }

  private startTicker() {
    if (this.ticker) return
    // YouTube no avisa del tiempo. Una lectura cada 5 s mantiene la barra útil sin actualizarla varias veces por segundo.
    this.ticker = window.setInterval(() => {
      this.syncTime()
      this.rememberDuration(false)
      if (this.time >= 30) this.countListen()
      if (Date.now() - this.lastSave > 4000) {
        this.lastSave = Date.now()
        updatePosition(this.duration, this.time)
        this.save()
      }
      this.emit()
    }, 5000)
  }

  private stopTicker() {
    window.clearInterval(this.ticker)
    this.ticker = undefined
  }

  private syncTime() {
    this.time = this.backend.getTime()
    const d = this.backend.getDuration()
    if (d > 0) this.duration = d
  }

  private currentTime() {
    return this.loadedId === this.current?.id ? this.backend.getTime() : this.time
  }

  // Guarda la duración para las listas. Solo tras 30 s o al terminar, para no confundirla con un anuncio.
  private rememberDuration(force: boolean) {
    const track = this.current
    if (!track || !(this.duration > 0) || (!force && this.time < 30)) return
    const seconds = Math.round(this.duration)
    if (this.durations[track.id] === seconds) return
    this.durations = { ...this.durations, [track.id]: seconds }
    try {
      localStorage.setItem(DURATIONS_KEY, JSON.stringify(this.durations))
    } catch {
      /* sin almacenamiento: no pasa nada */
    }
  }

  private applyVolume() {
    this.audio.setVolume(this.volume, this.muted)
  }

  // ---- Sesión: se guarda en el navegador y se restaura al abrir en pausa ----
  private restore() {
    try {
      this.durations = JSON.parse(localStorage.getItem(DURATIONS_KEY) || '{}')
      const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null')
      if (!saved) return
      if (saved.context?.name === 'Lista de prueba') {
        localStorage.removeItem(SESSION_KEY)
        return
      }
      const saveds: unknown[] = Array.isArray(saved.context?.tracks) ? saved.context.tracks : []
      const tracks: Track[] = saveds.filter(isTrack)
      if (tracks.length) {
        const groups = saved.context.groups
        const genres = Array.isArray(saved.context.genres) ? saved.context.genres.filter(isGenreKey) : []
        this.context = {
          name: String(saved.context.name || 'Tu música'),
          tracks,
          groups: groups && typeof groups === 'object' ? groups : undefined,
          genres: genres.length ? genres : undefined,
        }
        // Si se descartaron canciones (las de la fuente retirada), el orden guardado ya no corresponde: se empieza la lista.
        const sameList = tracks.length === saveds.length
        this.order =
          sameList && Array.isArray(saved.order) ? saved.order.filter((i: unknown) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < tracks.length) : range(tracks.length)
        this.pos = sameList ? clamp(Number(saved.pos) || 0, 0, Math.max(0, this.order.length - 1)) : 0
      }
      this.queue = Array.isArray(saved.queue) ? saved.queue.filter(isTrack) : []
      this.history = Array.isArray(saved.history)
        ? saved.history.filter((s: Step) => s && isTrack(s.track)).map((s: Step) => ({ track: s.track, fromQueue: !!s.fromQueue, pos: Number(s.pos) || 0 }))
        : []
      this.current = isTrack(saved.current) ? saved.current : null
      this.fromQueue = !!saved.fromQueue
      this.shuffle = !!saved.shuffle
      this.repeat = ['off', 'all', 'one'].includes(saved.repeat) ? saved.repeat : 'off'
      this.volume = typeof saved.volume === 'number' ? clamp(saved.volume, 0, 1) : 1
      this.muted = !!saved.muted
      this.time = Number(saved.time) || 0
      if (this.current) {
        this.status = 'standby'
        this.duration = this.durations[this.current.id] ?? this.current.duration ?? 0
        updateMetadata(this.current, this.context?.name)
      }
    } catch {
      /* sesión guardada dañada: se empieza de cero */
    }
  }

  private save() {
    window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => this.saveNow(), 250)
  }

  private saveNow() {
    try {
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
          context: this.context,
          order: this.order,
          pos: this.pos,
          queue: this.queue,
          history: this.history,
          current: this.current,
          fromQueue: this.fromQueue,
          shuffle: this.shuffle,
          repeat: this.repeat,
          volume: this.volume,
          muted: this.muted,
          time: this.currentTime(),
        }),
      )
    } catch {
      /* almacenamiento lleno o bloqueado */
    }
  }

  private changed() {
    if (this.prunePools()) void this.fillPools()
    this.syncNative()
    this.emit()
    this.save()
  }

  private emit() {
    this.snapshot = this.buildSnapshot()
    this.listeners.forEach((listener) => listener())
  }

  private buildSnapshot(): PlayerSnapshot {
    return {
      current: this.current,
      fromQueue: this.fromQueue,
      nextTrack: this.peekNext()?.track ?? null,
      prevTrack: this.current ? (this.peekPrevious()?.track ?? null) : null,
      contextName: this.context?.name ?? null,
      queue: [...this.queue],
      upcoming: this.upcomingIndexes().map((i) => this.context!.tracks[i]),
      upcomingGroups: this.upcomingIndexes().map((i) => this.context!.groups?.[this.context!.tracks[i].id] ?? null),
      recommended: [...this.pools.recomendadas],
      discover: [...this.pools.nuevas],
      recsSeed: this.poolSeed,
      recsLoading: this.poolsLoading !== null,
      status: this.status,
      time: this.time,
      duration: this.duration,
      shuffle: this.shuffle,
      repeat: this.repeat,
      volume: this.volume,
      muted: this.muted,
      error: this.error,
      durations: this.durations,
    }
  }
}

/** Reproductor único de la app. */
export const player = new PlayerEngine()

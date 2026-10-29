import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import {
  sizedArtwork,
  thumbnail,
  type BackendEvents,
  type BackendState,
  type LoadOptions,
  type MediaBackend,
  type Neighbors,
  type PlaybackFailure,
  type Track,
  type TrackChange,
} from './types'

interface NativeTrack {
  id: string
  title: string
  artist: string
  album: string
  artwork: string
}

interface NativeState {
  id?: string
  status: BackendState
  position?: number // segundos
  duration?: number // segundos (0 si aún no se sabe)
  seq?: number // el load al que corresponde el aviso
  // La canción que tiene cargada (por si la app se abre con la música ya sonando).
  title?: string
  artist?: string
  artwork?: string
}

interface NativePlayerPlugin {
  load(options: {
    history: NativeTrack[]
    current: NativeTrack
    upcoming: NativeTrack[]
    start: number
    autoplay: boolean
    volume: number
    seq: number
  }): Promise<void>
  setNeighbors(options: { currentId: string; history: NativeTrack[]; upcoming: NativeTrack[] }): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seek(options: { seconds: number }): Promise<void>
  previous(): Promise<void>
  setVolume(options: { volume: number }): Promise<void>
  setRepeatOne(options: { enabled: boolean }): Promise<void>
  setLiked(options: { id: string; liked: boolean }): Promise<void>
  getState(): Promise<NativeState>
  addListener(eventName: 'state', listener: (state: NativeState) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'trackChanged', listener: (event: NativeState & { id: string; reason: TrackChange }) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'trackFailed', listener: (event: PlaybackFailure & { seq?: number }) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'likeToggle', listener: (event: { id: string }) => void): Promise<PluginListenerHandle>
}

// android/app/src/main/java/com/soundblue/mobile/PlaybackPlugin.java
const NativePlayer = registerPlugin<NativePlayerPlugin>('NativePlayer')

const ignore = () => {}

function nativeTrack(track: Track, album?: string): NativeTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album || album || 'SoundBlue',
    artwork: track.artwork ? sizedArtwork(track.artwork, 544) : thumbnail(track.id, 'hq'),
  }
}

const neighborsKey = (track: Track, { history, upcoming }: Neighbors) =>
  [track.id, history.map((t) => t.id).join(','), upcoming.map((t) => t.id).join(',')].join('|')

/**
 * Reproductor nativo de Android (PlaybackService: ExoPlayer + NewPipe). El motor le pasa la canción con sus vecinas y él
 * sigue solo: al terminar una pasa a la siguiente, pre-carga la URL de la que sigue y salta las que fallan, aunque la app
 * esté en segundo plano. Avisa cada cambio para que el motor ponga su cola al día.
 */
export class NativePlayerBackend implements MediaBackend {
  private readonly events: BackendEvents
  private listening = false
  private loaded = false
  private seq = 0 // número del último load: los avisos de antes se descartan
  private sent = '' // las vecinas que ya tiene el reproductor nativo (para no mandarlas otra vez)
  private known = new Map<string, Track>() // las canciones que tiene el reproductor nativo
  private repeatOne: boolean | null = null
  private time = 0 // última posición que dio el nativo…
  private readAt = 0 // …y cuándo (performance.now): mientras suena, el tiempo avanza solo entre lecturas
  private playing = false
  private duration = 0
  private volume = 1
  private poller: number | undefined

  constructor(events: BackendEvents) {
    this.events = events
  }

  async load(track: Track, options: LoadOptions): Promise<void> {
    if (Capacitor.getPlatform() !== 'android') throw new Error('La reproducción nativa está disponible en la app de Android.')
    this.listen()
    const seq = ++this.seq
    this.time = Math.max(0, options.start)
    this.readAt = performance.now()
    this.playing = false
    this.duration = 0
    this.sent = neighborsKey(track, options)
    this.remember(track, options)
    this.loaded = true
    await NativePlayer.load({
      history: options.history.map((t) => nativeTrack(t, options.album)),
      current: nativeTrack(track, options.album),
      upcoming: options.upcoming.map((t) => nativeTrack(t, options.album)),
      start: options.start,
      autoplay: options.autoplay,
      volume: this.volume,
      seq,
    })
  }

  sync(track: Track, neighbors: Neighbors, repeatOne: boolean) {
    if (!this.loaded) return
    if (repeatOne !== this.repeatOne) {
      this.repeatOne = repeatOne
      void NativePlayer.setRepeatOne({ enabled: repeatOne }).catch(ignore)
    }
    const key = neighborsKey(track, neighbors)
    if (key === this.sent) return
    this.sent = key
    this.remember(track, neighbors)
    void NativePlayer.setNeighbors({
      currentId: track.id,
      history: neighbors.history.map((t) => nativeTrack(t, neighbors.album)),
      upcoming: neighbors.upcoming.map((t) => nativeTrack(t, neighbors.album)),
    }).catch(ignore)
  }

  play() {
    if (this.loaded) void NativePlayer.play().catch(ignore)
  }

  pause() {
    if (this.loaded) void NativePlayer.pause().catch(ignore)
  }

  seek(seconds: number) {
    this.time = Math.max(0, this.duration ? Math.min(seconds, this.duration) : seconds)
    this.readAt = performance.now()
    if (this.loaded) void NativePlayer.seek({ seconds: this.time }).catch(ignore)
  }

  previous() {
    if (this.loaded) void NativePlayer.previous().catch(ignore)
  }

  getTime() {
    if (!this.playing) return this.time
    const time = this.time + (performance.now() - this.readAt) / 1000
    return this.duration > 0 ? Math.min(time, this.duration) : time
  }

  getDuration() { return this.duration }

  /** Si la canción está en Tus me gusta: el corazón del widget. Antes de cargar nada no hay widget que pintar. */
  setLiked(id: string, liked: boolean): boolean {
    if (!this.loaded) return false
    void NativePlayer.setLiked({ id, liked }).catch(ignore)
    return true
  }

  /** Se tocó el corazón del widget sobre la canción `id`. */
  onLikeToggle(listener: (id: string) => void) {
    if (Capacitor.getPlatform() === 'android') void NativePlayer.addListener('likeToggle', ({ id }) => listener(id))
  }

  /**
   * Al abrir la app: si el reproductor nativo ya está en marcha (lo arrancó el widget con la app cerrada), la app se
   * pone al día con él en vez de quedarse con su sesión guardada en pausa. No arranca el reproductor si no lo está.
   */
  async attach() {
    if (Capacitor.getPlatform() !== 'android') return
    this.listen()
    const state = await NativePlayer.getState().catch(() => null)
    if (state && !this.loaded) this.attachTo(state)
  }

  private attachTo(state: NativeState) {
    const id = state.id
    if (!id) return // no tiene nada cargado
    this.loaded = true
    this.read(state)
    if (state.title && !this.known.has(id)) {
      this.known.set(id, { id, title: state.title, artist: state.artist ?? '', artwork: state.artwork || undefined })
    }
    this.events.onAttach(id, state.status)
  }

  /** Una canción que se le mandó al reproductor nativo (por si avanzó a una que el motor ya no tiene en su cola). */
  trackFor(id: string): Track | undefined {
    return this.known.get(id)
  }

  private remember(track: Track, { history, upcoming }: Neighbors) {
    // Las de antes se conservan: el nativo puede seguir teniéndolas para «anterior».
    for (const t of [...history, track, ...upcoming]) this.known.set(t.id, t)
    if (this.known.size > 200) this.known = new Map([...this.known].slice(-100))
  }

  setVolume(volume: number, muted: boolean) {
    this.volume = muted ? 0 : Math.max(0, Math.min(1, volume))
    if (this.loaded) void NativePlayer.setVolume({ volume: this.volume }).catch(ignore)
  }

  private listen() {
    if (this.listening) return
    this.listening = true
    void NativePlayer.addListener('state', (state) => {
      if (this.stale(state)) return
      if (!this.loaded) return this.attachTo(state) // empezó a sonar sin la app (el widget)
      this.read(state)
      this.events.onState(state.status)
    })
    void NativePlayer.addListener('trackChanged', (event) => {
      if (this.stale(event)) return
      if (!this.loaded) return this.attachTo(event)
      this.duration = 0 // la de la canción anterior ya no vale
      this.read(event)
      this.events.onTrack(event.id, event.reason, event.status)
    })
    void NativePlayer.addListener('trackFailed', (failure) => {
      if (!this.stale(failure)) this.events.onFailed(failure)
    })
  }

  private stale(event: { seq?: number }) {
    return (event.seq ?? 0) < this.seq
  }

  private read(state: NativeState) {
    if (typeof state.position === 'number') {
      this.time = state.position
      this.readAt = performance.now()
    }
    if (typeof state.duration === 'number' && state.duration > 0) this.duration = state.duration
    this.playing = state.status === 'playing'
    if (this.playing) this.startPolling()
    else this.stopPolling()
  }

  // El nativo avisa los cambios de estado; el tiempo se corrige cada segundo mientras suena (entre lecturas lo calcula
  // getTime, así la barra y la letra pueden leerlo 4 veces por segundo sin preguntarle al nativo).
  private startPolling() {
    if (this.poller !== undefined) return
    this.poller = window.setInterval(() => {
      void NativePlayer.getState()
        .then((state) => {
          if (!this.stale(state)) this.read(state)
        })
        .catch(ignore)
    }, 1000)
  }

  private stopPolling() {
    if (this.poller !== undefined) window.clearInterval(this.poller)
    this.poller = undefined
  }
}

/** Una canción de YouTube Music (o un video de YouTube), que suena en el reproductor oficial de YouTube. */
export interface Track {
  id: string // id del video de YouTube (p. ej. "60ItHLz5WEA")
  title: string
  artist: string
  artistId?: string // id del (primer) artista en YouTube Music, para «Para ti»
  album?: string // álbum, si se conoce (pistas de YouTube Music)
  duration?: number // segundos, si se conoce
  ytMusic?: boolean // pista de YouTube Music (canal «Artista - Topic»): su imagen es la portada del álbum
  artwork?: string // portada cuadrada de YouTube Music (si no, la imagen del video)
  viewCount?: number // reproducciones públicas de YouTube, si se conoce
}

export type Repeat = 'off' | 'all' | 'one'

/**
 * Estado del reproductor. 'standby' = se restauró la sesión anterior pero la canción aún no se cargó
 * (no se reproduce nada solo al abrir la app).
 */
export type Status = 'idle' | 'standby' | 'loading' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error'

/** Estados que reportan los reproductores, ya traducidos. 'error': falló la canción (el detalle llega en onFailed). */
export type BackendState = 'unstarted' | 'cued' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error'

/** Las vecinas de la que suena: el reproductor nativo las encadena solo, sin esperar a la app. */
export interface Neighbors {
  history: readonly Track[] // las que alcanza «anterior», de la más vieja a la más reciente
  upcoming: readonly Track[] // las próximas, en el orden en que van a sonar
  album?: string // de dónde suena (para la notificación, si la canción no trae álbum)
  // Fila Dinámica (y sin «repetir»): si se le acaban las próximas y la app no le manda más (dormida en segundo plano o
  // cerrada), el reproductor nativo sigue solo con canciones parecidas en vez de detenerse.
  endless: boolean
}

export interface LoadOptions extends Neighbors {
  autoplay: boolean
  start: number // segundos
}

/** Por qué el reproductor nativo pasó a otra canción: terminó la anterior, un botón (notificación, audífonos, reloj) o falló. */
export type TrackChange = 'auto' | 'seek' | 'failed'

export interface PlaybackFailure {
  id: string
  message: string
  network: boolean // sin conexión: no se salta, sigue cuando vuelva internet
  skipped: boolean // el reproductor nativo ya pasó a la siguiente
}

export interface BackendEvents {
  onState(state: BackendState): void
  /** `after`: la canción es de las que el reproductor nativo agregó solo, después de `after` (la última que le mandó la app). */
  onTrack(id: string, reason: TrackChange, state: BackendState, after?: string): void
  onFailed(failure: PlaybackFailure): void
  /** El reproductor nativo ya sonaba sin que la app lo pidiera (p. ej. lo arrancó el widget con la app cerrada). */
  onAttach(id: string, state: BackendState): void
  /** Al reproductor nativo le quedan 3 o menos por sonar: hay que mandarle más. */
  onQueueLow(): void
}

/** Lo que el motor necesita de un reproductor de audio. */
export interface MediaBackend {
  load(track: Track, options: LoadOptions): Promise<void>
  sync(track: Track, neighbors: Neighbors, repeatOne: boolean): void
  play(): void
  pause(): void
  seek(seconds: number): void
  previous(): void // «anterior» con la regla de los 3 s, medida por el propio reproductor
  getTime(): number
  getDuration(): number
  setVolume(volume: number, muted: boolean): void
}

/** Miniatura oficial del video (servida por YouTube). 'maxres' = 1280×720, no existe en todos los videos. */
export function thumbnail(videoId: string, quality: 'mq' | 'hq' | 'maxres' = 'hq'): string {
  return `https://i.ytimg.com/vi/${videoId}/${quality}default.jpg`
}

/**
 * Imagen de la canción: la portada de YouTube Music o la imagen del video. En las pistas de YouTube Music la
 * portada va al centro de una imagen 16:9 ('mq' y 'maxres'; 'hq' agrega franjas negras arriba y abajo), así que
 * recortada al cuadrado (object-cover) queda la portada exacta.
 */
export function coverUrl(track: Track, size: 'small' | 'large' = 'small'): string | undefined {
  if (track.artwork) return sizedArtwork(track.artwork, size === 'small' ? 120 : 544)
  if (size === 'small') return thumbnail(track.id, 'mq')
  return thumbnail(track.id, track.ytMusic ? 'maxres' : 'hq')
}

/** La imagen y sus alternativas, en orden: si una no carga, se prueba la siguiente. */
export function coverSources(track: Track, size: 'small' | 'large' = 'small'): string[] {
  // La portada en el tamaño pedido y, si Google no la da así (a veces responde 429), la original.
  const art = track.artwork ? [...new Set([sizedArtwork(track.artwork, size === 'small' ? 120 : 544), track.artwork])] : []
  // Alta resolución si existe; maxres y mq vienen sin franjas negras.
  return size === 'large' ? [...art, thumbnail(track.id, 'maxres'), thumbnail(track.id, 'mq')] : [...art, thumbnail(track.id, 'mq')]
}

/** Portada de YouTube Music en el tamaño pedido (sus direcciones llevan el tamaño: «…=w120-h120-l90-rj»). */
export function sizedArtwork(url: string, px: number): string {
  return url.replace(/=w\d+-h\d+/, `=w${px}-h${px}`)
}

// Las canciones de la fuente anterior (source: 'audius', ya retirada) se descartan al leer lo guardado.
export const isTrack = (t: unknown): t is Track =>
  typeof t === 'object' &&
  t !== null &&
  typeof (t as Track).id === 'string' &&
  typeof (t as Track).title === 'string' &&
  (t as { source?: string }).source !== 'audius'

/** Id corto y único (crypto.randomUUID no existe sin HTTPS, p. ej. al probar en la red local). */
export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

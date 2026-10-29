// Android metadata and playback controls are owned by the native PlaybackService (Media3 session).
// Keep the standard browser Media Session API for desktop browsers and PWAs.
import { sizedArtwork, thumbnail, type Status, type Track } from './types'

interface Controls {
  play(): void
  pause(): void
  next(): void
  prev(): void
  seek(seconds: number): void
  seekBy(delta: number): void
}

const supported = () => typeof navigator !== 'undefined' && 'mediaSession' in navigator

export function setupMediaSession(controls: Controls) {
  if (!supported()) return
  const set = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
    try { navigator.mediaSession.setActionHandler(action, handler) } catch { /* acción no disponible */ }
  }
  set('play', () => controls.play())
  set('pause', () => controls.pause())
  set('previoustrack', () => controls.prev())
  set('nexttrack', () => controls.next())
  set('seekbackward', (details) => controls.seekBy(-(details.seekOffset ?? 10)))
  set('seekforward', (details) => controls.seekBy(details.seekOffset ?? 10))
  set('seekto', (details) => details.seekTime != null && controls.seek(details.seekTime))
  set('stop', () => controls.pause())
}

function artworkFor(track: Track): MediaImage[] {
  if (track.artwork) return [302, 544].map((px) => ({ src: sizedArtwork(track.artwork!, px), sizes: `${px}x${px}`, type: 'image/jpeg' }))
  return [{ src: thumbnail(track.id, 'hq'), sizes: '480x360', type: 'image/jpeg' }]
}

export function updateMetadata(track: Track | null, contextName?: string | null) {
  if (!supported()) return
  if (!track) {
    navigator.mediaSession.metadata = null
    return
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album || contextName || 'SoundBlue',
    artwork: artworkFor(track),
  })
}

export function updatePlaybackState(status: Status) {
  if (!supported()) return
  navigator.mediaSession.playbackState = status === 'playing' || status === 'buffering' ? 'playing' : status === 'idle' ? 'none' : 'paused'
}

export function updatePosition(duration: number, position: number) {
  if (!supported() || !navigator.mediaSession.setPositionState || !(duration > 0)) return
  try { navigator.mediaSession.setPositionState({ duration, playbackRate: 1, position: Math.min(position, duration) }) } catch { /* posición transitoria fuera de rango */ }
}

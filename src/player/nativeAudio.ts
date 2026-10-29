import { AudioPlayer } from '@mediagrid/capacitor-native-audio'
import { Capacitor } from '@capacitor/core'
import { NewPipe } from './newPipe'
import { thumbnail, type BackendEvents, type BackendState, type LoadOptions, type MediaBackend } from './types'

const AUDIO_ID = 'soundblue-main'

interface AudioResolution {
  audioUrl?: string
  error?: string
  title?: string
  artist?: string
  artwork?: string
}

/** Stream resolver + Media3/ExoPlayer backend. The plugin also supplies its own web implementation. */
export class NativeAudioBackend implements MediaBackend {
  private readonly events: BackendEvents
  private created = false
  private request = 0
  private time = 0
  private duration = 0
  private volume = 1
  private muted = false
  private poller: number | undefined
  private readyWaiter: (() => void) | null = null
  private nextListener: Promise<unknown> | null = null
  private previousListener: Promise<unknown> | null = null

  constructor(events: BackendEvents) {
    this.events = events
  }

  async load(videoId: string, options: LoadOptions): Promise<void> {
    const request = ++this.request
    let result: AudioResolution
    if (Capacitor.getPlatform() === 'android') {
      try {
        this.nextListener ??= NewPipe.addListener('mediaNext', () => this.events.onMediaNext?.())
        this.previousListener ??= NewPipe.addListener('mediaPrevious', () => this.events.onMediaPrevious?.())
        result = await NewPipe.getAudioStream({ videoId })
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : 'NewPipe no pudo obtener el audio.')
      }
    } else {
      throw new Error('La reproducción nativa está disponible en la app de Android.')
    }
    if (!result.audioUrl) throw new Error('No se recibió una URL de audio reproducible.')
    if (request !== this.request) return

    const track = options.track
    const metadata = {
      friendlyTitle: result.title || track?.title || videoId,
      artistName: result.artist || track?.artist || 'SoundBlue',
      albumTitle: track?.album || options.album || 'SoundBlue',
      artworkSource: result.artwork || track?.artwork || thumbnail(videoId, 'hq'),
    }

    this.time = Math.max(0, options.start)
    this.duration = 0
    if (!this.created) {
      await AudioPlayer.create({
        audioId: AUDIO_ID,
        audioSource: result.audioUrl,
        useForNotification: true,
        showSeekBackward: true,
        showSeekForward: true,
        seekBackwardTime: 10,
        seekForwardTime: 10,
        ...metadata,
      })
      this.created = true
      await AudioPlayer.onAudioReady({ audioId: AUDIO_ID }, () => this.onReady())
      await AudioPlayer.onAudioEnd({ audioId: AUDIO_ID }, () => {
        this.stopPolling()
        this.events.onState('ended')
      })
      await AudioPlayer.onPlaybackStatusChange({ audioId: AUDIO_ID }, ({ status }) => {
        const state: BackendState = status === 'playing' ? 'playing' : 'paused'
        if (state === 'playing') this.startPolling()
        else this.stopPolling()
        this.events.onState(state)
      })
      const ready = this.waitUntilReady(request)
      await AudioPlayer.initialize({ audioId: AUDIO_ID })
      await ready
    } else {
      const ready = this.waitUntilReady(request)
      await AudioPlayer.changeMetadata({ audioId: AUDIO_ID, ...metadata })
      await AudioPlayer.changeAudioSource({ audioId: AUDIO_ID, source: result.audioUrl })
      await ready
    }

    if (request !== this.request) return
    await this.applyVolume()
    if (options.start > 0) await AudioPlayer.seek({ audioId: AUDIO_ID, timeInSeconds: options.start })
    if (options.autoplay) {
      await AudioPlayer.play({ audioId: AUDIO_ID })
      this.startPolling()
    } else {
      this.events.onState('cued')
    }
  }

  play() {
    if (!this.created) return
    void AudioPlayer.play({ audioId: AUDIO_ID }).then(() => this.startPolling()).catch(() => this.events.onError(1))
  }

  pause() {
    if (!this.created) return
    void AudioPlayer.pause({ audioId: AUDIO_ID }).catch(() => {})
  }

  seek(seconds: number) {
    this.time = Math.max(0, this.duration ? Math.min(seconds, this.duration) : seconds)
    if (this.created) void AudioPlayer.seek({ audioId: AUDIO_ID, timeInSeconds: this.time }).catch(() => {})
  }

  getTime() { return this.time }
  getDuration() { return this.duration }

  setVolume(volume: number, muted: boolean) {
    this.volume = Math.max(0, Math.min(1, volume))
    this.muted = muted
    void this.applyVolume()
  }

  private async applyVolume() {
    if (this.created) await AudioPlayer.setVolume({ audioId: AUDIO_ID, volume: this.muted ? 0 : this.volume }).catch(() => {})
  }

  private onReady() {
    this.events.onReady()
    void AudioPlayer.getDuration({ audioId: AUDIO_ID }).then(({ duration }) => { this.duration = duration }).catch(() => {})
    this.readyWaiter?.()
    this.readyWaiter = null
  }

  private waitUntilReady(request: number): Promise<void> {
    if (request !== this.request) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (this.readyWaiter === done) this.readyWaiter = null
        reject(new Error('El stream de audio tardó demasiado en responder.'))
      }, 30000)
      const done = () => {
        window.clearTimeout(timeout)
        resolve()
      }
      this.readyWaiter = done
    })
  }

  private startPolling() {
    if (this.poller !== undefined) return
    this.poller = window.setInterval(() => {
      void Promise.all([
        AudioPlayer.getCurrentTime({ audioId: AUDIO_ID }).then(({ currentTime }) => { this.time = currentTime }),
        AudioPlayer.getDuration({ audioId: AUDIO_ID }).then(({ duration }) => { if (duration > 0) this.duration = duration }),
      ]).catch(() => {})
    }, 1000)
  }

  private stopPolling() {
    if (this.poller !== undefined) window.clearInterval(this.poller)
    this.poller = undefined
  }
}

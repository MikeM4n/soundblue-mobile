import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export interface NewPipeVideo {
  id: string
  title: string
  artist: string
  duration: number
  artwork: string
  ytMusic: boolean
}

interface NewPipePlugin {
  searchVideos(options: { query: string }): Promise<{ results: NewPipeVideo[] }>
  getAudioStream(options: { videoId: string }): Promise<{
    audioUrl: string
    title: string
    artist: string
    duration: number
    artwork: string
    mimeType: string
  }>
  addListener(eventName: 'mediaNext', listener: () => void): Promise<PluginListenerHandle>
  addListener(eventName: 'mediaPrevious', listener: () => void): Promise<PluginListenerHandle>
}

export const NewPipe = registerPlugin<NewPipePlugin>('NewPipe')

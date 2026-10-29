import { useEffect, useSyncExternalStore } from 'react'
import { showToast } from '../ui/toast'
import { player } from '../player/engine'
import { Capacitor } from '@capacitor/core'

export function useScreenWakeLock() {
  const { status } = useSyncExternalStore(player.subscribe, player.getSnapshot)
  useEffect(() => {
    // En Android, no mantener la pantalla encendida al reproducir.
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') return
    if (status !== 'playing' && status !== 'buffering') return
    type Sentinel = { release(): Promise<void>; onrelease?: (() => void) | null }
    type WakeLock = { request(type: 'screen'): Promise<Sentinel> }
    const api = (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock
    let sentinel: Sentinel | undefined
    let alive = true
    let informed = false
    const request = async () => {
      try {
        sentinel = await api?.request('screen')
        if (sentinel) sentinel.onrelease = () => { sentinel = undefined; if (alive && document.visibilityState === 'visible') window.setTimeout(() => void request(), 0) }
      }
      catch { if (alive && !informed) { informed = true; showToast('Brave o el navegador bloqueó mantener la pantalla encendida.') } }
    }
    if (!api && !informed) { informed = true; showToast('Este navegador no permite mantener la pantalla encendida; revisa el ajuste de pantalla de Brave.') }
    void request()
    const visible = () => { if (document.visibilityState === 'visible' && !sentinel) void request() }
    document.addEventListener('visibilitychange', visible)
    return () => { alive = false; document.removeEventListener('visibilitychange', visible); void sentinel?.release() }
  }, [status])
}

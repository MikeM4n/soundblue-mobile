// Canal en vivo de una Jam: un WebSocket por sala avisa cada cambio al instante (agregar, quitar, deshacer, lo que suena)
// y así todos los teléfonos ven lo mismo enseguida. Si no conecta o se cae, se pregunta por HTTP cada 3 s y se reintenta
// el WebSocket cada vez más espaciado (hasta 30 s). Protocolo: ver src/jam/api.ts.
import { jamApi, JamError, liveUrl, type JamState } from './api'
import { App } from '@capacitor/app'
import { Capacitor, type PluginListenerHandle } from '@capacitor/core'

const POLL_MS = 3000
const PING_MS = 25_000
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000]

export interface JamWatcher {
  stop(): void
  refresh(): void // pide el estado ya (p. ej. después de un cambio sin WebSocket)
}

/**
 * Sigue la Jam `code`: `onState` con cada estado nuevo (nunca uno más viejo que el último) y `onGone` si ya no existe
 * (404) o esta versión no tiene servidor de Jams (503); después de `onGone` deja de seguirla.
 */
export function watchJam(code: string, onState: (jam: JamState) => void, onGone: (error: JamError) => void): JamWatcher {
  let stopped = false
  let socket: WebSocket | null = null
  let open = false
  let lastHeard = 0 // última vez que habló el servidor (para notar una conexión muerta)
  let version = -1
  let attempts = 0
  let poller: number | undefined
  let pinger: number | undefined
  let retry: number | undefined
  let appStateListener: PluginListenerHandle | undefined

  const deliver = (jam: JamState) => {
    if (stopped || jam.version < version) return
    version = jam.version
    onState(jam)
  }

  const gone = (error: JamError) => {
    if (stopped) return
    stop()
    onGone(error)
  }

  const load = () =>
    jamApi
      .get(code)
      .then(deliver)
      .catch((error) => {
        if (error instanceof JamError && (error.status === 404 || error.status === 503)) gone(error)
        // Sin conexión: se reintenta en la próxima vuelta.
      })

  const startPolling = () => {
    if (poller === undefined) poller = window.setInterval(load, POLL_MS)
  }
  const stopPolling = () => {
    window.clearInterval(poller)
    poller = undefined
  }

  /** Suelta el WebSocket actual sin que su cierre cuente como caída. */
  const drop = () => {
    const ws = socket
    socket = null
    open = false
    window.clearInterval(pinger)
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      ws.close()
    }
  }

  function connect() {
    window.clearTimeout(retry)
    if (stopped) return
    if (typeof WebSocket === 'undefined') return startPolling()
    let ws: WebSocket
    try {
      ws = new WebSocket(liveUrl(code))
    } catch {
      return fallBack()
    }
    socket = ws
    ws.onopen = () => {
      open = true
      attempts = 0
      lastHeard = Date.now()
      stopPolling()
      pinger = window.setInterval(() => {
        // Sin noticias en dos vueltas de «ping»: la conexión murió sin avisar (p. ej. el teléfono cambió de red).
        if (Date.now() - lastHeard > PING_MS * 2) return ws.close()
        ws.send('ping')
      }, PING_MS)
    }
    ws.onmessage = (event) => {
      lastHeard = Date.now()
      if (typeof event.data !== 'string' || event.data === 'pong') return
      try {
        const message = JSON.parse(event.data)
        if (message?.type === 'state' && message.jam) deliver(message.jam)
        else if (message?.type === 'ended') gone(new JamError('La Jam terminó', 404))
      } catch {
        /* mensaje que no es de la Jam */
      }
    }
    ws.onclose = () => {
      if (socket !== ws) return
      drop()
      fallBack()
    }
  }

  /** Sin WebSocket: se pregunta cada 3 s y se reintenta conectar cada vez más espaciado. */
  function fallBack() {
    if (stopped) return
    startPolling()
    void load()
    retry = window.setTimeout(connect, RETRY_MS[Math.min(attempts++, RETRY_MS.length - 1)])
  }

  // Al volver a la app (el teléfono congela o corta las conexiones en segundo plano): estado ya y, si hace falta,
  // WebSocket nuevo sin esperar el próximo reintento.
  const onVisible = (visible: boolean) => {
    if (stopped || !visible) return
    void load()
    if (!open || Date.now() - lastHeard > PING_MS) {
      drop()
      attempts = 0
      connect()
    }
  }

  function stop() {
    stopped = true
    stopPolling()
    window.clearTimeout(retry)
    document.removeEventListener('visibilitychange', onBrowserVisibility)
    void appStateListener?.remove()
    drop()
  }

  const onBrowserVisibility = () => onVisible(document.visibilityState === 'visible')

  if (Capacitor.isNativePlatform()) {
    void App.addListener('appStateChange', ({ isActive }) => onVisible(isActive)).then((listener) => {
      if (stopped) void listener.remove()
      else appStateListener = listener
    })
  } else {
    document.addEventListener('visibilitychange', onBrowserVisibility)
  }
  void load() // el primer estado sin esperar al WebSocket
  connect()
  return { stop, refresh: () => void load() }
}

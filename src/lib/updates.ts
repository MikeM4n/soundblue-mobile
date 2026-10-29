// Aviso de versión nueva: compara la versión con la que se abrió la app con la publicada (version.json, que se pide
// siempre a la red). Se revisa al abrir, cada vez que vuelves a la app y cada 10 minutos. Si hay una más nueva y no está
// sonando nada, la app se recarga sola (una vez por versión). Si está sonando, no corta la música: la versión nueva
// espera y se aplica sola en cuanto la música queda en pausa 3 s; mientras tanto, cada vez que vuelves a la app sale
// «Actualizar ahora». (Antes el aviso salía una sola vez por sesión: con música sonando siempre, un teléfono podía
// quedarse días en una versión vieja.)
import { player } from '../player/engine'
import { showToast } from '../ui/toast'
import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'

const RELOADED_KEY = 'soundblue:recargada-por-version'
const CHECK_EVERY_MS = 10 * 60 * 1000
const IDLE_MS = 3000 // en pausa (o sin nada sonando) este tiempo: se aplica la versión nueva

async function publishedVersion(): Promise<string | null> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}version.json`, { cache: 'no-store' })
    if (!response.ok) return null
    const data: unknown = await response.json()
    const version = (data as { version?: unknown } | null)?.version
    return typeof version === 'string' ? version : null
  } catch {
    return null // sin conexión o sin version.json (al probar con `npm run dev`)
  }
}

let pending: string | null = null // versión publicada más nueva que esta, esperando un momento sin música
let idleTimer: number | undefined
let started = false

const busy = () => {
  const { status } = player.getSnapshot()
  return status === 'playing' || status === 'buffering'
}

/** Recarga si no suena nada. Una sola recarga automática por versión (si después sigue llegando la vieja, no insiste). */
function reloadIfIdle(): boolean {
  if (!pending || busy()) return false
  let reloadedFor: string | null = null
  try {
    reloadedFor = sessionStorage.getItem(RELOADED_KEY)
    if (reloadedFor !== pending) sessionStorage.setItem(RELOADED_KEY, pending)
  } catch {
    reloadedFor = pending // sin almacenamiento: no se recarga sola, solo se ofrece el botón
  }
  if (reloadedFor === pending) return false
  window.location.reload()
  return true
}

async function checkForUpdate() {
  const latest = await publishedVersion()
  if (!latest || latest === __APP_VERSION__) return
  pending = latest
  if (reloadIfIdle()) return
  showToast('Hay una versión nueva de SoundBlue: se aplica sola cuando pauses la música', { label: 'Actualizar ahora', run: () => window.location.reload() }, 15000)
}

export function startUpdateChecks() {
  if (started) return
  started = true
  void checkForUpdate()
  if (Capacitor.isNativePlatform()) {
    void App.addListener('appStateChange', ({ isActive }) => { if (isActive) void checkForUpdate() })
  } else {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void checkForUpdate()
    })
  }
  window.setInterval(() => void checkForUpdate(), CHECK_EVERY_MS)
  // Con una versión nueva esperando: en cuanto la música queda en pausa 3 s, se aplica (la canción queda donde iba).
  player.subscribe(() => {
    if (!pending) return
    if (busy()) {
      window.clearTimeout(idleTimer)
      idleTimer = undefined
      return
    }
    idleTimer ??= window.setTimeout(() => {
      idleTimer = undefined
      reloadIfIdle()
    }, IDLE_MS)
  })
}

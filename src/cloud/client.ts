// Conexión con Supabase (Mi Cuenta). La sesión la lleva el SDK nativo de Supabase (@capgo/capacitor-supabase): el
// código de 6 dígitos por correo, guardar la sesión en el teléfono y renovarla sola. Los datos (me gusta, playlists,
// historial) van por la API REST de Supabase con el token de esa sesión: así se suben en bloques (cientos de filas por
// pedido, con «upsert»), que el plugin no sabe hacer (inserta de a una fila).
// Solo en la app de Android. La clave es la PUBLICABLE (sb_publishable_…): hecha para ir dentro de la app; sin una
// sesión no lee ni escribe nada (Row Level Security, ver docs/supabase.sql). Nunca va aquí la clave secreta.
import { Capacitor } from '@capacitor/core'
import { CapacitorSupabase, type Session, type User } from '@capgo/capacitor-supabase'

export const SUPABASE_URL = 'https://ypaaujjteleobhbhzecg.supabase.co'
const SUPABASE_KEY = 'sb_publishable_L7m8_IwAIcHcZZTWFBJ5Qg_6tSvebiS'

const REQUEST_TIMEOUT_MS = 25_000
const FIRST_STATUS_MS = 6000 // lo que espera al SDK nativo para saber si había una sesión guardada
const RENEW_BEFORE_MS = 60_000 // el token se renueva si le queda menos de 1 minuto
const SIGN_OUT_PENDING_KEY = 'soundblue:cuenta-salida-pendiente' // «Cerrar sesión» sin internet: se termina al abrir

export const cloudEnabled = Capacitor.getPlatform() === 'android'

/** 'offline': hay sesión guardada, pero no se pudo renovar (sin internet). 'signed-out': no hay sesión (o venció). */
export type AuthStatus = 'unknown' | 'signed-in' | 'signed-out' | 'offline'

/** Error al hablar con Supabase. `kind`: sin internet, sesión vencida, o lo que respondió el servidor. */
export class CloudError extends Error {
  constructor(
    readonly kind: 'network' | 'auth' | 'http',
    message: string,
    readonly status = 0,
    readonly code = '',
  ) {
    super(message)
  }
  /** ¿Vale la pena reintentar más tarde? (sin internet, servidor caído o «espera un momento»). */
  get retryable() {
    return this.kind !== 'http' || this.status >= 500 || this.status === 408 || this.status === 429
  }
}

let ready: Promise<AuthStatus> | null = null
let status: AuthStatus = 'unknown'
const statusListeners = new Set<(status: AuthStatus, userId?: string) => void>()

/** Lo que dice el SDK nativo de la sesión (al abrir la app, al entrar, al salir o si no se pudo renovar). */
export function onAuthStatus(listener: (status: AuthStatus, userId?: string) => void) {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

/** Arranca el SDK nativo (una vez) y espera a saber si había una sesión guardada. */
export function startClient(): Promise<AuthStatus> {
  if (!cloudEnabled) return Promise.resolve('signed-out')
  ready ??= boot().catch((error: unknown) => {
    ready = null // que se pueda reintentar
    throw error
  })
  return ready
}

async function boot(): Promise<AuthStatus> {
  let settle: (status: AuthStatus) => void = () => {}
  const first = new Promise<AuthStatus>((resolve) => (settle = resolve))
  // El oyente va ANTES de initialize: el SDK avisa enseguida si encontró una sesión guardada.
  await CapacitorSupabase.addListener('authStateChange', ({ event, session }) => {
    const next: AuthStatus | null =
      event === 'SIGNED_IN' ? 'signed-in' : event === 'SIGNED_OUT' ? 'signed-out' : event === 'TOKEN_REFRESHED' && !session ? 'offline' : null
    if (!next) return
    status = next
    settle(next)
    statusListeners.forEach((listener) => listener(next, session?.user?.id))
  })
  await CapacitorSupabase.initialize({ supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY })
  const known = await Promise.race([first, new Promise<AuthStatus>((resolve) => window.setTimeout(() => resolve('unknown'), FIRST_STATUS_MS))])
  if (known === 'unknown') {
    const session = await CapacitorSupabase.getSession().then((r) => r.session, () => null)
    if (session) status = 'signed-in'
  }
  return status
}

export const authStatus = () => status

/** «Enviar código»: Supabase manda un correo con el código de 6 dígitos (crea la cuenta si es la primera vez). */
export async function sendCode(email: string): Promise<void> {
  await startClient()
  try {
    await CapacitorSupabase.signInWithOtp({ email, shouldCreateUser: true })
  } catch (error) {
    throw new Error(authMessage(error, 'send'))
  }
}

/** «Entrar»: valida el código. Devuelve la cuenta (id y correo). */
export async function verifyCode(email: string, code: string): Promise<{ id: string; email: string }> {
  await startClient()
  let user: User | null = null
  try {
    ;({ user } = await CapacitorSupabase.verifyOtp({ email, token: code, type: 'email' }))
  } catch (error) {
    throw new Error(authMessage(error, 'verify'))
  }
  if (!user?.id) throw new Error('No se pudo iniciar sesión. Pide un código nuevo.')
  status = 'signed-in'
  setSignOutPending(false) // la sesión nueva reemplaza a la que quedó sin cerrar
  return { id: user.id, email: user.email ?? email }
}

/**
 * Cierra la sesión en el teléfono (y en Supabase si hay internet). No toca tu música. Si falla (sin internet), se anota
 * y se vuelve a intentar al abrir la app (retrySignOut), para que la sesión no quede guardada.
 */
export async function endSession(): Promise<void> {
  if (!cloudEnabled) return
  status = 'signed-out'
  try {
    await startClient()
    await CapacitorSupabase.signOut()
    setSignOutPending(false)
  } catch {
    setSignOutPending(true)
  }
}

/** Al abrir la app sin cuenta: termina un «Cerrar sesión» que quedó a medias. */
export async function retrySignOut(): Promise<void> {
  if (!cloudEnabled) return
  try {
    if (localStorage.getItem(SIGN_OUT_PENDING_KEY) !== '1') return
  } catch {
    return
  }
  await endSession()
}

function setSignOutPending(pending: boolean) {
  try {
    if (pending) localStorage.setItem(SIGN_OUT_PENDING_KEY, '1')
    else localStorage.removeItem(SIGN_OUT_PENDING_KEY)
  } catch {
    /* sin almacenamiento */
  }
}

/** Mensajes en español para lo que responde Supabase al pedir o validar el código. */
function authMessage(error: unknown, step: 'send' | 'verify'): string {
  // El plugin antepone «OTP sign in failed:» / «OTP verification failed:»: se mira solo lo que dijo el servidor.
  const text = (error instanceof Error ? error.message : String(error)).replace(/^(OTP (sign in|verification) failed|Sign in failed):\s*/i, '')
  if (/rate limit|only request this after|too many|429/i.test(text)) {
    const seconds = /after (\d+) seconds/i.exec(text)?.[1]
    return seconds ? `Espera ${seconds} segundos antes de pedir otro código.` : 'Se pidieron demasiados códigos. Espera unos minutos e inténtalo de nuevo.'
  }
  if (!navigator.onLine || /unable to resolve|failed to connect|timeout|timed out|network|unreachable|connection|socket/i.test(text)) {
    return 'Sin conexión con el servidor de cuentas. Revisa tu internet e inténtalo de nuevo.'
  }
  if (step === 'verify' && /expired|invalid|incorrect|token|otp/i.test(text)) return 'El código no es válido o ya venció. Revísalo o pide uno nuevo.'
  if (/email.*(invalid|valid)|invalid.*email/i.test(text)) return 'Ese correo no es válido.'
  if (/signups? not allowed|disabled/i.test(text)) return 'El registro con correo está desactivado en el servidor.'
  if (/error sending|smtp|mail/i.test(text)) return 'El servidor no pudo enviar el correo. Inténtalo en unos minutos.'
  return step === 'send' ? 'No se pudo enviar el código. Inténtalo de nuevo.' : 'No se pudo validar el código. Inténtalo de nuevo.'
}

let renewing: Promise<Session | null> | null = null

/**
 * La sesión vigente, renovada si está por vencer (una sola renovación a la vez: el token de renovación es de un uso).
 * Solo se da por VENCIDA si el teléfono dice que no hay sesión o el servidor rechaza el token; si el SDK aún la está
 * renovando (volvió internet, arranque lento), es un error de red y se reintenta después.
 */
async function session(forceRenew = false): Promise<Session> {
  await startClient()
  let current = forceRenew ? null : await CapacitorSupabase.getSession().then((r) => r.session, () => null)
  if (!current || !current.expiresAt || current.expiresAt * 1000 < Date.now() + RENEW_BEFORE_MS) {
    if (!current && status === 'signed-out') throw new CloudError('auth', 'Sin sesión')
    try {
      renewing ??= CapacitorSupabase.refreshSession()
        .then((r) => r.session)
        .finally(() => (renewing = null))
      current = await renewing
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      if (/invalid refresh token|refresh token not found|already used|revoked|invalid grant/i.test(text)) throw new CloudError('auth', 'La sesión venció')
      throw new CloudError('network', 'Sin conexión')
    }
  }
  if (!current?.accessToken) throw new CloudError('network', 'Sesión no disponible todavía')
  return current
}

/**
 * Un pedido a la API REST de Supabase (PostgREST) con la sesión de la cuenta. `path`: tabla y filtros
 * («likes?video_id=in.(…)»). Si el token venció justo, se renueva y se repite una vez.
 */
export async function rest<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, options: { body?: unknown; prefer?: string } = {}, renewed = false): Promise<T> {
  const { accessToken } = await session(renewed)
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response: Response
  let text: string
  try {
    response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(options.prefer ? { Prefer: options.prefer } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })
    text = await response.text() // el tiempo límite cubre también la respuesta completa
  } catch {
    throw new CloudError('network', 'Sin conexión')
  } finally {
    window.clearTimeout(timer)
  }
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!response.ok) {
    const info = (body ?? {}) as { message?: string; code?: string }
    // 401 por el token (vencido o inválido): se renueva una vez. Un «permiso denegado» (42501) no es de la sesión.
    const tokenProblem = response.status === 401 && info.code !== '42501'
    if (tokenProblem && !renewed) return rest<T>(method, path, options, true)
    throw new CloudError(tokenProblem ? 'auth' : 'http', info.message || `HTTP ${response.status}`, response.status, info.code ?? '')
  }
  return body as T
}

/** Todas las filas de una consulta, de a páginas (Supabase devuelve como mucho 1000 por pedido). */
export async function selectAll<T>(table: string, query: string): Promise<T[]> {
  const rows: T[] = []
  for (;;) {
    const page = await rest<T[]>('GET', `${table}?${query}&limit=1000&offset=${rows.length}`)
    if (!Array.isArray(page) || !page.length) return rows
    rows.push(...page)
  }
}

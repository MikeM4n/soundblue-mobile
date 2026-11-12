import { ChevronLeft, LoaderCircle, Mail, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { IconButton } from '../components/ui/IconButton'
import { account, useAccount } from '../cloud/account'
import { cloudEnabled, sendCode, startClient } from '../cloud/client'

const RESEND_SECONDS = 60
const CODE_LENGTH = 6
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/**
 * Iniciar sesión (Ajustes → Mi Cuenta → «Iniciar sesión»): tu correo → «Enviar código» → el código de 6 dígitos que
 * llega por correo → «Entrar». Sin contraseñas. Al entrar, primero se guarda una copia de seguridad de tu música y
 * después se junta con la de tu cuenta (cloud/account.ts); vuelves a Ajustes, donde se ve cómo va.
 */
export function AccountPage() {
  const navigate = useNavigate()
  const { account: current, expired } = useAccount()
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState(current?.email ?? '')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)
  const codeRef = useRef<HTMLInputElement>(null)
  const emailRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (cloudEnabled) void startClient().catch(() => {}) // el SDK nativo arranca mientras escribes
  }, [])
  useEffect(() => {
    ;(step === 'code' ? codeRef : emailRef).current?.focus()
  }, [step])
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setTimeout(() => setCooldown((s) => s - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [cooldown])

  if (current && !expired) return <Navigate to="/ajustes" replace />

  const cleanEmail = email.trim().toLowerCase()

  const send = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!EMAIL.test(cleanEmail)) {
      setError('Escribe un correo válido, p. ej. nombre@gmail.com')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await sendCode(cleanEmail)
      setCode('')
      setStep('code')
      setCooldown(RESEND_SECONDS)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo enviar el código.')
    } finally {
      setBusy(false)
    }
  }

  const enter = async (value = code) => {
    if (value.length < CODE_LENGTH || busy) return
    setBusy(true)
    setError(null)
    try {
      await account.signIn(cleanEmail, value)
      navigate('/ajustes', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo validar el código.')
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-md px-4 pt-4 pb-10">
      <IconButton label="Volver" onClick={() => navigate(-1)} className="-ml-2">
        <ChevronLeft className="size-6" />
      </IconButton>
      <h1 className="mt-2 text-2xl font-bold md:text-3xl">Iniciar sesión</h1>
      <p className="mt-1 text-texto-sec">Guarda tus me gusta, tus playlists y tu historial en la nube. Tu música sigue también en este teléfono.</p>

      {!cloudEnabled ? (
        <p className="mt-6 rounded-lg bg-tarjeta p-4 text-sm text-texto-sec">Solo en la app de Android.</p>
      ) : step === 'email' ? (
        <form onSubmit={(e) => void send(e)} className="mt-6 rounded-lg bg-tarjeta p-4">
          <label htmlFor="cuenta-correo" className="block font-semibold">
            Tu correo
          </label>
          <input
            id="cuenta-correo"
            ref={emailRef}
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="nombre@gmail.com"
            className="mt-2 h-12 w-full rounded-md bg-contraste/10 px-3 text-texto ring-1 ring-contraste/10 outline-none placeholder:text-texto-sec focus:ring-2 focus:ring-acento"
          />
          <p className="mt-2 text-xs text-texto-sec">Te enviaremos un código de {CODE_LENGTH} dígitos. Sin contraseñas.</p>
          {error && (
            <p role="alert" className="mt-3 text-sm text-red-300">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || !email.trim()}
            className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-acento px-6 font-bold text-white shadow-lg shadow-acento/30 enabled:hover:bg-acento-hover disabled:opacity-50"
          >
            {busy ? <LoaderCircle className="size-5 animate-spin" aria-hidden="true" /> : <Mail className="size-5" aria-hidden="true" />}
            {busy ? 'Enviando…' : 'Enviar código'}
          </button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void enter()
          }}
          className="mt-6 rounded-lg bg-tarjeta p-4"
        >
          <label htmlFor="cuenta-codigo" className="block font-semibold">
            Código de {CODE_LENGTH} dígitos
          </label>
          <p className="mt-1 text-sm text-texto-sec">
            Lo enviamos a <span className="font-semibold text-texto">{cleanEmail}</span>. Si no llega en un minuto, revisa «Spam» o «Promociones».
          </p>
          <input
            id="cuenta-codigo"
            ref={codeRef}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={10}
            value={code}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, '').slice(0, 10)
              setCode(digits)
              if (digits.length === CODE_LENGTH && code.length < CODE_LENGTH) void enter(digits) // al completar, entra solo
            }}
            placeholder={'•'.repeat(CODE_LENGTH)}
            aria-describedby="cuenta-codigo-ayuda"
            className="mt-3 h-14 w-full rounded-md bg-contraste/10 px-3 text-center text-2xl font-bold tracking-[0.4em] text-texto ring-1 ring-contraste/10 outline-none placeholder:text-texto-sec focus:ring-2 focus:ring-acento"
          />
          {error && (
            <p role="alert" className="mt-3 text-sm text-red-300">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || code.length < CODE_LENGTH}
            className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-acento px-6 font-bold text-white shadow-lg shadow-acento/30 enabled:hover:bg-acento-hover disabled:opacity-50"
          >
            {busy ? <LoaderCircle className="size-5 animate-spin" aria-hidden="true" /> : <ShieldCheck className="size-5" aria-hidden="true" />}
            {busy ? 'Validando…' : 'Entrar'}
          </button>
          <div id="cuenta-codigo-ayuda" className="mt-3 flex items-center justify-between gap-2 text-sm">
            <button
              type="button"
              onClick={() => {
                setStep('email')
                setError(null)
              }}
              className="py-2 font-semibold text-texto-sec hover:text-texto"
            >
              Cambiar correo
            </button>
            <button type="button" onClick={() => void send()} disabled={busy || cooldown > 0} className="py-2 font-semibold text-acento-texto disabled:text-texto-sec disabled:opacity-60">
              {cooldown > 0 ? `Reenviar código (${cooldown} s)` : 'Reenviar código'}
            </button>
          </div>
        </form>
      )}

      <p className="mt-4 text-sm text-texto-sec">
        Al entrar, primero se guarda una copia de seguridad de tu música en este teléfono. Nada de lo que tienes aquí se borra: si tu cuenta ya tiene música, tú eliges
        cómo juntarlas.
      </p>
    </div>
  )
}

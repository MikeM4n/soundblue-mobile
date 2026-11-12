import { Check, CloudOff, LoaderCircle, LogIn } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router'
import { account, useAccount } from '../../cloud/account'
import { hasBackup, restoreBackups } from '../../cloud/backup'
import { cloudEnabled } from '../../cloud/client'
import { syncStatus } from '../../cloud/sync'
import { showToast } from '../../ui/toast'

const changes = (n: number) => (n === 1 ? '1 cambio' : `${n.toLocaleString('es-CO')} cambios`)

/**
 * Ajustes → Mi Cuenta: iniciar sesión (cloud/account.ts), tu correo, cómo va la sincronización, «Cerrar sesión» (tu
 * música se queda en el teléfono) y «Recuperar copia de seguridad» (suma lo de la copia que se hizo al iniciar sesión;
 * no borra nada). Solo en la app de Android.
 */
export function AccountSection() {
  const { account: current, phase, expired } = useAccount()
  const sync = useSyncExternalStore(syncStatus.subscribe, syncStatus.get)
  const [backup, setBackup] = useState(false)
  const [restoring, setRestoring] = useState(false)
  useEffect(() => {
    if (cloudEnabled) void hasBackup().then(setBackup)
  }, [current?.id, current?.ready])

  const signOut = () => {
    if (!window.confirm('¿Cerrar sesión? Tu música sigue en este teléfono; lo que cambies no se guardará en la nube hasta que vuelvas a entrar.')) return
    void account.signOut().then(() => showToast('Sesión cerrada. Tu música sigue en este teléfono.'))
  }
  const restore = async () => {
    if (!window.confirm('Se agregarán a tu biblioteca los me gusta, playlists y canciones de la copia de seguridad que ya no tengas. No se borra nada. ¿Recuperar?')) return
    setRestoring(true)
    const added = await restoreBackups()
    setRestoring(false)
    if (!added) {
      showToast('No hay espacio en el teléfono para recuperar la copia de seguridad.', undefined, 4000)
      return
    }
    const parts = [
      added.favorites && `${added.favorites} me gusta`,
      added.playlists && (added.playlists === 1 ? '1 playlist' : `${added.playlists} playlists`),
      added.songs && (added.songs === 1 ? '1 canción en tus playlists' : `${added.songs} canciones en tus playlists`),
      added.saved && (added.saved === 1 ? '1 playlist guardada' : `${added.saved} playlists guardadas`),
    ].filter(Boolean)
    showToast(parts.length ? `Recuperado: ${parts.join(', ')}` : 'Ya tenías todo lo de la copia de seguridad', undefined, 4500)
  }

  return (
    <section aria-labelledby="ajustes-cuenta" className="rounded-lg bg-tarjeta p-4">
      <h2 id="ajustes-cuenta" className="text-lg font-bold">
        Mi Cuenta
      </h2>
      {!cloudEnabled ? (
        <p className="mt-1 text-sm text-texto-sec">Solo en la app de Android.</p>
      ) : !current ? (
        <>
          <p className="mt-1 text-sm text-texto-sec">
            Inicia sesión con tu correo para guardar tus me gusta, tus playlists y tu historial en la nube y no perderlos si cambias de teléfono. Tu música sigue también aquí.
          </p>
          <Link to="/cuenta" className="mt-3 inline-flex items-center gap-2 rounded-full bg-acento px-5 py-2.5 font-bold text-white shadow-lg shadow-acento/30 hover:bg-acento-hover">
            <LogIn className="size-4" aria-hidden="true" />
            Iniciar sesión
          </Link>
        </>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-acento text-lg font-bold text-white uppercase" aria-hidden="true">
              {current.email.charAt(0)}
            </span>
            <div className="min-w-0">
              <p className="truncate font-semibold">{current.email}</p>
              <p className="text-sm text-texto-sec">{expired ? 'Sesión vencida' : 'Sesión iniciada'}</p>
            </div>
          </div>
          {renderStatus()}
          <button
            type="button"
            onClick={signOut}
            disabled={phase.kind === 'working'}
            className="mt-4 rounded-full bg-contraste/10 px-4 py-2 text-sm font-semibold transition-colors hover:bg-contraste/15 disabled:opacity-40"
          >
            Cerrar sesión
          </button>
        </>
      )}
      {cloudEnabled && backup && (
        <div className="mt-4 border-t border-contraste/10 pt-3">
          <button type="button" onClick={() => void restore()} disabled={restoring || phase.kind === 'working'} className="text-sm font-semibold text-acento-texto hover:underline disabled:opacity-40">
            {restoring ? 'Recuperando…' : 'Recuperar copia de seguridad'}
          </button>
          <p className="text-xs text-texto-sec">Suma lo que tenías antes de iniciar sesión y ya no esté. No borra nada.</p>
        </div>
      )}
    </section>
  )

  /** Cómo va: juntando tu música, eligiendo, error, sesión vencida o la sincronización. */
  function renderStatus() {
    if (!current) return null
    const line = 'mt-3 flex items-start gap-2 text-sm'
    if (expired) {
      return (
        <div className="mt-3 text-sm">
          <p className="text-amber-400">Tu sesión venció. Vuelve a entrar para seguir guardando tus cambios en la nube (mientras tanto se guardan en el teléfono).</p>
          <Link to="/cuenta" className="mt-2 inline-flex rounded-full bg-acento px-4 py-2 font-bold text-white hover:bg-acento-hover">
            Volver a entrar
          </Link>
        </div>
      )
    }
    if (phase.kind === 'working') {
      return (
        <p className={`${line} text-texto-sec`} role="status">
          <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden="true" />
          {phase.message}
        </p>
      )
    }
    if (phase.kind === 'error') {
      return (
        <div className="mt-3 text-sm">
          <p role="alert" className="text-red-300">
            {phase.message}
          </p>
          <button type="button" onClick={account.retry} className="mt-2 rounded-full bg-acento px-4 py-2 font-bold text-white hover:bg-acento-hover">
            Reintentar
          </button>
        </div>
      )
    }
    if (!current.ready) {
      return (
        <div className="mt-3 text-sm">
          <p className="text-amber-400">Falta elegir cómo juntar tu música con la de tu cuenta. Mientras tanto no se sincroniza.</p>
          <button type="button" onClick={account.reopenChoice} className="mt-2 rounded-full bg-acento px-4 py-2 font-bold text-white hover:bg-acento-hover">
            Elegir ahora
          </button>
        </div>
      )
    }
    if (sync.state === 'offline') {
      return (
        <p className={`${line} text-texto-sec`}>
          <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Sin conexión: {changes(sync.pending)} se {sync.pending === 1 ? 'subirá' : 'subirán'} a tu cuenta cuando vuelva internet.
        </p>
      )
    }
    if (sync.state === 'syncing' || (sync.state === 'pending' && sync.pending > 0)) {
      return (
        <p className={`${line} text-texto-sec`} role="status">
          <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden="true" />
          Guardando tus cambios en la nube…
        </p>
      )
    }
    return (
      <p className={`${line} text-texto-sec`}>
        <Check className="mt-0.5 size-4 shrink-0 text-acento-texto" aria-hidden="true" />
        Todo guardado en tu cuenta: tus me gusta, playlists e historial se guardan en el teléfono y en la nube.
      </p>
    )
  }
}

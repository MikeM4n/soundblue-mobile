import { Cloud, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { account, describeCounts, useAccount } from '../../cloud/account'

/**
 * Al iniciar sesión, si tu cuenta ya tiene música y el teléfono también: «Fusionar» (se juntan sin repetir canciones ni
 * playlists; no se borra nada) o «Mantener solo la nube» (el teléfono queda como tu cuenta; lo de antes queda en la
 * copia de seguridad, que se recupera en Ajustes → Mi Cuenta). Esta segunda pide confirmación. «Decidir después» lo
 * cierra: no se sincroniza hasta que elijas (Ajustes → Mi Cuenta → «Elegir ahora»).
 */
export function MergeDialog() {
  const { phase } = useAccount()
  const [confirming, setConfirming] = useState(false)
  const choosing = phase.kind === 'choose' && phase.open
  const working = phase.kind === 'working' && phase.modal
  useEffect(() => {
    if (!choosing) setConfirming(false)
  }, [choosing])
  if (!choosing && !working) return null

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="fusion-titulo" className="max-h-[90dvh] w-full max-w-sm overflow-y-auto rounded-xl bg-panel p-5 shadow-2xl ring-1 ring-contraste/10">
        <span className="grid size-11 place-items-center rounded-full bg-acento text-white" aria-hidden="true">
          <Cloud className="size-5" />
        </span>
        {working ? (
          <>
            <h2 id="fusion-titulo" className="mt-3 text-lg font-bold">
              Un momento…
            </h2>
            <p className="mt-2 flex items-center gap-2 text-sm text-texto-sec" role="status">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              {phase.kind === 'working' ? phase.message : ''}
            </p>
          </>
        ) : phase.kind === 'choose' && !confirming ? (
          <>
            <h2 id="fusion-titulo" className="mt-3 text-lg font-bold">
              Tu cuenta ya tiene música
            </h2>
            <p className="mt-1 text-sm text-texto-sec">¿Cómo la juntamos con la de este teléfono? Ya guardamos una copia de seguridad de lo que tienes aquí.</p>
            <dl className="mt-3 space-y-2 rounded-lg bg-contraste/5 p-3 text-sm">
              <div>
                <dt className="font-semibold">En este teléfono</dt>
                <dd className="text-texto-sec">{describeCounts(phase.local)}</dd>
              </div>
              <div>
                <dt className="font-semibold">En tu cuenta</dt>
                <dd className="text-texto-sec">{describeCounts(phase.cloud)}</dd>
              </div>
            </dl>
            <button type="button" onClick={() => void account.choose('merge')} className="mt-4 w-full rounded-2xl bg-acento px-4 py-3 text-left text-white shadow-lg shadow-acento/30 hover:bg-acento-hover">
              <span className="block font-bold">Fusionar (recomendado)</span>
              <span className="block text-sm text-white/85">Se juntan las dos sin repetir canciones ni playlists. No se borra nada.</span>
            </button>
            <button type="button" onClick={() => setConfirming(true)} className="mt-2 w-full rounded-2xl bg-contraste/10 px-4 py-3 text-left hover:bg-contraste/15">
              <span className="block font-bold">Mantener solo la nube</span>
              <span className="block text-sm text-texto-sec">Este teléfono queda igual que tu cuenta. Lo que solo está aquí queda en la copia de seguridad.</span>
            </button>
            <div className="mt-3 flex justify-end">
              <button type="button" onClick={account.postponeChoice} className="rounded-full px-4 py-2 text-sm font-semibold text-texto-sec hover:text-texto">
                Decidir después
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="fusion-titulo" className="mt-3 text-lg font-bold">
              ¿Mantener solo la nube?
            </h2>
            <p className="mt-2 text-sm">
              Los me gusta, playlists e historial que solo están en este teléfono dejarán de verse aquí. No se pierden: quedan en la copia de seguridad y los recuperas cuando
              quieras en Ajustes → Mi Cuenta → «Recuperar copia de seguridad».
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirming(false)} className="rounded-full px-4 py-2 font-semibold text-texto-sec hover:text-texto">
                Volver
              </button>
              <button type="button" onClick={() => void account.choose('cloud')} className="rounded-full bg-contraste/15 px-5 py-2 font-bold hover:bg-contraste/20">
                Sí, solo la nube
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

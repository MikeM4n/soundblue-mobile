import { Download } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { findApkUpdate, installApkUpdate, type ApkUpdate } from '../../lib/apkUpdate'

type Step = { kind: 'ask' } | { kind: 'downloading'; percent: number } | { kind: 'installing' } | { kind: 'error'; message: string }

/**
 * «Nueva versión de SoundBlue disponible»: se revisa una vez al abrir la app (lib/apkUpdate.ts). «Ahora no» lo cierra
 * hasta la próxima vez que la abras. Mientras baja se puede ocultar: el instalador se abre igual al terminar.
 */
export function ApkUpdatePrompt() {
  const [update, setUpdate] = useState<ApkUpdate | null>(null)
  const [step, setStep] = useState<Step>({ kind: 'ask' })

  useEffect(() => {
    let alive = true
    void findApkUpdate().then((found) => alive && setUpdate(found))
    return () => {
      alive = false
    }
  }, [])

  if (!update) return null
  const close = () => setUpdate(null)
  const start = () => {
    setStep({ kind: 'downloading', percent: 0 })
    installApkUpdate(update, (percent) => setStep({ kind: 'downloading', percent }))
      .then(() => setStep({ kind: 'installing' }))
      .catch((error: unknown) => setStep({ kind: 'error', message: error instanceof Error ? error.message : 'No se pudo descargar la actualización.' }))
  }

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="actualizacion-titulo"
        className="w-full max-w-sm rounded-xl bg-panel p-5 shadow-2xl ring-1 ring-contraste/10"
      >
        <span className="grid size-11 place-items-center rounded-full bg-acento text-white" aria-hidden="true">
          <Download className="size-5" />
        </span>
        <h2 id="actualizacion-titulo" className="mt-3 text-lg font-bold">
          Nueva versión de SoundBlue disponible.
        </h2>
        {step.kind === 'ask' && <p className="mt-1">¿Quieres actualizar?</p>}
        <p className="mt-2 text-sm text-texto-sec">
          Versión {update.versionName}
          {update.changelog && ` · ${update.changelog}`}
        </p>

        {step.kind === 'downloading' && (
          <div className="mt-4" role="status">
            <p className="text-sm font-semibold">Descargando… {step.percent} %</p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-contraste/15">
              <div className="h-full rounded-full bg-acento transition-[width]" style={{ width: `${step.percent}%` }} />
            </div>
          </div>
        )}
        {step.kind === 'installing' && (
          <p className="mt-4 text-sm" role="status">
            Sigue los pasos del instalador de Android. Si te pide permitir «Instalar apps desconocidas», actívalo para SoundBlue y
            vuelve atrás.
          </p>
        )}
        {step.kind === 'error' && (
          <p className="mt-4 text-sm text-red-300" role="alert">
            {step.message}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={close} className="rounded-full px-4 py-2 font-semibold text-texto-sec hover:text-texto">
            {step.kind === 'ask' ? 'Ahora no' : step.kind === 'downloading' ? 'Ocultar' : 'Cerrar'}
          </button>
          {(step.kind === 'ask' || step.kind === 'error') && (
            <button type="button" onClick={start} className="rounded-full bg-acento px-5 py-2 font-bold text-white hover:bg-acento-hover">
              {step.kind === 'error' ? 'Reintentar' : 'Actualizar'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

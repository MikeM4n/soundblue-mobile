import { useSyncExternalStore } from 'react'
import { stageBox } from '../../player/stage'
import { dismissToast, toastStore } from '../../ui/toast'

/**
 * Muestra el aviso actual abajo, encima de la barra. Si el video de YouTube está en esa zona,
 * el aviso se sube: nada puede quedar encima del video.
 */
export function Toaster() {
  const toast = useSyncExternalStore(toastStore.subscribe, toastStore.get)
  const video = useSyncExternalStore(stageBox.subscribe, stageBox.get)
  if (!toast) return null

  const main = document.querySelector('main')?.getBoundingClientRect()
  // + lo que creció la barra inferior con navegación por 3 botones (con gestos mide 70 px: no cambia nada).
  const navGrowth = Math.max(0, (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')) || 0) - 70)
  let bottom = (main ? window.innerHeight - main.bottom + 12 : 96) + navGrowth
  const toastTop = window.innerHeight - bottom - 56
  if (video && video.top + video.height > toastTop && video.top < window.innerHeight - bottom) {
    bottom = window.innerHeight - video.top + 8
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4" style={{ bottom }}>
      <div
        key={toast.id}
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex max-w-md items-center gap-4 rounded-lg bg-texto py-3 pr-3 pl-4 text-sm font-medium text-fondo shadow-xl shadow-black/40"
      >
        <span>{toast.message}</span>
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action!.run()
              dismissToast()
            }}
            className="shrink-0 rounded px-2 py-1 font-bold text-acento-inverso hover:bg-fondo/10"
          >
            {toast.action.label}
          </button>
        )}
      </div>
    </div>
  )
}

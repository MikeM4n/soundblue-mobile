import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { usePreventTouchMove } from '../../lib/usePreventTouchMove'
import { QueueSections } from '../tracks/QueueSections'

interface QueuePanelProps {
  open: boolean
  top: number // hasta dónde sube (en «Letra», justo debajo del video)
  onClose: () => void
}

const CLOSE_FRACTION = 0.3 // se cierra si se baja más del 30 % de su altura…
const FLING = 0.5 // …o con un movimiento rápido hacia abajo (px/ms)
const FLING_WINDOW = 120 // ms

/**
 * Mide la velocidad del dedo en los últimos ~120 ms antes de soltar, para cerrar con un «flick» aunque el
 * recorrido sea corto. Si el dedo se detuvo antes de soltar, la velocidad es 0 (no cuenta como flick).
 */
function createFlingTracker() {
  let samples: { y: number; t: number }[] = []
  return {
    reset(y: number) {
      samples = [{ y, t: performance.now() }]
    },
    add(y: number) {
      const now = performance.now()
      samples = [...samples.filter((s) => now - s.t < FLING_WINDOW), { y, t: now }]
    },
    velocity() {
      const now = performance.now()
      const recent = samples.filter((s) => now - s.t < FLING_WINDOW)
      if (recent.length < 2) return 0
      const first = recent[0]
      const last = recent[recent.length - 1]
      return (last.y - first.y) / Math.max(1, last.t - first.t)
    },
  }
}

// Hacia abajo sigue al dedo; hacia arriba apenas cede (resistencia), porque ya está abierto del todo.
const follow = (dy: number) => (dy < 0 ? Math.max(-24, dy * 0.2) : dy)

/**
 * Hoja inferior «Próximas en sonar», dentro de «Sonando ahora». Se cierra arrastrando hacia abajo desde su
 * borde superior, o desde la lista cuando ya está arriba del todo (con la lista desplazada, el mismo gesto la
 * desplaza). Cerrarla solo oculta la cola: la canción sigue igual. Dentro: las pestañas En Cola, Recomendadas y Por Descubrir (QueueSections).
 */
export function QueuePanel({ open, top, onClose }: QueuePanelProps) {
  const [dragY, setDragY] = useState<number | null>(null)
  const drag = useRef<{ pointerId: number; startY: number; dy: number } | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const handleRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const fling = useRef(createFlingTracker()).current
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  usePreventTouchMove(handleRef, () => drag.current !== null)

  // ¿Al soltar, se cierra o vuelve a abrirse?
  const shouldClose = useRef((moved: number) => {
    const height = panelRef.current?.offsetHeight || window.innerHeight
    return moved > height * CLOSE_FRACTION || (fling.velocity() > FLING && moved > 24)
  }).current

  // Desde la lista: con la lista arriba del todo, arrastrar hacia abajo baja el panel en vez de desplazarla.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    let pull: { startX: number; startY: number; active: boolean; dy: number } | null = null
    const onStart = (e: TouchEvent) => {
      const onHandle = (e.target as Element).closest('[aria-label^="Mover "]') // el asa ≡ reordena, no cierra
      pull = onHandle || e.touches.length > 1 ? null : { startX: e.touches[0].clientX, startY: e.touches[0].clientY, active: false, dy: 0 }
      if (pull) fling.reset(pull.startY)
    }
    const onMove = (e: TouchEvent) => {
      if (!pull) return
      const dx = e.touches[0].clientX - pull.startX
      const dy = e.touches[0].clientY - pull.startY
      if (!pull.active) {
        if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return
        // Solo si es hacia abajo, más vertical que horizontal, y la lista no puede subir más.
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || list.scrollTop > 0) {
          pull = null
          return
        }
        pull.active = true
      }
      if (e.cancelable) e.preventDefault()
      fling.add(e.touches[0].clientY)
      pull.dy = Math.max(0, dy)
      setDragY(pull.dy)
    }
    const onEnd = () => {
      const moved = pull?.active ? pull.dy : null
      pull = null
      if (moved === null) return
      setDragY(null)
      if (shouldClose(moved)) onCloseRef.current()
    }
    list.addEventListener('touchstart', onStart, { passive: true })
    list.addEventListener('touchmove', onMove, { passive: false })
    list.addEventListener('touchend', onEnd)
    list.addEventListener('touchcancel', onEnd)
    return () => {
      list.removeEventListener('touchstart', onStart)
      list.removeEventListener('touchmove', onMove)
      list.removeEventListener('touchend', onEnd)
      list.removeEventListener('touchcancel', onEnd)
    }
  }, [fling, shouldClose])

  // Desde el borde superior (asa y título).
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('button, a')) return // «Cerrar» funciona como botón normal
    drag.current = { pointerId: e.pointerId, startY: e.clientY, dy: 0 }
    fling.reset(e.clientY)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    d.dy = e.clientY - d.startY
    fling.add(e.clientY)
    setDragY(follow(d.dy))
  }
  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    setDragY(null)
    if (shouldClose(d.dy)) onClose()
  }

  // La capa oscura se aclara a medida que el panel baja.
  const height = panelRef.current?.offsetHeight || window.innerHeight
  const lowered = open ? Math.min(1, Math.max(0, (dragY ?? 0) / height)) : 1
  const animate = dragY === null
  return (
    <>
      <div
        aria-hidden="true"
        className={`absolute inset-0 bg-black/60 ${open ? '' : 'pointer-events-none'}`}
        style={{ opacity: 1 - lowered, transition: animate ? 'opacity 300ms ease' : 'none' }}
        onPointerDown={(e) => e.stopPropagation()} // no minimiza «Sonando ahora»
        onClick={(e) => {
          e.stopPropagation()
          onClose() // tocar fuera también cierra la cola
        }}
      />
      <section
        ref={panelRef}
        data-queue-panel
        aria-label="Próximas en sonar"
        aria-hidden={!open}
        inert={!open} // cerrado, nada de adentro recibe el foco (y no puede desplazar «Sonando ahora»)
        className={`absolute inset-x-0 bottom-0 flex flex-col rounded-t-2xl bg-panel text-texto shadow-[0_-12px_40px_rgb(0_0_0/0.6)] ${open ? '' : 'pointer-events-none invisible'}`}
        style={{
          top,
          transform: `translateY(${open ? `${dragY ?? 0}px` : '100%'})`,
          transition: animate ? 'transform 300ms cubic-bezier(.2,.8,.2,1)' : 'none',
        }}
        onPointerDown={(e) => e.stopPropagation()} // los gestos de adentro no minimizan «Sonando ahora»
        onClick={(e) => e.stopPropagation()}
      >
        {/* Borde superior: arrastrar hacia abajo cierra el panel. */}
        <div
          ref={handleRef}
          className="shrink-0 cursor-grab touch-none px-4 pt-2 pb-1"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="mx-auto h-1 w-10 rounded-full bg-contraste/30" aria-hidden="true" />
          <div className="mt-2 flex items-center justify-between gap-3">
            <h2 className="text-lg font-bold">Próximas en sonar</h2>
            <button type="button" onClick={onClose} className="text-sm text-texto-sec hover:text-texto">
              Cerrar
            </button>
          </div>
        </div>
        <div ref={listRef} className="scroll-fino min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain pb-[calc(env(safe-area-inset-bottom)+12px)]">
          {open && <div className="queue-pure-black"><QueueSections /></div>}
        </div>
      </section>
    </>
  )
}

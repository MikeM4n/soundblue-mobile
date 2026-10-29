/**
 * Esqueletos grises de Inicio mientras llegan los datos: la forma de lo que viene (filas de canciones, tarjetas de
 * artista), en vez de un «Cargando…». Laten suave, salvo con «reducir movimiento».
 */
export function SkeletonRows({ rows = 4, label = 'Cargando…', className = '' }: { rows?: number; label?: string; className?: string }) {
  return (
    <div role="status" className={`max-w-md px-2 motion-safe:animate-pulse md:px-4 ${className}`}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-16 items-center gap-3 pr-3 pl-2 md:pl-4" aria-hidden="true">
          <span className="size-12 shrink-0 rounded bg-contraste/10" />
          <span className="min-w-0 flex-1 space-y-2">
            <span className="block h-3.5 w-3/4 rounded bg-contraste/10" />
            <span className="block h-3 w-1/2 rounded bg-contraste/10" />
          </span>
        </div>
      ))}
    </div>
  )
}

/** Un estante entero en gris: título y filas (para «Para ti» y las tendencias antes de saber qué estantes habrá). */
export function SkeletonSection({ rows = 4, label }: { rows?: number; label?: string }) {
  return (
    <section className="mt-8">
      <div className="mb-3 px-4 motion-safe:animate-pulse md:px-6" aria-hidden="true">
        <span className="block h-6 w-44 rounded bg-contraste/10" />
      </div>
      <SkeletonRows rows={rows} label={label} />
    </section>
  )
}

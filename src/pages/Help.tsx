import type { ReactNode } from 'react'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-lg bg-tarjeta p-4"><h2 className="text-lg font-bold">{title}</h2><div className="mt-2 space-y-2 text-sm text-texto-sec">{children}</div></section>
}
const B = ({ children }: { children: ReactNode }) => <span className="font-semibold text-texto">{children}</span>

export function Help() {
  return <div className="mx-auto max-w-2xl space-y-4 px-4 pt-6 pb-10">
    <h1 className="text-2xl font-bold md:text-3xl">Ayuda</h1>
    <Section title="Reproducción"><p>La app reproduce audio en segundo plano. Usa los controles de la notificación o de tus audífonos para pausar, volver a la canción anterior o avanzar a la siguiente.</p><p>La pantalla <B>Sonando ahora</B> muestra la canción actual y permite controlar la reproducción.</p></Section>
    <Section title="Gestos"><ul className="list-disc space-y-2 pl-5"><li>Desliza una canción hacia la izquierda para agregarla a la cola o reproducirla a continuación.</li><li>Deslízala hacia la derecha para quitarla de la cola o abrir sus opciones.</li></ul></Section>
    <Section title="Cola de reproducción"><p>En <B>Próximas en sonar</B> puedes ver y ordenar la cola. Las canciones agregadas por ti suenan antes que las demás.</p><p>La <B>Fila Dinámica</B> mantiene canciones recomendadas al final de la cola y se puede activar o desactivar en Ajustes.</p></Section>
  </div>
}
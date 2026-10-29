// Pantalla de carga (está en index.html para que aparezca al instante): se queda 1,2 s desde que se abrió la app (o lo
// que tarde la interfaz en dibujarse, si es más) y luego se desvanece hacia Inicio. Nunca espera a la red: lo que falte
// de Inicio sale en gris (esqueletos) mientras llega. Con «reducir movimiento», solo 0,6 s. Si la interfaz tardara más,
// index.html la quita igual a los 2 s.
const SHOWN_MS = 1200
const SHOWN_REDUCED_MS = 600

export function hideSplash() {
  const splash = document.getElementById('splash')
  if (!splash) return
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const wait = Math.max(0, (reduced ? SHOWN_REDUCED_MS : SHOWN_MS) - performance.now())
  window.setTimeout(() => {
    splash.classList.add('splash-out')
    window.setTimeout(() => splash.remove(), 500) // después del desvanecido (450 ms)
  }, wait)
}

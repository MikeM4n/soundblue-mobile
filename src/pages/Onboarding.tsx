import { Heart, Music, Play, SkipBack, SkipForward, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ArtistPicker } from '../components/tastes/ArtistPicker'
import { GenrePicker } from '../components/tastes/GenrePicker'
import { Switch } from '../components/ui/Switch'
import { favoriteGenres } from '../data/favoriteGenres'
import { cancelPrefetch, schedulePrefetch } from '../data/prefetch'
import { readTastes, saveTastes, SUGGESTED_ARTISTS } from '../data/tastes'
import type { YtmCard } from '../data/ytmusic'
import { onboarding } from '../lib/onboarding'
import { settings, useSettings } from '../lib/settings'

const STEPS = 4

/**
 * Bienvenida, a pantalla completa la primera vez que abres la app o cuando la pides en Ajustes (lib/onboarding.ts):
 * tus artistas, tus ritmos, la Fila Dinámica y el widget. Lo que elijas se guarda igual que en «Cambiar tus artistas»,
 * en Ajustes → Mis Géneros Favoritos y en Ajustes → Fila Dinámica, y «Empezar a escuchar» lleva a Inicio. Mientras
 * eliges artistas y géneros, lo que Inicio va a mostrar se precarga en segundo plano (data/prefetch.ts).
 */
export function Onboarding() {
  const navigate = useNavigate()
  const { dynamicQueue } = useSettings()
  const [step, setStep] = useState(0)
  const [artists, setArtists] = useState<YtmCard[]>(() => readTastes()?.artists ?? [])

  const go = (next: number) => {
    // Al dejar el paso de artistas se guardan tal cual (también si no elegiste ninguno o quitaste los que tenías):
    // Inicio ya no los vuelve a pedir y se cambian después en «Cambiar tus artistas».
    if (step === 0) saveTastes(artists)
    setStep(next)
    window.scrollTo(0, 0)
  }

  const pickArtists = (next: YtmCard[]) => {
    setArtists(next)
    schedulePrefetch(next, favoriteGenres.get())
  }

  const finish = () => {
    cancelPrefetch()
    navigate('/', { replace: true })
    onboarding.finish()
  }

  return (
    <div className="flex min-h-dvh flex-col bg-fondo pt-[env(safe-area-inset-top)] text-texto">
      <main className="flex-1 px-4 pt-8 md:px-6">
        <p className="text-sm font-semibold text-acento-texto">
          Paso {step + 1} de {STEPS}
        </p>
        {step === 0 && (
          <>
            <h1 className="mt-1 text-3xl font-bold md:text-4xl">Selecciona tus artistas favoritos</h1>
            <p className="mt-2 text-texto-sec">
              Elige {SUGGESTED_ARTISTS} o más y te recomendaremos música. Al tocar uno aparecen otros parecidos; tócalo otra vez para quitarlo.
            </p>
            <ArtistPicker selected={artists} onChange={pickArtists} />
          </>
        )}
        {step === 1 && (
          <>
            <h1 className="mt-1 text-3xl font-bold md:text-4xl">Elige tus ritmos favoritos</h1>
            <p className="mt-2 text-texto-sec">
              Con ellos se arman tus selecciones, las recomendaciones y la cola. Puedes cambiarlos cuando quieras en Ajustes.
            </p>
            <p className="mt-4 flex gap-3 rounded-lg bg-tarjeta p-3 text-sm text-texto">
              <SlidersHorizontal className="mt-0.5 size-5 shrink-0 text-acento-texto" aria-hidden="true" />
              <span>Elige tus ritmos favoritos para las sugerencias. Más adelante puedes personalizar cada Modo de Ambiente (Rumba, Tomar, Relax) a tu gusto.</span>
            </p>
            <GenrePicker className="mt-6" onChange={(genres) => schedulePrefetch(artists, genres)} />
          </>
        )}
        {step === 2 && (
          <>
            <h1 className="mt-1 text-3xl font-bold md:text-4xl">Que la música no pare</h1>
            <p className="mt-2 text-texto-sec">Cuando se acaba lo que elegiste, siguen sonando canciones parecidas.</p>
            <Switch
              className="mt-6 max-w-xl rounded-lg bg-tarjeta p-4"
              label="Activar Fila Dinámica"
              note="La cola nunca baja de 10: si se acaba la lista, entran canciones de «Recomendadas». Puedes cambiarlo en Ajustes."
              checked={dynamicQueue}
              onChange={(on) => settings.set({ dynamicQueue: on })}
            />
          </>
        )}
        {step === 3 && (
          <>
            <h1 className="mt-1 text-3xl font-bold md:text-4xl">Tu música desde el inicio</h1>
            <p className="mt-2 text-texto-sec">Añade el widget a tu inicio para controlar la música rápido. (Funciona en Android 12 o superior)</p>
            <WidgetPreview />
            <ol className="mt-6 max-w-xl list-decimal space-y-2 pl-5 text-sm text-texto-sec">
              <li>Mantén presionado un espacio vacío de tu pantalla de inicio.</li>
              <li>Toca «Widgets» y busca SoundBlue.</li>
              <li>Arrástralo a donde quieras tenerlo.</li>
            </ol>
          </>
        )}
      </main>

      {/* Acciones siempre a la vista, al pie de la pantalla. */}
      <footer className="sticky bottom-0 flex items-center justify-between gap-3 bg-linear-to-t from-fondo via-fondo/95 to-transparent px-4 pt-8 pb-[calc(env(safe-area-inset-bottom)+1rem)] md:px-6">
        <div className="w-20 shrink-0">
          {step > 0 && (
            <button type="button" onClick={() => go(step - 1)} className="rounded-full px-4 py-2 font-semibold text-texto-sec hover:text-texto">
              Atrás
            </button>
          )}
        </div>
        <ol className="flex gap-2" aria-label={`Paso ${step + 1} de ${STEPS}`}>
          {Array.from({ length: STEPS }, (_, i) => (
            <li key={i} className={`size-2 rounded-full ${i === step ? 'bg-acento' : 'bg-contraste/20'}`} />
          ))}
        </ol>
        <button
          type="button"
          onClick={step < STEPS - 1 ? () => go(step + 1) : finish}
          className="shrink-0 rounded-full bg-acento px-5 py-3 font-bold whitespace-nowrap text-white transition hover:bg-acento-hover"
        >
          {step === STEPS - 1 ? 'Empezar a escuchar' : step === 0 && artists.length ? `Siguiente (${artists.length})` : 'Siguiente'}
        </button>
      </footer>
    </div>
  )
}

/** El widget de Android en pequeño (los colores de widget/SoundBlueWidget.kt): carátula, canción, ⏮ ▶ ⏭ y ♥. */
function WidgetPreview() {
  return (
    <div className="mt-6 flex max-w-sm items-center gap-3 rounded-3xl bg-[#1f1f1f] p-3 text-white shadow-lg" aria-hidden="true">
      <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-acento">
        <Music className="size-6" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">Tu canción</span>
        <span className="block truncate text-xs text-white/60">Tu artista</span>
      </span>
      <SkipBack className="size-5 shrink-0" fill="currentColor" />
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-white text-black">
        <Play className="size-5" fill="currentColor" />
      </span>
      <SkipForward className="size-5 shrink-0" fill="currentColor" />
      <Heart className="size-5 shrink-0 text-[#4169e1]" fill="currentColor" />
    </div>
  )
}

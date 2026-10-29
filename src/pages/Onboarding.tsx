import { Download, Heart, ListPlus } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { ArtistPicker } from '../components/tastes/ArtistPicker'
import { GenrePicker } from '../components/tastes/GenrePicker'
import { readTastes, saveTastes, skipTastes, SUGGESTED_ARTISTS } from '../data/tastes'
import type { YtmCard } from '../data/ytmusic'
import { markOnboardingSeen } from '../lib/onboarding'

const STEPS = 3

/**
 * Bienvenida, a pantalla completa la primera vez que abres la app (lib/onboarding.ts): tus artistas, tus ritmos y cómo
 * traer tu música. Lo que elijas se guarda igual que en «Cambiar tus artistas» y en Ajustes → Mis Géneros Favoritos,
 * y «Empezar a escuchar» lleva a Inicio.
 */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [artists, setArtists] = useState<YtmCard[]>(() => readTastes()?.artists ?? [])

  const go = (next: number) => {
    // Al dejar el paso de artistas se guardan; sin elegir ninguno, Inicio ya no los vuelve a pedir (se cambian después).
    if (step === 0) {
      if (artists.length) saveTastes(artists)
      else skipTastes()
    }
    setStep(next)
    window.scrollTo(0, 0)
  }

  const finish = () => {
    markOnboardingSeen()
    navigate('/', { replace: true })
    onDone()
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
            <ArtistPicker selected={artists} onChange={setArtists} />
          </>
        )}
        {step === 1 && (
          <>
            <h1 className="mt-1 text-3xl font-bold md:text-4xl">Elige tus ritmos favoritos</h1>
            <p className="mt-2 text-texto-sec">
              Con ellos se arman tus selecciones, las recomendaciones y la cola. Puedes cambiarlos cuando quieras en Ajustes.
            </p>
            <GenrePicker className="mt-6" />
          </>
        )}
        {step === 2 && (
          <>
            <h1 className="mt-1 text-3xl font-bold md:text-4xl">Importa tu música</h1>
            <p className="mt-2 text-texto-sec">Trae a SoundBlue lo que ya escuchas y arma tus propias listas.</p>
            <ul className="mt-6 max-w-xl space-y-3">
              <Tip icon={<Download className="size-5" />} title="Importa playlists de YouTube">
                En Tu biblioteca toca «Importar playlist» y pega el enlace de una playlist pública de YouTube o YouTube Music: sus
                canciones pasan a Tus me gusta.
              </Tip>
              <Tip icon={<ListPlus className="size-5" />} title="Crea tus listas">
                En Tu biblioteca toca + para crear una playlist y agrégale canciones con «Agregar a playlist» en el menú ⋮ de
                cualquier canción.
              </Tip>
              <Tip icon={<Heart className="size-5" />} title="Guarda lo que te gusta">
                Toca el corazón mientras suena una canción y queda en Tus me gusta.
              </Tip>
            </ul>
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

function Tip({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-4 rounded-lg bg-tarjeta p-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-acento text-white" aria-hidden="true">
        {icon}
      </span>
      <span>
        <span className="block font-bold">{title}</span>
        <span className="mt-1 block text-sm text-texto-sec">{children}</span>
      </span>
    </li>
  )
}

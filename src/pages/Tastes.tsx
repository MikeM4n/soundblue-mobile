import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ArtistPicker } from '../components/tastes/ArtistPicker'
import { readTastes, saveTastes, skipTastes, SUGGESTED_ARTISTS } from '../data/tastes'
import type { YtmCard } from '../data/ytmusic'

/**
 * «¿Qué artistas te gustan?»: en Tu biblioteca y Ajustes → «Cambiar tus artistas» (la primera vez, en la bienvenida).
 * Con lo que elijas, Inicio arma «Para ti».
 */
export function Tastes() {
  const navigate = useNavigate()
  const [selected, setSelected] = useState<YtmCard[]>(() => readTastes()?.artists ?? [])

  const finish = () => {
    saveTastes(selected)
    navigate('/', { replace: true })
  }
  const skip = () => {
    skipTastes()
    navigate('/', { replace: true })
  }

  return (
    <div className="px-4 pt-8 md:px-6">
      <h1 className="text-3xl font-bold md:text-4xl">¿Qué artistas te gustan?</h1>
      <p className="mt-2 text-texto-sec">
        Elige {SUGGESTED_ARTISTS} o más y te recomendaremos música. Al tocar uno aparecen otros parecidos; tócalo otra vez para quitarlo.
      </p>

      <ArtistPicker selected={selected} onChange={setSelected} />

      {/* Acciones siempre a la vista, al pie de la pantalla. */}
      <div className="sticky bottom-0 -mx-4 mt-6 flex items-center justify-between gap-3 bg-linear-to-t from-fondo via-fondo/95 to-transparent px-4 pt-8 pb-4 md:-mx-6 md:px-6">
        <button type="button" onClick={skip} className="rounded-full px-4 py-2 font-semibold text-texto-sec hover:text-texto">
          Omitir
        </button>
        <button
          type="button"
          onClick={finish}
          disabled={selected.length === 0}
          className="rounded-full bg-acento px-6 py-3 font-bold text-white transition hover:bg-acento-hover disabled:opacity-40"
        >
          {selected.length ? `Listo (${selected.length})` : 'Elige artistas'}
        </button>
      </div>
    </div>
  )
}

import { Check } from 'lucide-react'
import { favoriteGenres, useFavoriteGenres } from '../../data/favoriteGenres'
import type { GenreKey } from '../../data/genreIndex'
import { INDEX_GENRES } from '../../data/genres'

/**
 * «Mis Géneros Favoritos» (Ajustes y el segundo paso de la bienvenida): filtran selecciones, recomendaciones, búsqueda y
 * la cola. Se guardan al tocarlos; `onChange` recibe los que quedaron (la bienvenida los precarga).
 */
export function GenrePicker({ className = '', onChange }: { className?: string; onChange?: (genres: readonly GenreKey[]) => void }) {
  const selected = useFavoriteGenres()
  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {Object.entries(INDEX_GENRES).map(([key, source]) => {
        const genre = key as GenreKey
        const active = selected.includes(genre)
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            onClick={() => {
              favoriteGenres.set(active ? selected.filter((item) => item !== genre) : [...selected, genre])
              onChange?.(favoriteGenres.get())
            }}
            className={`rounded-full px-3 py-2 text-sm font-semibold ${active ? 'bg-acento text-white' : 'bg-contraste/10 text-texto'}`}
          >
            {active && <Check aria-hidden="true" className="mr-1 inline size-3.5" />}
            {source.label}
          </button>
        )
      })}
    </div>
  )
}

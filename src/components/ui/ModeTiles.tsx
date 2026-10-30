import { Beer, Leaf, PartyPopper, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router'
import { MODES, modeNote, type Mode } from '../../data/genres'
import { modeGenres, useModeGenres } from '../../data/modeGenres'

/** Ícono y color de cada modo de ambiente (Inicio y su página). */
export const MODE_LOOK: Record<Mode['key'], { icon: LucideIcon; gradient: string }> = {
  rumba: { icon: PartyPopper, gradient: 'from-fuchsia-600 to-orange-500' },
  tomar: { icon: Beer, gradient: 'from-amber-500 to-red-700' },
  relax: { icon: Leaf, gradient: 'from-teal-500 to-sky-700' },
}

/** Modos de ambiente en Inicio: Rumba, Tomar y Relax. Cada uno abre su página, con subfiltros. */
export function ModeTiles() {
  const saved = useModeGenres() // si personalizaste un modo, debajo de su nombre van sus géneros
  return (
    <ul className="grid grid-cols-3 gap-2 px-4 md:px-6">
      {MODES.map((mode) => {
        const { icon: Icon, gradient } = MODE_LOOK[mode.key]
        return (
          <li key={mode.key}>
            <Link
              to={`/modo/${mode.key}`}
              className={`flex h-24 flex-col justify-between overflow-hidden rounded-lg bg-linear-to-br ${gradient} p-3 text-white shadow-lg shadow-black/30 transition-transform active:scale-95`}
            >
              <Icon className="size-7" aria-hidden="true" />
              <span className="leading-tight">
                <span className="block text-sm font-bold">{mode.label}</span>
                <span className="block truncate text-[11px] text-white/80">{modeNote(mode, modeGenres.of(mode, saved))}</span>
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

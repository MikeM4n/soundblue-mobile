import { useNavigate } from 'react-router'
import { useState } from 'react'
import { useLibrary, type SavedPlaylist } from '../../library/store'
import { coverSources } from '../../player/types'
import { PlaylistDialog } from '../tracks/PlaylistDialog'
import { Cover } from '../ui/Cover'
import { FavoritesCover, LibraryItem } from '../ui/LibraryItem'

const count = (n: number) => (n === 1 ? '1 canción' : `${n} canciones`)

/**
 * «Tus me gusta», tus playlists y (si `saved`) las playlists de YouTube que guardaste. La usan la
 * barra lateral y la página Biblioteca (que muestra las guardadas aparte, en «Playlists guardadas»).
 */
/** La carátula de una playlist tuya: la suya (si es importada) y, si no carga, la de su primera canción. */
export const playlistCover = (image: string | undefined, first: string[]) => (image ? [image, ...first] : first.length ? first : undefined)

export function LibraryList({ coverSize = 'size-12', saved: withSaved = true }: { coverSize?: string; saved?: boolean }) {
  const { favorites, playlists, saved } = useLibrary()
  return (
    <ul>
      <li>
        <LibraryItem to="/coleccion/favoritos/todas" title="Tus me gusta" subtitle={`Playlist · ${count(favorites.length)}`} cover={<FavoritesCover className={coverSize} />} />
      </li>
      {playlists.map((p) => (
        <li key={p.id}>
          <LibraryItem
            to={`/coleccion/playlist/${p.id}`}
            title={p.name}
            subtitle={`${p.source ? 'Importada de YouTube' : 'Playlist'} · ${count(p.tracks.length)}`}
            cover={<Cover seed={p.id} src={playlistCover(p.image, p.tracks[0] ? coverSources(p.tracks[0]) : [])} className={`${coverSize} shrink-0 rounded-md`} />}
          />
        </li>
      ))}
      {withSaved && <SavedItems saved={saved} coverSize={coverSize} />}
    </ul>
  )
}

/** Las playlists de YouTube guardadas: abren su página (con todas sus canciones). */
export function SavedItems({ saved, coverSize = 'size-12' }: { saved: readonly SavedPlaylist[]; coverSize?: string }) {
  return saved.map((p) => (
    <li key={p.id}>
      <LibraryItem
        to={`/ytm/${encodeURIComponent(p.id)}`}
        title={p.title}
        subtitle={['Playlist guardada', p.count !== undefined ? count(p.count) : p.subtitle].filter(Boolean).join(' · ')}
        cover={<Cover seed={p.id} src={p.image} className={`${coverSize} shrink-0 rounded-md`} />}
      />
    </li>
  ))
}

/** Hook para el botón «+»: abre el diálogo y, al crear, lleva a la playlist nueva. */
export function useCreatePlaylist() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const dialog = open ? (
    <PlaylistDialog onClose={() => setOpen(false)} onCreated={(id) => navigate(`/coleccion/playlist/${id}`)} />
  ) : null
  return { open: () => setOpen(true), dialog }
}

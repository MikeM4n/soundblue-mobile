import { ChevronRight, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ImportButton, ImportPlaylistDialog } from '../components/library/ImportPlaylistDialog'
import { LibraryList, SavedItems, useCreatePlaylist } from '../components/library/LibraryList'
import { IconButton } from '../components/ui/IconButton'
import { useLibrary } from '../library/store'

/** Biblioteca personal: favoritos y playlists guardadas. */
export function Library() {
  const createPlaylist = useCreatePlaylist()
  const [importing, setImporting] = useState(false)
  const { saved } = useLibrary()
  return (
    <div className="px-2 pt-6 pb-10 md:px-4">
      <div className="flex items-center justify-between px-2">
        <h1 className="text-2xl font-bold md:text-3xl">Tu biblioteca</h1>
        <IconButton label="Crear playlist" onClick={createPlaylist.open}>
          <Plus className="size-6" />
        </IconButton>
      </div>
      <div className="mx-2 mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link to="/gustos" className="inline-flex items-center gap-1 text-sm font-semibold text-acento-texto hover:underline">
          Cambiar tus artistas
          <ChevronRight className="size-4" aria-hidden="true" />
        </Link>
        <ImportButton onClick={() => setImporting(true)} />
      </div>
      <div className="mt-4">
        <LibraryList coverSize="size-16" saved={false} />
      </div>
      <section aria-labelledby="playlists-guardadas" className="mt-6">
        <h2 id="playlists-guardadas" className="px-2 text-lg font-bold">
          Playlists guardadas
        </h2>
        {saved.length ? (
          <ul className="mt-1">
            <SavedItems saved={saved} coverSize="size-16" />
          </ul>
        ) : (
          <p className="mt-1 px-2 text-sm text-texto-sec">Todavía no guardaste playlists. En Buscar, toca «+» junto a una playlist de YouTube.</p>
        )}
      </section>

      {createPlaylist.dialog}
      {importing && <ImportPlaylistDialog onClose={() => setImporting(false)} />}
    </div>
  )
}

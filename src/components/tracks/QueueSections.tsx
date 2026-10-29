import { GripVertical, Lightbulb, Play } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { QueueGroup } from '../../data/radio'
import { settings, useSettings } from '../../lib/settings'
import { player, type RecsKind } from '../../player/engine'
import type { Track } from '../../player/types'
import { usePlayer } from '../../player/usePlayer'
import { showToast } from '../../ui/toast'
import { Switch } from '../ui/Switch'
import { stableKeys } from './TrackList'
import { TrackRow } from './TrackRow'
import { playRecommendationsNext, type RemoveAction } from './trackActions'
import { useDragReorder } from './useDragReorder'

type Tab = 'cola' | RecsKind
const TABS: readonly { key: Tab; label: string }[] = [
  { key: 'cola', label: 'En Cola' },
  { key: 'recomendadas', label: 'Recomendadas' },
  { key: 'nuevas', label: 'Por Descubrir' },
]
const TIP_KEY = 'soundblue:consejo-fila-dinamica' // ya se cerró el consejo de la Fila Dinámica

/**
 * «Próximas en sonar», en tres pestañas (la usan la página Cola y el panel que sube en «Sonando ahora»):
 * - «En Cola»: lo que va a sonar. «Siguiente en la cola» (las que agregaste), «Siguiente de: …» (la lista que elegiste)
 *   y lo que agregó la Fila Dinámica. Izquierda = a continuación, derecha = quitar (con Deshacer), ≡ = reordenar. Arriba,
 *   el interruptor de la Fila Dinámica.
 * - «Recomendadas» y «Por Descubrir» (solo las que nunca sonaron aquí): de la radio de la canción que suena; no suenan
 *   hasta que pasan a la cola. Izquierda = a la cola, derecha = descartar (con Deshacer), «Reproducir a continuación» =
 *   todas justo después de la que suena.
 * Una canción nunca está en dos pestañas a la vez (por videoId): al pasar a la cola, sale de su pestaña.
 */
export function QueueSections({ beforePlay }: { beforePlay?: () => void }) {
  const [tab, setTab] = useState<Tab>('cola') // siempre abre en «En Cola»
  useEffect(() => player.ensureRecommendations(), []) // recién abierta la app todavía no hay radio

  return (
    <>
      <div role="tablist" aria-label="Próximas en sonar" className="sin-scroll mt-3 flex gap-2 overflow-x-auto px-2">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`pestana-${key}`}
            aria-selected={tab === key}
            aria-controls={`panel-${key}`}
            onClick={() => setTab(key)}
            className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${tab === key ? 'bg-contraste text-inverso' : 'bg-contraste/10 text-texto hover:bg-contraste/15'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`pestana-${tab}`}>
        {tab === 'cola' ? <QueueTab beforePlay={beforePlay} /> : <RecsTab key={tab} kind={tab} beforePlay={beforePlay} />}
      </div>
    </>
  )
}

/** Tramos seguidos de «En Cola» que van bajo el mismo encabezado (la lista elegida o lo que agregó la Fila Dinámica). */
interface Run {
  start: number // índice en `upcoming`
  tracks: Track[]
  group: QueueGroup | null
}

function runsOf(upcoming: readonly Track[], groups: readonly (QueueGroup | null)[]): Run[] {
  const runs: Run[] = []
  upcoming.forEach((track, i) => {
    const group = groups[i] ?? null
    const last = runs.at(-1)
    if (last && !!last.group === !!group && last.group?.seed === group?.seed) last.tracks.push(track)
    else runs.push({ start: i, tracks: [track], group })
  })
  return runs
}

function QueueTab({ beforePlay }: { beforePlay?: () => void }) {
  const { queue, upcoming, upcomingGroups, contextName } = usePlayer()

  const clearQueue = () => {
    const undo = player.clearQueue()
    showToast('Cola vaciada', { label: 'Deshacer', run: undo })
  }

  return (
    <>
      <DynamicQueueSwitch />
      {queue.length === 0 && upcoming.length === 0 && (
        <p className="mt-6 px-2 text-sm text-texto-sec">
          No hay más canciones. Agrégalas desde «Recomendadas» o «Por Descubrir», o en Buscar o en una lista desliza una canción a la
          izquierda.
        </p>
      )}
      {queue.length > 0 && (
        <>
          <SectionTitle
            action={
              <button type="button" onClick={clearQueue} className="shrink-0 text-sm text-texto-sec hover:text-texto">
                Vaciar cola
              </button>
            }
          >
            Siguiente en la cola
          </SectionTitle>
          <ReorderableList
            tracks={queue}
            onPlay={(i) => {
              beforePlay?.()
              player.jumpToQueue(i)
            }}
            onMove={(from, to) => player.moveQueue(from, to)}
            remove={(i) => ({ listName: 'la cola', remove: () => player.removeQueueAt(i) })}
          />
        </>
      )}
      {runsOf(upcoming, upcomingGroups).map(({ start, tracks, group }) => (
        <section key={`${start}-${tracks[0].id}`} aria-label={group ? 'Agregadas por la Fila Dinámica' : `Siguiente de: ${contextName}`}>
          {group ? (
            <SectionTitle note={`De «Recomendadas», a partir de ${group.seed}`}>Agregadas por la Fila Dinámica</SectionTitle>
          ) : (
            <SectionTitle>Siguiente de: {contextName}</SectionTitle>
          )}
          <ReorderableList
            tracks={tracks}
            onPlay={(i) => {
              beforePlay?.()
              player.jumpToUpcoming(start + i)
            }}
            onMove={(from, to) => player.moveUpcoming(start + from, start + to)}
            remove={(i) => ({ listName: 'la cola', remove: () => player.removeUpcomingAt(start + i) })}
          />
        </section>
      ))}
    </>
  )
}

/** Interruptor de la Fila Dinámica, con un consejo la primera vez: dejarla encendida para no quedarse sin música. */
function DynamicQueueSwitch() {
  const { dynamicQueue } = useSettings()
  const [tip, setTip] = useState(() => {
    try {
      return !localStorage.getItem(TIP_KEY)
    } catch {
      return false
    }
  })
  const closeTip = () => {
    try {
      localStorage.setItem(TIP_KEY, '1')
    } catch {
      /* sin almacenamiento: se vuelve a mostrar la próxima vez */
    }
    setTip(false)
  }
  return (
    <div className="mx-2 mt-3 rounded-lg bg-tarjeta p-3">
      <Switch
        label="Fila Dinámica"
        note={
          dynamicQueue
            ? 'Siempre hay al menos 10 por sonar: si quitas una, entra otra de «Recomendadas».'
            : 'Apagada: la cola no se rellena sola. Cuando se acabe, la música se detiene.'
        }
        checked={dynamicQueue}
        onChange={(on) => settings.set({ dynamicQueue: on })}
      />
      {tip && (
        <div role="note" className="mt-3 flex items-start gap-2 rounded-md bg-acento/15 p-2 text-sm">
          <Lightbulb className="mt-0.5 size-4 shrink-0 text-acento-texto" aria-hidden="true" />
          <p className="min-w-0 flex-1">
            Te recomendamos dejar la <b>Fila Dinámica</b> encendida para no quedarte sin música.
          </p>
          <button type="button" onClick={closeTip} className="shrink-0 font-semibold text-acento-texto hover:underline">
            Entendido
          </button>
        </div>
      )}
    </div>
  )
}

const RECS_TEXT: Record<RecsKind, { title: string; tab: string; empty: string }> = {
  recomendadas: { title: 'Recomendadas basadas en esta canción', tab: 'Recomendadas', empty: 'No hay más recomendaciones para esta canción.' },
  nuevas: { title: 'Por descubrir', tab: 'Por Descubrir', empty: 'Ya no quedan canciones nuevas para ti a partir de esta. Prueba con otra canción.' },
}

/** «Recomendadas» o «Por Descubrir»: «Reproducir a continuación» y la lista (izquierda = a la cola, derecha = descartar). */
function RecsTab({ kind, beforePlay }: { kind: RecsKind; beforePlay?: () => void }) {
  const { recommended, discover, recsSeed, recsLoading } = usePlayer()
  const tracks = kind === 'recomendadas' ? recommended : discover
  const keys = stableKeys(tracks)
  const text = RECS_TEXT[kind]
  const note = kind === 'nuevas' ? `Nunca sonaron aquí, del mismo género${recsSeed ? ` que ${recsSeed}` : ''}` : recsSeed ? `A partir de ${recsSeed}` : undefined

  return (
    <section aria-label={text.tab}>
      <SectionTitle note={note}>{text.title}</SectionTitle>
      {/* La acción principal de la pestaña: botón ancho y grande, como en los Modos. */}
      <div className="px-2 pt-1 pb-2">
        <button
          type="button"
          disabled={!tracks.length}
          onClick={() => playRecommendationsNext(kind)}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-acento px-6 font-bold text-white shadow-lg shadow-acento/30 transition hover:bg-acento-hover active:scale-[.98] disabled:opacity-50 md:max-w-sm"
        >
          <Play className="size-5 shrink-0 fill-current" aria-hidden="true" />
          Reproducir a continuación
        </button>
        <p className="mt-2 text-xs text-texto-sec">Desliza una canción a la izquierda para agregarla a la cola; a la derecha, para descartarla.</p>
      </div>
      {tracks.length > 0 ? (
        <ol>
          {tracks.map((track, i) => (
            <TrackRow
              key={keys[i]}
              track={track}
              onPlay={() => {
                beforePlay?.()
                player.playRecommendation(kind, i)
              }}
              swipe="sugerencia"
              removeAction={{ listName: text.tab, notice: 'Descartada', remove: () => player.discardRecommendation(kind, i) }}
            />
          ))}
        </ol>
      ) : (
        <p className="mt-4 px-2 text-sm text-texto-sec">{recsLoading ? 'Buscando recomendaciones…' : text.empty}</p>
      )}
    </section>
  )
}

export function SectionTitle({ children, action, note }: { children: ReactNode; action?: ReactNode; note?: string }) {
  return (
    <div className="mt-6 mb-1 flex items-center justify-between gap-2 px-2">
      <div className="min-w-0">
        <h2 className="truncate font-bold">{children}</h2>
        {note && <p className="truncate text-xs text-texto-sec">{note}</p>}
      </div>
      {action}
    </div>
  )
}

interface ReorderableListProps {
  tracks: readonly Track[]
  onPlay: (index: number) => void
  onMove: (from: number, to: number) => void
  remove: (index: number) => RemoveAction
}

function ReorderableList({ tracks, onPlay, onMove, remove }: ReorderableListProps) {
  const { handleProps, rowStyle } = useDragReorder(tracks.length, onMove)
  const keys = stableKeys(tracks)
  return (
    <ol>
      {tracks.map((track, i) => (
        <TrackRow
          key={keys[i]}
          track={track}
          onPlay={() => onPlay(i)}
          removeAction={remove(i)}
          swipe="cola"
          style={rowStyle(i)}
          trailing={
            <button
              type="button"
              aria-label={`Mover ${track.title} (arrastra, o usa las flechas)`}
              className="grid size-10 shrink-0 cursor-grab place-items-center rounded-full text-texto-sec hover:text-texto active:cursor-grabbing"
              {...handleProps(i)}
            >
              <GripVertical className="size-5" />
            </button>
          }
        />
      ))}
    </ol>
  )
}

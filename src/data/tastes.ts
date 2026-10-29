// Tus gustos: los artistas que elegiste al abrir la app por primera vez (o en «Cambiar tus artistas»).
// Junto con tus favoritas y tu historial alimentan «Para ti» (ver forYou.ts).
import { ytmSearchArtists, type YtmCard } from './ytmusic'

const KEY = 'soundblue:gustos'
const STARTERS_KEY = 'soundblue:artistas-iniciales'
const STARTERS_MS = 7 * 24 * 3600 * 1000

export const SUGGESTED_ARTISTS = 3 // como en Spotify: con 3 o más artistas las recomendaciones salen mejor

export interface Tastes {
  artists: YtmCard[]
  skipped?: boolean // tocó «Omitir»: no se vuelve a preguntar al abrir
}

/** null = todavía no ha pasado por la pantalla de gustos. */
export function readTastes(): Tastes | null {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    return saved && Array.isArray(saved.artists) ? saved : null
  } catch {
    return null
  }
}

function writeTastes(tastes: Tastes) {
  try {
    localStorage.setItem(KEY, JSON.stringify(tastes))
  } catch {
    /* sin almacenamiento: se volverá a preguntar la próxima vez */
  }
}

export const saveTastes = (artists: YtmCard[]) => writeTastes({ artists })
export const skipTastes = () => writeTastes({ artists: readTastes()?.artists ?? [], skipped: true })

// Artistas para empezar: populares en Colombia y Latinoamérica, y algunos internacionales, de varios géneros.
const STARTER_NAMES = [
  'Bad Bunny', 'KAROL G', 'Feid', 'Shakira', 'J Balvin', 'Maluma', 'Carlos Vives', 'Silvestre Dangond',
  'Marc Anthony', 'Romeo Santos', 'Peso Pluma', 'Grupo Frontera', 'Rauw Alejandro', 'Ryan Castro', 'Blessd', 'Morat',
  'Juanes', 'Camilo', 'Sebastián Yatra', 'Manuel Turizo', 'Grupo Niche', 'Joe Arroyo', 'Diomedes Díaz', 'Jessi Uribe',
  'Soda Stereo', 'Taylor Swift', 'The Weeknd', 'Dua Lipa', 'Coldplay', 'Bruno Mars', 'Eminem', 'BTS',
]

const simplify = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '')

/** Los artistas iniciales con su foto (se buscan una vez y se guardan una semana). */
export async function starterArtists(): Promise<YtmCard[]> {
  try {
    const saved = JSON.parse(localStorage.getItem(STARTERS_KEY) ?? 'null')
    if (saved && Date.now() - saved.at < STARTERS_MS && Array.isArray(saved.artists) && saved.artists.length) return saved.artists
  } catch {
    /* se vuelven a buscar */
  }
  const found = await Promise.all(
    STARTER_NAMES.map(async (name) => {
      const results = await ytmSearchArtists(name).catch(() => [])
      return results.find((card) => simplify(card.title) === simplify(name)) ?? results[0] ?? null
    }),
  )
  const artists = unique(found.filter((card): card is YtmCard => !!card))
  if (!artists.length) throw new Error('YouTube Music no respondió')
  try {
    localStorage.setItem(STARTERS_KEY, JSON.stringify({ at: Date.now(), artists }))
  } catch {
    /* sin almacenamiento: se buscan otra vez la próxima */
  }
  return artists
}

function unique<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter((item) => !seen.has(item.id) && !!seen.add(item.id))
}

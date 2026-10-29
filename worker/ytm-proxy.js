// Intermediario de SoundBlue para el catálogo de YouTube Music (Cloudflare Worker).
// GitHub Pages no puede llamar a YouTube Music (CORS). La app publicada manda aquí las mismas peticiones que, al
// probar con `npm run dev`, hace al servidor de Vite (/ytm-api), y este Worker las reenvía a la API interna de
// YouTube Music (InnerTube). Solo datos —búsqueda, páginas y radio—, nunca audio: no reenvía `player`.
// Es una API no oficial: puede dejar de funcionar si YouTube la cambia.

const UPSTREAM = 'https://music.youtube.com/youtubei/v1'
// search = Buscar · browse = Inicio, playlists, álbumes y artistas · next = radio («A continuación»)
const ENDPOINTS = new Set(['search', 'browse', 'next'])
// Solo la app publicada y las pruebas en el PC (npm run dev / preview).
const ORIGINS = new Set(['https://mikem4n.github.io', 'https://localhost', 'http://localhost:5173', 'http://localhost:4173'])
const MAX_BODY = 32 * 1024
// Como el navegador de una persona en music.youtube.com.
const BROWSER_HEADERS = {
  'content-type': 'application/json',
  origin: 'https://music.youtube.com',
  referer: 'https://music.youtube.com/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'accept-language': 'es-CO,es;q=0.9',
}

const corsHeaders = (origin) => ({
  'access-control-allow-origin': origin,
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
  vary: 'Origin',
})

const reply = (status, data, origin) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(origin ? corsHeaders(origin) : {}) },
  })

/** Reenvía a YouTube Music. A veces rechaza una petición suelta (403, 429 o 5xx): se reintenta una vez. */
async function forward(endpoint, body) {
  const send = () => fetch(`${UPSTREAM}/${endpoint}?prettyPrint=false`, { method: 'POST', headers: BROWSER_HEADERS, body })
  const first = await send()
  if (first.status !== 403 && first.status !== 429 && first.status < 500) return first
  await first.body?.cancel()
  await new Promise((resolve) => setTimeout(resolve, 400))
  return send()
}

/** ¿Es una petición de InnerTube como las que arma la app (un objeto con context.client)? */
function looksLikeInnerTube(text) {
  try {
    const body = JSON.parse(text)
    return typeof body === 'object' && body !== null && typeof body.context?.client?.clientName === 'string'
  } catch {
    return false
  }
}

export default {
  async fetch(request) {
    const origin = request.headers.get('origin') ?? ''
    if (!ORIGINS.has(origin)) return reply(403, { error: 'Origen no permitido' })
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) })

    const endpoint = new URL(request.url).pathname.replace(/^\/+|\/+$/g, '')
    if (request.method !== 'POST' || !ENDPOINTS.has(endpoint)) return reply(404, { error: 'No existe' }, origin)
    const body = await request.text()
    if (body.length > MAX_BODY) return reply(413, { error: 'Petición demasiado grande' }, origin)
    if (!looksLikeInnerTube(body)) return reply(400, { error: 'Petición no válida' }, origin)

    try {
      const upstream = await forward(endpoint, body)
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(origin) },
      })
    } catch {
      return reply(502, { error: 'YouTube Music no respondió' }, origin)
    }
  },
}

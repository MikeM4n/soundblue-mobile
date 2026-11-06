# Historial de cambios

## 2026-11-06 — v2.0.0

- Descargas como en Spotify (app de Android):
  - «Descargar» (nube con flecha) en la cabecera de «Tus me gusta», «Tu Top 50», tus playlists y cualquier playlist o álbum que abras (también las públicas de YouTube: se lee la lista COMPLETA antes de descargar). Mientras descarga muestra «12 de 50» (tocarlo cancela); descargada, ✓ verde (tocarlo pregunta si quitar las descargas).
  - Cada fila de esas listas muestra su estado: ✓ verde (descargada), flecha girando (en camino) o nube vacía (no descargada). En las demás listas (Buscar, Inicio…) se ve solo el ✓.
  - Menú ⋮ de cualquier canción: «Descargar», «Cancelar descarga» o «Quitar descarga».
  - «Importar playlist»: además de «Agregar todas a Me gusta», «Agregar y descargar».
  - Una descargada suena desde el teléfono, con o sin internet (no gasta datos). Sin internet, la cola salta las que no están descargadas; si ya no queda ninguna por delante, suena el respaldo en bucle hasta que vuelve la conexión.
- Ajustes → «Modo sin conexión»: slider de 50 a 1000 canciones (antes 15/30/50/100), guardado en localStorage y en el teléfono, que vale para TODAS las descargas. Texto en vivo: «Usando: 45 canciones (150 MB) / Límite: 200 canciones (700 MB)», cuántas son tuyas y cuántas de respaldo. Por defecto 200; los límites de la 1.9.x menores de 50 suben a 50. El respaldo automático de «Selecciones rápidas» guarda hasta 50, solo si caben.
- Prioridad de borrado: si lo que descargas no cabe, se borran primero las de respaldo (las más viejas) y después las tuyas que menos escuchas (según el historial), nunca las de la misma descarga. Aviso: «Se borraron X canciones antiguas para hacer espacio». Si aun así no cabe, «No cupieron X canciones: sube el límite en Ajustes». Bajar el límite borra igual, con aviso previo en Ajustes.
- «Descargar solo con Wi-Fi» vale también para las descargas manuales: si toca esperar, quedan en cola (flecha girando) y siguen solas al llegar el Wi-Fi. «Borrar todas las descargas» pide confirmación.

## 2026-11-06 — v1.9.1

- Modo sin conexión más grande y configurable (Ajustes → «Modo sin conexión»):
  - «Canciones a guardar»: 15, 30, 50 o 100 (por defecto 50, unos 175 MB; antes eran 15 fijas). Bajarlo borra al momento las más viejas.
  - Para llenarla, Inicio ofrece las «Selecciones rápidas» de todos tus géneros (hasta 4 playlists de cada uno), mezcladas, no solo las del género que se ve.
  - «Descargar solo con Wi-Fi» (encendido por defecto): solo se descarga o renueva en Wi-Fi (red sin límite de datos). Apagado, también con datos móviles. Si toca esperar, se pausa con el aviso «Esperando conexión Wi-Fi para descargar» (en Ajustes, y una vez por sesión en Inicio) y sigue sola al llegar el Wi-Fi con la app abierta. En la 1.9.0 el primer llenado usaba cualquier red; ahora respeta el interruptor.

## 2026-11-06 — v1.9.0

- Buscar sin filtro de popularidad: además de «Canciones» trae «Videos» de YouTube Music y, en la app de Android, la búsqueda normal de YouTube con NewPipe (cualquier video, aunque tenga pocas vistas). Cada resultado sabe sus vistas; el chip «Solo populares» (apagado por defecto) deja solo lo que pasa de 1 millón.
- Importar playlist: cualquier playlist pública o no listada de YouTube o YouTube Music, de cualquier usuario. Se lee de YouTube Music y, en Android, también con NewPipe (gana la que trae más canciones; los datos de YouTube Music se conservan). Hasta 5000 canciones (antes 1000). Lee también el formato viejo de las páginas. «Tus me gusta» (LM), «Videos que me gustan» (LL) y «Ver más tarde» (WL) avisan que son privadas. También para «Playlists guardadas».
- Modos (Rumba y los demás): carga progresiva. Con las primeras 5 canciones ya se puede dar ▶; el resto llega en segundo plano («Cargando más canciones…») y, si la lista ya suena, se suma a la cola (antes de lo de la Fila Dinámica; con aleatorio, en lugares al azar).
- Modo offline: la app guarda en el teléfono el audio de hasta 15 canciones de «Selecciones rápidas» (unos 50 MB; cada una dura al menos 24 h; con Wi-Fi las de más de 24 h se cambian por nuevas, con datos móviles solo se completa lo que falte). Sin internet (o si NewPipe falla 10 seguidas), en vez de pausar suenan una tras otra, en bucle, y la cola espera en la canción y el segundo donde iba. Al volver la conexión (se prueba cada 20 s y al aparecer una red) deja la caché y sigue la cola. Ajustes → «Modo sin conexión»: cuántas hay y «Limpiar caché offline».
- Anti-repetición: lo que sonó en las últimas 24 h (historial de escucha) no entra en la radio, «Recomendadas», la Fila Dinámica, «Selecciones rápidas» ni los Modos. Solo como último recurso, para que la música no se detenga. La cola automática del reproductor nativo también recuerda 24 h (aunque se cierre la app).

## 2026-10-25

- Playlists guardadas (rama `feat/playlists-guardadas`, pedido por el dueño):
  - Buscar trae también «Playlists» (las de YouTube Music y las de la comunidad), cada una con «+» para guardarla en Tu biblioteca (queda ✓; tocar ✓ la quita). Con aviso y «Deshacer». También en la página de la playlist.
  - Tu biblioteca → «Playlists guardadas»: portada, título y cuántas canciones; al tocarla se abre con TODAS sus canciones (sigue las páginas, hasta 1000) para reproducirla o agregarlas a la cola. En el PC, también en la barra lateral.
  - Sus datos se guardan en la biblioteca (localStorage) y sus canciones en IndexedDB (se leen en segundo plano al guardarla): abre al instante, también sin conexión, y se actualiza desde YouTube Music al abrirla.
- Hotfix (rama `hotfix/top50-gestos`, pedido por el dueño): gestos de «Tu Top 50». Izquierda = suena a continuación (sin menú); derecha = la quita de tu Top (sin menú, con «Deshacer»; se olvidan sus reproducciones y, si la vuelves a escuchar mucho, regresa); ⋮ = menú. La lista se actualiza al momento.
- Tema, temporizador, vibración, Tu Top 50 y compartir (rama `feat/tema-temporizador-top50`, pedido por el dueño):
  - Tema en Ajustes: «Predeterminado del sistema» (por defecto: claro u oscuro como el teléfono, también si cambia con la app abierta), «Claro» u «Oscuro» (AMOLED: fondos y paneles en negro puro). Se aplica antes de pintar (sin destello) y cambia el color de la barra del sistema. «Sonando ahora», la mini barra y el panel del PC se ven siempre oscuros, sobre la carátula.
  - Temporizador (⋮ de «Sonando ahora»): 15, 30 o 45 min; al llegar, la música baja de volumen en 5 s y se pausa (tu volumen no cambia). El menú muestra cuánto falta.
  - Vibración corta (10 ms) al dar ▶/⏸ y al soltar un gesto de deslizar, si el teléfono la tiene.
  - «Tu Top 50» en Inicio: las 50 que más escuchaste aquí, de más a menos.
  - Compartir (⋮ de cualquier canción): imagen con la carátula, el título y el artista y un enlace que abre la canción en SoundBlue (#/cancion/…), con la función de compartir del celular.
- Karaoke, importar playlists y todo dentro de SoundBlue (rama `feat/karaoke-e-importar`, pedido por el dueño):
  - El video de YouTube no se muestra en ninguna parte (ni en «Sonando ahora», ni en el panel del PC): su reproductor suena oculto. «Canción» = la carátula grande.
  - «Letra» tipo karaoke: la línea que se canta se resalta y la lista avanza sola; tocar una línea lleva la canción a ese momento; deslizar con el dedo pausa el avance 4 s. Letra con tiempos de YouTube Music (como su app de Android, sincronizada con esa grabación) y, si no, de LRCLib (la versión que dura lo mismo). Sin tiempos, el texto (YouTube Music o lyrics.ovh). Con su fuente.
  - «Importar playlist» (en Tu biblioteca y en Tus me gusta): pegas el enlace de una playlist de YouTube o YouTube Music, se ven todas sus canciones (sigue las páginas, hasta 1000) y «Agregar todas a Me gusta» (sin repetir, con Deshacer). Los «Mix» automáticos y las privadas no se pueden.
  - Sin «Abrir en YouTube Music» (menú ⋮, «Sonando ahora» y avisos): nada saca de la app.
  - Tocar la carátula (o el fondo) ya no oculta los controles: no pasa nada.
  - Controles de reloj/carro y ⏮ ⏭ en la notificación: los manejadores de la Media Session ya estaban; el navegador le da esos botones al reproductor de YouTube (el que suena), así que solo hay ▶/⏸. Un `<audio>` propio exigiría extraer el audio de YouTube (descartado). Sin cambios.
- Ajustes de UI, filtros y letras (rama `feat/letra-y-filtros`, pedido por el dueño):
  - Canciones no disponibles: si una no se deja reproducir aquí (ni ella ni sus otras versiones), sale de tu cola, de lo que sigue y de las pestañas (la Fila Dinámica pone otra), no se deja agregar («no está disponible aquí») y deja de aparecer en todas las listas (Buscar, playlists, Inicio, búsqueda de la Jam). YouTube Music no dice de antemano cuáles son: probado, el oEmbed de YouTube solo avisó de 5 de 56 videos bloqueados, así que no se usa como filtro.
  - «Próximas en sonar»: sin el botón «Jam · código» (Jam sigue arriba a la derecha de «Sonando ahora»). Las pestañas quedan igual.
  - «Selecciones rápidas»: botón «+» para elegir qué géneros ver (16 para elegir: Salsa, Reggaetón, Merengue, Popular, Vallenato, Bachata, Cumbia, Regional mexicano, Pop latino, Baladas, Boleros, Trap latino, Dancehall, Electrónica, Rock en español, Música colombiana). Se recuerda en el navegador; siempre queda al menos uno.
  - «Canción | Video» pasa a «Canción | Letra»: con «Letra», el video oficial 16:9 (sin recortar) y la letra debajo, que se desplaza con el dedo. Letra de YouTube Music (Musixmatch/LyricFind, con su fuente) y, si no la tiene, de lyrics.ovh.
  - «Modo TikTok» (zoom del video y letra encima): no se hizo, porque recorta el logo y «Ver en YouTube» y taparía el reproductor. Queda la alternativa del mismo pedido: video normal y letra en un panel debajo.
- Rediseño de «Próximas en sonar» (rama `feat/proximas-pestanas`, pedido por el dueño):
  - Tres pestañas: **En Cola** (lo que va a sonar: tu cola, lo que sigue de la lista y lo que agregó la Fila Dinámica), **Recomendadas** y **Por Descubrir** (solo canciones que nunca sonaron aquí). Las dos últimas salen de la radio de la canción que suena y ya no suenan solas: pasan a la cola cuando tú quieras (o la Fila Dinámica). Siempre abre en «En Cola».
  - Gestos en todas: izquierda = a la cola (en «En Cola», a continuación); derecha = quitar o descartar, con «Deshacer». Lo descartado no vuelve en esa radio y la pestaña se repone.
  - **Fila Dinámica** (interruptor en «En Cola» y en Ajustes, encendida por defecto): con ella siempre hay al menos 10 por sonar; si quitas una, entra otra de «Recomendadas». Apagada, la cola queda como la dejas y la música se detiene al acabarse. La primera vez, un consejo recomienda dejarla encendida.
  - **Reproducir a continuación** (botón grande en «Recomendadas» y «Por Descubrir»): todas las de la pestaña, en su orden, justo después de la que suena. La pestaña se llena con otras.
  - Cero duplicados (por videoId): una canción nunca está en dos pestañas; al pasar a la cola por cualquier camino (gesto, Buscar, la Jam) sale de su pestaña.
  - Tocar una recomendada la pone a sonar ya, y las recomendaciones pasan a salir de ella.
- Hotfix 4 (rama `hotfix/generos-y-quitar`, pedido por el dueño):
  - Modo Tomar aislado: su lista y las recomendadas que siguen son solo popular, ranchera y vallenato. Nunca salsa, merengue, bachata ni urbano, aunque el artista también salga en playlists de esos géneros (Maluma, Romeo Santos, Becky G, «Nunca me fui» de Fonseca con Rubén Blades) o el título lo diga («Mi Decisión (Merengue)»). Artistas que el índice de géneros no conoce no entran, salvo los de la lista del modo y el de la canción que suena (la radio de Pastor López traía orquestas tropicales y salsa por ahí). El modo se recuerda al cerrar la app.
  - Matriz de géneros: popular, ranchera y vallenato son una familia cerrada también fuera del modo (la radio de una canción popular desde Buscar no cruza). Vallenato ya no acepta cumbia, ni cumbia vallenato. El índice lee 6 playlists de esos tres géneros (antes 3) para conocer más artistas; se vuelve a armar una vez (versión 4).
  - «Próximas en sonar» (página y panel de «Sonando ahora»): deslizar a la DERECHA quita la canción de la cola, con «Deshacer», sin abrir el menú. Igual en la cola de la Jam (el anfitrión, cualquiera; el invitado, las suyas; en las de otros no pasa nada). Izquierda sigue igual (a continuación). En Buscar y las listas, derecha sigue abriendo el menú. «⋮» siempre abre el menú.
- Hotfix 3 (rama `hotfix/jam-a-la-derecha`, pedido por el dueño):
  - «Sonando ahora»: Jam pasa a la esquina de arriba a la derecha, junto a ⋮. A la izquierda no queda nada (Minimizar sigue siendo deslizar hacia abajo, o Esc en el PC) y «Sonando desde» queda centrado. La barra tiene solo esas tres cosas; la pantalla flotante ya no existe desde el hotfix 2.
- Hotfix 2 (rama `hotfix/sin-pantalla-flotante`, pedido por el dueño con captura del teléfono):
  - «Sonando ahora»: la barra de arriba queda con solo tres cosas: Jam, «Sonando desde» y ⋮. Se quitó la pantalla flotante por completo (botón y `FloatingPlayer.tsx`); en el celular solo mostraba un aviso de que no existe.
  - Actualizaciones: con música sonando, la versión nueva ya no queda olvidada. Se aplica sola en cuanto la música queda en pausa 3 s (la canción queda donde iba). «Actualizar ahora» sale cada vez que vuelves a la app (antes, una sola vez por sesión) y se revisa también cada 10 minutos. La versión se ve en Ajustes.
  - Gestos: comprobados otra vez con toques reales en Buscar, playlists, «Próximas» (página y panel de «Sonando ahora») y la Jam. Deslizar a la izquierda nunca abre un menú. Lo que se veía en el teléfono era la versión anterior (f5f9e5d), donde «Próximas» y la cola de la Jam sí abrían el menú; esa versión no se actualizaba si la música estaba sonando.
- Hotfix (rama `hotfix/jam-y-deslizar`, pedido por el dueño):
  - «Sonando ahora»: en la esquina queda solo el botón Jam. Se quitaron «Minimizar» (ya no estaba desde la versión anterior; se minimiza deslizando hacia abajo o con Esc) y «Transmitir» (Chromecast).
  - Regla única de deslizar en todas las pantallas:
    - Izquierda = acción directa, nunca un menú: en Buscar, playlists, álbumes, modos y Tus me gusta agrega a la cola (o a la Jam); en «Próximas en sonar» y en la cola de tu Jam la pone a sonar a continuación.
    - Derecha (o tocar ⋮) = menú de opciones, donde está quitar («Quitar de la cola», «Eliminar de la Jam», con «Deshacer»).
    - El invitado no puede reordenar la cola del anfitrión: en esa lista, izquierda no hace nada.
  - Causa encontrada probando con toques reales: en «Próximas», el borde derecho de la fila es el asa ≡ para reordenar y se quedaba con todo deslizamiento que empezaba ahí (en el celular, deslizar a la izquierda suele empezar justo en ese borde). Ahora el asa solo reordena si el dedo va hacia arriba o abajo; si va de lado, es el gesto de la fila.

## 2026-10-24

- Ajustes finales y paso a producción (rama `feat/ajustes-finales` → `staging` → `main`, con el OK por escrito del dueño):
  - «Sonando ahora»: el botón Jam (a tu sala o a la del amigo) reemplaza a «Minimizar». Minimizar es deslizar hacia abajo (o Esc en el PC). «Transmitir» pasa a la derecha.
  - Deslizar a la izquierda agrega directo a la cola en Buscar, playlists, álbumes, modos y Tus me gusta (y a la Jam desde su búsqueda). El menú ⋮ sigue como botón aparte.
  - Modos de ambiente: botón ancho y grande «Reproducir Modo …» y «Aleatorio» al lado.
  - Al tocar a mano otra canción, se quitan las recomendaciones de la anterior y sale un bloque nuevo de 10 a partir de la tocada. También cuando empieza a sonar una que la radio no trajo (de tu lista, tu cola o la Jam). Toda radio nueva arranca con 10.
  - Géneros: K-Pop, J-Pop y Mandopop en el índice, y la escritura asiática se reconoce aunque el artista no esté. Si no se conoce el género de la canción que suena, se toma el de la mayoría de su radio. Una radio de salsa ya no trae K-Pop.
  - Avisos sin «YouTube Music» («Esta canción no está disponible aquí…»). Se deja el botón «Abrir en YouTube Music».
  - Esc al minimizar ya no puede sacarte de la pantalla a la que fuiste mientras bajaba «Sonando ahora».
  - Offline: descartado definitivamente (descargar audio de YouTube no es posible ni permitido). Quedan la app sin conexión y el aviso de reconexión.
- Rama `staging` (versión de prueba unificada, pendiente del OK del dueño). Une `feat/ui-recomendaciones-offline`, `feat/inicio-generos-ambiente` y `feat/jam-interactividad`, más `feat/gestos-genero-cast`:
  - Gestos según la pantalla. En Buscar y en las listas (playlists, álbumes, modos): izquierda = agregar a la cola de una vez (o a la Jam, en la de un amigo), derecha = menú «⋮». En «Próximas en sonar»: derecha = quitar, izquierda = menú. En la búsqueda de la sala de la Jam, izquierda = agregar a la Jam.
  - Recomendaciones: género > época. Se quitó el filtro de «misma época».
    - Un índice de géneros (qué artistas salen en las playlists de YouTube Music de cada género, guardado 7 días) y una matriz de géneros parecidos: reggaetón, dancehall y trap latino; salsa, merengue y bachata; popular, regional mexicano y vallenato; baladas, pop y boleros…
    - La radio deja solo lo del mismo género o uno parecido, de cualquier año.
  - La semilla de la radio es siempre la canción que suena. Si no la trajo la radio (es de la lista, de tu cola o la agregó alguien en la Jam), se arma la radio de esa canción. Ejemplo: tras una ranchera siguen rancheras, no lo que seguía de la playlist.
  - «Transmitir» (Chromecast) reemplaza a «Minimizar» en el celular: pausa aquí y abre la canción en la app de YouTube Music, que tiene el botón para mandarla a la TV. Minimizar sigue siendo deslizar hacia abajo (y en el PC queda el botón).
  - Jam en un Worker de Cloudflare de prueba (`soundblue-jam-staging`, `worker/jam.staging.wrangler.jsonc`): acepta además los links temporales de TryCloudflare. La versión final usará `soundblue-jam` (sin TryCloudflare).
- Inicio por géneros, Modos de ambiente y limpieza de etiquetas (rama `feat/inicio-generos-ambiente`, pendiente de la prueba del dueño):
  - Bajo «Tus me gusta» y «Jam» solo van tus canciones (las que te gustan y, si faltan, las últimas que sonaron); ya no las del catálogo de prueba.
  - Modos de ambiente: Modo Rumba (Salsa, Reggaetón, Merengue, Electrónica), Modo Tomar (Despecho, Rancheras, Vallenato) y Modo Relax (Baladas, Boleros, Chill), cada uno con «Todo» y sus subfiltros.
  - «Selecciones rápidas» por género (Salsa, Reggaetón, Merengue, Popular), ya no a partir del historial. «Muy sonadas» son las playlists de cada género (Salsa, Reggaetón, Merengue, Popular, Vallenato, Música colombiana).
  - Las canciones salen de las playlists que arma YouTube Music para cada género: su categoría de «Géneros» y búsquedas como «salsa para fiesta». Pasan por los filtros de las recomendaciones: sin covers, sin artistas que sueles saltar, 2 por artista y sin repetidas.
  - «Tus artistas» tiene «+ Agregar más artistas».
  - Sin las etiquetas «YouTube Music» en filas, Buscar, Inicio, páginas de playlist y subtítulos. Se dejó el botón de acción «Abrir en YouTube Music» y la explicación de Ayuda.
  - El reproductor carga siempre desde youtube.com, así lo alcanzan la opción de segundo plano y los filtros de Brave. Se quitó la opción nocookie de Ayuda.
- Limpieza de Inicio, recomendaciones, cola de 10 y sin conexión (rama `feat/ui-recomendaciones-offline`, pendiente de la prueba del dueño):
  - Inicio sin «Lista de prueba». Todo en lista compacta (carátula pequeña, título, artista y «⋮»), en páginas de 4 que se deslizan de lado.
  - Menú «⋮» en todas las filas (también en Inicio) con Reproducir, Agregar a la cola, Me gusta… Deslizar a la izquierda abre ese menú; ya no agrega nada por sí solo.
  - Ajustes (nuevo): ocultar el selector «Canción | Video» de «Sonando ahora».
  - «Selecciones rápidas» propias: la radio de tus últimas 10 canciones (mismo género y época), con filtros «Como …». Reemplaza la de YouTube Music, que sin iniciar sesión no es personal.
  - Tendencias y novedades de YouTube Music solo de tus géneros: artistas que aparecen en las radios de lo que escuchas. Fuera «Versiones y remixes».
  - Filtros estrictos en todo: sin covers, sin artistas que sueles saltar (pasar a la siguiente antes de 30 s, 2 veces o más), misma época, 2 por artista como mucho y nada repetido entre estantes (tampoco con «Tus artistas»).
  - Cola: siempre 10 o más por sonar. Al quitar una, la radio repone enseguida. Al tocar una recomendada, la cola arranca con 10 «Recomendadas basadas en esta canción» y sigue con bloques de 5 «Nuevas para ti» (nunca sonaron aquí) y más recomendadas.
  - Sin conexión: aviso y espera, sin saltar canciones en cadena ni marcarlas como «Solo en YouTube Music» (antes pasaba). Al volver internet sigue la misma canción.
  - No se implementó la descarga de canciones ni el paso a `<audio>` nativo: chocan con la regla del proyecto y con las condiciones de YouTube.
- Jam: cola compartida de verdad, en vivo (rama `feat/jam-interactividad`, pendiente de la prueba del dueño):
  - Causa de «no permite agregar canciones»: el invitado solo «estaba» en la Jam mientras miraba su página. Fuera de ella (Buscar, álbumes…), «⋮ → Agregar a la cola» y deslizar iban a la cola de SU teléfono, nunca a la Jam; y lo agregado desde la sala solo se veía cuando el teléfono del anfitrión lo tomaba y lo volvía a publicar (con su app en segundo plano, nunca; sin nada sonando, la primera quedaba «Sonando ahora» aunque estaba en pausa y la cola seguía diciendo «¡agrega la primera!»). El anfitrión no tenía búsqueda en su sala.
  - El invitado queda en la Jam en toda la app hasta tocar «Salir» (se recuerda al recargar): «⋮ → Agregar a la Jam» va a la cola compartida; «Jam» lo devuelve a su sala.
  - Anfitrión e invitados tienen «Agrega canciones» (búsqueda de YouTube Music) en la sala. Lo del anfitrión va directo a su cola, que es la de todos.
  - «Próximas en sonar» de la Jam (salas y panel/página «Próximas en sonar» del invitado): lo que viene en el teléfono del anfitrión, quién agregó cada una y lo recién agregado «En camino» al instante, aunque el anfitrión tarde. Se ve si la canción actual está «En pausa».
  - Quitar: en la lista de la Jam, deslizar a la derecha quita la canción con «Deshacer» de 4 s (la devuelve a su lugar). El anfitrión puede quitar cualquiera; cada invitado, solo las suyas (un id al azar guardado en su navegador, que el servidor verifica y no publica). Deslizar a la izquierda abre «⋮».
  - En vivo: un WebSocket por sala avisa cada cambio a todos (medido por el túnel: lo que agrega o quita uno aparece en los demás en 0,15–0,4 s). Si no conecta o se cae, la app consulta cada 3 s y lo reintenta.
  - Servidor final (no TryCloudflare): Worker de Cloudflare `soundblue-jam` (`worker/jam.js`) con un Durable Object SQLite por sala y WebSockets con hibernación; mismas reglas que el servidor de prueba (`worker/jam-room.ts`). Probado solo en local con `wrangler dev`; sin publicar (`npm run worker:jam:publicar` + `VITE_JAM_API` cuando el dueño lo apruebe).
  - Sin repetidas: lo que ya suena, viene o va en camino no se agrega otra vez («Ya está en la Jam», queda en el registro de repetidas; el servidor también lo rechaza); el anfitrión sigue descartando por videoId (avisa «…que ya estaba en la cola»).
  - Red local/Wi-Fi sin servidor: no es viable en una app web (ver README → Jam).
- Cero repetidas, cola infinita e Inicio solo con ▶ (rama `feat/fix-duplicados-ux`, pendiente de la prueba del dueño):
  - Causa de la canción doble en la cola: en el carrusel de «Tus artistas», deslizar de lado una fila la agregaba sin querer a «Siguiente en la cola», y luego volvía a sonar en la lista.
  - En Inicio las filas ya no tienen menú «⋮» ni gestos de agregar/quitar: solo ▶. Tocar algo en Inicio reemplaza la cola; las canciones de «Tus artistas» arrancan su radio.
  - Ninguna canción (mismo videoId) entra dos veces: ni repetida dentro de una lista, ni si ya está en tu cola, ni desde la radio, ni con «Agregar a la cola» («Ya está en siguientes»).
  - La radio trae como mucho 1 canción del mismo artista por cada 5; el resto (80 %) son otros artistas del mismo género.
  - Cola infinita: cuando a cualquier lista le quedan 2 canciones, sigue con la radio (mismo género y época) de su última canción, y si una radio se agota se arma otra. Con «repetir» activado no se agrega nada.
  - Ayuda → «Diagnóstico de recomendaciones» muestra las canciones descartadas por duplicado y el motivo de cada una.
- Se cierra el experimento de segundo plano basado en Mute-Trick: descartado, iframe de YouTube silenciado por Chrome a nivel de proceso. Repo de preview: su página de GitHub Pages se dio de baja (https://mikem4n.github.io/soundblue-preview/ da 404); el repositorio `MikeM4n/soundblue-preview` lo borra el dueño desde GitHub (Settings → Danger Zone), porque la credencial de este PC no tiene permiso para borrar repositorios.
- Radio por artista, género y época (rama `feat/radio-genero-epoca`, pendiente de la prueba del dueño): al reproducir desde Buscar (y en «Iniciar radio») la cola ya no son los demás resultados de la búsqueda (salían covers y canciones que solo comparten palabras con el título), sino una radio que se llena de a 5 cuando quedan 2: mismo artista (máx. 2 de cada 5) y otros artistas del mismo género (radio de YouTube Music a partir de la canción, no de su título), sin covers ni versiones del título de la semilla, sin repetidas, en la misma época (año del álbum ±10 años; con canciones viejas, nada de los últimos 3 años), al azar con una semilla por sesión. Diagnóstico en Ayuda: época detectada, descartadas por motivo y últimas 10 generadas.
- «Tus artistas» (Inicio): cada artista muestra sus 5 canciones más conocidas (estante «Canciones» de su página de YouTube Music, sin cuota), guardadas 24 h por artista; respaldo con la YouTube Data API solo si YouTube Music falla. Diagnóstico en Ayuda → «Diagnóstico de recomendaciones». Rama `feat/artistas-top-canciones`, pendiente de la prueba del dueño.

package com.soundblue.mobile.widget

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import androidx.annotation.OptIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.Action
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartService
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ContentScale
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxHeight
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import com.soundblue.mobile.MainActivity
import com.soundblue.mobile.PlaybackService
import com.soundblue.mobile.R
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

// Colores del widget, como el de YouTube Music: superficie oscura, ▶ en un círculo blanco.
private val BACKGROUND = Color(0xFF1F1F1F)
private val PLACEHOLDER = Color(0xFF333333)
private val TEXT = Color.White
private val TEXT_SECONDARY = Color(0xFFAAAAAA)
private val DIMMED = Color(0x59FFFFFF) // controles apagados (nada cargado)
private val PLAY_ICON = Color(0xFF0F0F0F)
private val LIKED = Color(0xFF4169E1) // azul rey del logo: el corazón de Tus me gusta, como en la app

// Siempre el mismo diseño (carátula a la izquierda; a la derecha la canción arriba y ⏮ ⏯ ⏭ ♥ abajo); según el alto que
// le dé el inicio cambian los tamaños (ver Dims):
private val SMALL = DpSize(250.dp, 56.dp) // menos de 72 dp (p. ej. el teléfono acostado)
private val COMPACT = DpSize(250.dp, 72.dp) // 4×1 de la mayoría de los inicios
private val TALL = DpSize(250.dp, 90.dp) // 4×1 con filas altas, o estirado
private val TALL_WIDE = DpSize(310.dp, 90.dp) // lo mismo, con aire entre los botones

/** Medidas de un tamaño del widget. Sin `artist`, solo cabe el título. */
private class Dims(val art: Dp, val button: Dp, val icon: Dp, val gap: Dp, val title: TextUnit, val artist: TextUnit?, val padding: Dp)

private fun dimsFor(size: DpSize): Dims = when {
    // 4 + 19 + 16 + 44 + 4 = 87 dp de alto; 4 × 44 dp caben justo en lo que queda de 250 dp de ancho.
    size.height >= TALL.height -> Dims(48.dp, 44.dp, 28.dp, if (size.width >= TALL_WIDE.width) 8.dp else 0.dp, 14.sp, 12.sp, 4.dp)
    // 3 + 16 + 14 + 36 + 3 = 72 dp.
    size.height >= COMPACT.height -> Dims(44.dp, 36.dp, 24.dp, 8.dp, 12.sp, 10.sp, 3.dp)
    // 3 + 16 + 32 + 3 = 54 dp: sin la línea del artista.
    else -> Dims(40.dp, 32.dp, 22.dp, 8.dp, 12.sp, null, 3.dp)
}

/**
 * Widget de SoundBlue (Jetpack Glance), como el de YouTube Music: a la izquierda la carátula y a la derecha título y
 * artista arriba, con ⏮ ⏯ ⏭ ♥ centrados abajo. Los botones le mandan la orden a PlaybackService con un MediaController
 * (WidgetControls), sin abrir la app; tocar la carátula o el texto la abre. Si el reproductor ya no tiene nada cargado
 * (p. ej. cerraste la app), se ve la última canción que sonó y ▶ la vuelve a poner a sonar sin abrir la app.
 */
class SoundBlueWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(SMALL, COMPACT, TALL, TALL_WIDE))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        SoundBlueWidgetState.restore(context) // proceso nuevo: la última canción guardada
        provideContent {
            val snapshot by SoundBlueWidgetState.snapshot.collectAsState()
            WidgetContent(snapshot)
        }
    }
}

class SoundBlueWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = SoundBlueWidget()
}

@Composable
private fun WidgetContent(snapshot: WidgetSnapshot) {
    val dims = dimsFor(LocalSize.current)
    val openApp = actionStartActivity<MainActivity>()
    Row(
        modifier = GlanceModifier.fillMaxSize().background(BACKGROUND).cornerRadius(16.dp).padding(horizontal = 8.dp, vertical = dims.padding),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Artwork(snapshot.artwork, dims.art, GlanceModifier.clickable(openApp))
        Spacer(GlanceModifier.width(10.dp))
        Column(modifier = GlanceModifier.defaultWeight().fillMaxHeight()) {
            SongText(snapshot, dims, GlanceModifier.fillMaxWidth().clickable(openApp))
            // Como Arrangement.SpaceBetween (Glance no lo tiene): el texto arriba y los botones abajo.
            Spacer(GlanceModifier.defaultWeight())
            Row(
                modifier = GlanceModifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Controls(snapshot, dims)
            }
        }
    }
}

/** Título y artista, una línea cada uno (solo el título si no cabe más). */
@Composable
private fun SongText(snapshot: WidgetSnapshot, dims: Dims, modifier: GlanceModifier) {
    Column(modifier = modifier) {
        Text(
            text = snapshot.title ?: "SoundBlue",
            style = TextStyle(color = ColorProvider(TEXT), fontSize = dims.title, fontWeight = FontWeight.Bold),
            maxLines = 1,
        )
        if (dims.artist != null) {
            Text(
                text = if (snapshot.title != null) snapshot.artist.orEmpty() else "Elige algo para escuchar",
                style = TextStyle(color = ColorProvider(TEXT_SECONDARY), fontSize = dims.artist),
                maxLines = 1,
            )
        }
    }
}

/** ⏮ ⏯ ⏭ ♥ con las medidas de `dims`. */
@Composable
private fun Controls(snapshot: WidgetSnapshot, dims: Dims) {
    val button = dims.button
    val icon = dims.icon
    val gap = dims.gap
    val context = LocalContext.current
    val heart = if (snapshot.liked) R.drawable.ic_widget_favorite else R.drawable.ic_widget_favorite_border
    val heartLabel = if (snapshot.liked) "Quitar de Tus me gusta" else "Me gusta"
    // Sin nada cargado en el reproductor, ▶ vuelve a poner a sonar la última canción (y su cola) sin abrir la app: Android
    // arranca PlaybackService en primer plano porque es un toque en el widget. Los demás se ven apagados.
    val play = when {
        snapshot.active -> actionRunCallback<PlayPauseAction>()
        snapshot.title != null -> {
            val intent = Intent(context, PlaybackService::class.java).setAction(PlaybackService.ACTION_RESUME_FROM_WIDGET)
            actionStartService(intent, isForegroundService = true)
        }
        else -> actionStartActivity<MainActivity>() // nunca ha sonado nada: a elegir música
    }
    ControlIcon(R.drawable.ic_widget_previous, "Anterior", if (snapshot.active) actionRunCallback<PreviousAction>() else null, button, icon)
    Gap(gap)
    PlayButton(snapshot.active && snapshot.playing, play, button, icon)
    Gap(gap)
    ControlIcon(R.drawable.ic_widget_next, "Siguiente", if (snapshot.active) actionRunCallback<NextAction>() else null, button, icon)
    Gap(gap)
    // ♥ solo con la app abierta: Tus me gusta viven en ella.
    val like = if (snapshot.active && snapshot.likeable) actionRunCallback<ToggleLikeAction>() else null
    ControlIcon(heart, heartLabel, like, button, icon, tint = if (snapshot.liked) LIKED else TEXT)
}

@Composable
private fun Gap(width: Dp) {
    if (width > 0.dp) Spacer(GlanceModifier.width(width))
}

@Composable
private fun Artwork(artwork: Bitmap?, size: Dp, extra: GlanceModifier) {
    val modifier = extra.size(size).cornerRadius(6.dp)
    if (artwork != null) {
        Image(ImageProvider(artwork), contentDescription = null, modifier = modifier, contentScale = ContentScale.Crop)
        return
    }
    // Sin carátula (nada cargado o mientras llega): una nota musical, como un reproductor vacío.
    Box(modifier = modifier.background(PLACEHOLDER), contentAlignment = Alignment.Center) {
        Image(
            ImageProvider(R.drawable.ic_widget_music_note),
            contentDescription = null,
            modifier = GlanceModifier.size(size / 2),
            colorFilter = ColorFilter.tint(ColorProvider(TEXT_SECONDARY)),
        )
    }
}

/** Un control. Sin `onClick` se ve apagado y no hace nada. */
@Composable
private fun ControlIcon(icon: Int, label: String, onClick: Action?, button: Dp, iconSize: Dp, tint: Color = TEXT) {
    val base = GlanceModifier.size(button).cornerRadius(button / 2)
    Box(modifier = if (onClick != null) base.clickable(onClick) else base, contentAlignment = Alignment.Center) {
        Image(
            ImageProvider(icon),
            contentDescription = label,
            modifier = GlanceModifier.size(iconSize),
            colorFilter = ColorFilter.tint(ColorProvider(if (onClick != null) tint else DIMMED)),
        )
    }
}

/** ⏯ en el círculo blanco. */
@Composable
private fun PlayButton(playing: Boolean, onClick: Action, button: Dp, iconSize: Dp) {
    Box(
        modifier = GlanceModifier.size(button).background(TEXT).cornerRadius(button / 2).clickable(onClick),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            ImageProvider(if (playing) R.drawable.ic_widget_pause else R.drawable.ic_widget_play),
            contentDescription = if (playing) "Pausar" else "Reproducir",
            modifier = GlanceModifier.size(iconSize),
            colorFilter = ColorFilter.tint(ColorProvider(PLAY_ICON)),
        )
    }
}

class PlayPauseAction : ActionCallback {
    @OptIn(UnstableApi::class)
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        WidgetControls.send(context) { Util.handlePlayPauseButtonAction(it) }
    }
}

class PreviousAction : ActionCallback {
    // «Anterior» con la regla de los 3 s, medida por el reproductor (como los audífonos y el reloj).
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        WidgetControls.send(context, Player::seekToPrevious)
    }
}

class NextAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        WidgetControls.send(context, Player::seekToNext)
    }
}

/** ♥: PlaybackService le pasa el pedido a la app, que es la que guarda Tus me gusta. */
class ToggleLikeAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        WidgetControls.send(context) {
            it.sendCustomCommand(SessionCommand(PlaybackService.ACTION_TOGGLE_LIKE, Bundle.EMPTY), Bundle.EMPTY)
        }
    }
}

/**
 * Un control remoto de un solo uso: se conecta a PlaybackService, manda la orden y suelta la conexión. Llega a la misma
 * MediaSession que la notificación, los audífonos y el reloj.
 */
private object WidgetControls {
    private const val RELEASE_DELAY_MS = 1_000L // que la orden llegue al servicio antes de soltar la conexión

    suspend fun send(context: Context, command: (MediaController) -> Unit) = withContext(Dispatchers.Main) {
        // Con el contexto de la app: el que Glance pasa a los ActionCallback es el del BroadcastReceiver, que Android no
        // deja enlazarse a un servicio (bindService lanza una excepción y la orden se perdía sin hacer nada).
        val app = context.applicationContext
        val token = SessionToken(app, ComponentName(app, PlaybackService::class.java))
        val controller = MediaController.Builder(app, token).buildAsync().await()
        try {
            command(controller)
            delay(RELEASE_DELAY_MS)
        } finally {
            controller.release()
        }
    }

    private suspend fun <T> ListenableFuture<T>.await(): T = suspendCancellableCoroutine { continuation ->
        addListener({
            try {
                continuation.resume(get())
            } catch (error: Exception) {
                continuation.resumeWithException(error.cause ?: error)
            }
        }, MoreExecutors.directExecutor())
        continuation.invokeOnCancellation { cancel(false) }
    }
}

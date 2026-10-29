package com.soundblue.mobile.widget

import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import android.os.Bundle
import androidx.annotation.OptIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
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

// Angosto: ♥, ⏯ y ⏭. Desde 310 dp de ancho también ⏮.
private val COMPACT = DpSize(250.dp, 56.dp)
private val WIDE = DpSize(310.dp, 56.dp)

/**
 * Widget de SoundBlue (Jetpack Glance), al estilo del de YouTube Music: a la izquierda la carátula, al centro título y
 * artista (una línea cada uno), a la derecha ♥ ⏮ ⏯ ⏭. Los botones le mandan la orden a PlaybackService con un
 * MediaController (WidgetControls), sin abrir la app; tocar la carátula o el texto la abre. Sin nada cargado se ve como
 * un reproductor vacío y ▶ abre la app para elegir música.
 */
class SoundBlueWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(COMPACT, WIDE))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
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
    val openApp = actionStartActivity<MainActivity>()
    val wide = LocalSize.current.width >= WIDE.width
    val loaded = snapshot.title != null
    Row(
        modifier = GlanceModifier.fillMaxSize().background(BACKGROUND).cornerRadius(16.dp).padding(start = 8.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            modifier = GlanceModifier.defaultWeight().fillMaxHeight().clickable(openApp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Artwork(snapshot.artwork)
            Spacer(GlanceModifier.width(10.dp))
            Column(modifier = GlanceModifier.defaultWeight()) {
                Text(
                    text = snapshot.title ?: "SoundBlue",
                    style = TextStyle(color = ColorProvider(TEXT), fontSize = 14.sp, fontWeight = FontWeight.Bold),
                    maxLines = 1,
                )
                Text(
                    text = if (loaded) snapshot.artist.orEmpty() else "Elige algo para escuchar",
                    style = TextStyle(color = ColorProvider(TEXT_SECONDARY), fontSize = 12.sp),
                    maxLines = 1,
                )
            }
        }
        if (loaded) {
            ControlIcon(
                icon = if (snapshot.liked) R.drawable.ic_widget_favorite else R.drawable.ic_widget_favorite_border,
                label = if (snapshot.liked) "Quitar de Tus me gusta" else "Me gusta",
                onClick = actionRunCallback<ToggleLikeAction>(),
                tint = if (snapshot.liked) LIKED else TEXT,
            )
            if (wide) ControlIcon(R.drawable.ic_widget_previous, "Anterior", actionRunCallback<PreviousAction>())
            PlayButton(snapshot.playing, actionRunCallback<PlayPauseAction>())
            ControlIcon(R.drawable.ic_widget_next, "Siguiente", actionRunCallback<NextAction>())
        } else {
            ControlIcon(R.drawable.ic_widget_favorite_border, "Me gusta", onClick = null, tint = DIMMED)
            if (wide) ControlIcon(R.drawable.ic_widget_previous, "Anterior", onClick = null, tint = DIMMED)
            PlayButton(playing = false, onClick = openApp)
            ControlIcon(R.drawable.ic_widget_next, "Siguiente", onClick = null, tint = DIMMED)
        }
    }
}

@Composable
private fun Artwork(artwork: Bitmap?) {
    val modifier = GlanceModifier.size(48.dp).cornerRadius(6.dp)
    if (artwork != null) {
        Image(ImageProvider(artwork), contentDescription = null, modifier = modifier, contentScale = ContentScale.Crop)
        return
    }
    // Sin carátula (nada cargado o mientras llega): una nota musical, como un reproductor vacío.
    Box(modifier = modifier.background(PLACEHOLDER), contentAlignment = Alignment.Center) {
        Image(
            ImageProvider(R.drawable.ic_widget_music_note),
            contentDescription = null,
            modifier = GlanceModifier.size(24.dp),
            colorFilter = ColorFilter.tint(ColorProvider(TEXT_SECONDARY)),
        )
    }
}

/** Un control. Sin `onClick` se ve apagado y no hace nada. */
@Composable
private fun ControlIcon(icon: Int, label: String, onClick: Action?, tint: Color = TEXT) {
    val base = GlanceModifier.size(40.dp).cornerRadius(20.dp)
    Box(modifier = if (onClick != null) base.clickable(onClick) else base, contentAlignment = Alignment.Center) {
        Image(
            ImageProvider(icon),
            contentDescription = label,
            modifier = GlanceModifier.size(24.dp),
            colorFilter = ColorFilter.tint(ColorProvider(tint)),
        )
    }
}

@Composable
private fun PlayButton(playing: Boolean, onClick: Action) {
    Box(
        modifier = GlanceModifier.size(40.dp).background(TEXT).cornerRadius(20.dp).clickable(onClick),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            ImageProvider(if (playing) R.drawable.ic_widget_pause else R.drawable.ic_widget_play),
            contentDescription = if (playing) "Pausar" else "Reproducir",
            modifier = GlanceModifier.size(24.dp),
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

/** Un control remoto de un solo uso: se conecta a PlaybackService, manda la orden y suelta la conexión. */
private object WidgetControls {
    private const val RELEASE_DELAY_MS = 1_000L // que la orden llegue al servicio antes de soltar la conexión

    suspend fun send(context: Context, command: (MediaController) -> Unit) = withContext(Dispatchers.Main) {
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val controller = MediaController.Builder(context, token).buildAsync().await()
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

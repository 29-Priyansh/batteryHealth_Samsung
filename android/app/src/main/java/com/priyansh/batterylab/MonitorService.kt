package com.priyansh.batterylab

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.IBinder
import android.os.PowerManager
import android.telephony.TelephonyCallback
import android.telephony.TelephonyDisplayInfo
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Foreground service that exists only while a session is active (docs/PLAN.md §3, §11.1).
 * It only keeps the process alive so runtime receivers keep firing: no alarms, no polling, no wakelocks.
 */
class MonitorService : Service() {

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            when (i.action) {
                Intent.ACTION_BATTERY_CHANGED -> Recorder.onBattery(i)
                Intent.ACTION_SCREEN_ON -> { Recorder.onScreen(true); startNowTicker() }
                Intent.ACTION_SCREEN_OFF -> { Recorder.onScreen(false); stopNowTicker() }
                PowerManager.ACTION_POWER_SAVE_MODE_CHANGED -> Recorder.onAutoParamSignal("broadcast")
                WifiManager.WIFI_STATE_CHANGED_ACTION -> Recorder.onAutoParamSignal("broadcast")
                LocationManager.MODE_CHANGED_ACTION -> Recorder.onAutoParamSignal("broadcast")
                Intent.ACTION_TIME_CHANGED -> Recorder.onSystemEvent("time_set")
                Intent.ACTION_TIMEZONE_CHANGED -> Recorder.onSystemEvent("tz_changed", JSONObject().put("tz", i.getStringExtra(Intent.EXTRA_TIMEZONE)))
                Intent.ACTION_SHUTDOWN -> {
                    Recorder.onSystemEvent("shutdown")
                    // Give the executor a moment to write before the device powers off.
                    val done = java.util.concurrent.CountDownLatch(1)
                    Recorder.post { done.countDown() }
                    done.await(2, TimeUnit.SECONDS)
                }
            }
        }
    }

    private var telephonyCallback: TelephonyCallback? = null

    // "Now" meter ticker: runs only while the screen is on (R2.11); no alarms, no wakelocks.
    private val ticker = android.os.Handler(android.os.Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            Recorder.sampleNow()
            ticker.postDelayed(this, NOW_TICK_MS)
        }
    }

    private fun startNowTicker() {
        ticker.removeCallbacks(tick)
        ticker.post(tick)
    }

    private fun stopNowTicker() = ticker.removeCallbacks(tick)

    override fun onCreate() {
        super.onCreate()
        Recorder.init(this)
        Recorder.service = this
        createChannel()
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_BATTERY_CHANGED)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
            addAction(WifiManager.WIFI_STATE_CHANGED_ACTION)
            addAction(LocationManager.MODE_CHANGED_ACTION)
            addAction(Intent.ACTION_TIME_CHANGED)
            addAction(Intent.ACTION_TIMEZONE_CHANGED)
            addAction(Intent.ACTION_SHUTDOWN)
        }
        ContextCompat.registerReceiver(this, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        registerTelephony()
        if (getSystemService(PowerManager::class.java).isInteractive) startNowTicker()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(
            NOTIFICATION_ID, build(Recorder.Notice("Battery test", "Starting…", "Starting…"), paused = false),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
        )
        when (intent?.action) {
            ACTION_PAUSE -> Recorder.post { runCatching { Recorder.pause() } }
            ACTION_RESUME -> Recorder.post { runCatching { Recorder.resume() } }
        }
        Recorder.post { Recorder.onServiceStarted() }
        return START_STICKY
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        Recorder.onAutoParamSignal("configuration")
    }

    override fun onDestroy() {
        stopNowTicker()
        runCatching { unregisterReceiver(receiver) }
        telephonyCallback?.let { cb ->
            runCatching { getSystemService(TelephonyManager::class.java).unregisterTelephonyCallback(cb) }
        }
        if (Recorder.service === this) Recorder.service = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    fun stopMonitoring() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    @Volatile private var lastNotice: Recorder.Notice? = null

    fun updateNotification(notice: Recorder.Notice, paused: Boolean, startWall: Long) {
        sessionStartWall = startWall
        lastNotice = notice
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, build(notice, paused))
    }

    private fun build(notice: Recorder.Notice, paused: Boolean): Notification {
        val n = lastNotice ?: notice
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val toggle = PendingIntent.getService(
            this, 1, Intent(this, MonitorService::class.java).setAction(if (paused) ACTION_RESUME else ACTION_PAUSE),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val icon = android.graphics.drawable.Icon.createWithResource(this, R.drawable.ic_stat_monitor)
        // Opens the app straight into the "Log a setting change" sheet.
        val logChange = PendingIntent.getActivity(
            this, 2, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(MainActivity.EXTRA_OPEN, "log_change"),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        // The chronometer is rendered by the system UI, so the elapsed time ticks without waking the app.
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_monitor)
            .setColor(0xFF2563EB.toInt())
            .setContentTitle(n.title)
            .setContentText(n.text)
            .setStyle(Notification.BigTextStyle().bigText(n.details))
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(icon, if (paused) "Resume" else "Pause", toggle).build())
            .addAction(Notification.Action.Builder(icon, "Log change", logChange).build())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(true)
            .setUsesChronometer(true)
            .setWhen(sessionStartWall)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    @Volatile var sessionStartWall: Long = System.currentTimeMillis()

    private fun createChannel() {
        val channel = NotificationChannel(CHANNEL_ID, "Battery test monitoring", NotificationManager.IMPORTANCE_LOW).apply {
            setShowBadge(false)
            enableVibration(false)
            setSound(null, null)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun registerTelephony() {
        val tm = getSystemService(TelephonyManager::class.java)
        val executor = ContextCompat.getMainExecutor(this)
        // The data-state listener needs READ_PHONE_STATE; fall back to radio-only if it is denied.
        val full = object : TelephonyCallback(), TelephonyCallback.DisplayInfoListener, TelephonyCallback.UserMobileDataStateListener {
            override fun onDisplayInfoChanged(info: TelephonyDisplayInfo) = Recorder.onRadio(AutoParams.radioLabel(info))
            override fun onUserMobileDataStateChanged(enabled: Boolean) = Recorder.onAutoParamSignal("telephony_callback")
        }
        val radioOnly = object : TelephonyCallback(), TelephonyCallback.DisplayInfoListener {
            override fun onDisplayInfoChanged(info: TelephonyDisplayInfo) = Recorder.onRadio(AutoParams.radioLabel(info))
        }
        telephonyCallback = listOf(full, radioOnly).firstOrNull { cb ->
            runCatching { tm.registerTelephonyCallback(executor, cb) }.isSuccess
        }
    }

    companion object {
        private const val CHANNEL_ID = "monitoring"
        private const val NOTIFICATION_ID = 1
        private const val NOW_TICK_MS = 5_000L
        private const val ACTION_PAUSE = "com.priyansh.batterylab.PAUSE"
        private const val ACTION_RESUME = "com.priyansh.batterylab.RESUME"

        fun start(ctx: Context) = ContextCompat.startForegroundService(ctx, Intent(ctx, MonitorService::class.java))
    }
}

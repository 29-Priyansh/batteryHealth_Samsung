package com.priyansh.batterylab

import android.Manifest
import android.app.AppOpsManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import android.provider.Settings
import android.telephony.TelephonyCallback
import android.telephony.TelephonyDisplayInfo
import android.telephony.TelephonyManager
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.json.JSONObject
import java.util.concurrent.Executors

@CapacitorPlugin(
    name = "BatteryLab",
    permissions = [
        Permission(alias = "phone", strings = [Manifest.permission.READ_PHONE_STATE]),
        Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS]),
    ],
)
class BatteryLabPlugin : Plugin() {

    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val db by lazy { LabDatabase.get(context) }

    @Volatile private var visible = true
    private val sampleListener: (JSObject) -> Unit = { msg -> if (visible) notifyListeners("sampleAdded", msg) }

    override fun load() {
        Recorder.init(context)
        Recorder.listeners.add(sampleListener)
        // If a session survived a process death without the service restarting, resume monitoring now.
        Recorder.post { if (Recorder.hasActiveSession()) MonitorService.start(context) }
    }

    override fun handleOnPause() {
        visible = false
        Recorder.uiPausedElapsed = SystemClock.elapsedRealtime()
        super.handleOnPause()
    }

    override fun handleOnResume() {
        visible = true
        super.handleOnResume()
    }

    override fun handleOnDestroy() {
        Recorder.listeners.remove(sampleListener)
        super.handleOnDestroy()
    }

    // ------------------------------------------------------------------ sessions (M2)

    /** Runs [block] on the recorder thread and resolves with its result, or rejects with its error message. */
    private fun onRecorder(call: PluginCall, block: () -> JSObject?) = Recorder.post {
        try {
            val result = block()
            if (result == null) call.resolve() else call.resolve(result)
        } catch (e: Throwable) {
            call.reject(e.message ?: e.javaClass.simpleName)
        }
    }

    @PluginMethod
    fun getCurrentState(call: PluginCall) = onRecorder(call) {
        val active = if (Recorder.hasActiveSession()) Recorder.activeSessionId() else null
        val battery = Recorder.readBattery()
        JSObject().apply {
            put("battery", battery?.let {
                JSObject().put("level", it.level).put("status", it.status).put("plugged", it.plugged)
                    .put("tempC", it.tempDc / 10.0).put("voltageMv", it.voltageMv)
            })
            put("auto", JSObject().also { o -> AutoParams.read(context).forEach { (k, v) -> o.put(k, v ?: JSONObject.NULL) } })
            put("radio", Recorder.currentRadio() ?: JSONObject.NULL)
            put("activeSession", active?.let { Recorder.sessionJson(it) } ?: JSONObject.NULL)
            put("activeValues", if (active != null) Recorder.currentValuesJson() else JSONObject.NULL)
            put("live", Recorder.liveJson() ?: JSONObject.NULL)
            put("counts", active?.let {
                db.queryOne(
                    "SELECT (SELECT COUNT(*) FROM sample WHERE session_id = ?1) AS samples, " +
                        "(SELECT COUNT(*) FROM event WHERE session_id = ?1) AS events, " +
                        "(SELECT COUNT(*) FROM config_change WHERE session_id = ?1) AS changes", it,
                )
            } ?: JSONObject.NULL)
        }
    }

    @PluginMethod
    fun startSession(call: PluginCall) {
        val type = call.getString("type")
        if (type != "charging" && type != "draining") return call.reject("type must be charging or draining")
        val manualObj = call.getObject("manual", JSObject())!!
        val manual = manualObj.keys().asSequence().associateWith { k -> manualObj.optString(k).takeIf { !manualObj.isNull(k) } }
        val tracked = call.getArray("trackedParams")?.toList<String>() ?: emptyList()
        onRecorder(call) {
            Recorder.startSession(
                type, call.getInt("target"), call.getInt("threshold"), manual, tracked,
                call.getObject("conditions")?.toString(), call.getString("notes"),
            ).also { MonitorService.start(context) }
        }
    }

    @PluginMethod
    fun pauseSession(call: PluginCall) = onRecorder(call) { Recorder.pause() }

    @PluginMethod
    fun setLimit(call: PluginCall) {
        val value = call.getInt("value") ?: return call.reject("value required")
        onRecorder(call) { Recorder.setLimit(value) }
    }

    @PluginMethod
    fun resumeSession(call: PluginCall) = onRecorder(call) { Recorder.resume() }

    @PluginMethod
    fun stopSession(call: PluginCall) = onRecorder(call) {
        Recorder.stop(payload = call.getObject("confirmations")?.let { JSONObject().put("confirmations", it) })
    }

    @PluginMethod
    fun logChange(call: PluginCall) {
        val key = call.getString("param") ?: return call.reject("param required")
        val value = call.getString("value")
        val windowStart = call.getLong("windowStartWall")
        onRecorder(call) { Recorder.logChange(key, value, windowStart) }
    }

    @PluginMethod
    fun listSessions(call: PluginCall) = onRecorder(call) {
        JSObject().put("sessions", db.queryJson(
            "SELECT s.*, (SELECT COUNT(*) FROM sample WHERE session_id = s.id) AS sample_count, " +
                "(SELECT COUNT(*) FROM config_change WHERE session_id = s.id) AS change_count " +
                "FROM session s ORDER BY start_wall DESC",
        ))
    }

    @PluginMethod
    fun getSessionData(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id required")
        onRecorder(call) {
            JSObject().apply {
                put("session", db.queryOne("SELECT * FROM session WHERE id = ?", id) ?: error("Session not found"))
                put("samples", db.queryJson("SELECT * FROM sample WHERE session_id = ? ORDER BY id", id))
                put("events", db.queryJson("SELECT * FROM event WHERE session_id = ? ORDER BY id", id))
                put("configStates", db.queryJson("SELECT * FROM config_state WHERE session_id = ? ORDER BY id", id))
                put("paramValues", db.queryJson(
                    "SELECT p.* FROM param_value p JOIN config_state c ON c.id = p.config_state_id WHERE c.session_id = ?", id,
                ))
                put("configChanges", db.queryJson("SELECT * FROM config_change WHERE session_id = ? ORDER BY id", id))
                put("build", db.queryOne(
                    "SELECT b.* FROM build_snapshot b JOIN session s ON s.build_snapshot_id = b.id WHERE s.id = ?", id,
                ) ?: JSONObject.NULL)
            }
        }
    }

    @PluginMethod
    fun deleteSession(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id required")
        onRecorder(call) {
            check(Recorder.activeSessionId() != id) { "Stop the session before deleting it" }
            db.writableDatabase.delete("session", "id = ?", arrayOf(id))
            null
        }
    }

    @PluginMethod
    fun getOverhead(call: PluginCall) = onRecorder(call) {
        JSObject().put("days", db.queryJson("SELECT * FROM overhead_stat ORDER BY day DESC LIMIT 30"))
    }

    // ------------------------------------------------------------------ probe (M0)

    @PluginMethod
    fun probe(call: PluginCall) {
        val report = Probe(context).collect()
        // TelephonyDisplayInfo (LTE vs NR-NSA vs NR-SA icon state) is only delivered via callback.
        val result = JSObject()
        val tm = context.getSystemService(TelephonyManager::class.java)
        var done = false
        var callback: TelephonyCallback? = null
        val finish = {
            if (!done) {
                done = true
                callback?.let { runCatching { tm.unregisterTelephonyCallback(it) } }
                report.put("telephony_display_info", result)
                call.resolve(report)
            }
        }
        try {
            callback = object : TelephonyCallback(), TelephonyCallback.DisplayInfoListener {
                override fun onDisplayInfoChanged(info: TelephonyDisplayInfo) {
                    result.put("network_type", Probe.networkTypeName(info.networkType))
                    result.put("override_network_type", overrideName(info.overrideNetworkType))
                    main.post(finish)
                }
            }
            tm.registerTelephonyCallback(ContextCompat.getMainExecutor(context), callback)
            main.postDelayed({ result.put("note", "no callback within 2 s"); finish() }, 2000)
        } catch (e: Throwable) {
            result.put("error", "${e.javaClass.simpleName}: ${e.message}")
            finish()
        }
    }

    @PluginMethod
    fun sampleBroadcasts(call: PluginCall) {
        val seconds = call.getInt("seconds", 120)!!.coerceIn(5, 900)
        var count = 0
        var level = -1; var voltage = -1; var temp = Int.MIN_VALUE; var status = -1
        var levelChanges = 0; var voltageChanges = 0; var tempChanges = 0; var statusChanges = 0
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                val l = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
                val v = i.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1)
                val t = i.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
                val s = i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
                // The first delivery is the sticky intent replayed on registration; it is the baseline, not a broadcast.
                if (count++ > 0) {
                    if (l != level) levelChanges++
                    if (v != voltage) voltageChanges++
                    if (t != temp) tempChanges++
                    if (s != status) statusChanges++
                }
                level = l; voltage = v; temp = t; status = s
            }
        }
        context.registerReceiver(receiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        main.postDelayed({
            context.unregisterReceiver(receiver)
            call.resolve(JSObject().apply {
                put("seconds", seconds)
                put("broadcasts", (count - 1).coerceAtLeast(0))
                put("levelChanges", levelChanges)
                put("voltageChanges", voltageChanges)
                put("temperatureChanges", tempChanges)
                put("statusChanges", statusChanges)
            })
        }, seconds * 1000L)
    }

    // ------------------------------------------------------------------ permissions & settings screens

    @PluginMethod
    fun getPermissions(call: PluginCall) = call.resolve(permissionState())

    @PluginMethod
    fun requestPhoneState(call: PluginCall) =
        if (granted(Manifest.permission.READ_PHONE_STATE)) call.resolve(permissionState())
        else requestPermissionForAlias("phone", call, "permissionResult")

    @PluginMethod
    fun requestNotifications(call: PluginCall) =
        if (NotificationManagerCompat.from(context).areNotificationsEnabled()) call.resolve(permissionState())
        else requestPermissionForAlias("notifications", call, "permissionResult")

    @PermissionCallback
    private fun permissionResult(call: PluginCall) = call.resolve(permissionState())

    @PluginMethod
    fun openBatteryOptimization(call: PluginCall) {
        val pm = context.getSystemService(PowerManager::class.java)
        val intent = if (pm.isIgnoringBatteryOptimizations(context.packageName)) {
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        } else {
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
        }
        startSettings(call, intent)
    }

    @PluginMethod
    fun openUsageAccess(call: PluginCall) = startSettings(call, Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))

    @PluginMethod
    fun openAppDetails(call: PluginCall) =
        startSettings(call, Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))

    private fun startSettings(call: PluginCall, intent: Intent) {
        try {
            activity.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Could not open settings: ${e.message}")
        }
    }

    private fun permissionState() = JSObject().apply {
        put("phoneState", granted(Manifest.permission.READ_PHONE_STATE))
        put("notifications", NotificationManagerCompat.from(context).areNotificationsEnabled())
        put("usageAccess", context.getSystemService(AppOpsManager::class.java)
            .unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName) ==
            AppOpsManager.MODE_ALLOWED)
        put("ignoringBatteryOptimizations",
            context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName))
    }

    private fun granted(permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    // ------------------------------------------------------------------ settings store

    @PluginMethod
    fun getSetting(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key required")
        io.execute { call.resolve(JSObject().put("value", db.getSetting(key))) }
    }

    @PluginMethod
    fun setSetting(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key required")
        val value = call.getString("value") ?: return call.reject("value required")
        io.execute {
            db.setSetting(key, value)
            call.resolve()
        }
    }

    private fun overrideName(t: Int) = when (t) {
        TelephonyDisplayInfo.OVERRIDE_NETWORK_TYPE_NONE -> "NONE"
        TelephonyDisplayInfo.OVERRIDE_NETWORK_TYPE_LTE_CA -> "LTE_CA"
        TelephonyDisplayInfo.OVERRIDE_NETWORK_TYPE_LTE_ADVANCED_PRO -> "LTE_ADVANCED_PRO"
        TelephonyDisplayInfo.OVERRIDE_NETWORK_TYPE_NR_NSA -> "NR_NSA"
        TelephonyDisplayInfo.OVERRIDE_NETWORK_TYPE_NR_ADVANCED -> "NR_ADVANCED"
        else -> "type_$t"
    }
}

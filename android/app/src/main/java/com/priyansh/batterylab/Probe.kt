package com.priyansh.batterylab

import android.app.ActivityManager
import android.app.UiModeManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.hardware.display.DisplayManager
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.telephony.TelephonyManager
import android.view.Display
import com.getcapacitor.JSObject

/**
 * Milestone 0 capability probe: reads every public API the plan depends on and reports
 * the raw result, sentinel, or the exception. Read-only; never changes device state.
 */
class Probe(private val ctx: Context) {

    fun collect(): JSObject = JSObject().apply {
        put("device", device())
        put("battery_intent", batteryIntent())
        put("battery_manager", batteryManager())
        put("power", power())
        put("connectivity", connectivity())
        put("telephony", telephony())
        put("display", display())
        put("exit_reasons", exitReasons())
    }

    private fun device() = JSObject().apply {
        put("manufacturer", Build.MANUFACTURER)
        put("model", Build.MODEL)
        put("device", Build.DEVICE)
        put("soc_model", Build.SOC_MODEL)
        put("android_release", Build.VERSION.RELEASE)
        put("sdk_int", Build.VERSION.SDK_INT)
        put("security_patch", Build.VERSION.SECURITY_PATCH)
        put("display_id", Build.DISPLAY)
        put("fingerprint", Build.FINGERPRINT)
        attempt("boot_count") { Settings.Global.getInt(ctx.contentResolver, Settings.Global.BOOT_COUNT) }
        put("elapsed_realtime_ms", SystemClock.elapsedRealtime())
        put("wall_ms", System.currentTimeMillis())
    }

    private fun batteryIntent() = JSObject().apply {
        val intent = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val extras = intent?.extras
        if (extras == null) {
            put("error", "no sticky ACTION_BATTERY_CHANGED")
            return@apply
        }
        // All keys, including non-public ones, are listed for information only; the app relies on public extras.
        for (key in extras.keySet().sorted()) {
            @Suppress("DEPRECATION")
            put(key, extras.get(key)?.toString())
        }
    }

    private fun batteryManager() = JSObject().apply {
        val bm = ctx.getSystemService(BatteryManager::class.java)
        intProp(bm, "charge_counter_uAh", BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER)
        intProp(bm, "current_now", BatteryManager.BATTERY_PROPERTY_CURRENT_NOW)
        intProp(bm, "current_average", BatteryManager.BATTERY_PROPERTY_CURRENT_AVERAGE)
        intProp(bm, "capacity_percent", BatteryManager.BATTERY_PROPERTY_CAPACITY)
        intProp(bm, "status", BatteryManager.BATTERY_PROPERTY_STATUS)
        attempt("energy_counter_nWh") {
            bm.getLongProperty(BatteryManager.BATTERY_PROPERTY_ENERGY_COUNTER).let { if (it == Long.MIN_VALUE) "unsupported" else it }
        }
        attempt("is_charging") { bm.isCharging }
        attempt("charge_time_remaining_ms") { bm.computeChargeTimeRemaining() }
    }

    private fun JSObject.intProp(bm: BatteryManager, name: String, id: Int) =
        attempt(name) { bm.getIntProperty(id).let { if (it == Int.MIN_VALUE) "unsupported" else it } }

    private fun power() = JSObject().apply {
        val pm = ctx.getSystemService(PowerManager::class.java)
        attempt("power_save_mode") { pm.isPowerSaveMode }
        attempt("interactive") { pm.isInteractive }
        attempt("device_idle_mode") { pm.isDeviceIdleMode }
        attempt("ignoring_battery_optimizations") { pm.isIgnoringBatteryOptimizations(ctx.packageName) }
        attempt("location_power_save_mode") { pm.locationPowerSaveMode }
        attempt("thermal_status") { pm.currentThermalStatus }
        attempt("thermal_headroom_10s") { pm.getThermalHeadroom(10) }
        attempt("location_enabled") { ctx.getSystemService(LocationManager::class.java).isLocationEnabled }
        attempt("night_mode_setting") { ctx.getSystemService(UiModeManager::class.java).nightMode }
        attempt("night_mode_active") {
            (ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        }
    }

    private fun connectivity() = JSObject().apply {
        attempt("wifi_enabled") { ctx.getSystemService(WifiManager::class.java).isWifiEnabled }
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        attempt("active_transports") {
            val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return@attempt "none"
            listOfNotNull(
                "wifi".takeIf { caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) },
                "cellular".takeIf { caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) },
                "vpn".takeIf { caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) },
            ).joinToString(",")
        }
        attempt("rx_bytes") { android.net.TrafficStats.getTotalRxBytes() }
        attempt("tx_bytes") { android.net.TrafficStats.getTotalTxBytes() }
    }

    private fun telephony() = JSObject().apply {
        val tm = ctx.getSystemService(TelephonyManager::class.java)
        attempt("sim_state") { tm.simState }
        attempt("active_modem_count") { tm.activeModemCount }
        attempt("operator") { tm.networkOperatorName }
        attempt("is_data_enabled") { tm.isDataEnabled }
        attempt("data_enabled_user") { tm.isDataEnabledForReason(TelephonyManager.DATA_ENABLED_REASON_USER) }
        attempt("data_network_type") { networkTypeName(tm.dataNetworkType) }
        attempt("signal_level_0_4") { tm.signalStrength?.level }
    }

    private fun display() = JSObject().apply {
        attempt("brightness_0_255") { Settings.System.getInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS) }
        attempt("brightness_auto") {
            Settings.System.getInt(ctx.contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE) ==
                Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC
        }
        val d = ctx.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
        attempt("refresh_rate_now") { d.refreshRate }
        attempt("supported_refresh_rates") { d.supportedModes.map { it.refreshRate }.distinct().sorted().joinToString(",") }
    }

    private fun exitReasons() = JSObject().apply {
        attempt("recent") {
            ctx.getSystemService(ActivityManager::class.java)
                .getHistoricalProcessExitReasons(null, 0, 5)
                .joinToString(" | ") { "${it.timestamp}: reason=${it.reason} ${it.description ?: ""}" }
                .ifEmpty { "none" }
        }
    }

    companion object {
        fun networkTypeName(t: Int): String = when (t) {
            TelephonyManager.NETWORK_TYPE_NR -> "NR"
            TelephonyManager.NETWORK_TYPE_LTE -> "LTE"
            TelephonyManager.NETWORK_TYPE_IWLAN -> "IWLAN"
            TelephonyManager.NETWORK_TYPE_UNKNOWN -> "UNKNOWN"
            else -> "type_$t"
        }
    }
}

/** Puts the block's result, or the exception it threw, so the probe never aborts on one failing API. */
internal inline fun JSObject.attempt(key: String, block: () -> Any?) {
    try {
        put(key, block() ?: "null")
    } catch (e: Throwable) {
        put(key, "error: ${e.javaClass.simpleName}: ${e.message}")
    }
}

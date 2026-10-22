package com.priyansh.batterylab

import android.content.Context
import android.content.res.Configuration
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.PowerManager
import android.telephony.SubscriptionManager
import android.telephony.TelephonyDisplayInfo
import android.telephony.TelephonyManager

/**
 * Configuration parameters readable through public APIs (keys match src/engine/params.ts).
 * Always recorded, selected or not, so they can be added to a selection later.
 */
object AutoParams {
    val KEYS = listOf("mobile_data", "power_saving", "wifi", "location", "dark_mode", "sim_count")

    /** Current values; null when an API is unavailable (stored with src = unknown). */
    @Suppress("MissingPermission")
    fun read(ctx: Context): Map<String, String?> = mapOf(
        "mobile_data" to safe { onOff(ctx.getSystemService(TelephonyManager::class.java).isDataEnabled) },
        "power_saving" to safe { onOff(ctx.getSystemService(PowerManager::class.java).isPowerSaveMode) },
        "wifi" to safe { onOff(ctx.getSystemService(WifiManager::class.java).isWifiEnabled) },
        "location" to safe { onOff(ctx.getSystemService(LocationManager::class.java).isLocationEnabled) },
        "dark_mode" to safe {
            onOff((ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES)
        },
        "sim_count" to safe { ctx.getSystemService(SubscriptionManager::class.java).activeSubscriptionInfoCount.toString() },
    )

    /** Radio label from TelephonyDisplayInfo; data network type is unreliable during Wi-Fi calling (R2.5). */
    fun radioLabel(info: TelephonyDisplayInfo): String = when (info.overrideNetworkType) {
        TelephonyDisplayInfo.OVERRIDE_NETWORK_TYPE_NR_NSA -> "NR_NSA"
        TelephonyDisplayInfo.OVERRIDE_NETWORK_TYPE_NR_ADVANCED -> "NR_ADVANCED"
        else -> if (info.networkType == TelephonyManager.NETWORK_TYPE_NR) "NR_SA" else Probe.networkTypeName(info.networkType)
    }

    private fun onOff(b: Boolean) = if (b) "on" else "off"

    private inline fun safe(block: () -> String): String? = try {
        block()
    } catch (e: Throwable) {
        null
    }
}

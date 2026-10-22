package com.priyansh.batterylab

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Resumes monitoring after a reboot or app update if a session was active (gap is recorded on restore). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        Recorder.init(context)
        val pending = goAsync()
        Recorder.post {
            try {
                if (Recorder.hasActiveSession() || Recorder.startPassiveIfEnabled()) MonitorService.start(context)
            } finally {
                pending.finish()
            }
        }
    }
}

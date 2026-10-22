package com.priyansh.batterylab

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    companion object {
        /** Extra telling the UI what to open: "log_change" or "session:<id>". */
        const val EXTRA_OPEN = "com.priyansh.batterylab.OPEN"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(BatteryLabPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}

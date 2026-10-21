package com.priyansh.batterylab

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(BatteryLabPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}

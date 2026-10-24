# Implementation Plan — Ultra-Low-Overhead Samsung Battery Testing App

Status: **APPROVED (Revision 2) — execution started at M0/M1.**
Source spec: `d:\Priyansh\BatteryHealth\project.md` · Date: 2026-10-21

---

## Revision 2 — decisions from the user (these override anything below that conflicts)

| Question | Answer | Plan impact |
|---|---|---|
| Device | **Galaxy S24, One UI 8.5** (Android 16, API 36) | `targetSdk 36`, `compileSdk 36`, `minSdk 31` (kept because the APIs need it, not for other devices). All "present on the phone?" items are confirmed by the user: Performance profile, Protect battery, Fast charging. *Readability* is still checked by the M0 probe. |
| Distribution | Sideloaded APK only | `specialUse` FGS, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` and `READ_PHONE_STATE` are fine. Debug-signed APK during development; a local release keystore later. |
| Which variables define a configuration? | **User-selectable** | The fixed 4-variable matrix is replaced by a **parameter catalogue** (R2.1). The user picks which parameters define a configuration. The app shows the cost of each choice before it's applied (R2.2). |

### R2.1 Parameter catalogue
Each parameter has a key, levels, an applicability (charging / draining / both), a detection method (`auto` = a public API reads and detects changes; `manual` = the user confirms) and a short note on its battery relevance.

| Key | Levels | Applies to | Detection |
|---|---|---|---|
| `network_mode` | 5G, 4G | both | manual (preference isn't readable; observed radio corroborates) |
| `mobile_data` | on, off | both | auto (`isDataEnabled`, needs READ_PHONE_STATE) |
| `power_saving` | on, off | both | auto (`isPowerSaveMode` + broadcast) |
| `perf_profile` | standard, light | both | manual |
| `wifi` | on, off | both | auto (`WifiManager.isWifiEnabled` + NetworkCallback) |
| `location` | on, off | draining | auto (`LocationManager.isLocationEnabled` + `MODE_CHANGED` broadcast) |
| `dark_mode` | on, off | draining | auto (`UiModeManager` / configuration) |
| `refresh_rate` | adaptive, standard | draining | manual |
| `aod` | on, off | draining | manual |
| `fast_charging` | on, off | charging | manual |
| `battery_protection` | off, basic, adaptive, maximum | charging | manual |
| `charger` | user-defined labels | charging | manual (picked from your saved list) |

**Default selection** = the original four (`network_mode`, `mobile_data`, `power_saving`, `perf_profile`), which gives 16 configurations. The selection is stored separately for charging and draining, because their parameters differ.

**Recording rule (this keeps the selection reversible):**
- **Automatic parameters are always recorded**, selected or not. That costs a few reads per persisted sample and nothing more. They can therefore be added to the selection later, and history regroups automatically.
- **Manual parameters are only asked for when selected.** Turning one on later means older sessions show it as `unknown`. Those sessions are excluded from configuration views for that selection but are kept in raw history.
- Unselected parameters still appear as **conditions** in comparisons (e.g. "Wi‑Fi differed between A and B → inconclusive").

**Configuration identity** is no longer a fixed table. It's the canonical string of the *selected* parameters' values, e.g. `mobile_data=on;network_mode=5g;perf_profile=standard;power_saving=off`. It's stable, deterministic and recomputed whenever the selection changes. A short display code (C01…) comes from the sorted order of that string.

### R2.2 "Cost of this selection" panel (shown live while choosing)
For the parameters selected for each test type:
- **Configurations** = product of level counts. Example: 4 defaults → 16. Adding Wi‑Fi and Fast charging → 64 (charging).
- **Sessions for a minimal fair comparison** = configurations × repeats (default 3).
- **Estimated test time** = sessions × assumed hours per session (charging default 1.5 h, draining default 4 h; both editable).
- **Manual confirmations**: the number of manual parameters you must confirm at every test start, and log whenever you change them.
- **Downside warnings**, each shown with a severity:
  - *Data thinning*: more configurations means fewer sessions per configuration, so more comparisons come out **inconclusive**.
  - *Time cost*: shown as days or weeks at a realistic pace (default 2 sessions per day).
  - *Attribution loss*: each logged change costs about 1 percent point (the boundary step), and more parameters mean more changes.
  - *Human error*: every manual parameter is another value you can forget to log. Forgotten values become `unknown` and the data is excluded.
  - *Confounding stays*: anything not selected is still a confounder; it's only reported, not controlled.
  - *Applicability*: e.g. `fast_charging` has no effect on draining tests and is ignored there.
  - *Overhead*: automatic parameters add no measurable overhead (event listeners only). This is stated so it isn't a reason to avoid them.
- A **recommendation** line, e.g. "≤ 16 configurations is realistic; > 64 needs months of testing".

### R2.3 Schema changes (replaces `configuration` and the fixed columns in `config_state`)
```sql
param_value(config_state_id FK, param_key TEXT, value TEXT NULL, src TEXT, PRIMARY KEY(config_state_id, param_key))
setting(key TEXT PK, value TEXT)          -- e.g. 'selection.charging', 'selection.draining', 'chargers'
session.tracked_params TEXT               -- JSON snapshot of the selection at session start
```
`config_change.changed_variable` becomes `param_key`. No other tables change.

### R2.5 M0 probe results (SM-S921E, Snapdragon SM8650, Android 16 / One UI 8.5, build S921EXXS3CZG1)
| Item | Result | Decision |
|---|---|---|
| `isPowerSaveMode` | readable (`true`) | auto ✔ (toggle detection is confirmed by M2 recorder logs) |
| `isDataEnabled` / `isDataEnabledForReason(USER)` | readable with READ_PHONE_STATE | auto ✔ |
| `getDataNetworkType` | `IWLAN` while Wi‑Fi calling is active | **not used** as radio evidence |
| `TelephonyDisplayInfo` | `LTE` + override `NR_NSA` | **radio evidence source** (NR_NSA / NR_SA / LTE …) |
| Power saving forcing 4G (C7) | not observed: NR_NSA shown with PS on | risk lowered; still flagged if seen |
| `CHARGE_COUNTER` | 2 250 400 µAh at 57% → ≈3.95 Ah full | plausible µAh; candidate for the §7.6 trust check |
| `CURRENT_NOW/AVERAGE` | −81 / −182 → **mA**, negative = discharging | store raw; unit decided per device from magnitude statistics |
| `ENERGY_COUNTER` | unsupported | ignored |
| `EXTRA_CYCLE_COUNT` | 0 | treated as unavailable |
| Vendor extras | `hv_charger`, `protection`, `charge_type`, `charger_type`, `max_charging_current/voltage`, `misc_event`, `current_event`, `online` | recorded raw per sample as *evidence only* (never `verified`); interpretation validated during charging tests |
| `activeModemCount` | 2 (dual SIM capable) | new auto parameter **`sim_count`** (active subscriptions) |
| Supported refresh modes | max 60 Hz while PS on | motion smoothness *may* be inferable; to verify with PS off |
| Battery optimisation | already ignoring (Unrestricted) | — |
| Exit reasons | none | — |
| Still open | broadcast rate; status codes while charging / Protect battery hold | captured automatically by the M2 recorder in real sessions |

### R2.6 Live estimate in the notification (user request)
The user wants to see the expected backup or charge time for the current configuration while a test runs. This is a deliberate, narrow exception to "native records facts, never computes results" (§3.1):
- `LiveEstimator.kt` applies the §6 complete-step span rate to the **current uninterrupted run** only. A run restarts on a configuration change, pause/resume, direction change, jump or gap.
- **Measured estimate:** rate %/h → time to the session's limit (target or threshold) and the clock time. It's labelled *Measuring* (0 steps), *Early estimate* (1–2 steps) or *Measured* (≥3 steps).
- **Instant estimate:** charge counter ÷ average current (Samsung reports mA, R2.5) → time to the limit. It's labelled as swinging with current use. Shown in the app only. At the user's request, the notification shows just the expected time and the measured rate.
- **Updates:** the notification is updated only at persisted samples. No timers or alarms are added. The elapsed time is drawn by the system chronometer, so it costs no app wakeups.
- **Notification actions:** Pause/Resume and Log change.
- These numbers are never stored and never used in results or comparisons. Those always come from the TS engine (M3+). Validated against the same worked example in `LiveEstimatorTest`.

### R2.7 Visual style and test history (user request)
- **Colours:** neutral white and grey surfaces (`#f5f5f7` page, `#ffffff` cards). The pink tint in the reference screenshots came from the phone's theme, so it is not used. Accents: Samsung blue `#4565bc` (accent, draining), green `#a4c852` (charging fill; `#5f8a1f` for text), neutral red `#c7323e` (errors, Stop), amber for warnings. Dark mode uses black and lighter tints.
- **Finished tests:** the list shows "80% → 35% · took 3 h 05 m". Tapping a test opens a detail page with:
  - the duration headline;
  - active / interrupted / paused / unobserved time;
  - an overall average rate, labelled as mixing any configurations used;
  - the settings in force at the start, with source badges;
  - a timeline of setting changes with times, offset from the start, source (automatic or logged by you) and the uncertainty window.
- **Calculations** live in `src/engine/summary.ts` (pure, tested). Sessions recorded by the M2 recorder all have this data.

### R2.8 Overhead finding (2026-10-22, batterystats on the S24)
- **Measured:** the app was charged 78 mAh (≈2%) in a session with about 32 min in the foreground:
  - screen 39 mAh (display while the app was open);
  - CPU 39 mAh, of which 21.6 in the foreground and 13.3 in the background service;
  - 23 min 45 s of CPU time in 2 h 8 min of running.
- **The recorder was not the cause:** 60 broadcasts, 83 rows, 0.58 s of handler CPU that day.
- **Cause:** the WebView UI.
  - Capacitor's default `KeepRunning=true` never pauses the WebView in the background, so JS timers (a 1 s elapsed-time ticker and a 60 s refresh) kept running.
  - In the foreground, an infinite CSS animation (the pulsing "recording" dot) and a backdrop blur forced the WebView to render every frame at up to 120 Hz.
- **Fixes:**
  - `cordova.preferences.KeepRunning = false`, so the WebView and its timers pause when the app is not visible;
  - no infinite animations;
  - the elapsed time updates once per minute;
  - no polling (refresh on stored samples and on return to the app);
  - a solid tab bar instead of the blur.
- **After the fix:** the service-only process used 0 CPU ticks over 90 s with the screen on. Foreground cost still to be measured.

### R2.9 Always-on (everyday) recording (user request)
The user proposed recording all the time, splitting by configuration as settings change, and letting each configuration's average improve itself. Adopted as a mode alongside deliberate tests, with these safeguards:
- **Recording:** sessions get a `mode` column (schema v3). With Always-on enabled and no test running, the recorder keeps a `passive` session open:
  - it rolls over at local midnight, so **one day is one sample**;
  - a deliberate test supersedes it, and it resumes when the test ends;
  - no limits and no finish notifications.
- **Configurations** use **automatically read settings only**. Manual ones (network mode, performance profile) would go stale silently in a never-ending recording.
- **Rates** are split by screen state:
  - **screen-off (idle)** is the controlled part and the only one used in everyday comparisons;
  - **screen-on** is shown as "typical for your use".
- **Window:** only the last 30 days count, because ageing, updates and seasons shift rates. Everyday results are shown separately from test results and never pooled with them.
- **Live estimate** (tests and always-on) = this configuration's history blended with the current run, weighted by steps:
  - history counts as at most 8 steps, so the run takes over as it collects evidence;
  - the UI's engine computes the history (median rate per configuration, last 30 days, tests and everyday, keyed by automatic settings) and stores it as the `priors` setting for the recorder.
- **Always-on estimate limits:** the "reserve" level when on battery (default 20%) and the charge target (default 100%), set in Setup.

### R2.10 Automatic tests per charge/discharge cycle (user request)
- Always-on is **on by default**.
- Instead of one record per day, it opens one automatic test per cycle:
  - unplugged → `draining`;
  - plugged in → `charging`.
- A change of plug state must hold for 60 s before the test switches, so a wiggled cable doesn't split it. The test that ends gets status `plugged_in` or `unplugged`.
- Automatic tests appear in Recent tests with an "Auto" label and "took X h", and use the normal detail page.
- Each cycle is one sample in everyday results.
- Samples in the opposite direction inside a cycle (e.g. during the debounce minute) still count toward that direction's everyday rates.
- A manual test still supersedes automatic recording, which resumes afterwards.

### R2.11 "Now" meter (user request: car-style instant economy)
- **"Now":** `CURRENT_NOW` (Samsung: mA, net battery current) smoothed with an exponential moving average (τ = 30 s), divided into the charge left, measured by the charge counter, to the session's limit.
  - When charging past 80%, the remainder uses half the current, a conservative stand-in for the constant-voltage taper.
  - It reacts to the screen, apps, the radio and heat-limited charging, because the battery current is the net of all of them.
- **Cost control:** it only runs while the screen is on.
  - A main-looper handler in the service reads the current every 5 s (about 1 ms each).
  - The notification refreshes only when "now" changes by more than 5%, and at most every 15 s.
  - With the screen off there is no polling. On unlock, the screen-off period's drain comes from the two charge-counter readings already taken at the screen events.
  - The open screen refreshes every 10 s; the WebView pauses in the background.
- **Display:** "Now" and "Average" side by side; the clock time follows the average. Never stored, never used in results.

### R2.4 Execution order (unchanged milestones, adjusted contents)
- **M0 + M1 now:** project skeleton, local Kotlin plugin, a capability probe screen (it runs on the S24 once you connect it), and the parameter catalogue + selection/cost panel as pure TS with unit tests.
- M2 onward as planned. The recorder reads every `auto` parameter.

---

Legend for claim confidence:
- **[DOC]**: stated in official Android/Capacitor documentation (link given).
- **[KNOWN]**: widely observed platform behaviour, not a documented guarantee.
- **[VERIFY]**: plausible but must be confirmed on *your* device in Milestone 0 before anything depends on it.

---

## 0. Executive summary (read this first)

1. **16 configurations, not 24.** 2⁴ = 16. No missing variable justifies 24. I recommend recording **Wi‑Fi state** and the **charger/fast‑charging setting** as *session conditions* (confounders), not as new matrix variables. That keeps the matrix at 16.
2. **Only 2 of the 4 variables can be read automatically.** Power saving can be read and change-detected with a public API. Mobile data can be read with a public API, and change detection probably works [VERIFY]. **Network-mode preference (5G/4G) and Samsung Performance profile (Standard/Light) cannot be read** by a normal app. They need a fast manual-confirmation flow, with the uncertainty window recorded honestly. The *actual* radio technology in use (NR vs LTE) *can* be observed and used as corroboration.
3. **A foreground service is required.** It's the only supported way to receive `ACTION_BATTERY_CHANGED`, plug/unplug and screen events continuously. These broadcasts can't be declared in the manifest, and WorkManager's 15‑minute minimum plus Doze deferral makes per-percent charging timing impossible. The service is purely event-driven, with **no alarms, no polling, no wakelocks and no JavaScript in the background**.
4. **Measurement primitive: "complete percent steps".** A *step* is the time between the first observation of level L and the first observation of level L±1, inside one uninterrupted run with the same configuration. Steps cut by an interruption, pause, gap or configuration change are discarded. Rates come from spans of complete steps. This handles percent quantization, interruptions and config boundaries without complicated models.
5. **Recommended stack:** a native Kotlin layer (service, receivers and framework SQLite, with no Room or other DB dependency) and a local Capacitor plugin. The calculation engine is a **pure TypeScript module** tested with Vitest on recorded fixtures. The UI is Vite with Preact, and charts use uPlot.
6. **Practical caveat about the full matrix.** 16 configs × ≥3 repeats × 2 test types is about 96 sessions. The plan supports *balanced within-session rotation* for draining, analysed as paired comparisons. That cuts the work a lot without treating segments as independent trials.

---

## 1. Requirements audit

### 1.1 Confirmed requirements
- There are two separate pipelines (charging and draining), and their data is never mixed.
- The app never changes system settings, never adds load and never interferes with charging.
- It's local-first: no server, account, analytics or network.
- Raw observations are kept unchanged, and results carry an estimator version so they can be recalculated.
- Sessions are split by configuration, and uncertainty is flagged explicitly.
- Observations, predictions and adjusted comparisons are always labelled as such.

### 1.2 Contradictions and corrections
| # | Issue | Resolution |
|---|---|---|
| C1 | "24 permutations" | **16.** No genuine fourth binary/ternary variable was found. Variables I recommend recording as *conditions* (see C6) do not change the matrix. |
| C2 | "Network mode: 5G or 4G" treated as observable | The **preference** can't be read by a normal app (needs privileged/carrier permission). The **current radio** (LTE / NR‑NSA / NR‑SA) can be observed. These are different things: a phone set to 5G is often on LTE. Store both. Only the preference defines the configuration. |
| C3 | Performance profile assumed observable | It's a Samsung-only setting with no public API. It must be **manually confirmed**. |
| C4 | "Run in background with minimal overhead" vs. "Do not default to a permanent FGS" | The FGS runs **only while a session is active**, not permanently. When no test is running, nothing runs. |
| C5 | "Mobile data OFF" × "5G/4G" | These still interact, because the modem keeps a cellular registration for calls and SMS. Keep all 16, but expect some pairs to show no measurable difference. |
| C6 | Missing confounders that strongly affect results | **Wi‑Fi on/off** (draining), **charger + cable + Samsung "Fast charging" setting** (charging), **Protect battery limit** (charging target reachability). Record these as session conditions. They're manual where they can't be read. |
| C7 | Power saving may affect other variables | On some One UI versions, power saving can also turn off 5G and limit CPU [VERIFY]. "5G + PS ON" might then *effectively* be 4G. The observed radio will show this, and the UI will warn about it. |
| C8 | "Target 100%" | Samsung **Protect battery** (85% / Maximum 80% / Adaptive, depending on One UI version) may make 100% unreachable. Plugged-but-not-charging time is classified separately, and setup warns about it. |
| C9 | "Screen-on vs screen-off consumption" in mixed use | Screen state is observable while the service is alive. If on/off switches frequently, pure-state percent steps become rare, so the split may be "insufficient data". That's reported honestly. A regression split is an optional later milestone. |
| C10 | "Charging and draining in one session" (Review 5) | A session has exactly one type. A charging session that is unplugged gets an *interruption* interval. A draining session that is plugged in gets a *charging-interruption* interval. Unplugged time is never re-labelled as a draining test. If you want that data, start a separate draining session. |
| C11 | Precise "predicted wall-clock completion" | Only shown for charging while plugged in, as *now + predicted active time*. Your unplug behaviour can't be predicted, so no wall-clock forecast is made beyond that. |

### 1.3 Assumptions (to confirm)
- A1: Single device, single user, **sideloaded APK** (not Play Store). This affects the `specialUse` FGS justification and how freely the app can request battery-optimisation exemption and `READ_PHONE_STATE`.
- A2: The device runs **Android 14+ / One UI 6+**. Performance profile (Light/Standard) only exists on recent One UI versions. → **Need your exact model and One UI version.**
- A3: One active session at a time.

---

## 2. Platform feasibility report

### 2.1 Configuration variables
| Variable | Read API | Change detection | Classification |
|---|---|---|---|
| Power saving | `PowerManager.isPowerSaveMode()` [DOC](https://developer.android.com/reference/android/os/PowerManager#isPowerSaveMode()) | `ACTION_POWER_SAVE_MODE_CHANGED` (runtime receiver) | **Automatically verifiable.** Samsung's toggle should map to AOSP low-power mode [VERIFY]. Samsung's extra sub-options (limit apps, turn off AOD, etc.) are *not* readable. |
| Mobile data | `TelephonyManager.isDataEnabled()` [DOC](https://developer.android.com/reference/android/telephony/TelephonyManager#isDataEnabled()) | `TelephonyCallback.UserMobileDataStateListener` (API 31) [DOC](https://developer.android.com/reference/android/telephony/TelephonyCallback.UserMobileDataStateListener) | **Automatic, with `READ_PHONE_STATE`** (runtime permission) [VERIFY whether it's needed for each call]. Fallback: re-read at every persisted sample. |
| Network mode preference (5G/4G) | `getAllowedNetworkTypesForReason` needs privileged/carrier access [DOC](https://developer.android.com/reference/android/telephony/TelephonyManager#getAllowedNetworkTypesForReason(int)). Hidden `Settings.Global` keys aren't a supported interface. | None | **Not accessible → manual confirmation.** |
| Observed radio (LTE / NR‑NSA / NR‑SA) | `TelephonyDisplayInfo` via `TelephonyCallback.DisplayInfoListener` [DOC](https://developer.android.com/reference/android/telephony/TelephonyDisplayInfo); `getDataNetworkType()` (needs `READ_PHONE_STATE`) | Callback | **Automatic, as a condition only.** It's used to corroborate or contradict the manual preference. Seeing NR while "4G" is confirmed is a contradiction and gets flagged. |
| Performance profile | No public API | None | **Samsung-specific; manual confirmation.** |
| Wi‑Fi (condition) | `ConnectivityManager.NetworkCallback` / `WifiManager.isWifiEnabled()` | Callback | **Automatic.** |

**Rule:** every configuration value is stored with a `source` of `verified | user_confirmed | inferred | unknown`. A value is never assumed.

### 2.2 Battery measurements
| Quantity | API | Notes |
|---|---|---|
| Level / scale, status, plugged, health, temperature (0.1 °C), voltage (mV) | `ACTION_BATTERY_CHANGED` sticky intent extras [DOC](https://developer.android.com/reference/android/os/BatteryManager) | Reliable. **Can't be registered in the manifest**, so a live process is needed [DOC](https://developer.android.com/training/monitoring-device-state/battery-monitoring). |
| Charge counter (µAh) | `BATTERY_PROPERTY_CHARGE_COUNTER` | Often present on Samsung [KNOWN]. Accuracy is unknown → **diagnostic only in v1**. Trusted only after the validation in §7.6. |
| Current now / average | `BATTERY_PROPERTY_CURRENT_NOW / _AVERAGE` | Units and sign vary by vendor (some Samsung models report mA instead of µA) [KNOWN]. Diagnostic only. Units are auto-detected and flagged. |
| Energy counter | `BATTERY_PROPERTY_ENERGY_COUNTER` | Usually unsupported (returns `Long.MIN_VALUE`/0). Stored as null. |
| Platform charge estimate | `BatteryManager.computeChargeTimeRemaining()` (API 28) | Stored as a cross-check only. Never used as a result. |
| Charging-held state | `EXTRA_STATUS` = `NOT_CHARGING` / `FULL` while `EXTRA_PLUGGED` ≠ 0 | This is how Protect battery and thermal holds show up [VERIFY on device]. |
| Charger power | Max current/voltage extras are hidden → **not used**. | Charger label is entered manually. |

### 2.3 Context signals
| Signal | API | Notes |
|---|---|---|
| Screen on/off | `ACTION_SCREEN_ON/OFF` (runtime receiver), `PowerManager.isInteractive()` | Lost while the process is dead. **Can be recovered** with `UsageEvents.Event.SCREEN_INTERACTIVE/NON_INTERACTIVE` (API 28) [DOC](https://developer.android.com/reference/android/app/usage/UsageEvents.Event#SCREEN_INTERACTIVE). This needs the *Usage access* special permission, which is optional. |
| Brightness | `Settings.System.SCREEN_BRIGHTNESS` (public, readable) | Read at each persisted sample. Auto-brightness makes it partial. |
| Signal strength | `TelephonyManager.getSignalStrength()` (API 28) | Sampled only alongside persisted samples, never streamed. |
| Network traffic | `TrafficStats.getTotalRxBytes/TxBytes` | Cheap counters, sampled at persisted samples. Gives device-wide traffic, which is a useful confounder. |
| Foreground apps / workload | Usage access only | Optional, coarse. Most of it is **unavailable** without that access. |
| Why the process died | `ActivityManager.getHistoricalProcessExitReasons` (API 30) [DOC](https://developer.android.com/reference/android/app/ActivityManager#getHistoricalProcessExitReasons(java.lang.String,%20int,%20int)) | No permission needed. Used to label gaps. |
| Boot identity | `Settings.Global.BOOT_COUNT` (API 24) [DOC](https://developer.android.com/reference/android/provider/Settings.Global#BOOT_COUNT) | Lets elapsed-time values be compared only within the same boot. |
| OS updates | `Build.FINGERPRINT`, `Build.DISPLAY`, `Build.VERSION.SECURITY_PATCH` | Public. Changes are detected automatically. The One UI version is entered once by hand. |

### 2.4 Background execution
- Implicit broadcasts can't be declared in the manifest since Android 8. **Only exempt ones** work there, such as `BOOT_COMPLETED`, `LOCKED_BOOT_COMPLETED`, `MY_PACKAGE_REPLACED` and `TIME_SET` [DOC](https://developer.android.com/develop/background-work/background-tasks/broadcasts/broadcast-exceptions). `POWER_CONNECTED`/`DISCONNECTED` and `BATTERY_CHANGED` all need a runtime registration.
- Doze and App Standby defer jobs and alarms and cut network access [DOC](https://developer.android.com/training/monitoring-device-state/doze-standby). Periodic WorkManager has a **15‑minute minimum** and is deferred further in Doze [DOC](https://developer.android.com/reference/androidx/work/PeriodicWorkRequest).
- From Android 14, foreground services must declare a type [DOC](https://developer.android.com/develop/background-work/services/fgs/service-types). For battery monitoring, the only honest fit is **`specialUse`**. `dataSync` gets a ~6 h/day timeout on Android 15 [DOC](https://developer.android.com/develop/background-work/services/fgs/timeout), and `health` needs sensor permissions. Android 15 blocks some FGS types from being started by `BOOT_COMPLETED` [DOC](https://developer.android.com/about/versions/15/behavior-changes-15). `specialUse` isn't on that list [VERIFY on device].
- Notifications: `POST_NOTIFICATIONS` is a runtime permission on 13+. On 14+ the FGS notification can be swiped away but the service keeps running.
- **Samsung:** "Sleeping apps", "Deep sleeping apps", "Put unused apps to sleep" and Adaptive battery can kill or freeze apps [KNOWN; community source: https://dontkillmyapp.com/samsung, *not official*]. Setup will guide you to set the app's battery usage to **Unrestricted** and exclude it from sleeping lists. It will also request `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, which is acceptable for sideloading.

### 2.5 What cannot be guaranteed
- Continuous observation if One UI kills the process anyway. Mitigation: gap detection, bounded recovery and quality downgrades.
- Exact timestamps for manual configuration changes.
- Network-mode preference and performance profile verification.
- Charge counter and current accuracy.
- Charger wattage or protocol.
- Ambient temperature (only battery temperature is available).
- Per-app workload without Usage access.

---

## 3. Architecture proposal (recommended: Option A)

```
┌──────────────────────── Android process (same process) ────────────────────────┐
│                                                                                 │
│  Capacitor WebView (only while UI visible)                                      │
│   ├─ UI (Preact + uPlot)                                                        │
│   └─ engine/ (pure TS, no DOM, no Capacitor)  ← unit-tested in Node/Vitest      │
│            ▲ query results (on demand)        ▲ throttled "sampleAdded" event  │
│  ──────────┼──────────────── BatteryLab plugin (local Capacitor plugin) ─────── │
│            │                                                                    │
│  Native Kotlin                                                                  │
│   ├─ MonitorService (FGS, specialUse) — exists only while a session is active  │
│   │    ├─ runtime receivers: BATTERY_CHANGED, POWER_SAVE_MODE_CHANGED,          │
│   │    │   SCREEN_ON/OFF, SHUTDOWN, TIME_SET/TIMEZONE_CHANGED                   │
│   │    ├─ TelephonyCallback (DisplayInfo, UserMobileDataState), NetworkCallback │
│   │    └─ SampleRecorder: dedupe → decide → write (single thread executor)     │
│   ├─ BootReceiver (BOOT_COMPLETED, MY_PACKAGE_REPLACED) → restart FGS if active │
│   └─ Store (framework SQLite, WAL, hand-written migrations)                     │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Responsibilities
- **Native records facts; it never computes results.** It has no estimator logic, so it stays small and doesn't need re-testing when the estimator changes.
- **The TS engine computes everything on demand**, from raw rows to intervals, steps, segment results, session summaries and configuration aggregates. Data volume is small (a few hundred rows per session), so recomputing is cheap (<100 ms expected, to be measured). Results can be cached by `(session_id, estimator_version)`.
- **The bridge is query-driven.** JS asks for rows when a screen opens. Native emits at most one event per persisted sample, and only while the UI is visible. There is no JS polling.
- **The notification** shows level, state and active duration. It updates **only when a sample is persisted** (each percent step), never on a timer.

### 3.2 Sample-persistence policy (the overhead heart of the design)
`BATTERY_CHANGED` fires often, because voltage and temperature updates trigger it every few seconds to minutes, more while charging [KNOWN]. In the handler:
1. Read the extras (cheap) and update the in-memory "last seen" values.
2. **Persist a row only if** one of these is true:
   - the level changed
   - the status or plugged state changed
   - the temperature crossed a 1 °C bucket
   - the configuration, screen or pause state changed
   - **≥10 min** have passed since the last persisted row (the heartbeat; it piggybacks on broadcasts and needs no alarm)
3. Each write is a **single immediate insert** on a background executor. At roughly 100–300 rows a day, batching adds risk of losing data and saves almost nothing. This intentionally departs from "batch writes" and is justified by the low volume.
4. Optional counters (charge counter, current, signal, TrafficStats, brightness) are read **only when persisting**.

Why a 10 min heartbeat: it limits how long an undetected process death can go unnoticed, records slow temperature drift, and lets us prove the gaps where nothing was missed. It doesn't wake the device; it rides on broadcasts that are already being delivered. If no broadcast arrives for hours in deep Doze, nothing is lost, because the level didn't change either.

### 3.3 Timekeeping
Every row stores `wall_ms` (`System.currentTimeMillis`), `elapsed_ms` (`SystemClock.elapsedRealtime`, which keeps counting through deep sleep) [DOC](https://developer.android.com/reference/android/os/SystemClock), and `boot_count`.
- Durations **within the same boot** use `elapsed_ms`. They're immune to clock changes.
- Across a reboot the elapsed clock resets. Durations that span a reboot use wall-clock time, and the reboot gap itself is a `gap` interval bounded by the last pre-shutdown row and the first post-boot row. `ACTION_SHUTDOWN` is recorded when it's delivered.
- `TIME_SET` and `TIMEZONE_CHANGED` are recorded as events. Wall-clock time is used only for display.

---

## 4. Architecture comparison

| | **A. Session-scoped FGS + events (recommended)** | B. WorkManager periodic only | C. Hybrid: FGS for charging, alarms for draining | D. JS-only (`@capacitor/device` + background-runner) |
|---|---|---|---|---|
| Charging step timing (~30–90 s per %) | ✅ seconds | ❌ ≥15 min, deferred | ✅ | ❌ |
| Draining step timing | ✅ | ⚠️ 15 min to hours in Doze | ⚠️ inexact `setAndAllowWhileIdle` (≥~9 min in Doze) | ❌ |
| Plug/unplug, screen events | ✅ live | ❌ inferred only | ⚠️ draining: inferred | ❌ |
| Config change detection | ✅ live callbacks | ❌ | ⚠️ | ❌ |
| Overhead | Low: broadcasts delivered anyway; no alarms or wakelocks | Lowest | Low, but alarms *add* wakeups | Higher: wakes JS runtime |
| Complexity | Medium (one path) | Low | High (two paths) | Low, but useless |
| Survives Samsung killing | Mostly, with Unrestricted battery setting; gaps detected | Yes, but data-poor | Mixed | Poor |

**Recommendation: A.** B and D can't measure charging at all. C adds a second code path and *more* wakeups to save a cost that probably doesn't exist. An idle FGS uses no CPU; the cost is handling broadcasts that the system already sends. **Fallback:** if the benchmarks (§10) show A has measurable drain overhead, add C's draining path in a later milestone.

Other choices:
- **Storage:** framework `SQLiteOpenHelper`, not Room (no annotation processor or extra dependencies; the schema is small) or Capacitor Preferences (key-value, no relations, rewrites the whole value). SQLite is justified by relational time-series data with indexes.
- **Engine language:** TypeScript, not Kotlin. Results are only needed when the UI is open, a pure TS module is easy to test with fixtures, and native stays minimal.
- **UI:** Vite + Preact (~4 KB) + uPlot (~45 KB). No Ionic or component framework.
- **Plugin:** a local plugin inside `android/app/src/main/java/...` [DOC](https://capacitorjs.com/docs/android/custom-code), not a published npm package.
- **Capacitor version:** use the current stable major release at implementation time.
- **minSdk 31 / targetSdk = latest stable.** API 31 is needed for `TelephonyCallback`, `UserMobileDataStateListener` and current FGS rules. Supporting older versions has no value for a single recent Samsung device.

---

## 5. Data schema (SQLite, `user_version` = schema version)

All IDs are TEXT UUIDv7 (time-sortable) unless noted. Times are INTEGER ms.

```sql
-- One row per OS/build observed (detects Android/One UI updates)
build_snapshot(id PK, fingerprint, display, sdk_int, security_patch, model, oneui_version_manual, first_seen_wall)

-- Stable configuration identity (16 rows in v1; new variables → new columns + migration)
configuration(
  id TEXT PK,            -- canonical key, e.g. "v1:net=5g;data=on;ps=off;perf=std"
  short_code TEXT UNIQUE,-- e.g. "C05" for display, deterministic from bit order
  network_mode TEXT CHECK(network_mode IN ('5g','4g')),
  mobile_data INTEGER, power_saving INTEGER,
  perf_profile TEXT CHECK(perf_profile IN ('standard','light'))
)
-- Note: unknown values are NOT a configuration; a segment with any unknown variable has config_id NULL
-- and is excluded from configuration views (kept in session view).

session(
  id PK, type TEXT CHECK(type IN ('charging','draining')),
  status TEXT,  -- active|paused|completed|target_reached|threshold_reached|stopped_early|abandoned
  start_wall, start_elapsed, start_boot, end_wall, end_elapsed, end_boot,
  start_level, end_level, target_level NULL, lower_threshold NULL,
  charger_label NULL, fast_charging_setting NULL, protect_battery_setting NULL, -- manual conditions
  wifi_policy NULL, notes, build_snapshot_id FK, schema_version, created_by_app_version)

config_state(  -- one row each time the believed configuration (or any variable's source) changes
  id PK, session_id FK, wall_ms, elapsed_ms, boot_count,
  config_id NULL FK,
  network_mode, network_mode_src, mobile_data, mobile_data_src,
  power_saving, power_saving_src, perf_profile, perf_profile_src)  -- src ∈ verified|user_confirmed|inferred|unknown

config_change(
  id PK, session_id FK, prev_state_id FK, new_state_id FK, changed_variable TEXT,
  event_wall, event_elapsed, boot_count,
  window_start_elapsed, window_end_elapsed,  -- uncertainty window; equal for exact detections
  detection_source TEXT,  -- broadcast|telephony_callback|user_tap|end_of_session_confirm
  verification TEXT)

sample(
  id INTEGER PK AUTOINCREMENT, session_id FK, wall_ms, elapsed_ms, boot_count,
  level, scale, status, plugged, health, temp_dc, voltage_mv,
  charge_counter_uah NULL, current_now NULL, current_avg NULL, current_unit_guess NULL,
  screen_on NULL, brightness NULL, wifi_on NULL, radio TEXT NULL, signal_level NULL,
  rx_bytes NULL, tx_bytes NULL, platform_charge_eta_ms NULL,
  config_state_id FK, source TEXT,  -- broadcast|heartbeat|startup|recovery|manual
  flags INTEGER)                    -- bitmask: duplicate, implausible_jump, invalid_value, clock_jump…

event(
  id INTEGER PK, session_id FK, wall_ms, elapsed_ms, boot_count,
  type TEXT,  -- start|pause|resume|stop|plugged|unplugged|charge_held|charge_resumed|screen_on|screen_off|
              -- shutdown|boot|process_start|gap_detected|time_set|tz_changed|build_changed|target_reached
  payload TEXT)  -- small JSON (e.g. exit reason, gap bounds)

-- Derived, disposable, recomputable cache (written by engine via plugin; can be dropped any time)
result_cache(session_id FK, estimator_version, computed_wall, json, PRIMARY KEY(session_id, estimator_version))

-- Self-measurement (debug builds or opt-in)
overhead_stat(day TEXT, broadcasts_received, rows_written, handler_cpu_ns, wakeups_est, PRIMARY KEY(day))
```

**Indexes:** `sample(session_id, elapsed_ms)`, `sample(session_id, boot_count, elapsed_ms)`, `event(session_id, elapsed_ms)`, `config_state(session_id, elapsed_ms)`, `session(type, start_wall)`.

**Measurement intervals** (the spec's entity) are **derived** by the engine rather than stored as truth. They're the output of §6–§8: `{session_id, segment_id, start, end, config_id, class, level_start, level_end, valid_duration, boundary_uncertainty, exclusion_reason}`. Storing them as raw truth would tie history to one algorithm, which the spec forbids.

**Persistence:** WAL mode. Every user action (start, pause, config change) is written in one transaction together with its sample and event. Migrations are hand-written `onUpgrade` steps, each with a test that upgrades a fixture DB. Raw tables are append-only except `session` status and end fields, and user deletion.

---

## 6. Core derivation (shared by both pipelines, implemented separately)

The engine turns raw rows into a timeline of **intervals**, cut at every event that changes any of these:

| Class | Charging pipeline | Draining pipeline |
|---|---|---|
| `active` | plugged ∧ status=CHARGING ∧ not paused | unplugged ∧ status=DISCHARGING ∧ not paused |
| `held` | plugged ∧ status ∈ {NOT_CHARGING, FULL} | — |
| `interruption` | unplugged | plugged (any status) |
| `paused` | user pause | user pause |
| `gap` | no observation for > 15 min after the expected heartbeat, process restart, or reboot | same |
| `uncertain_config` | inside a config-change uncertainty window | same |

**Runs** are maximal chains of `active` intervals with the same `config_id`, no gap and the same screen state class. Screen state class only affects sub-splits (§8.3).

**Complete steps:** inside a run, let `t(L)` be the elapsed time at which level L was **first observed**. A step L→L' (|L−L'|=1) is *complete* only if both `t(L)` and `t(L')` lie in the same run. The first level of every run is a **partial** step, because we don't know when it was entered, so it's never used for rates.

**Span rate:** for a run with first observed transition at level `La` (time `ta`) and last observed transition at level `Lb` (time `tb`):
`rate = |Lb − La| / (tb − ta)` in % per hour. The step durations telescope, so only the two endpoint timings carry error (broadcast latency of a few seconds) [KNOWN].

**Implausible jumps:** a change of more than 1 point between consecutive observations, while no gap was detected, is flagged. More than 3 points within 2 min is excluded and labelled. Samsung sometimes recalibrates near 100% and 0–5% [KNOWN].

**When no rate can be given:** if a run has fewer than **3 complete steps** or lasts under **20 min** (draining), the result is `insufficient_data`. If the observed level didn't change for duration T, we report the bound **rate < 1/T %/h**, never a point value.

---

## 7. Charging calculation specification

### 7.1 Outputs per configuration × SoC band
Bands are 10 points wide (0–10, …, 90–100). They're configurable. 10 is the default because charging behaviour (CC vs CV phase) changes on roughly that scale.

1. **Band time per point** `τ_b` (s/%) per session = Σ complete-step durations in band b ÷ number of those steps.
2. Session-level result per band (only sessions with ≥3 complete steps in that band).
3. **Across sessions:** median of session `τ_b` (and mean when n ≥ 3), n_sessions, n_runs, min–max, and IQR when n ≥ 5.
4. **Confidence interval:** only when n_sessions ≥ 5, using a percentile bootstrap that **resamples sessions, not steps**. Otherwise show "n too small for CI". A CI is never presented as a quality score.
5. **Quality rating** is separate from the CI. It covers completeness %, gaps, held time, temperature excursions, screen-on charging share and configuration uncertainty, and lists the reasons.

### 7.2 Durations
- **Observed active duration** = Σ `active` interval durations (elapsed time) from session start to the first observation of the target level. It's reported as *observed* only if the target was reached. Otherwise the session is "incomplete at X%".
- **Wall-clock duration** = end − start (including interruptions), for completed sessions only.
- **Held, interrupted, paused and gap durations** are reported separately.
- **Predicted remaining active time** from level `c` to target `T`: `Σ_{L=c}^{T−1} τ_{band(L)}`, using the profile of the *current configuration*. It's labelled **prediction**. It's shown only if every band from c to T has ≥2 sessions of data. Otherwise it's shown up to the last covered band, with "no data above X%".
- **Predicted wall-clock completion** = now + predicted remaining active time. It's only shown while currently plugged and actively charging.

### 7.3 Exclusions and stratification
- `held` time is never counted as active. If the session status shows a charging hold at a level ≥ the protection limit, mark **target capped**.
- **Screen-on charging** steps are kept, but the strict comparison uses only screen-off steps by default. Using the phone while charging changes both load and temperature. There's a toggle in the UI.
- **Temperature:** each step records its max temperature. Steps above 40 °C get a `hot` flag (configurable). Strict comparisons exclude `hot` steps. No temperature *adjustment* model is applied; we stratify instead, which is simpler and defensible.
- **Charger:** comparisons only pool sessions with the same `charger_label` and fast-charging setting. Mismatches make the comparison *inconclusive*.

### 7.4 Worked example: interrupted charging session (config C05, target 80%)
Raw first-observation times:

| Wall time | Event / level |
|---|---|
| 10:00:00 | Start, plugged, **30%** (partial step; entry time unknown) |
| 10:00:50 | 31% ← first complete-step anchor |
| 10:19:30 | 50% |
| 10:20:00 | Unplugged (still 50%) |
| 10:20–11:05 | Interruption; drains to 46% |
| 11:05:00 | Replugged at **46%** (partial) |
| 11:06:00 | 47% ← anchor of run 2 |
| 11:08:54 | 50% |
| 11:28:04 | 70% |
| 11:40:00 | **80% → target reached** |

- Run 1 complete steps: 31→50 = 19 steps in 18 m 40 s → **58.9 s/%**.
- Run 2: 47→50 = 3 steps in 2 m 54 s (58.0 s/%); 50→70 = 20 steps in 19 m 10 s (**57.5 s/%**); 70→80 = 10 steps in 11 m 56 s (**71.6 s/%**, the slower CV phase).
- **Observed active duration** = 20 m 00 s + 35 m 00 s = **55 m 00 s**.
- **Wall-clock** = **1 h 40 m** (45 m interruption, labelled).
- Quality: *interrupted*. 4 points (46→50) were charged twice, so the 55 m is **not** a clean 30→80 measurement. It's shown as "observed, interrupted". It's excluded from the "clean full-range duration" statistic but contributes all of its complete steps to the band profile.
- A **modelled clean 30→80 duration** from this session's band rates is (20 × 58.9) + (20 × 57.5) + (10 × 71.6) = 1178 + 1150 + 716 = 3044 s ≈ **50.7 min**. It's labelled **model-based**. (The 30–50 band uses run 1 + run 2's 47–50 steps pooled: 22 steps ≈ 58.8 s/%, which rounds to the same result.)
- If power saving had been turned on at 11:20, run 2 would split at 11:20. The step that straddles 11:20 is discarded, and the steps after it go to the PS‑ON configuration.

### 7.5 Methods considered and rejected for v1
- **Elapsed time ÷ points gained:** wrong with interruptions and nonlinear SoC curves. Rejected.
- **Robust regression (Theil–Sen) on level vs time per run:** about the same as the span rate when steps are uniform within a band, but harder to explain. Kept as an **estimator v2 candidate** and validated against v1 on fixtures.
- **Charge-counter estimator:** gives sub-percent resolution, but its accuracy is device-dependent. Deferred until validated (§7.6).

### 7.6 Charge-counter validation (Milestone 8, optional)
In long runs, compute Δcharge_counter for each complete percent step. If the coefficient of variation is < 10% and the implied capacity is close to the rated capacity, mark the device *counter-trusted*. Then estimator v2 may use counter-based rates for short segments. The trust decision is stored and shown.

---

## 8. Draining calculation specification

### 8.1 Outputs
- **%/h per valid segment** (span rate over complete steps).
- Per session and configuration: the step-weighted rate over that configuration's segments in the session. That is Σsteps ÷ Σspan durations; segments are **not** averaged naively.
- Across sessions: median / mean (n ≥ 3) of **session-level** rates, n_sessions, n_segments, range, IQR (n ≥ 5), and bootstrap CI over sessions (n ≥ 5).
- Rate by SoC band (10-point bands), using the same rules.
- **Time to threshold** from level c to threshold h: `Σ_{L=h+1}^{c} 1/rate_{band(L)}`. It's labelled **prediction** and needs band coverage, otherwise "insufficient data".
- Exclusions with reasons, and completeness = valid active time ÷ session wall time.

### 8.2 Segmentation and attribution
- Segments are cut at every configuration change, interruption, pause, gap and reboot.
- **The boundary step rule:** the step that contains a boundary (from the last transition before it to the first transition after it) belongs to *neither* side. If the configuration change has an uncertainty window `[w1, w2]`, any step overlapping the window is discarded. This is the "best defensible timestamp" rule. Consumption is never assigned across a boundary, and the cost is about 1 point per boundary.
- Many short segments: each one is likely `insufficient_data`. The session view shows them all, while the configuration view only uses qualifying ones. The UI suggests minimum segment lengths (≥ 60 min, or ≥ 4 points).

### 8.3 Screen on/off
- A step is labelled `screen_off`, `screen_on` or `mixed` from the screen events it contains. Rates are calculated for pure steps only. Mixed steps count toward the overall rate but not the split.
- If there are fewer than 3 pure steps for a state, that state shows "insufficient data".
- **Estimator v2 candidate (optional):** a non-negative least-squares fit of `points ≈ a·T_on + b·T_off` over steps and segments. It's only used if validated on fixtures and if a, b are stable across sessions.

### 8.4 Worked example: one draining session, three configurations (the spec's scenario, with transition detail)

| Time | Observation | Config |
|---|---|---|
| 10:00 | Start, **80%** (partial) | A = 5G/data ON/PS OFF/Std |
| 10:06 | 79% ← anchor | A |
| 10:58 | 73% | A |
| 11:00:00 | Network mode → 4G, **user tap**. Window = [10:59:10 app backgrounded, 11:00:00 tap]. Observed radio NR‑NSA→LTE at 10:59:41 (corroborates). | A→B |
| 11:07 | 72% ← first transition after boundary | B |
| 11:55 | 68% | B |
| 12:00:00 | Mobile data OFF, **auto-detected** (exact; window 0 s) | B→C |
| 12:10 | 67% | C |
| 12:58 | 64% | C |
| 13:00 | Stop, 64% | C |

- Segment A: 79→73 = 6 points in 52 min → **6.92 %/h**. Quality OK (6 steps, 52 min).
- Boundary step 73→72 (10:58→11:07) overlaps the window → **excluded** (1 point).
- Segment B: 72→68 = 4 points in 48 min → **5.00 %/h**. Quality: low; it passes the minimum but is short.
- Boundary step 68→67 → excluded (1 point).
- Segment C: 67→64 = 3 points in 48 min → **3.75 %/h**. Quality: minimal (3 steps). It's reportable but flagged "low precision ±≈1 point".
- Accounting: 16 points lost = 13 attributed (6+4+3) + 1 initial partial + 2 boundary steps. Every point is accounted for in the session view.
- **Must not** be presented as "battery life on config A = 80/6.92 h". That would be a mixed-session extrapolation. Any time-to-threshold prediction for A uses A's band profile across sessions, labelled as a prediction.
- Note the confounding: A was measured at 80–73%, B at 72–68% and C at 67–64%. SoC band and elapsed time are confounded with configuration in this session, so the comparison tool marks this *single* session's A/B/C differences as **not a controlled comparison**.

### 8.5 Charge-counter cross-check
When it's available, each segment shows its counter-derived mAh/h next to %/h, labelled *diagnostic* until the device is counter-trusted (§7.6).

---

## 9. Dynamic configuration handling (exact behaviour)

1. **Auto-detectable change** (power saving, mobile data; Wi‑Fi as a condition): the callback or broadcast fires → in one transaction: persist the current sample, a new `config_state` (src=`verified`), and a `config_change` with window = [t, t]. The current run closes and the next one opens. Monitoring continues and the session is not restarted.
2. **Manual change** (network mode, performance profile):
   - The **"Log change" button** is in the app (one tap opens a 2-tap sheet) and also as a **notification action**.
   - The timestamp is the tap time. The window starts at **max(the last moment the app/notification confirmed the old state, the time the app was last backgrounded if you returned from Settings)**. The UI shows the window and lets you shrink it ("I changed it just now"), but never widens it silently.
   - Corroboration: an observed radio change (NR↔LTE) inside the window is stored as supporting evidence. It's never used as the change time for the *preference*.
3. **Forgotten changes:** when a session stops, you're asked to confirm that the manual variables stayed X throughout. "Not sure" sets those variables to `unknown` for the uncovered span, and that span gets `config_id NULL`, so it's excluded from configuration views but kept in the session view.
4. **Contradiction detection:** if 4G is confirmed but NR is observed, the app flags it and prompts you. With power saving ON, observed LTE is noted as a possible PS side effect.
5. **Charging sessions** follow the same rules. Configuration changes split charging runs.
6. The app **never** changes a setting. It only opens the relevant Settings screen via a public intent where one exists, at most.

---

## 10. UI specification

All screens are plain Preact. No animations during tests. Charts render only when a results or live screen is opened, using decimated data (≤ 1 point per step). Nothing keeps the screen on.

1. **Dashboard:** level, state (charging / held / discharging), current configuration with a source badge per variable (✓ verified / 👤 confirmed / ? unknown), monitoring status (none / active / gap detected), "Start charging test" and "Start draining test" buttons, the last 3 results with quality badges, and setup warnings (battery not Unrestricted, notification permission denied, etc.).
2. **Test setup:** type; configuration with auto values pre-filled and manual ones requiring confirmation; target (80/90/100) or lower threshold; charger label (remembered list); conditions (Fast charging, Protect battery, Wi‑Fi intent); notes; and a "What this test can't measure" panel generated from the device's capabilities probe. Start.
3. **Live test:** a small uPlot chart of level vs time (updates per step), active, held, interrupted, paused and gap durations, wall time, a configuration timeline strip, the last 10 observations, warnings, and buttons for Pause/Resume, Log change, Stop and Add note. When it's charging: predicted remaining active time (labelled as a prediction, or "insufficient data").
4. **Results: Charging** and **Results: Draining** are separate tabs and never combined. They have:
   - A configuration matrix (16 cells): median and n per cell, colour-coded only by data sufficiency, never by "winner".
   - Filters for configuration, SoC band, charger, screen-off only and exclude hot.
   - A **comparison view** for two configurations: band-matched rates, n, spread, CI if justified, condition differences (temperature, screen-on share, signal, charger), and a verdict that is one of *A faster*, *B faster*, *no detectable difference*, or **inconclusive (reason)**.
   - Observed vs predicted shown in separate columns, and an excluded-observations list with reasons.
5. **Session detail:** the full timeline (intervals coloured by class), segments with their results, configuration changes with their windows, interruptions, and a raw sample table. Export CSV/JSON. Delete.
6. **History:** list with search and filters (type, configuration, date, quality). Bulk export or delete. Raw data is kept, and results are recomputed with the current estimator, with the version shown.
7. **Settings / Diagnostics:** capability probe results, battery-optimisation status, overhead stats, "recompute all", and full DB export.

**Exports:** CSV (one file per table) and a JSON bundle (raw tables + computed results + estimator version), saved through the Storage Access Framework. No network.

---

## 11. Performance plan

### 11.1 Background components
| Component | Why | When | Event or periodic | Expected overhead | How to measure | If unavailable |
|---|---|---|---|---|---|---|
| MonitorService (FGS) | Keeps the process alive so runtime receivers work | Active session only | Event | ~0 CPU when idle; memory ~15–30 MB native without WebView [VERIFY] | `dumpsys meminfo`, procstats | Session shows gaps; quality downgraded |
| BATTERY_CHANGED receiver | Level, status and temperature transitions | Each system battery broadcast | Event | ~µs–ms per broadcast; persists ≤ ~300 rows/day | In-app counters + handler time (`elapsedRealtimeNanos`) | — (core) |
| Power-save / screen / shutdown / time receivers | Config and context events | On change | Event | Negligible | Counters | Screen: recover via Usage access |
| TelephonyCallback (DisplayInfo, data state) | Radio corroboration, data toggle | On change | Event | Low [VERIFY: DisplayInfo churn in weak coverage] | Callback counter | Read at persisted samples instead |
| NetworkCallback (Wi‑Fi) | Condition | On change | Event | Negligible | Counter | Read at samples |
| BootReceiver | Resume after reboot | Boot / app update | Event | One-off | — | Gap until app opened |
| SQLite writes | Persistence | Per persisted sample | Event | ≤ 300 small inserts/day | Row counter; `dumpsys diskstats` | — |
| WebView / JS | UI only | Only while visible | — | 0 in background | Verify that no JS timers survive `onStop` | — |

**Not used:** AlarmManager, WorkManager, wakelocks, JS polling, logging in release builds (Log calls stripped by R8), analytics, or network permission (**the `INTERNET` permission is removed from the manifest**; Capacitor serves local assets without it [VERIFY on build]).

### 11.2 Benchmark protocol
1. **System attribution:** `adb shell dumpsys batterystats --reset` → run for N hours → `dumpsys batterystats --charged <pkg>` plus a bugreport into Battery Historian [DOC](https://developer.android.com/topic/performance/power/battery-historian). Record app CPU time, wakeups, wakelocks and estimated mAh.
2. **Self-instrumentation (debug or opt-in):** broadcasts received per hour, persisted rows per hour, total handler CPU time, and the process's `/proc/self/stat` utime+stime read at heartbeat.
3. **A/B drain test:** paired overnight screen-off idle sessions, monitoring ON vs OFF, ≥3 pairs, same configuration and similar start level and temperature, alternating order. Use the start and end levels from Settings (OFF case) and the app (ON case). The expected difference is below percent resolution. The honest result is likely "not detectable at ±1% per 8 h", which is the target.
4. **Continuity:** missing-sample rate, defined as gaps detected per 24 h.

### 11.3 Proposed acceptance thresholds (to revise after measurement)
- App CPU time ≤ **60 s per 24 h** screen-off with a session active.
- **0** app-held wakelocks beyond broadcast dispatch, and **0** alarms.
- Batterystats-attributed drain ≤ **0.5% of capacity per 24 h**.
- A/B overnight difference not detectable (< 1 point per 8 h, over ≥3 pairs).
- ≤ 1 undetected gap per week. Every gap > 15 min is detected and labelled.
- Results screen recompute for 100 sessions in ≤ 300 ms on device.

---

## 12. Failure-handling plan (Review 5)

| Scenario | Behaviour | Recoverable? |
|---|---|---|
| Charger disconnected for hours | `interruption` interval; charging session stays active, run closes; at the 24 h default you're notified to stop or keep | Fully recorded |
| Phone restarted | `SHUTDOWN` event if delivered → BOOT_COMPLETED → service restarts → `boot` event + `gap` interval bounded by the last pre-shutdown row and the first post-boot row; level difference known, timing within the gap unknown | Endpoints yes; inside no |
| Android kills the app | On restart: `process_start` event; if `now − last_row` > heartbeat + 5 min → `gap`; exit reason from ApplicationExitInfo; screen events recovered via UsageStats if granted; plug state during gap **unknown** → gap excluded from strict results | Partially |
| A broadcast is missed | The next broadcast carries the current state; a level jump > 1 is flagged; that step isn't complete → excluded | Yes (flagged) |
| Level unchanged across many observations | Normal; heartbeats only; a run with no transition gives the bound rate < 1/T | N/A |
| Unexpected level jump | Flag; > 3 points in < 2 min excluded as implausible; near 0% or 100% labelled as possible recalibration | Raw kept |
| Config changes mid-segment | §9 | Yes |
| Uncertain change timestamp | Window recorded; steps overlapping it excluded | Yes, at the cost of about 1 point |
| Temperature rises significantly | `hot` flag per step; stratified; charging hold → `held` | Yes |
| Charging paused by battery protection | `held` interval (status NOT_CHARGING or FULL while plugged); target marked *capped* if hold happens at or above the protection level | Yes [VERIFY Samsung status codes] |
| Native APIs return unavailable values | Sentinels (`Long.MIN_VALUE`, 0, `Integer.MIN_VALUE`) → NULL + `invalid_value` flag; capability probe hides unsupported metrics | Yes |
| Android or One UI update | New `build_snapshot`; results grouped or filterable by build; comparisons across builds flagged | Yes |
| Many short config segments | Each likely insufficient; session view shows them all; UI warns about minimum segment length | By design |
| Session includes both charging and draining | Never re-typed; opposite-direction time = interruption (§1.2 C10) | By design |
| Clock change | `elapsed_ms` used for durations; `time_set` event; display time adjusted | Yes |
| Duplicate broadcasts | Deduplicated in memory; persisted only on meaningful change | Yes |
| DB write failure or full storage | Retry once, then notify; the service keeps running | Partially |
| Notification permission denied | FGS still runs; setup warns that the status is invisible | Yes |

---

## 13. Testing strategy

1. **Engine unit tests (Vitest, Node):** pure functions over synthetic timelines. Required fixtures:
   - the two worked examples (exact expected numbers from §7.4 and §8.4)
   - plateau
   - jump
   - gap
   - reboot across elapsed reset
   - held at 80%
   - hot steps
   - many short segments
   - uncertainty window overlapping a step
   - mixed screen steps
   - config `unknown` spans
2. **Estimator validation:** a **simulator** that produces ground-truth timelines (known %/h per band, broadcast latency jitter, random interruptions, config switches, quantization). It asserts bias < 2% and correct `insufficient_data` behaviour. New estimator versions must pass the same suite. Version diffs are reported on recorded real sessions.
3. **Native unit tests (JVM/Robolectric):** sample-persistence policy (dedupe, heartbeat), sentinel handling, migration tests (v1→vN on fixture DBs).
4. **Integration on device (instrumented):** use `adb shell dumpsys battery unplug | set level N | set status N | reset` to simulate plug/level/status [KNOWN dev technique]. Kill the process with `am kill` / `adb shell am crash`, reboot, change the clock, and toggle power saving.
5. **Real-device tests (manual checklist):** Milestone 0 probe results, a 1 h charge, an overnight drain, a Samsung sleeping-app kill test, and Protect battery behaviour.
6. **Overhead benchmarks:** §11.2, repeated after every milestone that touches native code.

---

## 14. Implementation roadmap

Each milestone ends with a demonstration against its acceptance criteria before the next one starts.

| M | Scope | Acceptance criteria |
|---|---|---|
| **M0: Capability probe** | Minimal Capacitor app + plugin `probe()`: dumps every API in §2 and logs broadcast frequency for 30 min | Report on *your* device: readable fields, sentinels, charge-counter/current units, power-save mapping, data-enabled listener needs permission?, DisplayInfo behaviour, Protect battery status codes, specialUse FGS from boot. **Plan revised from this report.** |
| **M1: Project skeleton** | Vite + Preact + TS, Capacitor Android, local plugin stub, `engine/` package with Vitest, no `INTERNET` permission | Builds; `npm test` runs; APK installs; manifest permissions audited |
| **M2: Storage + recorder** | Schema v1, migrations framework, MonitorService, receivers, persistence policy, boot restart, gap detection | 8 h drain on device: ≤ 300 rows, all transitions present, kill/reboot produce labelled gaps; migration test passes |
| **M3: Engine v1** | Intervals, runs, complete steps, span rates, band profiles, both pipelines, exclusions, quality; fixtures + simulator | All fixture tests including both worked examples; simulator bias < 2% |
| **M4: Sessions + config handling UI** | Setup, live screen, pause/resume, Log change sheet, notification action, end-of-session confirmation | Scripted scenario (§8.4) reproduced on device via adb + manual taps; correct segments |
| **M5: Results + comparisons** | Charging and draining dashboards, matrix, comparison verdicts, session detail, history | Verdict logic unit-tested (inconclusive cases); renders 100 synthetic sessions in ≤ 300 ms |
| **M6: Export / delete / recompute** | CSV/JSON via SAF, delete, recompute-all, result cache | Round-trip: exported raw → re-imported in test → identical results |
| **M7: Overhead benchmark + hardening** | §11.2 protocol, Samsung setup guidance, R8 log stripping | Thresholds of §11.3 met or plan revised with measured numbers |
| **M8 (optional)** | Charge-counter trust, Theil–Sen / screen NNLS as estimator v2, UsageStats screen recovery, Quick Settings "Log change" tile | Each feature behind validation; v1 vs v2 diff report |

---

## 15. Risk register

| Risk | Severity | Mitigation | Residual uncertainty |
|---|---|---|---|
| One UI kills the FGS despite settings | High | Unrestricted setup guide, gap detection, ApplicationExitInfo, boot restart | Medium: depends on firmware |
| Manual config changes forgotten or mis-timed | High (attribution) | Notification action, end-of-session confirmation, radio corroboration, `unknown` exclusion | Medium: human factor |
| Power saving silently changes other variables | Medium | Observed radio, warning, M0 probe | Low after M0 |
| Protect battery or thermal hold misclassified | Medium | `held` class from status; M0 verification | Low–Medium |
| Too few sessions for conclusions (16 configs) | High (usefulness) | Inconclusive verdicts, balanced within-session rotation for draining, prioritise configs you care about | Inherent |
| SoC-band confounding in rotation sessions | Medium | Band-matched comparisons, ABBA ordering suggestion | Low |
| Broadcast latency vs fast-charge step (~40–60 s) | Medium | Span rates (only endpoint error), 10-point bands | Low: ~1–2% |
| Charge counter or current untrustworthy | Low (diagnostic only) | Validation gate | — |
| `specialUse` FGS policy changes in future Android | Low (sideload) | Track behaviour changes; fallback Option C | Low |
| Overhead higher than expected (DisplayInfo churn) | Medium | Counters; disable callback, read at samples instead | Low |
| WebView memory or JS timers leaking into background | Low | No timers; verify after `onStop` | Low |

---

## 16. Final self-review (Reviews 1–7, condensed)

- **Requirements audit:** 16 vs 24 resolved; contradictions C1–C11 documented. ✔
- **Feasibility:** each variable classified (§2.1); unsupported capabilities listed (§2.5); [VERIFY] items are collected into M0. ✔ *Limitation: some claims are from platform knowledge and flagged for on-device verification rather than fully re-confirmed against current docs. M0 exists to close that gap.*
- **Measurement validity:** quantization (complete steps), interruptions (run splitting), missing samples (gaps), temperature (stratification), boundary uncertainty (boundary-step rule); no-estimate conditions defined (§6). ✔
- **Architecture:** four options compared; simplest viable chosen; no alarms, WorkManager, wakelocks or network. ✔
- **Failure simulation:** all 14 spec scenarios plus 4 extra (§12). ✔
- **Statistics:** session is the unit of replication; segments are aggregated per session first; CI only with n ≥ 5 via session bootstrap; quality ≠ CI; predictions labelled; raw data recomputable with versioned estimator. ✔
- **Consistency:** the engine is independent of the UI and native layers (pure TS); charging and draining pipelines are separate code paths with shared *primitives* only (step extraction), which doesn't mix data. ✔
- **Known remaining weaknesses:**
  - The screen-on/off split will often be "insufficient" in real mixed use.
  - Wall-clock charging predictions are limited by design.
  - The full matrix needs many sessions.
  - Charger power isn't observable.

---

## 17. Implementation gate: decision summary

- **Feasible as specified:** charging and draining measurement with interruption handling, segmentation, per-band rates, history, exports, local-first operation, and low overhead.
- **Needs correction:**
  - 24 → 16 configurations.
  - Network-mode and performance-profile values are manual, not verified.
  - "Battery life per configuration" from mixed sessions is replaced by per-segment rates and band-based predictions.
  - Sessions never change type.
  - 100% targets may be capped by Protect battery.
- **Cannot be guaranteed:**
  - Uninterrupted monitoring on Samsung.
  - Exact manual-change timestamps.
  - Charge-counter accuracy.
  - Charger wattage.
  - Ambient temperature.
  - Per-app workload.
  - Screen split under heavy toggling.
- **Recommended architecture:** session-scoped `specialUse` foreground service with only event-driven receivers, framework SQLite in native code, a local Capacitor plugin, a pure-TS estimator, and a Preact + uPlot UI.
- **Charging time:** active time = Σ actively-charging intervals (plugged ∧ CHARGING ∧ not paused). Rates come from complete percent steps per 10-point band. Predicted remaining = Σ band time-per-point to the target.
- **Mixed-configuration segmentation:** cut at each change. The step straddling the change (or its uncertainty window) is discarded. Segments are aggregated per session, then across sessions.
- **Acceptable accuracy limits:** ±1 point quantization per run endpoint (removed by complete-step accounting), seconds of broadcast latency, about 1 lost point per configuration boundary, and manual-change windows.
- **Overhead benchmarking:** batterystats/Battery Historian, in-app counters and CPU time, and paired ON/OFF overnight drains, with the thresholds in §11.3.
- **Must verify on your device (M0):**
  - power-save mapping
  - data-enabled listener permissions
  - DisplayInfo behaviour
  - Protect battery status codes
  - charge counter and current units
  - `specialUse` FGS restart from boot
  - Samsung kill behaviour
  - performance profile availability on your firmware
- **Milestones:** M0 probe → M1 skeleton → M2 recorder → M3 engine → M4 session UI → M5 results → M6 export → M7 overhead → M8 optional.

### Questions that block implementation
1. **Exact phone model and One UI / Android version?** This sets the minimum SDK assumptions and whether Performance profile exists.
2. **Sideload only (no Play Store)?** This plan assumes yes.
3. **Should Wi‑Fi state, charger label, Fast-charging setting and Protect-battery setting be recorded as session conditions (recommended), or promoted to configuration variables (which would enlarge the matrix)?**

**Stopping here, waiting for approval before creating any project files.**

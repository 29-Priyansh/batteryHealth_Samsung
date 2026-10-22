# Battery Lab

A local-only Android app (Capacitor + Kotlin) that measures charging and draining behaviour of a Galaxy S24 under user-selected system configurations. The design and its rationale are in [docs/PLAN.md](docs/PLAN.md); the original brief is [project.md](project.md).

## Layout

- `src/engine/`: pure TypeScript calculation code (no DOM, no Capacitor), unit-tested with Vitest.
- `src/ui/`: Preact screens.
- `src/native/`: TypeScript interface of the native `BatteryLab` plugin.
- `android/app/src/main/java/com/priyansh/batterylab/`: Kotlin plugin, capability probe, SQLite store.

## Build

Requires Node 22+, the Android SDK (API 36), and a JDK 21 (Android Studio's bundled JBR works).

```sh
npm install
npm test                # engine unit tests
npm run apk             # web build + cap sync + debug APK
```

The APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. Install it with:

```sh
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## Status

- M0 capability probe: done (results in docs/PLAN.md R2.5).
- M1 skeleton: done.
- M2 recorder: built (foreground service, persistence policy, gap/reboot recovery, config changes,
  battery-protection hold detection, finish notification). On-device reboot acceptance run still pending.
- M3 estimator (`src/engine/steps.ts`, `compare.ts`): complete-step extraction, per-session rates,
  band medians, predictions, comparisons with inconclusive verdicts.
- M4 session UI, M5 results/comparisons, M6 CSV/JSON export: built.
- M7 overhead: in-app counters (Setup → Advanced); batterystats A/B runs still to do on the device.

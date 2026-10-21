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

- M0 capability probe: built; needs to be run on the phone (Diagnostics tab).
- M1 skeleton: done.
- Parameter selection with cost/downside analysis: done.
- M2+ (recorder, estimator, results): not started.

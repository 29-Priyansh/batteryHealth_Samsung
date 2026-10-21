# Project: Ultra-Low-Overhead Samsung Battery Testing App

## 1. Your Role and Mission

Act as a senior Android engineer, Capacitor specialist, battery-measurement engineer, data analyst, performance engineer, and critical technical planner.

I want to build an Android application using Capacitor that measures, records, analyzes, and compares my Samsung phone's battery charging and draining behavior under different system configurations.

Currently, I manually change system settings and record battery percentages and times. This is tedious, error-prone, and makes fair comparisons difficult, particularly when I use my phone during charging or change settings during a draining test.

The app should automatically collect as much reliable information as Android permits, run in the background with minimal overhead, retain historical measurements, and calculate useful comparisons without requiring me to supervise every measurement.

**Your first task is to produce a complete, critically reviewed implementation plan. Do not start coding until the plan is complete and the major architectural decisions have been presented for approval.**

Do not blindly follow this specification. Some assumptions may be incorrect or incomplete. Research the platform, challenge the requirements, correct mistakes, and improve the design independently.

The objective is the simplest, lightest practical application that produces trustworthy measurements, not the most complicated application possible.

---

## 2. Initial Requirements and Configuration Matrix

The application must measure battery behavior under these four configuration variables:

1. Network mode: 5G or 4G.
2. Mobile data: ON or OFF.
3. Power saving: ON or OFF.
4. Performance profile: Standard or Light.

The original requirement states that there are 24 permutations. Verify this independently: four binary variables produce 16 combinations.

Use the 16 valid combinations unless a genuinely missing variable is identified and explicitly approved. Do not invent another variable merely to reach 24.

Generate stable, unique configuration IDs. Store each variable independently so future configuration variables can be introduced through schema migrations rather than architectural changes.

Investigate whether each setting can actually be read through supported Android APIs on my Samsung phone.

Classify every setting as:

- Automatically verifiable through a supported API.
- Available only with additional permissions or special access.
- Not reliably accessible to an ordinary third-party application.
- Dependent on the Samsung device or One UI version.
- Requiring manual confirmation.

Never silently assume a setting's state. Store whether each value is verified, user-confirmed, estimated, or unknown.

If automatic detection is unavailable, provide a lightweight interface that lets me confirm the configuration and record a change immediately.

The app must not automatically modify network mode, mobile data, power saving, performance profile, or other system settings.

---

## 3. Two Independent Measurement Systems

Implement charging and draining as logically separate measurement systems.

They must have independent calculation pipelines, result categories, comparison screens, and data-quality rules.

Never mix charging data with draining data.

### A. Charging tests

The app must handle situations where I:

- Connect a charger.
- Disconnect it to use the phone.
- Reconnect it later.
- Pause or resume a test.
- Change settings during a test.
- Reach a selected battery target.
- Restart the phone.
- Close or stop using the app while background monitoring continues.

Only count periods when the device is actually charging as active charging time.

Do not count unplugged intervals as charging time. If the device is connected to power but the battery is not charging, investigate whether the interval should be excluded, separately classified, or marked uncertain.

Preserve valid measurements before and after interruptions.

Support configurable targets such as 80%, 90%, and 100%, subject to the phone's charging limits.

Distinguish clearly between:

- Active charging duration: total time actually spent charging.
- Wall-clock duration: total elapsed time, including unplugged intervals.
- Predicted remaining active charging time.
- Predicted wall-clock completion time, only when sufficient information supports the estimate.

If the charging configuration changes midway through a test, segment the measurements by configuration. Never combine different configurations into a single unqualified charging-rate measurement.

### B. Draining tests

Collect battery measurements while the device is discharging.

Support:

- Screen-on and screen-off periods where measurable.
- Idle and active usage where distinguishable.
- Configuration changes during the test.
- Charging interruptions.
- Pausing and resuming.
- Restarts and application process termination.
- Variable battery levels and temperatures.

Charging intervals must never count as discharging time.

A charging interruption should be recorded as an interruption, not as additional battery-draining time. Resume the draining test when valid discharge resumes.

---

## 4. Dynamic Configuration Changes During Draining

A draining test may contain multiple configurations in one continuous real-world session.

For example:

- 10:00 — Battery 80%, 5G, mobile data ON, power saving OFF, Standard profile.
- 11:00 — Battery 73%, same configuration.
- 11:00 — Switch from 5G to 4G.
- 12:00 — Battery 68%, 4G, mobile data ON, power saving OFF, Standard profile.
- 12:00 — Switch mobile data OFF.
- 13:00 — Battery 64%, 4G, mobile data OFF, power saving OFF, Standard profile.

This is one session containing three configuration-specific segments.

### Required behavior

Whenever a configuration changes:

1. Record the previous and new configurations.
2. Record a timestamp for the change and its source.
3. Close the current segment at the best defensible timestamp.
4. Start a new segment with the new configuration.
5. Preserve raw measurements from both segments.
6. Flag uncertainty if the exact change time is unknown.
7. Continue monitoring without unnecessarily restarting the entire session.

If Android supports reliable change detection, use it. Otherwise, allow manual change events through a quick confirmation interface.

Do not assume that opening Settings or returning to the app identifies the exact time a setting changed.

### Attribution rules

Calculate each valid segment independently.

A basic discharge-rate estimate is:

Discharge rate = battery percentage points lost / valid discharge duration in hours.

Use monotonic elapsed time for duration calculations where possible.

Do not assign battery consumption before a configuration change to the new configuration. Do not assign consumption after the change to the previous configuration.

If a battery-percentage drop spans an uncertain configuration boundary, retain the raw data but flag the affected interval. Exclude it from strict comparisons if the uncertainty materially affects attribution.

Battery percentage is quantized, so a short segment might show no change even though energy was consumed. Do not invent a precise rate when the observations are insufficient.

Where supported and reliable, evaluate charge-counter data, multiple observations, robust regression, and percentage-range-specific rates to improve estimation.

A mixed-configuration session must never be presented as a direct measurement of battery life under one unchanged configuration.

### Statistical handling

Maintain two views:

**Session view:** The complete chronological timeline, including every configuration, battery observation, interruption, and change event.

**Configuration view:** Aggregated measurements from valid segments belonging to the same configuration, retaining the original session and segment identifiers.

Do not treat multiple segments from the same session as independent experimental trials automatically. Calculate per-session summaries where appropriate before combining results across sessions.

Allow historical results to be recalculated when the estimator improves.

Accept small errors caused by battery-percentage rounding, delayed broadcasts, and uncertain change timestamps. Prioritize reliable comparisons across repeated tests over perfect attribution of every individual percentage point.

Do not introduce unnecessarily complex statistical models merely to eliminate negligible errors.

---

## 5. Background Monitoring Architecture

Use Capacitor for the application interface and Android-native functionality where necessary.

Inspect the existing repository before selecting the architecture. If no project exists, propose a minimal, maintainable project structure.

Investigate:

- Capacitor plugin capabilities and limitations.
- A custom Kotlin Android plugin where required.
- BatteryManager and supported battery-related APIs.
- Battery status broadcasts and charging-state events.
- Battery level, voltage, temperature, charge counter, and current measurements.
- Android background execution restrictions.
- Doze mode and process termination.
- Foreground-service requirements and notification policies.
- Samsung-specific background restrictions.
- Persistent storage and recovery after restart.
- Access to screen state and relevant system settings.
- API behavior across the selected minimum Android version and One UI version.

Prefer native Android APIs for measurements and a Capacitor-based interface for dashboards, test setup, history, and comparisons.

Avoid unnecessary JavaScript polling and frequent communication between native Android and JavaScript.

Use event-driven monitoring when appropriate. If periodic sampling is necessary, justify the sampling interval according to measurement accuracy, battery overhead, and Android platform restrictions.

Do not default to a permanent foreground service without investigating whether it is needed. If continuous monitoring requires one, explain its notification, power, reliability, and compatibility trade-offs.

Do not assume that an app can continuously execute arbitrary background code indefinitely.

The application must preserve already collected measurements if Android terminates the process. Explain which missing observations can be recovered and which cannot.

---

## 6. Measurement Data Model

Design a normalized, versioned, local-first data model.

### Configuration

Include:

- Unique configuration ID.
- Network mode.
- Mobile data state.
- Power-saving state.
- Performance profile.
- Verification status for each setting.
- Optional device model, Android version, One UI version, and relevant software metadata.

### Test session

Include:

- Unique session ID.
- Test type: charging or draining.
- Initial configuration.
- Start and end timestamps.
- Initial and final battery levels.
- Target battery level, where applicable.
- Session status.
- Interruption history.
- Data completeness and quality.
- User notes.
- Estimator version used for calculated results.

### Measurement samples

Include:

- Timestamp.
- Monotonic elapsed-time reference where available.
- Battery percentage.
- Charging or discharging state.
- Plugged-in state.
- Charging source, if available.
- Battery temperature.
- Battery voltage.
- Charge counter and current, if available and trustworthy.
- Screen state, where accessible.
- Active configuration ID.
- Sample source and validity flags.

Do not assume that all measurements are supported on every device.

### Configuration-change events

Include:

- Session ID.
- Previous and new configuration IDs.
- Changed variable.
- Event timestamp.
- Timestamp accuracy or uncertainty.
- Detection source.
- Verification status.

### Measurement intervals

Include:

- Session ID and segment ID.
- Start and end timestamps.
- Configuration ID.
- Interval classification.
- Battery levels at the boundaries.
- Valid discharge or charging duration.
- Interruption details.
- Configuration-boundary uncertainty.
- Exclusion reason, if applicable.

Use transactions, sensible indexes, and efficient persistence. Batch writes when doing so does not risk losing important observations.

Evaluate SQLite versus Capacitor Preferences or other appropriate local storage. Use structured database storage if justified by the volume and relationships of historical measurements.

The app must not require a server, account, analytics SDK, cloud storage, or internet connection for core functionality.

---

## 7. Charging Calculation Engine

Design a scientifically defensible estimator rather than simply dividing elapsed time by percentage gained.

The engine must account for:

- Unplugged intervals.
- Charging interruptions.
- Different configurations.
- Variable charging rates at different battery levels.
- Battery temperature.
- Charging source and charger differences.
- Battery-percentage quantization.
- Missing observations.
- Implausible battery jumps.
- Charging limits and battery protection.
- Inconsistent or uncertain configuration boundaries.

Investigate suitable estimation approaches, including:

- Charging-rate calculations within battery percentage ranges.
- Robust regression across multiple observations.
- Weighted averages and medians.
- Charge-counter-based estimation where the measurements are trustworthy.
- Confidence intervals when the data and statistical assumptions support them.

Explain the limitations of each approach and choose the simplest method that is sufficiently reliable.

### Required charging calculations

For each configuration and target battery percentage, report where supported:

- Number of valid sessions.
- Number of valid charging intervals.
- Observed active charging duration.
- Median and mean duration when meaningful.
- Observed charging rate by battery percentage range.
- Estimated remaining active charging time.
- Wall-clock duration for completed sessions.
- Variation across sessions.
- Data completeness.
- Statistical uncertainty, where supportable.
- Quality rating and reasons for exclusions.

Do not confuse a statistical confidence interval with a generic quality score.

Do not extrapolate far beyond observed battery ranges without explicitly identifying the result as a prediction and explaining its limitations.

When estimating the time from one battery level to another, use rate estimates for the relevant state-of-charge ranges rather than assuming a constant rate across the entire battery.

For interrupted sessions, combine valid intervals only when their configurations and conditions are sufficiently comparable. Otherwise, segment them and reduce the quality rating.

A session that reaches a target may provide an observed duration. An incomplete session should not be presented as if the target was reached.

---

## 8. Draining Calculation Engine

Implement an independent discharge estimator.

Required outputs include:

- Battery percentage points lost per valid discharge hour.
- Consumption by battery-percentage range.
- Screen-on versus screen-off consumption where measurable.
- Estimated time to a selected lower battery threshold.
- Median and mean rates where appropriate.
- Number of valid sessions and segments.
- Variation across repeated sessions.
- Data completeness and uncertainty.
- Excluded observations and reasons.

Exclude charging and paused intervals from discharge duration.

For mixed-configuration tests, calculate separate segment results and aggregate only valid observations for the same configuration.

Evaluate percentage-per-hour calculations against charge-counter measurements where available and reliable. Do not assume charge counters are universally available or accurate.

Recognize that battery percentage does not represent a perfectly linear quantity of remaining energy.

A battery-life prediction should be based on sufficient relevant data and labeled as a prediction. If a segment is too short or too noisy, report insufficient data rather than generating a misleadingly precise estimate.

Account for screen activity, temperature, network signal, and workload where measurable or manually recorded. Explain the limitations when these variables cannot be measured.

---

## 9. Fair Experimental Comparisons

The app should help me determine which configuration genuinely improves charging speed or battery life.

Identify potential confounding variables:

- Initial and final battery percentage.
- Battery and ambient temperature.
- Charger, cable, and charging protocol.
- Screen brightness and screen-on duration.
- Foreground applications and background activity.
- Network signal strength and network traffic.
- Charging limits and battery protection.
- Idle duration.
- Thermal throttling.
- Battery aging.
- Operating-system and application updates.

For each variable, classify it as automatically measurable, partially measurable, manually recordable, or unavailable.

Do not claim every factor can be obtained through public Android APIs.

Prioritize equivalent conditions, repeated sessions, comparable battery-percentage ranges, and consistent chargers.

Distinguish observed measurements from model-based predictions and adjusted comparisons.

Do not declare a configuration definitively superior based on one noisy or incomplete test.

If two configurations have substantially different test conditions or insufficient data, explicitly identify the comparison as inconclusive.

---

## 10. User Interface and Workflow

Keep the interface simple, responsive, and lightweight.

### Dashboard

Show:

- Current battery percentage.
- Current charging state.
- Current configuration.
- Verification status of configuration values.
- Monitoring status.
- Quick access to charging and draining tests.
- Recent results and data-quality warnings.

### Test setup

Allow me to:

- Choose charging or draining.
- Confirm the active configuration.
- Select a target battery percentage.
- Start, pause, resume, or stop a test.
- Add optional notes.
- See measurement limitations before starting.

Automatically populate reliable system information instead of requiring unnecessary manual entry.

### Live test screen

Show:

- Battery percentage over time.
- Current test duration.
- Active charging or discharging duration.
- Paused and interrupted duration.
- Configuration changes.
- Recent observations.
- Data-quality warnings.

Update the visible interface only as frequently as necessary. Do not keep the display awake or perform unnecessary animations during a test.

### Results and comparisons

Support:

- Separate charging and draining dashboards.
- Filtering by configuration.
- Comparison across all valid configurations.
- Battery-percentage-range comparisons.
- Median, mean, sample count, variation, and uncertainty where meaningful.
- Measured versus predicted values.
- Excluded observations and their reasons.
- Battery percentage against time graphs.
- Configuration-specific charging and draining rates.
- CSV and JSON exports of raw observations and calculated results.

For mixed-configuration sessions, display the timeline and each configuration-specific segment.

### History

Support:

- Searching and filtering sessions.
- Reviewing interruptions and configuration changes.
- Inspecting individual observations.
- Deleting or exporting sessions.
- Preserving raw data for future recalculation.

Do not make historical measurements dependent on the current calculation algorithm. Preserve raw observations and identify the estimator version used for each result.

---

## 11. Low Battery Overhead

Minimal measurement overhead is a core requirement.

Investigate how to benchmark the application's own impact on battery consumption.

Propose controlled comparisons with monitoring enabled and disabled under similar conditions.

Where feasible, measure:

- CPU usage.
- Wakeups.
- Background execution time.
- Storage writes.
- Memory use.
- Battery statistics attributable to the app.
- Measurement continuity and missing samples.

Set realistic performance budgets after investigating the selected architecture. Do not invent guarantees such as zero battery consumption.

For every background component, document:

- Why it is necessary.
- When it runs.
- Whether it is event-driven or periodic.
- Its expected overhead.
- How that overhead will be measured.
- What happens when it is unavailable.

Avoid:

- Extremely frequent polling without justification.
- Unnecessary JavaScript execution.
- Keeping the screen awake.
- Repeated database writes for every trivial event.
- Continuous console logging.
- Network traffic and external analytics.
- Unnecessary notifications.
- Heavy chart rendering during active measurement.
- Background services that are not justified by the requirements.

The application must not alter system performance settings, artificially increase workload, or interfere with charging.

The goal is negligible practical overhead, verified through measurement rather than asserted without evidence.

---

## 12. Compatibility, Reliability, and Privacy

Plan for:

- A justified minimum Android version.
- The target Samsung model and One UI version.
- Android permissions and background restrictions.
- Reboot recovery.
- Process termination.
- Duplicate broadcasts and missing samples.
- Clock changes.
- Unavailable sensors.
- Invalid measurement values.
- Database migrations.
- App upgrades.
- Battery-optimization restrictions.
- Local privacy and export.

Use monotonic elapsed time for duration calculations where possible, and wall-clock timestamps for readable history. Explain how timing is handled across reboots, when monotonic clocks reset.

Do not request unnecessary permissions.

Do not root the device, use hidden APIs, or depend on privileged Samsung interfaces in the default design.

If a requested capability requires special access or is impossible through supported APIs, document that limitation and propose the simplest safe alternative.

---

## 13. Self-Correction and Research Process

Treat this as an iterative engineering planning task.

### Review 1: Requirements audit

Identify contradictions, missing details, incorrect assumptions, and ambiguous requirements.

Resolve the discrepancy between 16 and 24 configurations.

### Review 2: Platform feasibility

Research current official Android documentation, Capacitor documentation, and Samsung documentation where available.

Verify the availability and restrictions of each proposed API.

Distinguish officially supported functionality from community workarounds and unsupported behavior.

### Review 3: Measurement validity

Challenge every proposed formula.

Verify that interrupted charging, changing configurations, missing samples, percentage quantization, and temperature variation are handled correctly.

Identify conditions where a reliable estimate cannot be calculated.

### Review 4: Architecture and overhead

Compare at least two feasible architectures.

Select the simplest design that satisfies the requirements.

Explain background execution, persistence, event collection, sampling, and expected overhead.

Remove unnecessary dependencies and background components.

### Review 5: Failure simulation

Analyze these cases:

- Charger disconnected for several hours.
- Phone restarted during a test.
- Android kills the application.
- A broadcast is missed.
- Battery percentage remains unchanged across several observations.
- Battery percentage jumps unexpectedly.
- Configuration changes during a segment.
- Configuration-change timestamp is uncertain.
- Device temperature increases significantly.
- Charging is paused by battery protection.
- Native APIs return unavailable values.
- The phone receives an Android or One UI update.
- A test contains many short configuration segments.
- A session includes both charging and draining.

Revise the data model, calculations, and architecture to address these failures.

### Review 6: Statistical correctness

Verify that:

- Segments from one session are not automatically treated as independent trials.
- Mixed-configuration results are not presented as controlled full-session outcomes.
- Confidence intervals are only reported when statistically justified.
- Incomplete observations are not represented as completed tests.
- Historical raw data can be recalculated.
- Predictions are distinguishable from direct measurements.

### Review 7: Final consistency audit

Compare the complete plan against every requirement in this prompt.

Resolve material contradictions. Document unavoidable limitations rather than pretending the plan is perfect.

Repeat the review until another pass identifies no material, unaddressed flaw. Do not claim mathematical proof of correctness or guarantee that no undiscovered issues exist.

If a critical assumption remains unresolved, explain why it matters and ask only the necessary question.

---

## 14. Required Deliverables

Produce these deliverables in order.

1. **Requirements audit:** Confirmed requirements, contradictions, corrections, and assumptions.
2. **Platform feasibility report:** What supported Android and Samsung APIs can and cannot provide.
3. **Architecture proposal:** Components, responsibilities, data flow, and background execution.
4. **Architecture comparison:** At least two feasible options with trade-offs and a justified recommendation.
5. **Data schema:** Entities, fields, relationships, indexes, persistence, and migrations.
6. **Charging calculation specification:** Formulas, assumptions, exclusions, uncertainty, and worked numerical examples.
7. **Draining calculation specification:** Formulas, segmentation, aggregation, uncertainty, and worked examples.
8. **Dynamic configuration handling:** Exact behavior when settings change during draining or charging.
9. **UI specification:** Screens, workflows, result presentation, and history.
10. **Performance plan:** Expected overhead, benchmarking, and proposed acceptance thresholds.
11. **Failure-handling plan:** Interruptions, restarts, missing observations, and compatibility limitations.
12. **Testing strategy:** Unit tests, estimator validation, integration tests, real-device tests, and overhead benchmarks.
13. **Implementation roadmap:** Small, ordered milestones with clear acceptance criteria.
14. **Risk register:** Technical risks, severity, mitigation, and remaining uncertainty.
15. **Final self-review:** Requirement-by-requirement verification and unresolved decisions.

Include official source links for important platform claims.

For calculations, include worked numerical examples showing how the app handles at least one interrupted charging session and one draining session with multiple configuration changes.

Make the calculation engine independently testable from the UI and Android-native measurement layer.

Prefer minimal dependencies, local-first operation, maintainable code, and the conventions of the existing repository.

---

## 15. Implementation Gate

At the end of the planning phase, provide a concise decision summary answering:

- What is feasible as specified?
- What requirements need correction?
- Which capabilities cannot be guaranteed?
- What architecture do you recommend?
- How will charging and draining time be calculated?
- How will mixed-configuration tests be segmented?
- What accuracy limitations remain acceptable?
- How will measurement overhead be benchmarked?
- What must be verified on my actual Samsung device?
- What are the implementation milestones?

Then stop and wait for my approval before implementing.

Do not start creating application files, installing dependencies, modifying the repository, or implementing features during this planning phase.

After approval, implement the plan in small milestones, validate each milestone against its acceptance criteria, and revise the plan if actual platform behavior contradicts its assumptions.

**Final objective:** Build the lightest practical Capacitor-based Android battery testing application that preserves trustworthy raw measurements, calculates defensible charging and draining estimates, handles interruptions and dynamic configuration changes, compares all valid configurations fairly, and clearly distinguishes observed facts from predictions.
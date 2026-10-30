# Vascular Flow Monitor (VFM)

<p align="center">
  <strong>A privacy-first vascular-access monitoring prototype for earlier, clearer detection of persistent flow-pattern changes.</strong>
</p>

<p align="center">
  <em>Hackathon prototype · Web Bluetooth · ESP32 band firmware included · Personalized baseline analysis</em>
</p>

> **Important:** VFM is a decision-support demonstration, not a medical device. It does not diagnose stenosis or thrombosis, replace clinical advice, contact emergency services, or make treatment decisions.

---

## 1. The problem

For people who rely on an arteriovenous (AV) fistula for hemodialysis, changes in vascular access flow can be clinically important. Today, many changes are discovered during scheduled checks or after symptoms become obvious. That creates a difficult gap between **continuous physiological change** and **intermittent human observation**.

VFM explores a simple question:

> **Can a wearable notice that a person's flow pattern has changed from their own normal pattern, verify that the change persists, and explain the result clearly enough for the person to take the next appropriate step?**

The prototype is intentionally designed around **personalized change detection**, rather than a universal threshold. Every person, sensor placement, device, and access site can produce a different normal signal. VFM therefore learns a local baseline and evaluates new readings against that baseline.

---

## 2. The product in one sentence

**VFM connects an acoustic and pulse-sensing wearable to a phone, builds a personal baseline, checks new flow features against that baseline, rechecks persistent changes, and presents an understandable alert with a simulated escalation path.**

This is not a diagnosis engine. It is an early-warning and explanation layer designed to support a future clinically validated workflow.

---

## 3. Why this approach is different

### Personalized instead of one-size-fits-all

VFM compares current measurements with the user's own recent baseline. This reduces dependence on a single population-wide threshold that may not generalize across access sites, body types, sensor placement, or hardware revisions.

### Recheck before escalating

A single unusual reading may be caused by movement, poor sensor contact, environmental noise, or a loose band. VFM uses a two-stage validation flow:

1. Detect a meaningful deviation from baseline.
2. Perform a second check before presenting a persistent-change alert.

### Privacy by default

The browser receives derived telemetry features rather than raw audio. The prototype stores local profile and monitoring state in the browser and writes a local audit record for simulated alert events. There is no required cloud database or continuous cloud telemetry stream.

### Designed for explanation

The interface does not only show a red warning. It shows the measured ratio, baseline, change percentage, signal quality, band-contact state, timeline events, and the evidence behind a recheck result.

### Honest about uncertainty

The UI clearly labels demo behavior, simulated notifications, and the medical-device boundary. That is important for a safety-sensitive prototype: the system must not imply more certainty than the evidence supports.

---

## 4. Judge-ready elevator pitch

> **Vascular Flow Monitor is a privacy-first wearable monitoring prototype for AV-fistula flow patterns. An ESP32-compatible band sends compact acoustic and pulse features to Android Chrome over Web Bluetooth. The phone learns the user's personal baseline, detects meaningful deviations, and runs a second check to filter out motion and placement artifacts. If the change persists, VFM gives the user a clear, explainable alert and starts a simulated safety timer. Our prototype proves the end-to-end interaction—from wearable telemetry to baseline analysis to auditable escalation—without claiming to diagnose disease or replace a clinician.**

---

## 5. How the system works

```text
┌──────────────────────────┐
│ Wearable prototype       │
│ ESP32 + sensors          │
│ Acoustic + optical data  │
└────────────┬─────────────┘
             │ BLE notification packets
             ▼
┌──────────────────────────┐
│ Android Chrome           │
│ Web Bluetooth client     │
│ Decode + quality checks  │
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐
│ Personal baseline layer  │
│ Rolling feature history  │
│ Ratio + delta analysis   │
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐
│ Two-stage validation     │
│ Trigger → recheck        │
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐
│ User-facing explanation  │
│ Trend, quality, evidence │
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐
│ Prototype escalation     │
│ Haptic + popup + audit   │
│ Simulated delivery      │
└──────────────────────────┘
```

### End-to-end flow

1. The user connects a band named `VFM-Band`.
2. The browser receives compact telemetry over a BLE notification characteristic.
3. VFM rejects or down-weights readings with poor quality or missing contact.
4. During calibration, the app collects quality-checked readings and establishes a local personal baseline.
5. New readings are converted into a flow-pattern ratio using high-band and low-band acoustic energy.
6. The current ratio is compared with the user's baseline and threshold.
7. A meaningful change starts a second-check window.
8. A transient change is cleared; a persistent change opens the alert dialog.
9. The band can receive a haptic command, while the server records a simulated escalation audit event.
10. The user can acknowledge the alert before the accelerated demo timer completes.

---

## 6. What the current website actually demonstrates

The repository contains a browser-based prototype rather than a native mobile application. The interface is served from `AVF.html` and organised as five views behind a hash router:

- **Monitor:** Operational status with a pulse ring that beats at the measured heart rate, the second-check recheck panel, personal-baseline calibration, four primary readouts (flow ratio, SpO₂, heart rate, signal quality) and the flow-pattern trace.
- **Readings:** A sortable, filterable, paginated log of every admissible reading. Columns are time, flow ratio, personal baseline, change from baseline, **SpO₂**, **heart rate**, perfusion index, quality and classification state. This view is also the accessible equivalent of the trace chart — the canvas is a shape, the table is the data behind it.
- **Signals:** Where the ratio comes from (low-band versus high-band acoustic energy), how much optical signal is reaching the sensor (perfusion gauge with quality bands), the device flag state, and dominant-frequency history.
- **Events:** A severity strip plus a filterable audit log where each entry can be expanded to show the measurements behind the decision.
- **Demo:** Three guided scenarios, each stating what it proves, what to say, and what result to expect.

Supporting behaviour:

- **Profile:** Display alias and access side, stored in a drawer so it does not interrupt the monitoring flow.
- **Data controls:** Export a monitoring summary or reset everything held on the device.
- **Theme:** Full dark and light palettes, toggled from the app bar and persisted locally.

The demo mode is especially important for judging. It exercises the same validation and alert path as live telemetry while making the presentation reliable and safe.

---

## 7. Product architecture

### 7.1 Wearable layer

The reference ESP32 firmware ships in [`esp-firm/`](esp-firm/README.md). It samples a
contact microphone at 4 kHz, runs a 1,024-point FFT on-device, reads a MAX30102 pulse
oximeter, and streams one 22-byte v2 frame per second when the phone's MTU permits;
otherwise it sends a 20-byte v1 fallback rather than truncating optical bytes:

- A MAX4466-style electret/contact microphone on GPIO34 for acoustic features.
- A MAX30102 / MAX30105 optical sensor on I²C for pulse rate, SpO₂ and perfusion.
- BLE advertising and notifications for telemetry. The firmware tracks the
  negotiated peer MTU and switches between the 22-byte v2 and 20-byte v1 frames.
- Optional haptic feedback on GPIO4, driven by a BLE write characteristic. Haptic
  capability is advertised only when the motor is configured as fitted.
- An optional conductive contact pad on GPIO5, with acoustic fallback when the pad or
  optical sensor is not fitted.

The ESP32 is appropriate for a hackathon because it is inexpensive, widely available, and includes BLE. It is not presented as the final medical hardware design.

### 7.2 Browser and edge-analysis layer

The browser is the primary interaction and analysis surface in this MVP:

- Web Bluetooth connects Android Chrome to the band.
- Telemetry is decoded as little-endian binary data.
- Signal quality and contact flags are checked before readings are used.
- The app calculates a compact flow-pattern ratio from low-band and high-band acoustic power.
- A rolling personal baseline and delta heuristic drive the recheck logic.
- The interface explains the result using metrics, trend visualization, and timeline events.

### 7.3 Local data layer

The current prototype intentionally avoids requiring a cloud backend for normal monitoring. The browser stores derived state locally, while the local Node server supports the demo alert workflow and audit logging.

The server writes simulated alert events to:

```text
data/alert-audit.ndjson
```

Each line is a separate JSON audit event, making it easy to inspect during a presentation without claiming that a real clinical message was sent.

### 7.4 Notification layer

The default mode is safe demo mode:

- The server returns a simulated delivery receipt.
- An audit event is written locally.
- No real SMS or WhatsApp message is sent.

A Twilio provider exists as an optional server-side integration path, but it is not enabled by default and should not be treated as a production clinical escalation workflow.

---

## 8. BLE contract

The browser and wearable share a deliberately small contract.

| Item | Value |
| --- | --- |
| Advertising name | `VFM-Band` |
| Service UUID | `3e5f0001-4c95-4b1a-9b35-9f31c2608c01` |
| Notify telemetry UUID | `3e5f0002-4c95-4b1a-9b35-9f31c2608c01` |
| Write control UUID | `3e5f0003-4c95-4b1a-9b35-9f31c2608c01` |

### Telemetry packet

Telemetry is little-endian. Two frame revisions exist and **both are accepted**:

| Revision | Bytes | Contents |
| --- | --- | --- |
| v1 | 20 | Acoustic features and pulse rate (original contract) |
| v2 | 22 | v1 plus optical saturation and perfusion index |

| Offset | Type | Field | Purpose |
| --- | --- | --- | --- |
| 0 | `u8` | Version | Packet format version: `1` or `2` |
| 1 | `u16` | Sequence | Reading order and continuity check |
| 3 | `f32` | Low-band power | Lower-frequency acoustic energy |
| 7 | `f32` | High-band power | Higher-frequency acoustic energy |
| 11 | `f32` | Acoustic amplitude | Overall acoustic signal magnitude |
| 15 | `u16` | Dominant frequency | Dominant frequency in Hz |
| 17 | `u8` | Quality | Signal-quality score, 0-100 |
| 18 | `u8` | BPM | Pulse estimate |
| 19 | `u8` | Flags | Contact, PPG, fault, and haptic state |
| 20 | `u8` | SpO₂ | **v2 only.** Uncalibrated saturation estimate, percent |
| 21 | `u8` | Perfusion index | **v2 only.** Optical signal strength reaching the sensor, 0-100 |

### Why the frame is 22 bytes and not 21

A saturation percentage reported without a perfusion-quality companion is not
trustworthy — which is why real pulse oximeters always report both. Perfusion index
is the measure of how much optical signal is actually reaching the sensor, so it is
what qualifies an SpO₂ number. Adding it is what justifies the 22nd byte.

### Backward compatibility

Firmware that has not yet been updated keeps working. A 20-byte v1 frame is parsed
normally and reports **no optical vitals**; a v1 frame that claims version 2 cannot
fabricate them, because a 20-byte frame is structurally incapable of carrying them.
The SpO₂ and heart-rate columns resolve to an em dash with an explanatory tooltip
explaining which of the three reasons applies:

| Reason | Meaning |
| --- | --- |
| `Firmware v1 frame` | The band sent 20 bytes; the field does not exist |
| `PPG not asserted` | Flag bit 1 was clear, so optical values are not admissible |
| `Out of range` | The value fell outside its plausibility bounds and was discarded |

This is the honest cost of putting SpO₂ in the wire format rather than simulating
it in the browser: **the column reads as unavailable until the band asserts
`FLAG_PPG_VALID`.** The reference firmware sends v2 frames when the peer MTU permits
and asserts the flag only when its optical validity gates pass; a 20-byte v1
fallback intentionally omits optical fields. The guided demo emits v2, so the column
is fully populated on stage.

### Flags

| Bit | Meaning |
| --- | --- |
| 0 | Sensor contact present |
| 1 | PPG value valid |
| 2 | Device fault detected |
| 3 | Haptic feedback available |

### Control packet

Control packets are two bytes:

```text
[2, command]
```

The reference firmware also accepts a `1` in the first byte so older clients keep
working; the command is always the second byte.

| Command | Meaning |
| --- | --- |
| `1` | Pulse haptic feedback |
| `2` | Stop haptic feedback |

Keeping the contract compact makes it easier to replace the physical wearable, replay synthetic telemetry, or migrate from an ESP32 prototype to a lower-power BLE platform.

---

## 9. Signal-processing and decision logic

The prototype focuses on derived features rather than raw-audio storage.

### Feature representation

The central demonstration feature is a flow-pattern ratio:

```text
flow-pattern ratio = high-band acoustic power / low-band acoustic power
```

This ratio is not a diagnosis. It is a compact way to demonstrate how changes in the distribution of acoustic energy could be tracked over time.

The telemetry also includes:

- Acoustic amplitude.
- Dominant frequency.
- Pulse rate estimate.
- Signal quality.
- Sensor-contact state.
- Device-fault state.

### Firmware signal chain

The reference band does the signal processing on-device, so the browser receives
features rather than raw audio (see [`esp-firm/README.md`](esp-firm/README.md)):

- **Acoustic:** 4 kHz sampling → 256 ms Hann-windowed 1,024-point FFT → 50-200 Hz and
  300-800 Hz band powers, a 900-1,800 Hz noise reference, and an interpolated
  dominant peak. Quality combines spectral SNR, in-band concentration, and signal
  level; clipping and a stuck ADC are penalised explicitly.
- **Optical:** 50 Hz Red+IR FIFO → 6 s window → DC/AC separation → peak-to-peak
  perfusion index, R-ratio SpO₂, and autocorrelation pulse rate. SpO₂ and perfusion
  are asserted when the DC, AC and perfusion gates pass; heart rate is sent only when
  autocorrelation confidence also passes, otherwise the browser resolves it to null.
- **Perfusion judgment:** a weak absolute PI (below 1 %) is always flagged, but at
  normal levels the app compares PI with the person's own optical baseline, so a
  naturally modest perfusion is not treated as an anomaly.
- **Cadence:** one frame per second, which is what the browser's 60-reading,
  60-second recheck expects.

Perfusion index uses the clinical peak-to-peak convention (`100 × AC pp / DC`), which
is why the display bands put weak below 1 %, fair at 1-3 %, and strong at 3 % or more.
The demo generator uses the same scale.

### Baseline

During calibration, VFM collects quality-checked readings and calculates a personal reference value. The interface exposes that baseline so the judge can see that the system is not operating as a black box.

### Trigger and recheck

The intended decision flow is:

```text
New reading
   │
   ├─ Poor contact / poor quality? ── yes ──> placement guidance; do not escalate
   │
   ▼
Compare with personal baseline
   │
   ├─ Within expected range? ── yes ──> continue monitoring
   │
   ▼
Start secondary check
   │
   ├─ Change disappears? ── yes ──> classify as transient and clear
   │
   ▼
Persistent change
   │
   ├─ Show evidence and haptic prompt
   ├─ Start acknowledgement timer
   └─ Record simulated escalation event if not acknowledged
```

This two-stage approach is the core safety-oriented product idea: **do not turn one noisy reading into a high-stakes notification.**

---

## 10. Hackathon demonstration script

### Demo setup

Use a closed-loop flow rig:

- Clear silicone tubing.
- Small 5V water pump.
- Water reservoir.
- Contact acoustic sensor strapped to the tubing.
- Optional ESP32 telemetry transmitter (reference firmware in `esp-firm/`).
- Laptop for the local server.
- Android phone running Chrome for Web Bluetooth.

The rig is a visual and acoustic analogy for changing flow. It is not a biological model and must be described that way.

### Three-minute presentation flow

#### 1. Start in stable flow

Say:

> “First, VFM learns what normal looks like for this sensor placement and this simulated access. We are building a personal baseline, not using a universal number.”

Show:

- Connected band.
- Calibration progress.
- Stable trend.
- Good signal quality.

#### 2. Create a transient disturbance

Briefly move or loosen the sensor.

Say:

> “A real monitoring system must distinguish a meaningful pattern from movement or poor contact. This first disturbance should be treated as uncertain, not immediately escalated.”

Show:

- Signal-quality change.
- Placement guidance.
- No persistent alert.

#### 3. Create a persistent flow-pattern change

Gently pinch the silicone tube or switch the guided demo to persistent change.

Say:

> “Now the change persists across the secondary check. VFM explains what changed relative to baseline, gives the user a clear prompt, and starts a simulated acknowledgement timer.”

Show:

- Flow-pattern ratio shift.
- Baseline comparison.
- Second-check confirmation.
- Haptic or haptic simulation.
- Alert dialog.
- Audit record or simulated delivery receipt.

#### 4. Close with the boundary

Say:

> “This prototype demonstrates the product interaction and architecture. It does not diagnose stenosis, contact emergency services, or claim clinical validation. The next step is validation with clinicians, controlled data, and regulated hardware.”

---

## 11. Why the prototype uses synthetic data

Real AV-fistula telemetry is difficult to obtain because it involves clinical populations, privacy constraints, institutional approvals, and specialized acquisition protocols. The hackathon MVP therefore uses:

- A physical water-flow rig for an intuitive live demonstration.
- Guided synthetic scenarios for reliable presentation.
- Personalized baseline deltas instead of claiming a clinically validated universal cutoff.
- Derived feature telemetry instead of storing raw audio.

This is a deliberate engineering choice, not a hidden limitation. The architecture is designed so validated clinical data and clinician-reviewed models can be introduced later without rebuilding the user experience from scratch.

A strong judge-facing answer is:

> “We are proving the closed-loop interaction and explainable baseline architecture first. Clinical thresholds require controlled studies and regulatory work, so this version uses synthetic perturbation profiles and a physical flow rig rather than pretending hackathon data is clinical evidence.”

---

## 12. Safety, privacy, and responsible scope

### What VFM does

- Detects changes in derived flow-pattern features.
- Checks signal quality and sensor contact.
- Rechecks a suspected change before escalating.
- Explains the evidence shown in the interface.
- Records simulated alert events for auditability.

### What VFM does not do

- Diagnose stenosis, thrombosis, infection, or any other condition.
- Replace a clinician or a dialysis-center assessment.
- Provide emergency response.
- Store or analyze raw audio in the current prototype.
- Claim that an alert is clinically validated.
- Guarantee that a normal result means the access is healthy.

### Privacy principles

- Derived features are preferred over raw audio.
- Local browser storage is used for the monitoring profile and demo state.
- The default server notification mode is simulated.
- No real message is sent unless an operator deliberately configures a separate provider.
- The UI identifies the prototype boundary directly rather than hiding it in technical documentation.

---

## 13. Running the prototype locally

### Requirements

- Node.js 20 or newer.
- A modern browser.
- Android Chrome for Web Bluetooth testing.
- Optional `cloudflared` installation for HTTPS tunneling.

### Start the local server

```bash
npm install
npm start
```

Then open:

```text
http://127.0.0.1:3000
```

The server serves `AVF.html` as the application entry point. There is no install
step: the single third-party dependency is committed under `assets/vendor/`.

> Open the URL above, not `AVF.html` directly. The health check and receipt API are
> served by `server.mjs`; without it the footer correctly reports "Receipt service
> unreachable" and alert delivery is recorded on this device only.

### Run the protocol tests

```bash
npm test
```

`test/packet.test.mjs` covers the v1/v2 decode and encode paths, the PPG-valid
gating, plausibility-bound rejection, malformed-frame handling, and the admissibility
gate. It imports the production decoder directly and needs no browser.

### Android Chrome and Web Bluetooth

Web Bluetooth requires a secure context for phone testing. From the development machine, run:

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

Open the generated HTTPS address on Android Chrome.

### Development mode

```bash
npm run dev
```

The development script runs the Node server with file watching enabled.

### Demo-only notification mode

The default mode is already safe for presentations:

```text
VFM_NOTIFICATION_MODE=demo
```

The server returns a simulated delivery receipt and appends an audit event to `data/alert-audit.ndjson`.

A Twilio mode is available as an integration seam, but it requires server-side environment variables and should only be used in a controlled, non-clinical test environment:

```text
VFM_NOTIFICATION_MODE=twilio
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM=...
TWILIO_TO=...
```

Never expose provider credentials in browser code or commit them to the repository.

---

## 14. Repository structure

```text
.
├── AVF.html                     # App shell and the five views
├── assets/
│   ├── vfm.css                  # Design system: tokens, components, responsive, print
│   ├── js/
│   │   ├── main.js              # App controller: ingest, calibration, recheck, alert
│   │   ├── ble.js               # v1/v2 packet decode + encode, Web Bluetooth
│   │   ├── engine.js            # Baseline learning, classification, reading projection
│   │   ├── store.js             # IndexedDB persistence
│   │   ├── theme.js             # Dual palette, motion budget
│   │   ├── views.js             # Hash router
│   │   ├── vitals.js            # Primary readout quartet + pulse ring
│   │   ├── readings-table.js    # Sortable/filterable/paginated reading log
│   │   ├── signals.js           # Spectral balance, perfusion gauge, device flags
│   │   ├── events.js            # Activity seismograph + audit log
│   │   ├── demo.js              # Scenario definitions and synthetic packet generator
│   │   ├── alert.js             # Escalation dialog and countdown
│   │   ├── format.js            # Shared formatting and clinical display bands
│   │   ├── charts/              # scope, sparkline, seismograph
│   │   └── ui/                  # odometer, decode-scramble, toast
│   └── vendor/                  # Third-party code, committed — see vendor/README.md
├── server.mjs                   # Static server, health endpoint, alert audit API
├── test/packet.test.mjs         # Protocol unit tests
├── esp-firm/
│   ├── esp-firm.ino             # ESP32 acoustic FFT + MAX30102 telemetry firmware
│   └── README.md                # Wiring, build, DSP/optical algorithms, troubleshooting
├── package.json                 # Node metadata and start/dev/test scripts
└── data/alert-audit.ndjson      # Generated local audit output; not clinical data
```

There is no build step and no `npm install`. Native ES modules are served directly,
and the single third-party dependency is committed under `assets/vendor/`.

The firmware is a standard Arduino sketch in `esp-firm/` and is built separately; it
needs the ESP32 core and the SparkFun MAX3010x library. The browser and server remain
usable on their own, because everything above the BLE contract is protocol-driven and
the guided demo replays real v2 frames through the same decoder.

---

## 15. API surface

The local server exposes a deliberately small API.

### Health check

```http
GET /api/health
```

Returns server status and the active notification mode.

### Create an alert event

```http
POST /api/alerts
Content-Type: application/json
```

The server normalizes the alert, invokes the configured notification provider, stores the in-memory event, and appends an audit record.

The normalized evidence object carries the acoustic measurements **and** the optical
ones, so an audit record explains a saturation alert as well as a flow-ratio alert:

```json
{
  "evidence": {
    "ratio": 1.493,
    "baseline": 1.245,
    "deltaPercent": 19.9,
    "amplitudeDeltaPercent": -15.6,
    "dominantFrequencyHz": 485,
    "spo2": 93,
    "bpm": 88,
    "perfusionIndex": 6,
    "quality": 91
  }
}
```

Absent optical values are normalized to `null` rather than omitted or zeroed.

### Acknowledge an alert

```http
POST /api/alerts/{id}/acknowledge
```

Appends an acknowledgement event with a timestamp. In the demo, this represents the user responding before the safety timer expires.

The server also applies basic safety controls such as JSON size limits, input normalization, security headers, and path traversal protection.

---

## 16. Production roadmap

### Phase 1 — Prototype reliability

- ~~Include and validate reference ESP32 firmware.~~ Reference firmware is included in
  `esp-firm/`; hardware validation on a physical band is still pending.
- Add deterministic telemetry replay tests.
- Improve BLE reconnect behavior and packet-loss handling.
- Add automated tests for baseline and recheck logic.
- Make all alert timing behavior configurable and testable.

### Phase 2 — Signal and hardware validation

- Compare sensor placements and acoustic coupling methods.
- Characterize pump, tubing, motion, and environmental noise.
- Evaluate battery life and enclosure ergonomics.
- Validate feature stability across devices and users.
- Conduct clinician-reviewed data collection under an approved protocol.

### Phase 3 — Clinical and regulatory pathway

- Define intended use and risk controls.
- Establish validated endpoints and performance metrics.
- Perform prospective clinical evaluation.
- Replace heuristic thresholds with clinically justified models.
- Implement secure identity, consent, retention, access control, and audit policies.
- Determine the applicable regulatory classification before making clinical claims.

### Production hardware direction

The hackathon ESP32 can be replaced with a lower-power BLE SoC such as an nRF52/nRF52840-class platform. The future form factor could use a compact, hypoallergenic elastomer band with controlled sensor contact and a dedicated charging and diagnostics workflow.

---

## 17. Judge questions and strong answers

### “Is this diagnosing stenosis?”

No. The current prototype detects and explains a persistent change in derived signal features relative to a personal baseline. It is a decision-support demonstration, not a diagnostic device.

### “Why not use a fixed threshold?”

A fixed threshold may not generalize across people, access sites, sensor placement, or hardware. A personal baseline lets the prototype demonstrate individualized change detection while leaving clinical threshold selection to future validation.

### “Why does the app need a second check?”

Movement, loose placement, and environmental noise can create one-off changes. The second check is a simple, understandable false-positive reduction step before an alert is shown.

### “Why use an ESP32?”

The ESP32 is inexpensive and fast to prototype with because it includes BLE and enough processing for the hackathon hardware. A production design would prioritize power consumption, enclosure integration, sensor validation, and a regulated hardware pathway.

### “Why is there no real clinical dataset?”

Clinical AV-fistula datasets require privacy protections, institutional approvals, and controlled acquisition. The prototype uses synthetic perturbations and a flow rig to prove the interaction without presenting unvalidated data as clinical evidence.

### “Does it message a clinic?”

The default mode does not send real messages. It returns a simulated delivery receipt and writes a local audit event. A server-side notification provider is included as an integration seam, but it is not a production clinical escalation service.

### “What happens if the sensor is poorly placed?”

VFM exposes contact and signal quality, provides placement guidance, and avoids treating low-quality readings as strong evidence. This is one of the reasons the recheck and quality layers are visible in the interface.

### “What is the most important next experiment?”

Collect synchronized, clinician-reviewed recordings across normal flow, controlled perturbations, movement, placement variation, and different hardware conditions. Then measure sensitivity, specificity, false-alert rate, latency, and usability before making any clinical claim.

---

## 18. Success metrics for the next iteration

The next version should be evaluated with explicit engineering and clinical-validation metrics:

- Percentage of readings passing quality checks.
- BLE packet-loss and reconnect rate.
- Calibration completion rate.
- Median detection latency.
- False-alert rate during movement and repositioning.
- Recheck confirmation rate.
- User acknowledgement time.
- Battery life of the wearable.
- Agreement between algorithm output and clinician-reviewed labels.
- Explainability: whether users and judges can identify why an alert occurred.

The goal is not simply to make the interface flash red. The goal is to make the system **reliable, interpretable, privacy-aware, and appropriately cautious**.

---

## 19. Final takeaway

VFM is a compact demonstration of a broader product idea:

> **Use a wearable to make subtle physiological change visible, use a personal baseline to make the signal meaningful, use a recheck to make the alert more responsible, and use clear explanations to keep the human in control.**

The hackathon contribution is not a claim of clinical readiness. It is an end-to-end, privacy-first prototype that makes the path from wearable telemetry to explainable decision support tangible, testable, and ready for the next stage of engineering and clinical validation.

---

## 20. Interface design system

### Colour

Two complete palettes are defined as token sets in `assets/js/theme.js`. Components
never name a colour directly, so the light theme is a token swap rather than a second
stylesheet. Dark is the default; the first visit honours `prefers-color-scheme`, and
the choice persists.

| Token role | Dark | Light | Used for |
| --- | --- | --- | --- |
| `accent` | `#ffb340` | `#a86400` | Signal amber — live trace, calibration, primary action |
| `info` | `#7d9cff` | `#2f4fb8` | Personal baseline, quality bars, low-band energy |
| `nominal` | `#5ee6a8` | `#0f7048` | Within personal range |
| `watch` | `#ffc247` | `#8a5a00` | Drifting, marginal, recheck in progress |
| `alert` | `#ff5c72` | `#c02b45` | Flagged, escalated |

Saturation and perfusion bands follow the display convention used on clinical pulse
oximetry. They are a **display convention, not a diagnosis**.

### Type

A system UI stack, plus a monospace stack with tabular figures for **every measured
value** — ratio, SpO₂, heart rate, perfusion, quality, timestamps, deltas, evidence
rows. Numbers that jitter in width read as unreliable; tabular figures are what
makes a dashboard feel like an instrument rather than a consumer app. The strict CSP
forbids web fonts, so there are no font requests at all.

### Motion

Everything except one vendored utility is hand-built, and all of it is suppressed or
reduced under `prefers-reduced-motion`:

| Effect | Implementation |
| --- | --- |
| Phosphor trace | Canvas polyline with an alpha ramp toward the head plus a short additive glow ghost of the most recent samples |
| Pulse ring | Animation period derived from the measured heart rate — the status cluster breathes at the subject's actual pulse |
| Odometer | Digit strips translated vertically inside masked cells, staggered from the least significant digit, with fixed decimal places |
| Calibration track | `stroke-dashoffset` reveal along a generated ECG-style trace |
| Alert | Sonar rings expanding from the alert origin, plus a depleting countdown ring |
| Decode-scramble | Status labels resolve from a glyph pool on state transitions only |
| Differential bloom | Brief radial glow on value change — never a colour flash |
| View switches | Native View Transitions API, degrading to an instant swap |
| DOM mutations | `@formkit/auto-animate` (MIT, vendored) for event insertion and table re-sort, disabled while rows stream in every second |

### Responsiveness

| Width | Layout |
| --- | --- |
| ≥ 1400 px | Wide container, left rail |
| 900-1399 px | Left rail, single-column content |
| 600-899 px | Bottom tab bar |
| < 600 px | Bottom tab bar; the readings table collapses into stacked label/value records rather than a horizontal scroller, because a sideways-scrolling table on a phone hides the very columns being compared |

### Accessibility

- The readings table is the screen-reader-accessible equivalent of the canvas trace.
- Sortable headers expose `aria-sort`; filters expose `aria-pressed`.
- Operational status is announced once per **phase change**, never on every tick of a
  running clock. The recheck countdown is `aria-hidden` for the same reason.
- The acknowledgement dialog cannot be dismissed with Escape: a pending alert must be
  resolved deliberately.
- The alert states plainly what the acknowledgement window does and does not do.
- After acknowledging or escalating, VFM keeps monitoring and keeps reporting the
  drift, but does not re-alert on the same unresolved change until readings return to
  the personal range. Acknowledging must not start an alert loop.
- Programmatic focus is moved to the new view's heading for assistive technology, but
  only draws a focus ring when navigation is actually keyboard-driven.
- Full keyboard support, visible focus, skip link, landmarks, ≥44 px touch targets,
  and a print stylesheet.

### Content Security Policy

`server.mjs` sends `script-src 'self'; style-src 'self'; connect-src 'self'` with no
`'unsafe-inline'`. Consequences that shape the codebase:

- **No CDN scripts.** Third-party code is vendored under `assets/vendor/`.
- **No inline styles and no `<style>` blocks.** Script-driven styling goes through the
  CSSOM (`el.style` / `setProperty`), which CSP does not govern.
- **No web fonts.**
- `.mjs` is mapped to `text/javascript` in the server's MIME table so the vendored
  ES module can actually be executed.

---

## License and project status

This repository is a hackathon prototype. Review the repository's licensing and contribution files before redistributing or integrating the code into another project.

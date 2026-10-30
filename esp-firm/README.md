# VFM Band — ESP32 reference firmware

Real acoustic and optical processing for the Vascular Flow Monitor prototype. The
sketch samples a contact microphone, computes genuine spectral features with an
on-device FFT, reads a MAX30102 pulse oximeter, and streams the documented 22-byte
v2 telemetry frame to Android Chrome over BLE once per second. If the phone leaves
the ATT MTU at its default, the firmware sends a valid 20-byte v1 fallback instead
of truncating the optical bytes.

This is a student/hackathon prototype. It is **not** a medical device, the SpO₂
estimate is uncalibrated, and nothing here diagnoses anything.

---

## 1. What it does

| Stage | Implementation |
| --- | --- |
| Acoustic capture | 4 kHz timed ADC sampling on GPIO34, 1,024 samples (256 ms) per frame |
| Acoustic analysis | DC removal → Hann window → radix-2 FFT → 50-200 Hz and 300-800 Hz band power, dominant peak with log-parabolic interpolation, SNR against a 900-1800 Hz noise band, quality score |
| Optical capture | MAX30102 Red+IR FIFO at 50 Hz (200 sps, 4-sample average) |
| Optical analysis | 6 s window → DC and AC separation → peak-to-peak perfusion index → R-ratio SpO₂ → autocorrelation pulse rate |
| Transport | 1 Hz BLE notification: 22-byte v2 when peer MTU ≥ 25, otherwise 20-byte v1 fallback |
| Feedback | Optional haptic pulse when `HAPTIC_INSTALLED`, plus contact/fault/PPG flags |

The browser remains the analysis surface. There is no HTTP link between the band and
`server.mjs`.

---

## 2. Hardware

### Bill of materials

- ESP32 DevKit (any ESP32-WROOM board works).
- MAX4466 electret microphone amplifier module (or a piezo contact pickup with a
  comparable amplifier).
- MAX30102 or MAX30105 breakout (I²C, 3.3 V).
- Optional conductive contact pad wired to GPIO5.
- Optional haptic motor plus an NPN transistor/MOSFET driver.

### Wiring

| Signal | ESP32 pin | Notes |
| --- | --- | --- |
| Microphone OUT | GPIO34 | ADC1, input-only; 12-bit, 11 dB attenuation |
| MAX30102 SDA | GPIO21 | 3.3 V logic, 400 kHz I²C |
| MAX30102 SCL | GPIO22 | 3.3 V logic |
| MAX30102 VIN/GND | 3V3 / GND | Do not power the sensor from 5 V |
| Contact pad | GPIO5 | `INPUT_PULLUP`; pad shorts to GND on skin contact |
| Haptic driver | GPIO4 | Through a transistor, never drive the motor directly |

> GPIO5 is an ESP32 strapping pin. Keep the contact pad untouched while the board
> boots; if your pad is shorted at power-up, move `PIN_CONTACT` to a non-strapping pin
> such as GPIO13.

The microphone module output must be biased inside the ADC range. The MAX4466
breakout does this by default; if you use a bare electret, add the usual bias
network and a coupling capacitor.

> The MAX30102 is optional. Without it the firmware runs in acoustic-only mode and
> reports no optical vitals, exactly as the v1 contract does. Detection runs once at
> boot, so if you connect the sensor after power-up, press EN/reset once.

---

## 3. Build and upload

### Arduino IDE

1. Install the **esp32** board package (Boards Manager).
2. Install **SparkFun MAX3010x Pulse and Proximity Sensor Library** (Library Manager).
3. Open `esp-firm/esp-firm.ino`. Arduino requires the folder and sketch names to
   match, which is why the file is not called `esp.ino`.
4. Select **ESP32 Dev Module** and the correct serial port.
5. Upload at 115200 baud and open the Serial Monitor.

### arduino-cli

```powershell
arduino-cli compile --fqbn esp32:esp32:esp32 esp-firm
arduino-cli upload  --fqbn esp32:esp32:esp32 --port COM5 esp-firm
```

The sketch is self-contained apart from the core and the SparkFun library. It uses a
local radix-2 FFT, so there is no DSP dependency to install.

### Expected boot log

```text
==================================================
 VFM Band — ESP32 acoustic FFT + optical vitals
==================================================
[DSP] Running boot self-test...
[SELFTEST] 100 Hz dominant: peak=100 Hz low=... high=... q=... -> PASS
[SELFTEST] 400 Hz dominant: peak=400 Hz low=... high=... q=... -> PASS
[DSP] Self-test PASSED.
[OPT] MAX30102 ready: 50 Hz Red+IR, 6 s optical window.
[BLE] Advertising as VFM-Band. Waiting for a client...
```

The self-test synthesises a 100 Hz-dominant and a 400 Hz-dominant tone and checks the
peak, band balance, and quality. If it fails, the fault flag is set and every packet
is rejected by the browser, so a DSP regression cannot silently produce plausible
wrong numbers.

---

## 4. Acoustic processing

| Parameter | Value |
| --- | --- |
| Sample rate | 4,000 Hz nominal, measured from `micros()` every window |
| Window | 1,024 samples = 256 ms |
| Window function | Hann |
| Transform | In-place iterative radix-2 Cooley-Tukey FFT |
| Low band | 50-200 Hz |
| High band | 300-800 Hz |
| Noise band | 900-1,800 Hz |
| Frame cadence | 1 Hz, advanced from the previous frame boundary |

Band powers are normalised by the total power from bin 1 to Nyquist, so the values on
the wire are fractions that sum to at most 1. A small floor (`0.005`) prevents a
silent band from producing a zero baseline ratio.

The dominant frequency is searched only inside the two diagnostic bands, then refined
with log-parabolic interpolation around the peak bin, giving sub-bin resolution
(≈3.9 Hz per bin at 4 kHz / 1,024).

### Quality score

```text
snrScore  = clamp(snrDb / 18, 0, 1)
bandScore = clamp((inBandFraction - 0.30) / 0.55, 0, 1)
levelScore= clamp((rmsDbfs + 60) / 35, 0, 1)

quality = 100 * (0.40*snrScore + 0.30*bandScore + 0.30*levelScore)
```

`inBandFraction` is the share of non-DC power that lands in the two diagnostic bands.
Heavy clipping halves the score, extreme clipping zeroes it, and a stuck ADC (range
below 3 counts) is reported as a fault.

The browser discards anything below quality 70, so 70 is the practical floor for a
usable acoustic frame.

### Timing notes

Sampling is a busy-wait on `micros()` at 250 µs intervals. That is accurate enough
for a 4 kHz analysis and keeps the sketch dependency-free, but it blocks for 256 ms
per frame. The optical FIFO is drained immediately before and after the capture so no
pulse samples are lost. If the loop cannot keep up, the sketch resynchronises instead
of emitting a burst of late samples, and the measured sample rate is reported so the
band edges stay correct.

---

## 5. Optical processing

The firmware talks to the MAX30102 directly for FIFO reads because the SparkFun
library exposes configuration and raw samples, not heart-rate or SpO₂ functions.

| Parameter | Value |
| --- | --- |
| LED current | 13 mA (`0x41`) |
| Sample averaging | 4 |
| Mode | Red + IR |
| Sensor sample rate | 200 sps → 50 Hz FIFO records |
| Pulse width | 411 µs |
| ADC range | 4,096 nA |
| Analysis window | 300 samples = 6 s |
| Minimum window | 250 samples = 5 s |

### Perfusion index

```text
PI = 100 * (IR AC peak-to-peak) / (IR DC)
```

This is the clinical peak-to-peak convention, which is what the website's Weak /
Fair / Strong bands assume. The AC component is taken after a 0.5 Hz one-pole
high-pass that removes DC and slow drift. RMS AC would read about three times lower
and make every real reading look like poor perfusion, so it is used only for the
SpO₂ ratio, where the convention cancels.

The browser flags a PI below 1 % outright; at higher levels it compares PI with the
person's learned optical baseline, so someone whose normal perfusion is modest is not
permanently "weak".

### SpO₂

```text
R    = (AC_red / DC_red) / (AC_ir / DC_ir)
SpO₂ = -45.060 R² + 30.354 R + 94.845   (clamped to 50-100)
```

This is the widely used uncalibrated Maxim curve. It is a demonstration estimate, not
a calibrated measurement.

### Pulse rate

Autocorrelation over lags 14-100 (≈214-30 bpm at 50 Hz), with parabolic interpolation
around the chosen lag. Autocorrelation peaks at every multiple of the pulse period, so
the firmware prefers the **earliest** local maximum that is above 0.5 and within 80 %
of the global peak; otherwise a strong harmonic could halve the reported heart rate.
A correlation floor of 0.35 rejects motion and noise.

### Validity gates

SpO₂ and perfusion are sent when these optical gates hold:

- IR DC and Red DC are at least 5,000 counts (something is actually against the
  sensor).
- Both AC channels are above 1 count RMS.
- Peak-to-peak perfusion index is at least 0.3 %.

Heart rate is computed independently by autocorrelation. It is sent only when
confidence is at least 0.35 and the resulting rate is 30-220 bpm; otherwise `bpm`
is sent as `0`, which the browser resolves to `null`, while SpO₂ and PI remain
available.

If the optical gates fail, `FLAG_PPG_VALID` is clear and the browser resolves SpO₂,
heart rate and perfusion to `null`. The perfusion byte is sent as `255`, which the
decoder rejects as out-of-range, so "no optical data" can never be misread as 0 %
perfusion.

Optical samples older than 2 s are discarded, so removing the sensor clears the
readout instead of freezing the last value.

---

## 6. Contact, faults, and haptics

### Contact

`FLAG_CONTACT` is set when either:

- the GPIO5 pad reads low (only when `CONTACT_PAD_INSTALLED` is true), or
- the optical sensor reports a valid DC level and at least 0.3 % perfusion (`OPTICAL_PI_MIN`), or
- acoustic quality is at least 70.

The fallback exists because the pad and the optical sensor are both optional, and a
microphone strapped to tubing still produces a usable acoustic signal. This build
sets `CONTACT_PAD_INSTALLED = false` because no pad is fitted, so contact is the
acoustic/optical signal-presence proxy. To require the physical pad only, set:

```cpp
static const bool CONTACT_PAD_INSTALLED = true;
static const bool CONTACT_FALLBACK_ENABLED = false;
```

### Fault

`FLAG_FAULT` is set when the boot self-test failed or the ADC is stuck. The browser
then refuses the reading rather than treating it as evidence.

### Haptics

The control characteristic accepts `[version, command]` where the version byte may be
`1` or `2`:

| Command | Effect |
| --- | --- |
| `1` | Drive GPIO4 high for 350 ms (only when `HAPTIC_INSTALLED` is true) |
| `2` | Stop immediately |

Disconnecting the client also stops the motor, so a lost phone cannot leave the band
buzzing. `FLAG_HAPTIC` is advertised only when `HAPTIC_INSTALLED` is true. This
build sets it to `false` because no motor is fitted, so the browser never sends
haptic commands.

---

## 7. BLE details

| Item | Value |
| --- | --- |
| Advertising name | `VFM-Band` |
| Service | `3e5f0001-4c95-4b1a-9b35-9f31c2608c01` |
| Telemetry (notify) | `3e5f0002-4c95-4b1a-9b35-9f31c2608c01` |
| Control (write) | `3e5f0003-4c95-4b1a-9b35-9f31c2608c01` |
| Frame | 22-byte v2 when peer MTU ≥ 25; 20-byte v1 fallback otherwise; little-endian, 1 Hz |

The sketch calls `BLEDevice::setMTU(64)` after `BLEDevice::init()`. That only sets the
local preference; the phone controls the negotiated ATT MTU. The default MTU of 23
bytes yields a 20-byte notification payload, so the firmware tracks the peer MTU and
sends the full 22-byte v2 frame only when the peer negotiated at least 25 bytes.
Otherwise it sends a valid 20-byte v1-shaped frame (version byte `1`) with the
acoustic fields, heart rate, flags, and contact status, and omits the last two
optical bytes. The serial log prints the actual MTU and which frame is in use.

The 1 Hz cadence is deliberate. The browser's 60-second recheck expects about 60
readings per minute, and a 256 ms acoustic capture must not stretch that interval.
Compile-time `static_assert`s pin the packet size and every field offset, so a
reordering mistake fails the build instead of corrupting the wire format.

---

## 8. Serial diagnostics

One line per frame:

```text
[VFM] seq=42 fs=3998 low=0.712 high=0.288 ratio=0.404 peak=118Hz q=88 amp=24.6mV contact=1 ppg=1 bpm=74 spo2=97 pi=3
```

Each frame with valid optical vitals also logs:

```text
[OPT] dcIR=58210 dcRed=41120 pi=3.18 corr=0.71 samples=300
```

Rare but useful:

```text
[ADC] 37 late sample deadlines; measured fs=3874.2 Hz
[OPT] FIFO overflow (3); optical window reset.
[OPT] MAX30102 not detected. Acoustic-only mode.
```

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Browser never finds `VFM-Band` | Band not powered, already connected to another device, or Web Bluetooth is not available (Android Chrome over HTTPS is required) |
| `[OPT] MAX30102 not detected` | Check 3.3 V, SDA/SCL, and pull-ups; run an I²C scanner at address `0x57` |
| SpO₂ and heart rate stay empty | No finger/tubing contact, PI below 0.3 %, correlation below 0.35, or a 20-byte v1 fallback because the peer MTU stayed below 25; check `dcIR`, `pi`, and the `[BLE] MTU` log |
| Every reading is rejected | Look for `FLAG_FAULT`: DSP self-test failure or stuck ADC. Quality below 70, or contact false, also rejects a frame |
| Quality is low but the trace looks fine | Signal level below roughly 2 mV RMS, or energy outside the 50-800 Hz diagnostic bands; raise microphone gain or improve coupling |
| Perfusion reads very low | Normal on a wrist or tubing compared with a fingertip; the Weak band starts below 1 % |
| Optical fields are missing from the website | Peer MTU is below 25, so the firmware is deliberately sending the 20-byte v1 fallback; the serial log shows the actual MTU |
| Heart rate reads about half or double | Autocorrelation ambiguity; the firmware prefers the earliest strong peak, but very clean synthetic waveforms can still confuse it |
| `[OPT] FIFO overflow` repeatedly | The loop is blocked too long (serial flooding, Wi-Fi, long BLE writes); reduce logging and keep the main loop short |

---

## 10. Safety and scope

- SpO₂ is computed with an uncalibrated curve and is not suitable for any clinical
  decision.
- The acoustic bands are chosen to make flow-pattern changes visible in a demo, not
  to characterise a real fistula.
- No raw audio is stored or transmitted; only derived features leave the device.
- The band is a prototype. Do not use it for monitoring a person.

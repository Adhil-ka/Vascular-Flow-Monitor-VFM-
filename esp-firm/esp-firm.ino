/*
 * Vascular Flow Monitor (VFM) — ESP32 reference firmware
 * ------------------------------------------------------
 * This sketch turns an ESP32 into the VFM band:
 *
 *   - MAX4466 electret microphone on GPIO34 (ADC1)
 *   - MAX30102 / MAX30105 optical sensor on I2C GPIO21/22
 *   - conductive contact pad on GPIO5 (active low, optional)
 *   - haptic motor driver on GPIO4 (through a transistor, never directly)
 *
 * It sends one 22-byte v2 telemetry frame per second to the browser over BLE when
 * the peer MTU is at least 25 bytes; otherwise it sends a valid 20-byte v1 frame
 * so the optical fields are omitted rather than silently truncated.
 * The browser is the analysis surface; there is no HTTP link to server.mjs.
 *
 * Acoustic chain:
 *   4 kHz timed sampling -> 1,024 samples (256 ms) -> DC removal -> Hann
 *   -> radix-2 FFT -> 50-200 Hz and 300-800 Hz band powers -> dominant peak
 *   -> quality score.
 *
 * Optical chain:
 *   MAX30102 Red+IR FIFO at 50 Hz -> 6 s window -> DC/AC separation
 *   -> peak-to-peak perfusion index -> R-ratio SpO2 estimate
 *   -> autocorrelation pulse rate.
 *
 * The SpO2 value is an uncalibrated demonstration estimate. This is not a
 * medical device and the firmware does not diagnose anything.
 */

#include <Arduino.h>
#include <Wire.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <MAX30105.h>
#include <math.h>
#include <stddef.h>

// ---------------------------------------------------------------------------
// 1. Hardware configuration
// ---------------------------------------------------------------------------

static const uint8_t PIN_ACOUSTIC = 34;  // MAX4466 OUT, ADC1 input-only pin
static const uint8_t PIN_HAPTIC = 4;     // optional transistor gate/base; not fitted
static const uint8_t PIN_CONTACT = 5;    // optional conductive pad to GND; not fitted
static const uint8_t PIN_I2C_SDA = 21;
static const uint8_t PIN_I2C_SCL = 22;

static const uint8_t MAX30102_I2C_ADDRESS = 0x57;
static const uint8_t REG_FIFO_WRITE_PTR = 0x04;
static const uint8_t REG_FIFO_OVERFLOW = 0x05;
static const uint8_t REG_FIFO_READ_PTR = 0x06;
static const uint8_t REG_FIFO_DATA = 0x07;

// ---------------------------------------------------------------------------
// 2. VFM BLE contract
// ---------------------------------------------------------------------------

static const char *const SERVICE_UUID = "3e5f0001-4c95-4b1a-9b35-9f31c2608c01";
static const char *const TELEMETRY_UUID = "3e5f0002-4c95-4b1a-9b35-9f31c2608c01";
static const char *const CONTROL_UUID = "3e5f0003-4c95-4b1a-9b35-9f31c2608c01";

static const uint8_t PROTOCOL_VERSION = 2;

enum FlagBits : uint8_t {
  FLAG_CONTACT = 0x01,
  FLAG_PPG_VALID = 0x02,
  FLAG_FAULT = 0x04,
  FLAG_HAPTIC = 0x08
};

enum ControlCommand : uint8_t {
  CONTROL_HAPTIC_PULSE = 1,
  CONTROL_HAPTIC_STOP = 2
};

// Exact little-endian v2 frame. The static assertions below protect the wire
// format from accidental field reordering or padding.
#pragma pack(push, 1)
struct VFMTelemetryPacket {
  uint8_t version;              // 0
  uint16_t sequence;            // 1
  float lowBandPower;           // 3
  float highBandPower;          // 7
  float amplitude;              // 11
  uint16_t dominantFrequencyHz; // 15
  uint8_t quality;              // 17
  uint8_t bpm;                  // 18
  uint8_t flags;                // 19
  uint8_t spo2;                 // 20
  uint8_t perfusionIndex;       // 21
};
#pragma pack(pop)

static_assert(sizeof(VFMTelemetryPacket) == 22, "VFM v2 frame must be exactly 22 bytes");
static_assert(offsetof(VFMTelemetryPacket, version) == 0, "version offset");
static_assert(offsetof(VFMTelemetryPacket, sequence) == 1, "sequence offset");
static_assert(offsetof(VFMTelemetryPacket, lowBandPower) == 3, "lowBandPower offset");
static_assert(offsetof(VFMTelemetryPacket, highBandPower) == 7, "highBandPower offset");
static_assert(offsetof(VFMTelemetryPacket, amplitude) == 11, "amplitude offset");
static_assert(offsetof(VFMTelemetryPacket, dominantFrequencyHz) == 15, "dominantFrequencyHz offset");
static_assert(offsetof(VFMTelemetryPacket, quality) == 17, "quality offset");
static_assert(offsetof(VFMTelemetryPacket, bpm) == 18, "bpm offset");
static_assert(offsetof(VFMTelemetryPacket, flags) == 19, "flags offset");
static_assert(offsetof(VFMTelemetryPacket, spo2) == 20, "spo2 offset");
static_assert(offsetof(VFMTelemetryPacket, perfusionIndex) == 21, "perfusionIndex offset");

// ---------------------------------------------------------------------------
// 3. DSP and timing constants
// ---------------------------------------------------------------------------

static const uint16_t FFT_SIZE = 1024;
static const float ACOUSTIC_SAMPLE_RATE_HZ = 4000.0f;
static const uint32_t ACOUSTIC_SAMPLE_PERIOD_US = 1000000UL / 4000UL; // 250 us
static_assert((FFT_SIZE & (FFT_SIZE - 1)) == 0, "FFT_SIZE must be a power of two");

static const float LOW_BAND_START_HZ = 50.0f;
static const float LOW_BAND_END_HZ = 200.0f;
static const float HIGH_BAND_START_HZ = 300.0f;
static const float HIGH_BAND_END_HZ = 800.0f;
static const float NOISE_BAND_START_HZ = 900.0f;
static const float NOISE_BAND_END_HZ = 1800.0f;

// A small floor keeps a numerically empty band from creating a zero baseline
// ratio, which would make every later reading look anomalous.
static const float BAND_POWER_FLOOR = 0.005f;
static const uint8_t QUALITY_MINIMUM = 70;

static const uint32_t FRAME_INTERVAL_MS = 1000;
static const uint32_t OPTICAL_POLL_INTERVAL_MS = 100;

// MAX30102 acquisition. Four-sample averaging at 200 sps produces 50 FIFO
// records per second, each carrying one Red and one IR sample.
static const uint16_t MAX30102_SAMPLE_RATE_HZ = 200;
static const uint8_t MAX30102_SAMPLE_AVERAGE = 4;
static const float OPTICAL_SAMPLE_RATE_HZ =
    (float)MAX30102_SAMPLE_RATE_HZ / (float)MAX30102_SAMPLE_AVERAGE;
static_assert(MAX30102_SAMPLE_RATE_HZ % MAX30102_SAMPLE_AVERAGE == 0,
              "MAX30102 sample rate must be an integer multiple of averaging");
static_assert(MAX30102_SAMPLE_RATE_HZ / MAX30102_SAMPLE_AVERAGE == 50,
              "Optical DSP assumes 50 FIFO records per second");

static const uint16_t OPTICAL_WINDOW_SAMPLES = 300; // 6 seconds at 50 Hz
static const uint16_t OPTICAL_MIN_PPG_SAMPLES = 250; // 5 seconds
static const uint16_t OPTICAL_MIN_LAG = 14;          // ~214 bpm at 50 Hz
static const uint16_t OPTICAL_MAX_LAG = 100;         // 30 bpm at 50 Hz
static const float OPTICAL_DC_MIN = 50000.0f;         // dark / no finger below this
static const float OPTICAL_AC_MIN = 1.5f;
static const float OPTICAL_PI_MIN = 0.5f;
static const float OPTICAL_CORRELATION_MIN = 0.40f;
static const uint32_t OPTICAL_STALE_MS = 2000;
static const uint8_t OPTICAL_NOT_AVAILABLE = 255;

static const uint16_t HAPTIC_PULSE_MS = 350;

// This build has no contact pad and no haptic motor fitted.
// Contact therefore means "a usable acoustic or optical signal is present",
// not "skin is touching a pad". Keep the fallback enabled so the website will
// admit readings from the microphone/optical sensor alone.
static const bool CONTACT_PAD_INSTALLED = false;
static const bool CONTACT_FALLBACK_ENABLED = true;
static const bool HAPTIC_INSTALLED = false;

static const float VFM_TWO_PI = 6.283185307179586f;

// ---------------------------------------------------------------------------
// 4. Global state
// ---------------------------------------------------------------------------

BLEServer *bleServer = nullptr;
BLECharacteristic *telemetryCharacteristic = nullptr;
BLECharacteristic *controlCharacteristic = nullptr;

volatile bool deviceConnected = false;
volatile bool telemetryV2Enabled = false;
volatile uint8_t requestedHapticCommand = 0;

bool hapticActive = false;
uint32_t hapticStartedMs = 0;
uint16_t packetSequence = 0;
bool opticalPpgStable = false;
bool opticalPpgStablePrev = false;

MAX30105 particleSensor;
bool max30102Ready = false;
bool dspSelfTestPassed = false;

uint16_t acousticSamples[FFT_SIZE];
float fftReal[FFT_SIZE];
float fftImag[FFT_SIZE];
float hannWindow[FFT_SIZE];

struct OpticalRing {
  uint32_t red[OPTICAL_WINDOW_SAMPLES];
  uint32_t ir[OPTICAL_WINDOW_SAMPLES];
  uint16_t head;
  uint16_t count;
};

OpticalRing opticalRing = {};
float opticalRed[OPTICAL_WINDOW_SAMPLES];
float opticalIr[OPTICAL_WINDOW_SAMPLES];
float opticalRedFiltered[OPTICAL_WINDOW_SAMPLES];
float opticalIrFiltered[OPTICAL_WINDOW_SAMPLES];
float opticalCorrelations[OPTICAL_MAX_LAG + 2];

uint32_t lastOpticalSampleMs = 0;
uint32_t lastOpticalPollMs = 0;
uint32_t opticalSampleCount = 0;
uint32_t opticalOverflowCount = 0;
uint32_t lastReportedOpticalOverflowCount = 0;

uint32_t lastFrameMs = 0;

// Result types are declared before the first function so the Arduino
// auto-prototype generator can see them when it inserts function prototypes.
struct AcousticFeatures {
  float lowBandPower;
  float highBandPower;
  float amplitudeMillivolts;
  uint16_t dominantFrequencyHz;
  uint8_t quality;
  float sampleRateHz;
  float snrDb;
  float inBandFraction;
  float rmsDbfs;
  uint16_t clippedSamples;
  bool adcStuck;
};

struct OpticalFeatures {
  bool ppgValid;
  uint8_t bpm;
  uint8_t spo2;
  uint8_t perfusionIndex;
  float irDc;
  float redDc;
  float pi;
  float correlation;
  uint16_t sampleCount;
};

// ---------------------------------------------------------------------------
// 5. Small math helpers
// ---------------------------------------------------------------------------

static inline float clampf(float value, float low, float high) {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

static float meanOf(const float *values, uint16_t count) {
  if (count == 0) return 0.0f;
  float sum = 0.0f;
  for (uint16_t i = 0; i < count; i++) sum += values[i];
  return sum / (float)count;
}

static float rmsOf(const float *values, uint16_t count) {
  if (count == 0) return 0.0f;
  float sum = 0.0f;
  for (uint16_t i = 0; i < count; i++) sum += values[i] * values[i];
  return sqrtf(sum / (float)count);
}

// One-pole high-pass. Removes DC and slow optical drift before AC analysis.
static void highPassFilter(const float *input, float *output, uint16_t count,
                           float sampleRateHz, float cutoffHz) {
  if (count == 0) return;
  const float alpha = expf(-VFM_TWO_PI * cutoffHz / sampleRateHz);
  float previousInput = input[0];
  float previousOutput = 0.0f;
  for (uint16_t i = 0; i < count; i++) {
    float x = input[i];
    float y = alpha * (previousOutput + x - previousInput);
    output[i] = y;
    previousInput = x;
    previousOutput = y;
  }
}

// ---------------------------------------------------------------------------
// 6. Acoustic FFT and feature extraction
// ---------------------------------------------------------------------------

void initDsp() {
  for (uint16_t i = 0; i < FFT_SIZE; i++) {
    hannWindow[i] = 0.5f * (1.0f - cosf(VFM_TWO_PI * (float)i / (float)(FFT_SIZE - 1)));
  }
}

// In-place iterative radix-2 Cooley-Tukey FFT.
void fftRadix2(float *real, float *imag, uint16_t n) {
  // Bit-reversal permutation.
  for (uint16_t i = 1, j = 0; i < n; i++) {
    uint16_t bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      float tempReal = real[i];
      real[i] = real[j];
      real[j] = tempReal;
      float tempImag = imag[i];
      imag[i] = imag[j];
      imag[j] = tempImag;
    }
  }

  // Butterfly stages.
  for (uint16_t len = 2; len <= n; len <<= 1) {
    float angle = -VFM_TWO_PI / (float)len;
    float wLengthReal = cosf(angle);
    float wLengthImag = sinf(angle);

    for (uint16_t start = 0; start < n; start += len) {
      float wReal = 1.0f;
      float wImag = 0.0f;

      for (uint16_t j = 0; j < len / 2; j++) {
        uint16_t a = start + j;
        uint16_t b = a + len / 2;

        float uReal = real[a];
        float uImag = imag[a];
        float vReal = real[b] * wReal - imag[b] * wImag;
        float vImag = real[b] * wImag + imag[b] * wReal;

        real[a] = uReal + vReal;
        imag[a] = uImag + vImag;
        real[b] = uReal - vReal;
        imag[b] = uImag - vImag;

        float nextWReal = wReal * wLengthReal - wImag * wLengthImag;
        wImag = wReal * wLengthImag + wImag * wLengthReal;
        wReal = nextWReal;
      }
    }
  }
}

static inline float fftBinPower(uint16_t bin) {
  return fftReal[bin] * fftReal[bin] + fftImag[bin] * fftImag[bin];
}

AcousticFeatures analyseAcousticWindow(float measuredSampleRateHz) {
  AcousticFeatures features = {};
  features.sampleRateHz = measuredSampleRateHz;

  if (measuredSampleRateHz < 1600.0f) {
    // Below this the 800 Hz high band is too close to Nyquist to be meaningful.
    features.adcStuck = true;
    return features;
  }

  // Mean, range, clipping, and unwindowed RMS.
  float sum = 0.0f;
  uint16_t minimum = 65535;
  uint16_t maximum = 0;
  uint16_t clipped = 0;

  for (uint16_t i = 0; i < FFT_SIZE; i++) {
    uint16_t sample = acousticSamples[i];
    sum += (float)sample;
    if (sample < minimum) minimum = sample;
    if (sample > maximum) maximum = sample;
    if (sample <= 1 || sample >= 4094) clipped++;
  }

  float mean = sum / (float)FFT_SIZE;
  features.adcStuck = (maximum - minimum) < 3;
  features.clippedSamples = clipped;

  float sumSquares = 0.0f;
  for (uint16_t i = 0; i < FFT_SIZE; i++) {
    float centered = (float)acousticSamples[i] - mean;
    sumSquares += centered * centered;
    fftReal[i] = centered * hannWindow[i];
    fftImag[i] = 0.0f;
  }

  float rmsCounts = sqrtf(sumSquares / (float)FFT_SIZE);
  features.amplitudeMillivolts = rmsCounts * (3300.0f / 4095.0f);
  features.rmsDbfs = rmsCounts > 0.001f ? 20.0f * log10f(rmsCounts / 2048.0f) : -120.0f;

  fftRadix2(fftReal, fftImag, FFT_SIZE);

  const float binHz = measuredSampleRateHz / (float)FFT_SIZE;
  const uint16_t maxBin = FFT_SIZE / 2 - 1;

  uint16_t lowStart = (uint16_t)ceilf(LOW_BAND_START_HZ / binHz);
  uint16_t lowEnd = (uint16_t)floorf(LOW_BAND_END_HZ / binHz);
  uint16_t highStart = (uint16_t)ceilf(HIGH_BAND_START_HZ / binHz);
  uint16_t highEnd = (uint16_t)floorf(HIGH_BAND_END_HZ / binHz);
  uint16_t noiseStart = (uint16_t)ceilf(NOISE_BAND_START_HZ / binHz);
  uint16_t noiseEnd = (uint16_t)floorf(NOISE_BAND_END_HZ / binHz);

  if (lowStart < 1) lowStart = 1;
  if (highStart < 1) highStart = 1;
  if (noiseStart < 1) noiseStart = 1;
  if (lowEnd > maxBin) lowEnd = maxBin;
  if (highEnd > maxBin) highEnd = maxBin;
  if (noiseEnd > maxBin) noiseEnd = maxBin;

  if (lowEnd < lowStart) lowEnd = lowStart - 1;
  if (highEnd < highStart) highEnd = highStart - 1;
  if (noiseEnd < noiseStart) {
    noiseStart = highEnd + 1;
    noiseEnd = maxBin;
  }

  float lowPower = 0.0f;
  float highPower = 0.0f;
  float noisePower = 0.0f;
  float totalPower = 0.0f;

  for (uint16_t bin = 1; bin <= maxBin; bin++) {
    float power = fftBinPower(bin);
    totalPower += power;

    if (bin >= lowStart && bin <= lowEnd) lowPower += power;
    if (bin >= highStart && bin <= highEnd) highPower += power;
    if (bin >= noiseStart && bin <= noiseEnd) noisePower += power;
  }

  uint16_t lowBins = lowEnd >= lowStart ? (lowEnd - lowStart + 1) : 0;
  uint16_t highBins = highEnd >= highStart ? (highEnd - highStart + 1) : 0;
  uint16_t noiseBins = noiseEnd >= noiseStart ? (noiseEnd - noiseStart + 1) : 0;

  // The noise reference must exist for the SNR score to mean anything. At a
  // low measured sample rate the 900-1800 Hz band can disappear above Nyquist;
  // be more lenient - use total power as noise reference if needed
  bool spectralBandsUsable = lowBins > 0 && highBins > 0; // allow missing noise band

  float signalPower = lowPower + highPower;
  float signalBins = (float)(lowBins + highBins);
  float signalPsd = signalBins > 0.0f ? signalPower / signalBins : 0.0f;
  float noisePsd = noiseBins > 0 ? noisePower / (float)noiseBins : (totalPower - signalPower > 0 && (maxBin - (lowBins+highBins)) > 0) ? (totalPower - signalPower) / (float)(maxBin - (lowBins+highBins)) : 1e-12f;

  features.snrDb = spectralBandsUsable
                       ? 10.0f * log10f(fmaxf(signalPsd, 1e-20f) / fmaxf(noisePsd, 1e-20f))
                       : 0.0f;
  features.inBandFraction = totalPower > 1e-12f ? signalPower / totalPower : 0.0f;

  if (totalPower > 1e-12f) {
    features.lowBandPower = fmaxf(lowPower / totalPower, BAND_POWER_FLOOR);
    features.highBandPower = fmaxf(highPower / totalPower, BAND_POWER_FLOOR);
  } else {
    features.lowBandPower = BAND_POWER_FLOOR;
    features.highBandPower = BAND_POWER_FLOOR;
  }

  // Dominant in-band peak. Search only the two diagnostic bands so an
  // out-of-band noise peak cannot masquerade as the flow frequency.
  uint16_t peakBin = 0;
  float peakPower = -1.0f;

  for (uint16_t bin = lowStart; bin <= lowEnd; bin++) {
    float power = fftBinPower(bin);
    if (power > peakPower) {
      peakPower = power;
      peakBin = bin;
    }
  }
  for (uint16_t bin = highStart; bin <= highEnd; bin++) {
    float power = fftBinPower(bin);
    if (power > peakPower) {
      peakPower = power;
      peakBin = bin;
    }
  }

  if (peakBin > 1 && peakBin < maxBin) {
    // Log-parabolic interpolation gives sub-bin frequency resolution.
    float left = logf(fmaxf(fftBinPower(peakBin - 1), 1e-20f));
    float centre = logf(fmaxf(fftBinPower(peakBin), 1e-20f));
    float right = logf(fmaxf(fftBinPower(peakBin + 1), 1e-20f));
    float denominator = left - 2.0f * centre + right;

    float delta = 0.0f;
    if (fabsf(denominator) > 1e-9f) {
      delta = 0.5f * (left - right) / denominator;
    }
    delta = clampf(delta, -0.5f, 0.5f);

    float peakHz = ((float)peakBin + delta) * binHz;
    features.dominantFrequencyHz = (uint16_t)clampf(lroundf(peakHz), 0, 65535);
  }

  // Quality combines spectral prominence, in-band concentration, and level.
  float snrScore = clampf(features.snrDb / 18.0f, 0.0f, 1.0f);
  float bandScore = clampf((features.inBandFraction - 0.30f) / 0.55f, 0.0f, 1.0f);
  float levelScore = clampf((features.rmsDbfs + 60.0f) / 35.0f, 0.0f, 1.0f);

  float quality = 100.0f * (0.40f * snrScore + 0.30f * bandScore + 0.30f * levelScore);

  if (features.clippedSamples > FFT_SIZE / 100) quality *= 0.5f;
  if (features.clippedSamples > FFT_SIZE / 10) quality *= 0.3f;
  if (features.adcStuck) quality *= 0.5f;
  if (rmsCounts < 0.3f) quality *= 0.5f;
  if (!spectralBandsUsable) quality *= 0.7f; // don't zero out completely

  features.quality = (uint8_t)clampf(lroundf(quality), 0, 100);
  return features;
}

// ---------------------------------------------------------------------------
// 7. Boot self-test
// ---------------------------------------------------------------------------

bool runDspSelfTest() {
  bool allPassed = true;

  struct TestCase {
    const char *label;
    float lowToneHz;
    float lowToneAmplitude;
    float highToneHz;
    float highToneAmplitude;
    bool expectLowDominant;
  };

  const TestCase tests[] = {
      {"100 Hz dominant", 100.0f, 700.0f, 400.0f, 60.0f, true},
      {"400 Hz dominant", 100.0f, 60.0f, 400.0f, 700.0f, false},
  };

  for (uint8_t testIndex = 0; testIndex < 2; testIndex++) {
    const TestCase &test = tests[testIndex];

    for (uint16_t i = 0; i < FFT_SIZE; i++) {
      float t = (float)i / ACOUSTIC_SAMPLE_RATE_HZ;
      float value = 2048.0f;
      value += test.lowToneAmplitude * sinf(VFM_TWO_PI * test.lowToneHz * t);
      value += test.highToneAmplitude * sinf(VFM_TWO_PI * test.highToneHz * t);
      value += (float)((i * 73) % 11) - 5.0f; // small deterministic dither
      acousticSamples[i] = (uint16_t)clampf(value, 0.0f, 4095.0f);
    }

    AcousticFeatures result = analyseAcousticWindow(ACOUSTIC_SAMPLE_RATE_HZ);

    bool dominantPassed = test.expectLowDominant
                              ? (result.dominantFrequencyHz >= 92 && result.dominantFrequencyHz <= 108)
                              : (result.dominantFrequencyHz >= 392 && result.dominantFrequencyHz <= 408);
    bool balancePassed = test.expectLowDominant
                             ? (result.lowBandPower > result.highBandPower)
                             : (result.highBandPower > result.lowBandPower);
    bool qualityPassed = result.quality >= QUALITY_MINIMUM;
    bool passed = dominantPassed && balancePassed && qualityPassed;

    allPassed = allPassed && passed;

    Serial.printf("[SELFTEST] %s: peak=%u Hz low=%.3f high=%.3f q=%u -> %s\n",
                  test.label,
                  (unsigned)result.dominantFrequencyHz,
                  result.lowBandPower,
                  result.highBandPower,
                  (unsigned)result.quality,
                  passed ? "PASS" : "FAIL");
  }

  return allPassed;
}

// ---------------------------------------------------------------------------
// 8. Acoustic capture
// ---------------------------------------------------------------------------

float captureAcousticWindow(uint16_t &missedDeadlines) {
  missedDeadlines = 0;

  uint32_t startUs = micros();
  uint32_t nextSampleUs = startUs;

  for (uint16_t i = 0; i < FFT_SIZE; i++) {
    while ((int32_t)(micros() - nextSampleUs) < 0) {
      // Busy-wait for the next 250 us sample slot.
    }

    acousticSamples[i] = (uint16_t)analogRead(PIN_ACOUSTIC);
    nextSampleUs += ACOUSTIC_SAMPLE_PERIOD_US;

    if ((int32_t)(micros() - nextSampleUs) > 1000) {
      // If analogRead or an interrupt made us badly late, resynchronise
      // instead of trying to catch up with a burst of samples.
      nextSampleUs = micros();
      missedDeadlines++;
    }
  }

  uint32_t endUs = micros();
  uint32_t elapsedUs = endUs - startUs;
  if (elapsedUs == 0) return ACOUSTIC_SAMPLE_RATE_HZ;

  return (float)(FFT_SIZE - 1) * 1000000.0f / (float)elapsedUs;
}

// ---------------------------------------------------------------------------
// 9. MAX30102 FIFO and optical vitals
// ---------------------------------------------------------------------------

int readRegister8(uint8_t reg) {
  Wire.beginTransmission(MAX30102_I2C_ADDRESS);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return -1;

  if (Wire.requestFrom(MAX30102_I2C_ADDRESS, (size_t)1) != 1) return -1;
  return Wire.read();
}

bool readFifoSample(uint32_t &red, uint32_t &ir) {
  Wire.beginTransmission(MAX30102_I2C_ADDRESS);
  Wire.write(REG_FIFO_DATA);
  if (Wire.endTransmission(false) != 0) return false;

  if (Wire.requestFrom(MAX30102_I2C_ADDRESS, (size_t)6) != 6) return false;

  uint8_t bytes[6];
  for (uint8_t i = 0; i < 6; i++) bytes[i] = (uint8_t)Wire.read();

  red = ((uint32_t)bytes[0] << 16) | ((uint32_t)bytes[1] << 8) | bytes[2];
  ir = ((uint32_t)bytes[3] << 16) | ((uint32_t)bytes[4] << 8) | bytes[5];
  red &= 0x3FFFF;
  ir &= 0x3FFFF;
  return true;
}

void pushOpticalSample(uint32_t red, uint32_t ir) {
  opticalRing.red[opticalRing.head] = red;
  opticalRing.ir[opticalRing.head] = ir;
  opticalRing.head = (opticalRing.head + 1) % OPTICAL_WINDOW_SAMPLES;
  if (opticalRing.count < OPTICAL_WINDOW_SAMPLES) opticalRing.count++;

  opticalSampleCount++;
  lastOpticalSampleMs = millis();
}

void resetOpticalWindow() {
  opticalRing.head = 0;
  opticalRing.count = 0;
  lastOpticalSampleMs = millis();
}

void pollOpticalFifo() {
  if (!max30102Ready) return;

  int writePointer = readRegister8(REG_FIFO_WRITE_PTR);
  int readPointer = readRegister8(REG_FIFO_READ_PTR);
  int overflow = readRegister8(REG_FIFO_OVERFLOW);

  if (writePointer < 0 || readPointer < 0 || overflow < 0) {
    return;
  }

  if (overflow > 0) {
    opticalOverflowCount += (uint32_t)overflow;
    particleSensor.clearFIFO();
    resetOpticalWindow();
    Serial.printf("[OPT] FIFO overflow (%d); optical window reset.\n", overflow);
    return;
  }

  uint8_t available = (uint8_t)(((uint8_t)writePointer - (uint8_t)readPointer) & 0x1F);
  for (uint8_t i = 0; i < available; i++) {
    uint32_t red = 0;
    uint32_t ir = 0;
    if (!readFifoSample(red, ir)) {
      Serial.println("[OPT] FIFO read failed.");
      return;
    }
    pushOpticalSample(red, ir);
  }
}

void copyOpticalSamples(float *red, float *ir, uint16_t &count) {
  count = opticalRing.count;
  if (count == 0) return;

  uint16_t start = (opticalRing.head + OPTICAL_WINDOW_SAMPLES - count) % OPTICAL_WINDOW_SAMPLES;
  for (uint16_t i = 0; i < count; i++) {
    uint16_t index = (start + i) % OPTICAL_WINDOW_SAMPLES;
    red[i] = (float)opticalRing.red[index];
    ir[i] = (float)opticalRing.ir[index];
  }
}

bool estimateHeartRate(const float *filteredIr, uint16_t count, float sampleRateHz,
                       uint8_t &bpmOut, float &confidenceOut) {
  if (count <= OPTICAL_MAX_LAG + 10) return false;

  uint16_t segment = count - OPTICAL_MAX_LAG;
  float bestCorrelation = -1.0f;
  uint16_t bestLag = 0;

  for (uint16_t lag = OPTICAL_MIN_LAG; lag <= OPTICAL_MAX_LAG; lag++) {
    float numerator = 0.0f;
    float energyA = 0.0f;
    float energyB = 0.0f;

    for (uint16_t i = 0; i < segment; i++) {
      float a = filteredIr[i];
      float b = filteredIr[i + lag];
      numerator += a * b;
      energyA += a * a;
      energyB += b * b;
    }

    float denominator = sqrtf(energyA * energyB);
    float correlation = denominator > 1e-9f ? numerator / denominator : 0.0f;
    opticalCorrelations[lag] = correlation;

    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }

  if (bestLag == 0 || bestCorrelation < OPTICAL_CORRELATION_MIN) return false;

  // Autocorrelation also peaks at every multiple of the pulse period, so the
  // global maximum can be the second or third harmonic. Prefer the earliest
  // local maximum that is nearly as strong: that is the true beat-to-beat lag.
  // The absolute floor keeps a noisy early ripple from winning.
  uint16_t chosenLag = bestLag;
  const float strongThreshold = fmaxf(0.50f, bestCorrelation * 0.80f);
  for (uint16_t lag = OPTICAL_MIN_LAG + 1; lag < OPTICAL_MAX_LAG; lag++) {
    float correlation = opticalCorrelations[lag];
    if (correlation < strongThreshold) continue;
    if (correlation < opticalCorrelations[lag - 1]) continue;
    if (correlation < opticalCorrelations[lag + 1]) continue;
    chosenLag = lag;
    break;
  }

  float lagEstimate = (float)chosenLag;
  if (chosenLag > OPTICAL_MIN_LAG && chosenLag < OPTICAL_MAX_LAG) {
    float left = opticalCorrelations[chosenLag - 1];
    float centre = opticalCorrelations[chosenLag];
    float right = opticalCorrelations[chosenLag + 1];
    float denominator = left - 2.0f * centre + right;

    if (fabsf(denominator) > 1e-9f) {
      float delta = 0.5f * (left - right) / denominator;
      lagEstimate += clampf(delta, -0.5f, 0.5f);
    }
  }

  float bpm = 60.0f * sampleRateHz / lagEstimate;
  if (bpm < 30.0f || bpm > 220.0f) return false;

  bpmOut = (uint8_t)lroundf(bpm);
  confidenceOut = opticalCorrelations[chosenLag];
  return true;
}

OpticalFeatures analyseOpticalWindow() {
  OpticalFeatures result = {};
  result.perfusionIndex = OPTICAL_NOT_AVAILABLE;

  if (!max30102Ready) return result;

  // If no optical samples have arrived for two seconds, the sensor has been
  // removed or the I2C bus has failed. Discard the stale window rather than
  // reporting old vitals forever.
  if (opticalRing.count > 0 && (millis() - lastOpticalSampleMs) > OPTICAL_STALE_MS) {
    resetOpticalWindow();
    opticalPpgStable = false;
    opticalPpgStablePrev = false;
  }

  if (opticalRing.count < OPTICAL_MIN_PPG_SAMPLES) return result;

  uint16_t count = 0;
  copyOpticalSamples(opticalRed, opticalIr, count);
  result.sampleCount = count;
  if (count < OPTICAL_MIN_PPG_SAMPLES) return result;

  float redDc = meanOf(opticalRed, count);
  float irDc = meanOf(opticalIr, count);
  result.redDc = redDc;
  result.irDc = irDc;

  if (redDc < OPTICAL_DC_MIN || irDc < OPTICAL_DC_MIN) {
    return result; // no finger / no optical coupling
  }

  // Remove slow drift before measuring the pulsatile component.
  highPassFilter(opticalRed, opticalRedFiltered, count, OPTICAL_SAMPLE_RATE_HZ, 0.5f);
  highPassFilter(opticalIr, opticalIrFiltered, count, OPTICAL_SAMPLE_RATE_HZ, 0.5f);

  float redAc = rmsOf(opticalRedFiltered, count);
  float irAc = rmsOf(opticalIrFiltered, count);

  if (redAc < OPTICAL_AC_MIN || irAc < OPTICAL_AC_MIN) return result;

  // Perfusion index uses the clinical peak-to-peak definition:
  // PI = 100 * (AC peak-to-peak) / DC. The website's Weak/Fair/Strong bands
  // assume this convention, whereas RMS AC would read about 3x lower.
  float irMin = opticalIrFiltered[0];
  float irMax = opticalIrFiltered[0];
  for (uint16_t i = 1; i < count; i++) {
    if (opticalIrFiltered[i] < irMin) irMin = opticalIrFiltered[i];
    if (opticalIrFiltered[i] > irMax) irMax = opticalIrFiltered[i];
  }

  float pi = 100.0f * (irMax - irMin) / irDc;
  result.pi = pi;
  if (pi < OPTICAL_PI_MIN) return result;

  // The R ratio is amplitude-relative, so RMS is fine for both channels.
  float ratio = (redAc / redDc) / (irAc / irDc);
  float spo2 = -45.060f * ratio * ratio + 30.354f * ratio + 94.845f;
  // Match the website's 50-100% plausibility window. The old 70% floor made a
  // true severe desaturation look less severe than it was.
  spo2 = clampf(spo2, 50.0f, 100.0f);

  uint8_t bpm = 0;
  float confidence = 0.0f;
  bool heartRateOk = estimateHeartRate(opticalIrFiltered, count, OPTICAL_SAMPLE_RATE_HZ, bpm, confidence);
  result.correlation = confidence;

  // Require a trustworthy heart rate for ppgValid to avoid noise passing gates
  result.spo2 = (uint8_t)lroundf(spo2);
  result.perfusionIndex = (uint8_t)clampf(lroundf(pi), 0, 100);
  if (heartRateOk) {
    result.bpm = bpm;
    result.ppgValid = true;
  } else {
    result.ppgValid = false;
    result.bpm = 0;
    result.spo2 = 0;
    result.perfusionIndex = OPTICAL_NOT_AVAILABLE;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 10. Haptic output
// ---------------------------------------------------------------------------

void serviceHaptic() {
  if (!HAPTIC_INSTALLED) return;

  uint8_t command = requestedHapticCommand;

  if (command == CONTROL_HAPTIC_PULSE) {
    requestedHapticCommand = 0;
    digitalWrite(PIN_HAPTIC, HIGH);
    hapticActive = true;
    hapticStartedMs = millis();
    Serial.println("[HAPTIC] Pulse started.");
  } else if (command == CONTROL_HAPTIC_STOP) {
    requestedHapticCommand = 0;
    digitalWrite(PIN_HAPTIC, LOW);
    hapticActive = false;
    Serial.println("[HAPTIC] Stopped.");
  }

  if (hapticActive && (millis() - hapticStartedMs >= HAPTIC_PULSE_MS)) {
    digitalWrite(PIN_HAPTIC, LOW);
    hapticActive = false;
    Serial.println("[HAPTIC] Pulse finished.");
  }
}

// ---------------------------------------------------------------------------
// 11. Telemetry and diagnostics
// ---------------------------------------------------------------------------

void sendTelemetry(const AcousticFeatures &acoustic, const OpticalFeatures &optical, bool contact) {
  if (telemetryCharacteristic == nullptr) return;

  VFMTelemetryPacket packet = {};
  const bool extended = telemetryV2Enabled;
  packet.version = extended ? PROTOCOL_VERSION : 1;
  packet.sequence = packetSequence;
  packet.lowBandPower = acoustic.lowBandPower;
  packet.highBandPower = acoustic.highBandPower;
  packet.amplitude = acoustic.amplitudeMillivolts;
  packet.dominantFrequencyHz = acoustic.dominantFrequencyHz;
  packet.quality = acoustic.quality;

  // Frame-level hysteresis: require stable state
  bool ppgOut = optical.ppgValid;
  if (opticalPpgStablePrev && !optical.ppgValid) {
    // If we were stable and just lost signal, be conservative - keep previous stable briefly
    // but better to drop; use opticalPpgStablePrev state
    ppgOut = false; // will be updated
  } else if (!opticalPpgStablePrev && optical.ppgValid) {
    ppgOut = true;
  } else {
    ppgOut = optical.ppgValid;
  }
  // Track stability
  static bool lastPpgOut = false;
  static uint8_t badCount = 0;
  if (optical.ppgValid) {
    badCount = 0;
    lastPpgOut = true;
    ppgOut = true;
  } else {
    if (lastPpgOut) {
      badCount++;
      if (badCount < 2) {
        ppgOut = true; // debounce dropout
      } else {
        ppgOut = false;
        lastPpgOut = false;
      }
    } else {
      ppgOut = false;
      badCount = 0;
    }
  }

  packet.bpm = ppgOut ? optical.bpm : 0;
  packet.spo2 = ppgOut ? optical.spo2 : 0;
  packet.perfusionIndex = ppgOut ? optical.perfusionIndex : OPTICAL_NOT_AVAILABLE;
  opticalPpgStablePrev = ppgOut;

  packet.flags = 0;
  if (HAPTIC_INSTALLED) packet.flags |= FLAG_HAPTIC;
  if (contact) packet.flags |= FLAG_CONTACT;
  if (ppgOut) packet.flags |= FLAG_PPG_VALID;
  // A stuck acoustic ADC is a degraded channel, not a dead device: it already
  // drives quality to ~0. Only a failed DSP self-test is a hard fault, so a
  // band with working optics is not rejected wholesale.
  if (!dspSelfTestPassed) packet.flags |= FLAG_FAULT;

  // Never put NaN or infinity on the wire; the browser expects real numbers.
  if (!isfinite(packet.lowBandPower)) packet.lowBandPower = 0.0f;
  if (!isfinite(packet.highBandPower)) packet.highBandPower = 0.0f;
  if (!isfinite(packet.amplitude)) packet.amplitude = 0.0f;

  // A default ATT MTU of 23 leaves only 20 notification bytes. Do not hand the
  // stack a 22-byte value when the peer never negotiated a larger MTU: send the
  // first 20 bytes as a valid v1-shaped frame instead of silently truncating.
  const size_t frameLength = extended ? sizeof(packet) : 20;
  telemetryCharacteristic->setValue((uint8_t *)&packet, frameLength);
  telemetryCharacteristic->notify();
}

void printDiagnostics(const AcousticFeatures &acoustic, const OpticalFeatures &optical,
                      bool contact, uint16_t missedDeadlines, uint16_t sequence) {
  float ratio = acoustic.highBandPower / fmaxf(acoustic.lowBandPower, 1e-6f);

  Serial.printf(
      "[VFM] seq=%u fs=%.0f low=%.3f high=%.3f ratio=%.3f peak=%uHz q=%u amp=%.1fmV "
      "contact=%u ppg=%u bpm=%u spo2=%u pi=%u\n",
      (unsigned)sequence,
      acoustic.sampleRateHz,
      acoustic.lowBandPower,
      acoustic.highBandPower,
      ratio,
      (unsigned)acoustic.dominantFrequencyHz,
      (unsigned)acoustic.quality,
      acoustic.amplitudeMillivolts,
      contact ? 1u : 0u,
      optical.ppgValid ? 1u : 0u,
      (unsigned)(optical.ppgValid ? optical.bpm : 0),
      (unsigned)(optical.ppgValid ? optical.spo2 : 0),
      (unsigned)(optical.ppgValid ? optical.perfusionIndex : OPTICAL_NOT_AVAILABLE));
  Serial.printf("[DIAG] irDc=%.0f redDc=%.0f pi=%.2f corr=%.2f cnt=%u\n",
                optical.irDc, optical.redDc, optical.pi, optical.correlation, (unsigned)optical.sampleCount);

  if (optical.ppgValid) {
    Serial.printf("[OPT] dcIR=%.0f dcRed=%.0f pi=%.2f corr=%.2f samples=%u\n",
                  optical.irDc,
                  optical.redDc,
                  optical.pi,
                  optical.correlation,
                  (unsigned)optical.sampleCount);
  }

  if (missedDeadlines > 20) {
    Serial.printf("[ADC] %u late sample deadlines; measured fs=%.1f Hz\n",
                  (unsigned)missedDeadlines,
                  acoustic.sampleRateHz);
  }

  if (opticalOverflowCount != lastReportedOpticalOverflowCount) {
    Serial.printf("[OPT] cumulative overflow count=%lu\n",
                  (unsigned long)opticalOverflowCount);
    lastReportedOpticalOverflowCount = opticalOverflowCount;
  }
}

// ---------------------------------------------------------------------------
// 12. BLE callbacks
// ---------------------------------------------------------------------------

class ControlCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    uint8_t *data = characteristic->getData();
    size_t length = characteristic->getLength();

    // The app writes [version, command]. Accept both the legacy v1 byte and
    // the current v2 byte; the command is always the second byte.
    if (data == nullptr || length < 2) return;
    if (data[0] != 1 && data[0] != 2) return;

    uint8_t command = data[1];
    if (command == CONTROL_HAPTIC_PULSE || command == CONTROL_HAPTIC_STOP) {
      requestedHapticCommand = command;
    }
  }
};

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *server) override {
    deviceConnected = true;

    uint16_t mtu = server->getPeerMTU(server->getConnId());
    telemetryV2Enabled = mtu >= 25;
    uint16_t payload = mtu > 3 ? mtu - 3 : 0;
    Serial.printf("[BLE] Client connected (MTU=%u, payload=%u); %s.\n",
                  mtu,
                  payload,
                  telemetryV2Enabled ? "v2 optical frame enabled"
                                     : "sending 20-byte v1 fallback until MTU is raised");
  }

  void onDisconnect(BLEServer *server) override {
    (void)server;
    deviceConnected = false;
    telemetryV2Enabled = false;
    if (HAPTIC_INSTALLED) {
      requestedHapticCommand = CONTROL_HAPTIC_STOP;
    } else {
      requestedHapticCommand = 0;
    }
    Serial.println("[BLE] Client disconnected; restarting advertising.");
    BLEDevice::startAdvertising();
  }

#if defined(CONFIG_BLUEDROID_ENABLED)
  void onMtuChanged(BLEServer *server, esp_ble_gatts_cb_param_t *param) override {
    (void)server;
    uint16_t mtu = param->mtu.mtu;
    telemetryV2Enabled = mtu >= 25;
    uint16_t payload = mtu > 3 ? mtu - 3 : 0;
    Serial.printf("[BLE] MTU changed to %u (payload=%u); %s.\n",
                  mtu,
                  payload,
                  telemetryV2Enabled ? "v2 optical frame enabled"
                                     : "optical bytes omitted in v1 fallback");
  }
#endif
};

// ---------------------------------------------------------------------------
// 13. Arduino setup and loop
// ---------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(250);

  Serial.println();
  Serial.println("==================================================");
  Serial.println(" VFM Band — ESP32 acoustic FFT + optical vitals");
  Serial.println("==================================================");

  if (HAPTIC_INSTALLED) {
    pinMode(PIN_HAPTIC, OUTPUT);
    digitalWrite(PIN_HAPTIC, LOW);
  } else {
    pinMode(PIN_HAPTIC, INPUT);
  }
  hapticActive = false;
  hapticStartedMs = 0;
  requestedHapticCommand = 0;
  pinMode(PIN_CONTACT, INPUT_PULLUP);
  pinMode(PIN_ACOUSTIC, INPUT);

  analogReadResolution(12);
  analogSetPinAttenuation(PIN_ACOUSTIC, ADC_11db);

  initDsp();
  Serial.println("[DSP] Running boot self-test...");
  dspSelfTestPassed = runDspSelfTest();
  Serial.printf("[DSP] Self-test %s.\n", dspSelfTestPassed ? "PASSED" : "FAILED");

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  if (particleSensor.begin(Wire, I2C_SPEED_FAST)) {
    // 13 mA LED drive, 4-sample average, Red+IR, 200 sps.
    // 200 / 4 = 50 Hz effective FIFO records, each carrying Red and IR.
    particleSensor.setup(0x41, MAX30102_SAMPLE_AVERAGE, 2, MAX30102_SAMPLE_RATE_HZ,
                         411, 4096);
    particleSensor.clearFIFO();
    max30102Ready = true;
    Serial.println("[OPT] MAX30102 ready: 50 Hz Red+IR, 6 s optical window.");
  } else {
    max30102Ready = false;
    Serial.println("[OPT] MAX30102 not detected. Acoustic-only mode.");
  }

  BLEDevice::init("VFM-Band");
  if (BLEDevice::setMTU(64) != 0) {
    Serial.println("[BLE] Warning: could not set local MTU preference; peer MTU still decides the frame size.");
  }

  bleServer = BLEDevice::createServer();
  bleServer->setCallbacks(new ServerCallbacks());

  BLEService *service = bleServer->createService(SERVICE_UUID);

  telemetryCharacteristic = service->createCharacteristic(
      TELEMETRY_UUID,
      BLECharacteristic::PROPERTY_NOTIFY);
  telemetryCharacteristic->addDescriptor(new BLE2902());

  controlCharacteristic = service->createCharacteristic(
      CONTROL_UUID,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  controlCharacteristic->setCallbacks(new ControlCallbacks());

  service->start();

  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->setMinPreferred(0x06);
  advertising->setMaxPreferred(0x12);
  BLEDevice::startAdvertising();

  lastFrameMs = millis();
  lastOpticalPollMs = millis();

  Serial.println("[BLE] Advertising as VFM-Band. Waiting for a client...");
}

void loop() {
  serviceHaptic();

  uint32_t now = millis();

  // Poll the optical FIFO regularly while the acoustic capture is idle.
  if (max30102Ready && (now - lastOpticalPollMs >= OPTICAL_POLL_INTERVAL_MS)) {
    pollOpticalFifo();
    lastOpticalPollMs = now;
  }
  // Also poll more frequently if we're close to frame time to avoid overflow
  if (max30102Ready && (now - lastOpticalPollMs >= 50)) {
    pollOpticalFifo();
    lastOpticalPollMs = now;
  }

  // One acoustic window and one telemetry frame per second. The cadence is
  // advanced from the previous frame boundary so the 256 ms capture does not
  // stretch it: the browser's 60 s recheck expects about 60 readings per minute.
  if (now - lastFrameMs >= FRAME_INTERVAL_MS) {
    lastFrameMs += FRAME_INTERVAL_MS;
    if (now - lastFrameMs >= FRAME_INTERVAL_MS * 2) {
      // A whole interval was missed (serial stall, BLE hiccup). Resynchronise
      // rather than sending a burst of catch-up frames.
      lastFrameMs = now;
    } else if (now - lastFrameMs >= FRAME_INTERVAL_MS) {
      // small drift, just resync
      lastFrameMs = now;
    }

    uint16_t missedDeadlines = 0;
    float measuredSampleRate = captureAcousticWindow(missedDeadlines);

    // Drain the optical FIFO immediately after the blocking audio window.
    if (max30102Ready) {
      pollOpticalFifo();
      lastOpticalPollMs = millis();
    }

    AcousticFeatures acoustic = analyseAcousticWindow(measuredSampleRate);
    OpticalFeatures optical = analyseOpticalWindow();

    bool contactPad = CONTACT_PAD_INSTALLED && (digitalRead(PIN_CONTACT) == LOW);
    bool opticalPresent = optical.irDc >= OPTICAL_DC_MIN && optical.pi >= OPTICAL_PI_MIN;
    bool acousticPresent = acoustic.quality >= QUALITY_MINIMUM;
    bool contact = contactPad ||
                   (CONTACT_FALLBACK_ENABLED && (opticalPresent || acousticPresent));

    if (deviceConnected) {
      sendTelemetry(acoustic, optical, contact);
    }

    printDiagnostics(acoustic, optical, contact, missedDeadlines, packetSequence);
    packetSequence++;
  }

  delay(2);
}

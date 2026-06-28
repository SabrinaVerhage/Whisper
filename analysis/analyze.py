"""
Audio feature extraction for the Whisper installation.
Called by the Node server as a background process after an audio file is saved.

Usage:
    python analyze.py <audio_file_path>

Outputs a single JSON object to stdout. All values are floats or null.
"""

import sys
import json
import traceback

def analyze(audio_path):
    import numpy as np
    import librosa
    import parselmouth

    # ── Load audio ────────────────────────────────────────────────────────────
    # librosa handles webm/ogg/mp4/wav — needs ffmpeg for compressed formats.
    # sr=None preserves the original sample rate.
    y, sr = librosa.load(audio_path, sr=None, mono=True)
    y = y.astype(np.float64)

    result = {}

    # ── Parselmouth / Praat ───────────────────────────────────────────────────
    # Create a Praat Sound from the librosa array so we use one loader for both.
    snd = parselmouth.Sound(values=y, sampling_frequency=float(sr))

    # HNR — Harmonic-to-Noise Ratio (the real breathiness signal).
    # Low HNR = more noise relative to harmonics = breathy voice.
    # Typical range: 0 dB (very breathy) to ~25 dB (clear, modal voice).
    try:
        harmonicity = snd.to_harmonicity_cc()
        vals = harmonicity.values[0]
        voiced = vals[vals > -200]          # -200 is Praat's "unvoiced" sentinel
        if len(voiced) > 0:
            result["hnr"] = round(float(np.mean(voiced)), 4)
            result["hnrMin"] = round(float(np.min(voiced)), 4)
    except Exception:
        pass

    # F0 — Fundamental frequency (pitch).
    # pitch_floor/ceiling tuned for whispering / close-mic speech.
    # Whispering has weak or absent periodicity, so voiced frames may be sparse.
    try:
        pitch = snd.to_pitch(pitch_floor=75.0, pitch_ceiling=500.0)
        f0 = pitch.selected_array["frequency"]
        voiced_f0 = f0[f0 > 0]
        if len(voiced_f0) > 0:
            result["f0Mean"]  = round(float(np.mean(voiced_f0)), 2)
            result["f0Min"]   = round(float(np.min(voiced_f0)), 2)
            result["f0Max"]   = round(float(np.max(voiced_f0)), 2)
            # Use 5th–95th percentile range to avoid outlier frames.
            result["f0Range"] = round(
                float(np.percentile(voiced_f0, 95) - np.percentile(voiced_f0, 5)), 2
            )
            result["voicedFraction"] = round(float(len(voiced_f0) / len(f0)), 4)
    except Exception:
        pass

    # Jitter (local) — cycle-to-cycle F0 variation; correlates with vocal roughness.
    try:
        point_process = parselmouth.praat.call([snd, pitch], "To PointProcess (cc)")
        result["jitter"] = round(
            parselmouth.praat.call(point_process, "Get jitter (local)", 0, 0, 0.0001, 0.02, 1.3),
            6,
        )
    except Exception:
        pass

    # ── librosa ───────────────────────────────────────────────────────────────

    # Spectral centroid — perceptual "brightness" in Hz.
    # Low centroid (< ~1500 Hz) = warm/dark; high = bright/thin.
    try:
        centroid = librosa.feature.spectral_centroid(y=y, sr=sr)
        result["spectralCentroid"] = round(float(np.mean(centroid)), 2)
    except Exception:
        pass

    # Spectral rolloff — frequency below which 85% of energy sits.
    # Another darkness/brightness indicator, less affected by harmonics.
    try:
        rolloff = librosa.feature.spectral_rolloff(y=y, sr=sr, roll_percent=0.85)
        result["spectralRolloff"] = round(float(np.mean(rolloff)), 2)
    except Exception:
        pass

    # RMS energy (frame-level mean) — cross-check against browser amplitude.
    try:
        rms_frames = librosa.feature.rms(y=y)
        result["rmsLibrosa"] = round(float(np.mean(rms_frames)), 6)
    except Exception:
        pass

    # Zero-crossing rate — cross-check against browser noisiness.
    try:
        zcr = librosa.feature.zero_crossing_rate(y)
        result["zcrLibrosa"] = round(float(np.mean(zcr)), 6)
    except Exception:
        pass

    # Speech rate (syllable nuclei per second).
    # Method: count local maxima in smoothed RMS above a silence threshold.
    # This is a rough estimate — proper speech rate needs a phone-level ASR model.
    try:
        hop = 512
        rms_frames = librosa.feature.rms(y=y, hop_length=hop)[0]
        # Smooth to reduce spurious peaks from consonants
        kernel = np.hanning(7)
        kernel /= kernel.sum()
        smoothed = np.convolve(rms_frames, kernel, mode="same")
        threshold = np.percentile(smoothed[smoothed > 0], 20) if smoothed.max() > 0 else 0
        peaks = []
        for i in range(1, len(smoothed) - 1):
            if smoothed[i] > smoothed[i - 1] and smoothed[i] > smoothed[i + 1] and smoothed[i] > threshold:
                peaks.append(i)
        duration_sec = len(y) / sr
        if duration_sec > 0.5 and len(peaks) > 0:
            result["speechRate"] = round(len(peaks) / duration_sec, 3)
    except Exception:
        pass

    # Duration cross-check
    result["durationLibrosa"] = round(float(len(y) / sr), 4)

    # ── Whisper transcription ─────────────────────────────────────────────────
    # Skipped when --skip-transcription is passed (fast sync phase from server).
    if '--skip-transcription' not in sys.argv:
        try:
            import whisper
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
            model = whisper.load_model("base", device=device)
            wresult = model.transcribe(audio_path, fp16=(device == "cuda"))
            result["transcript"] = wresult["text"].strip()
            result["transcriptLanguage"] = wresult.get("language", "")
        except Exception:
            pass

    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: analyze.py <audio_path>"}))
        sys.exit(1)

    try:
        output = analyze(sys.argv[1])
        print(json.dumps(output))
    except Exception:
        print(json.dumps({"error": traceback.format_exc()}))
        sys.exit(1)

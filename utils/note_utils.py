"""
note_utils.py
Frequency → musical note, vocal range, timbre label conversions.
"""

import math

import numpy as np

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def hz_to_note_name(freq: float) -> str:
    if not freq or math.isnan(freq) or freq <= 0:
        return "—"
    midi = 69 + 12 * math.log2(freq / 440.0)
    midi_int = round(midi)
    note = NOTE_NAMES[midi_int % 12]
    octave = midi_int // 12 - 1
    return f"{note}{octave}"


def hz_to_vocal_range(freq: float) -> str:
    if not freq or math.isnan(freq) or freq <= 0:
        return "—"
    if freq < 165:
        return "Bass"
    elif freq < 250:
        return "Chest"
    elif freq < 450:
        return "Mixed"
    elif freq < 700:
        return "Head"
    else:
        return "Whistle"


def centroid_to_timbre(centroid_hz: float) -> str:
    if centroid_hz < 600:
        return "Dark"
    elif centroid_hz < 1500:
        return "Warm"
    elif centroid_hz < 3000:
        return "Bright"
    else:
        return "Brilliant"


def loudness_color(loudness_db: float) -> str:
    """Return a CSS-style hex color for the loudness bar."""
    v = float(np.clip((loudness_db + 80) / 80, 0, 1))
    if v < 0.5:
        return "#3fb950"
    elif v < 0.8:
        return "#d29922"
    else:
        return "#f85149"

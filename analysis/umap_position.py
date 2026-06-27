"""
UMAP-based field positioning for new whispers.

Usage:
    python umap_position.py <new_whisper_id> <whispers_dir>

Reads all whisper JSON files, extracts 6-component sensuality vectors,
fits UMAP on the full set (including the new whisper), and returns the
new whisper's [x, y] position mapped to [12, 88].

Falls back to linear projection when < 8 whispers exist.
Outputs a single JSON object to stdout.
"""

import sys
import json
import os


COMPONENT_KEYS = [
    'breathiness', 'darkness', 'softness',
    'slowness', 'pitchLowness', 'pitchSteadiness',
]


def load_whispers(whispers_dir):
    records = []
    try:
        for fname in sorted(os.listdir(whispers_dir)):
            if not fname.endswith('.json'):
                continue
            try:
                with open(os.path.join(whispers_dir, fname), encoding='utf-8') as f:
                    records.append(json.load(f))
            except Exception:
                continue
    except Exception:
        pass
    return records


def extract_vector(record):
    comps = (record.get('sensuality') or {}).get('components') or {}
    if not comps:
        return None
    return [float(comps.get(k, 0.5)) for k in COMPONENT_KEYS]


def linear_position(vec):
    """Feature-based 2D projection, same formula as server.js computeFieldPosition."""
    x_raw = vec[0] * 0.55 + vec[1] * 0.45
    y_raw = vec[2] * 0.55 + vec[3] * 0.45
    return (
        round(12 + x_raw * 76, 4),
        round(12 + y_raw * 76, 4),
    )


def main():
    if len(sys.argv) < 3:
        print(json.dumps({'error': 'Usage: umap_position.py <id> <dir>'}))
        sys.exit(1)

    new_id = sys.argv[1]
    whispers_dir = sys.argv[2]

    records = load_whispers(whispers_dir)
    if not records:
        print(json.dumps({'error': 'No whispers found'}))
        sys.exit(1)

    # Build vectors for records that have sensuality components
    ids, vectors = [], []
    for rec in records:
        vec = extract_vector(rec)
        if vec is not None:
            ids.append(rec['id'])
            vectors.append(vec)

    if new_id not in ids:
        print(json.dumps({'error': f'Whisper {new_id} has no sensuality components yet'}))
        sys.exit(1)

    new_idx = ids.index(new_id)
    n = len(vectors)

    if n < 8:
        # Not enough data for UMAP — use linear projection
        x, y = linear_position(vectors[new_idx])
        print(json.dumps({'x': x, 'y': y, 'method': 'linear'}))
        return

    import numpy as np
    from umap import UMAP

    X = np.array(vectors, dtype=np.float32)
    n_neighbors = min(15, n - 1)
    reducer = UMAP(
        n_components=2,
        n_neighbors=n_neighbors,
        min_dist=0.1,
        random_state=42,
        low_memory=True,
    )
    embedding = reducer.fit_transform(X)

    # Normalise embedding to [12, 88] range
    e_min = embedding.min(axis=0)
    e_max = embedding.max(axis=0)
    rng   = e_max - e_min
    rng[rng < 1e-8] = 1.0  # avoid division by zero when all points coincide

    norm   = (embedding - e_min) / rng
    mapped = 12 + norm * 76

    x = round(float(mapped[new_idx, 0]), 4)
    y = round(float(mapped[new_idx, 1]), 4)
    print(json.dumps({'x': x, 'y': y, 'method': 'umap', 'n': n}))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        import traceback
        print(json.dumps({'error': traceback.format_exc()}))
        sys.exit(1)

"""Execute all notebooks with an explicitly synthetic tiny setup fixture.

This checks plumbing, not traffic-model quality. Results stay under outputs/smoke-*.
"""
import json
import sys
import time
import subprocess
import tempfile
from pathlib import Path

import nbformat
import numpy as np
from nbclient import NotebookClient
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]

def main():
    output = ROOT / 'outputs' / f'smoke-{time.time_ns()}'
    data = output / 'synthetic-fixture'
    rng = np.random.default_rng(17)
    for split in ('train', 'val', 'test'):
        for label in ('busy', 'clear'):
            folder = data / split / label
            folder.mkdir(parents=True)
            for i in range(4):
                Image.fromarray(rng.integers(0, 256, (48, 64, 3), dtype=np.uint8)).save(folder / f'{i}.png')
    substitutions = [
        f"DATA=Path({str(data)!r})\nOUTPUT=Path({str(output / 'cv')!r})\nBASE_MODEL='yolo11n-cls.yaml'\nIMAGE_SIZE=32\nEPOCHS=1\nBATCH=4\nDEVICE='cpu'\nSEED=42\nPATIENCE=2",
        f"MODEL=Path({str(output / 'cv/classifier.pt')!r})\nTEST_DATA=Path({str(data / 'test')!r})\nOUTPUT=Path({str(output / 'cv-test')!r})\nIMAGE_SIZE=32\nBATCH=4\nDEVICE='cpu'",
        f"from traffic_training.sumo_env import SumoConfig\nOUTPUT=Path({str(output / 'rl')!r})\nCONFIG=SumoConfig(horizon_seconds=40)\nTOTAL_DECISIONS=16\nROLLOUT_DECISIONS=8\nBATCH_SIZE=4\nSEED=42\nDEVICE='cpu'",
        f"MODEL=Path({str(output / 'rl/policy.zip')!r})\nOUTPUT=Path({str(output / 'rl-test')!r})\nSEEDS=[2000001]\nSCENARIOS=['balanced']\nFIXED_SECONDS=[30]\nHORIZON_SECONDS=40\nGUI=False\nDEVICE='cpu'",
    ]
    for path, replacement in zip(sorted((ROOT / 'notebooks').glob('*.ipynb')), substitutions):
        notebook = nbformat.read(path, as_version=4)
        for cell in notebook.cells:
            if 'parameters' in cell.metadata.get('tags', []): cell.source = replacement
        print('Executing', path.name, flush=True)
        NotebookClient(notebook, timeout=600, kernel_name='python3', resources={'metadata': {'path': str(ROOT)}}).execute()
        nbformat.write(notebook, output / path.name)
        if path.name.startswith('01_'):
            # A fresh process outside Train must load the exported checkpoint.
            with tempfile.TemporaryDirectory() as folder:
                subprocess.run([sys.executable, '-c',
                    'from ultralytics import YOLO; import sys; m=YOLO(sys.argv[1]); assert m.task == "classify"; print(m.names)',
                    str(output / 'cv/classifier.pt')], cwd=folder, check=True)
    print('Executed notebooks:', output, flush=True)

if __name__ == '__main__': main()

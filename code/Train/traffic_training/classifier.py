from __future__ import annotations

import csv
import hashlib
import json
import random
import shutil
import time
from copy import copy
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score
from torch.utils.data import DataLoader
from torchvision import datasets, transforms
from torchvision.transforms import InterpolationMode
from ultralytics import YOLO
from ultralytics.data import ClassificationDataset
from ultralytics.models.yolo.classify import ClassificationTrainer, ClassificationValidator

IMAGE_SUFFIXES = {'.jpg', '.jpeg', '.png', '.bmp', '.webp'}


def image_transform(size: int):
    """Same stretch resize + RGB/255 layout as the demo's ROI inference path."""
    return transforms.Compose([transforms.Resize((size, size), interpolation=InterpolationMode.BILINEAR), transforms.ToTensor()])


class StretchDataset(ClassificationDataset):
    def __init__(self, root, args, augment=False, prefix='', names=None):
        super().__init__(root, args, augment=augment, prefix=prefix, names=names)
        size = args.imgsz if isinstance(args.imgsz, int) else int(args.imgsz[0])
        self.torch_transforms = image_transform(size)


class StretchValidator(ClassificationValidator):
    def build_dataset(self, img_path):
        return StretchDataset(img_path, self.args, augment=False, prefix=self.args.split, names=self.names)


class StretchTrainer(ClassificationTrainer):
    def build_dataset(self, img_path, mode='train', batch=None):
        return StretchDataset(img_path, self.args, augment=mode == 'train', prefix=mode, names=self.data['names'])

    def get_validator(self):
        return StretchValidator(self.test_loader, self.save_dir, args=copy(self.args), _callbacks=self.callbacks)


def audit_dataset(root: str | Path, check_hashes=True):
    """Fail before training on empty/mislabeled/corrupt splits or exact split leakage."""
    root = Path(root).resolve()
    result, class_names, seen = {}, None, {}
    for split in ('train', 'val', 'test'):
        directory = root / split
        if not directory.is_dir():
            raise ValueError(f'Missing {directory}. Supply independent train/val/test class folders.')
        classes = sorted(path.name for path in directory.iterdir() if path.is_dir() and not path.name.startswith('.'))
        if len(classes) < 2 or (class_names is not None and classes != class_names):
            raise ValueError(f'{split} must contain the same >=2 class folders as train.')
        class_names = classes
        counts = {}
        for label in classes:
            files = sorted(path for path in (directory / label).rglob('*') if path.suffix.lower() in IMAGE_SUFFIXES)
            if not files:
                raise ValueError(f'Empty class: {split}/{label}')
            for path in files:
                with Image.open(path) as image:
                    image.verify()
                if check_hashes:
                    digest = hashlib.sha256(path.read_bytes()).hexdigest()
                    if digest in seen and seen[digest][0] != split:
                        raise ValueError(f'Exact image leakage between {seen[digest][1]} and {path}')
                    seen[digest] = (split, str(path))
            counts[label] = len(files)
        result[split] = counts
    return {'root': str(root), 'classes': class_names, 'counts': result}


def train_classifier(data, output, model='yolo11n-cls.pt', image_size=224, epochs=50, batch=16, seed=42, device='cpu', patience=12):
    if not 32 <= image_size <= 2048 or image_size % 32 or epochs < 1 or batch < 1:
        raise ValueError('Use a square image_size 32–2048 divisible by 32 and positive epochs/batch; this avoids implicit trainer stride rounding.')
    if ',' in str(device):
        raise ValueError('Use one CPU/GPU device in these notebooks; distributed notebook training is not configured.')
    audit = audit_dataset(data)
    random.seed(seed); np.random.seed(seed); torch.manual_seed(seed)
    output = Path(output).resolve(); output.mkdir(parents=True, exist_ok=True)
    if (output / 'classifier.pt').exists():
        raise FileExistsError('Choose a fresh output folder; classifier.pt exists.')
    run_name = f'classifier_{time.time_ns()}'
    network = YOLO(str(model))
    if network.task != 'classify':
        raise ValueError('Choose a YOLO classification checkpoint or classification YAML, not a detector.')
    network.train(trainer=StretchTrainer, data=audit['root'], epochs=epochs, imgsz=image_size,
                  batch=batch, seed=seed, deterministic=True, device=device, workers=0,
                  project=str(output / 'runs'), name=run_name, patience=patience, plots=True,
                  amp=False, cache=False, pretrained=True, resume=False)
    best = Path(network.trainer.best)
    if not best.is_file():
        raise RuntimeError('Training finished without a best.pt checkpoint.')
    exported = output / 'classifier.pt'; shutil.copy2(best, exported)
    names = YOLO(str(exported)).names
    metadata = {'format': 'ultralytics-classification-pt', 'model': str(exported), 'width': image_size, 'height': image_size,
                'color': 'RGB', 'layout': 'NCHW', 'scale': '0..1', 'resize': 'stretch', 'center_crop': False,
                'classes': names, 'seed': seed, 'dataset': audit, 'training_run': str(best.parent.parent),
                'source_model': str(model), 'epochs_requested': epochs, 'batch': batch}
    (output / 'classifier_metadata.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
    return metadata


def evaluate_classifier(model, split_dir, output, image_size=224, batch=32, device='cpu'):
    """Evaluate a held-out class-folder split using demo-compatible direct tensor inference."""
    if not 32 <= image_size <= 2048 or batch < 1:
        raise ValueError('Invalid image_size or batch.')
    target = Path(output); target.mkdir(parents=True, exist_ok=True)
    network = YOLO(str(model))
    if network.task != 'classify':
        raise ValueError('Expected a YOLO classification checkpoint.')
    names = [network.names[index] for index in range(len(network.names))]
    dataset = datasets.ImageFolder(str(split_dir), transform=image_transform(image_size))
    if dataset.classes != names:
        raise ValueError(f'Class order differs from the checkpoint: dataset={dataset.classes}, model={names}')
    loader = DataLoader(dataset, batch_size=batch, shuffle=False, num_workers=0)
    device_name = str(device)
    model_device = torch.device(f'cuda:{device_name}' if device_name.isdecimal() else device_name)
    classifier = network.model.float().to(model_device).eval()
    truth, predicted, top_scores, all_probabilities, timings = [], [], [], [], []
    with torch.inference_mode():
        # Warm-up is excluded from latency statistics.
        classifier(torch.zeros(1, 3, image_size, image_size, device=model_device))
        for images, labels in loader:
            images = images.to(model_device)
            if model_device.type == 'cuda': torch.cuda.synchronize()
            started = time.perf_counter(); result = classifier(images)
            probabilities = result[0] if isinstance(result, (list, tuple)) else result
            if model_device.type == 'cuda': torch.cuda.synchronize()
            timings.append((time.perf_counter() - started) * 1000 / len(labels))
            probabilities = probabilities.cpu().numpy()
            if probabilities.shape != (len(labels), len(names)) or not np.isfinite(probabilities).all():
                raise ValueError('Unexpected model output shape/values.')
            truth.extend(labels.tolist()); predicted.extend(probabilities.argmax(1).tolist())
            top_scores.extend(probabilities.max(1).tolist()); all_probabilities.extend(probabilities.tolist())
    probability_array = np.asarray(all_probabilities)
    k = min(5, len(names)); topk = np.argsort(probability_array, axis=1)[:, -k:]
    report = classification_report(truth, predicted, labels=list(range(len(names))), target_names=names, output_dict=True, zero_division=0)
    matrix = confusion_matrix(truth, predicted, labels=list(range(len(names))))
    metrics = {'samples': len(truth), 'accuracy_top1': float(accuracy_score(truth, predicted)),
               'accuracy_topk': float(np.mean([label in row for label, row in zip(truth, topk)])), 'topk': k,
               'macro_f1': float(f1_score(truth, predicted, average='macro', zero_division=0)),
               'model_ms_per_image_batch_median': float(np.median(timings)),
               'latency_note': 'Batch forward-pass latency only; excludes JPEG/network/preprocessing. Not demo end-to-end FPS.',
               'classes': names, 'classification_report': report}
    (target / 'metrics.json').write_text(json.dumps(metrics, indent=2), encoding='utf-8')
    with (target / 'predictions.csv').open('w', newline='', encoding='utf-8') as stream:
        writer = csv.writer(stream); writer.writerow(['image', 'true_class', 'predicted_class', 'confidence'])
        for (filename, _), label, prediction, confidence in zip(dataset.samples, truth, predicted, top_scores):
            writer.writerow([filename, names[label], names[prediction], confidence])
    import matplotlib.pyplot as plt
    from sklearn.metrics import ConfusionMatrixDisplay
    fig, ax = plt.subplots(figsize=(max(6, len(names)), max(5, len(names))))
    ConfusionMatrixDisplay(matrix, display_labels=names).plot(ax=ax, xticks_rotation=45, colorbar=False)
    fig.tight_layout(); fig.savefig(target / 'confusion_matrix.png', dpi=160); plt.close(fig)
    return metrics

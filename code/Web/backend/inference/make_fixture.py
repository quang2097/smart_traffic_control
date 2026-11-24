"""Generate explicitly UNTRAINED/SYNTHETIC assets for local integration QA only."""
import os
from pathlib import Path

directory = Path(__file__).parent / '.runtime'
directory.mkdir(exist_ok=True)
os.environ['YOLO_CONFIG_DIR'] = str(directory)
os.environ['YOLO_AUTOINSTALL'] = 'false'

import cv2
import numpy as np
import torch
from PIL import Image
from ultralytics import YOLO

config = directory / 'tiny-cls.yaml'
config.write_text('nc: 3\nbackbone:\n  - [-1, 1, Conv, [8, 3, 2]]\nhead:\n  - [-1, 1, Classify, [nc]]\n')
model = YOLO(str(config))
model.model.names = {0: 'TEST clear', 1: 'TEST moderate', 2: 'TEST congested'}
with torch.no_grad():
    model.model.model[-1].linear.weight.zero_()
    model.model.model[-1].linear.bias.copy_(torch.tensor([0., 1., 3.]))
model.save(str(directory / 'UNTRAINED-test-classifier.pt'))
Image.new('RGB', (160, 96), (100, 160, 200)).save(directory / 'test-frame.jpg')
video = cv2.VideoWriter(str(directory / 'SYNTHETIC-test-video.webm'), cv2.VideoWriter_fourcc(*'VP80'), 15, (640, 360))
if not video.isOpened():
    raise RuntimeError('Unable to generate VP8 test video')
for frame_number in range(150):
    frame = np.full((360, 640, 3), (30, 50, 40), np.uint8)
    cv2.putText(frame, 'SYNTHETIC QA VIDEO', (35, 65), cv2.FONT_HERSHEY_SIMPLEX, .8, (210, 240, 220), 2)
    cv2.rectangle(frame, (frame_number * 3 % 500, 140), (frame_number * 3 % 500 + 90, 200), (100, 220, 180), -1)
    cv2.putText(frame, f'Frame {frame_number}', (35, 300), cv2.FONT_HERSHEY_SIMPLEX, .7, (220, 240, 220), 1)
    video.write(frame)
video.release()
print('Generated UNTRAINED classifier and SYNTHETIC video in inference/.runtime for QA.')

"""Exercise the actual PyTorch/YOLO path using a tiny, untrained test fixture."""
import base64
import io
import os
import tempfile
import unittest
from pathlib import Path

os.environ['TRAFFIC_AI_SECRET'] = 'test-worker-secret'
os.environ['YOLO_CONFIG_DIR'] = str(Path(__file__).parent / '.runtime')
os.environ['YOLO_AUTOINSTALL'] = 'false'

import torch
from fastapi.testclient import TestClient
from PIL import Image
from ultralytics import YOLO
from app import app, models


class InferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='traffic-ai-test-')
        config = Path(cls.directory.name) / 'tiny-cls.yaml'
        config.write_text('nc: 3\nbackbone:\n  - [-1, 1, Conv, [8, 3, 2]]\nhead:\n  - [-1, 1, Classify, [nc]]\n')
        model = YOLO(str(config))
        model.model.names = {0: 'clear', 1: 'moderate', 2: 'congested'}
        with torch.no_grad():
            model.model.model[-1].linear.weight.zero_()
            model.model.model[-1].linear.bias.copy_(torch.tensor([0., 1., 3.]))
        checkpoint = Path(cls.directory.name) / 'fixture.pt'
        model.save(str(checkpoint))
        cls.encoded = base64.b64encode(checkpoint.read_bytes()).decode()
        cls.client = TestClient(app)
        cls.headers = {'x-ai-secret': 'test-worker-secret', 'x-ai-owner': 'test-admin'}

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def setUp(self):
        models.clear()

    def load(self):
        response = self.client.post('/model', json={'data': self.encoded}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['modelId']

    def frame(self, width=160, height=96):
        image = Image.new('RGB', (width, height), (100, 160, 200))
        data = io.BytesIO()
        image.save(data, format='JPEG')
        return {'width': width, 'height': height, 'frame': base64.b64encode(data.getvalue()).decode()}

    def test_private_worker_requires_secret(self):
        self.assertEqual(self.client.get('/health').status_code, 401)

    def test_real_yolo_classification_rectangular_input(self):
        identifier = self.load()
        response = self.client.post('/classify', headers=self.headers, json={'modelId': identifier, **self.frame()})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body['predictions'][0]['label'], 'congested')
        self.assertGreater(body['predictions'][0]['confidence'], .8)
        self.assertEqual((body['width'], body['height']), (160, 96))

    def test_model_isolation_and_release(self):
        identifier = self.load()
        self.assertEqual(self.client.post('/classify', headers={**self.headers, 'x-ai-owner': 'another-user'}, json={'modelId': identifier, **self.frame()}).status_code, 410)
        self.client.post('/release', headers=self.headers, json={'modelId': identifier})
        self.assertEqual(self.client.post('/classify', headers=self.headers, json={'modelId': identifier, **self.frame()}).status_code, 410)

    def test_bad_frames_and_resolution(self):
        identifier = self.load()
        for override in [{'width': 0}, {'height': 2049}, {'width': True}, {'frame': 'not a jpeg'}, {'height': 120}]:
            response = self.client.post('/classify', headers=self.headers, json={'modelId': identifier, **self.frame(), **override})
            self.assertEqual(response.status_code, 400, response.text)

    def test_invalid_checkpoint(self):
        response = self.client.post('/model', headers=self.headers, json={'data': base64.b64encode(b'not a checkpoint').decode()})
        self.assertEqual(response.status_code, 400)

    def test_detection_checkpoint_is_rejected(self):
        detector = YOLO('yolov8n.yaml')
        path = Path(self.directory.name) / 'detector.pt'
        detector.save(str(path))
        response = self.client.post('/model', headers=self.headers, json={'data': base64.b64encode(path.read_bytes()).decode()})
        self.assertEqual(response.status_code, 400)
        self.assertIn('not a YOLO classification', response.json()['detail'])

    def test_replaced_and_expired_models(self):
        first = self.load()
        second = self.load()
        self.assertNotEqual(first, second)
        self.assertEqual(self.client.post('/classify', headers=self.headers, json={'modelId': first, **self.frame()}).status_code, 410)
        models['test-admin']['used'] = 0
        self.assertEqual(self.client.post('/classify', headers=self.headers, json={'modelId': second, **self.frame()}).status_code, 410)


if __name__ == '__main__':
    unittest.main()

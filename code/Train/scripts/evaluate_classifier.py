"""Usage: python scripts/evaluate_classifier.py --help"""
import argparse
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from traffic_training.classifier import evaluate_classifier

def main():
    parser = argparse.ArgumentParser(description='Evaluate a held-out YOLO classification dataset.')
    parser.add_argument('--model', required=True)
    parser.add_argument('--data', required=True, help='Test directory containing class subfolders')
    parser.add_argument('--output', required=True)
    parser.add_argument('--image-size', type=int, default=224)
    parser.add_argument('--batch', type=int, default=32)
    parser.add_argument('--device', default='cpu')
    args = parser.parse_args()
    print(json.dumps(evaluate_classifier(args.model, args.data, args.output, args.image_size, args.batch, args.device), indent=2))

if __name__ == '__main__': main()

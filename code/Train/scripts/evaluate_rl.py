"""Usage: python scripts/evaluate_rl.py --help"""
import argparse
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from traffic_training.rl import evaluate_policy
from traffic_training.sumo_env import SumoConfig

def main():
    parser = argparse.ArgumentParser(description='Paired PPO/fixed-timer SUMO evaluation; no live device control.')
    parser.add_argument('--model', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--seeds', type=int, nargs='+', default=[1000001, 1000002, 1000003])
    parser.add_argument('--scenarios', nargs='+', default=['balanced', 'ns_peak', 'ew_peak', 'burst'])
    parser.add_argument('--fixed-seconds', type=int, nargs='+', default=[30, 60])
    parser.add_argument('--horizon', type=int, help='Override evaluation horizon; otherwise training setting')
    parser.add_argument('--gui', action='store_true')
    parser.add_argument('--device', default='cpu')
    args = parser.parse_args()
    config_data = json.loads(Path(args.model).with_name('policy_metadata.json').read_text())['sumo_config']
    config_data['durations'] = tuple(config_data['durations'])
    config_data['network_dir'] = str(Path(__file__).resolve().parents[1] / 'sumo' / 'junction')
    config_data['gui'] = args.gui
    config_data['sumo_binary'] = None
    if args.horizon is not None: config_data['horizon_seconds'] = args.horizon
    _, summary = evaluate_policy(args.model, args.output, SumoConfig(**config_data), args.seeds, args.scenarios, args.fixed_seconds, args.device)
    print(summary.to_string())

if __name__ == '__main__': main()

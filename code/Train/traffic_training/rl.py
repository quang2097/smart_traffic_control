"""Offline PPO training and paired, held-out SUMO evaluation."""
from __future__ import annotations

import json
from dataclasses import asdict, replace
from pathlib import Path

import numpy as np
import pandas as pd
from stable_baselines3 import PPO
from stable_baselines3.common.monitor import Monitor

from .sumo_env import SumoConfig, TrafficSumoEnv, OBSERVATION_NAMES, OBSERVATION_SCALE

SCENARIOS = ('balanced', 'ns_peak', 'ew_peak', 'burst')


def contract(config):
    return {'version': 1, 'observations': OBSERVATION_NAMES, 'scales': OBSERVATION_SCALE.tolist(),
            'durations': list(config.durations), 'yellow_s': 3, 'all_red_s': 2,
            'alternating_axes': True, 'reward': '-halted_and_pending_vehicle_seconds/1000'}


class TrainingEnv(TrafficSumoEnv):
    def reset(self, *, seed=None, options=None):
        # A private generator provides reproducible training-only episode seeds.
        if not hasattr(self, 'episode_rng'):
            self.episode_rng = np.random.default_rng(seed)
        episode_seed = int(self.episode_rng.integers(0, 1_000_000))
        self.config.scenario = str(self.episode_rng.choice(SCENARIOS))
        return super().reset(seed=episode_seed, options=options)


def train_policy(output, config=None, total_timesteps=50_000, seed=42,
                 n_steps=256, batch_size=64, device='cpu'):
    """Timesteps here count completed duration decisions, not SUMO seconds."""
    config = replace(config or SumoConfig())
    if total_timesteps < 1 or n_steps < 2 or batch_size < 2 or n_steps % batch_size:
        raise ValueError('Use positive timesteps and n_steps divisible by batch_size (both >=2).')
    output = Path(output).resolve()
    if (output / 'policy.zip').exists(): raise FileExistsError('Choose a fresh output folder; policy.zip exists.')
    output.mkdir(parents=True, exist_ok=True)
    env = Monitor(TrainingEnv(config), filename=str(output / 'episodes.csv'))
    try:
        # gamma=1 avoids discounting long and short locked holds equally per decision.
        model = PPO('MlpPolicy', env, seed=seed, n_steps=n_steps, batch_size=batch_size,
                    gamma=1.0, gae_lambda=1.0, learning_rate=3e-4, verbose=1, device=device)
        model.learn(total_timesteps=total_timesteps)
        model.save(output / 'policy.zip')
        metadata = {'algorithm': 'PPO', 'contract': contract(config), 'sumo_config': asdict(config),
                    'training_seed': seed, 'training_episode_seed_range': [0, 999999],
                    'training_scenarios': list(SCENARIOS), 'requested_decisions': total_timesteps,
                    'actual_decisions': model.num_timesteps, 'gamma': 1.0,
                    'status': 'simulation research artifact; no live deployment or CV observation bridge'}
        (output / 'policy_metadata.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
        return metadata
    finally:
        env.close()


def load_policy(path, config, device='cpu'):
    path = Path(path).resolve()
    metadata = json.loads(path.with_name('policy_metadata.json').read_text(encoding='utf-8'))
    if metadata['contract'] != contract(config):
        raise ValueError('Policy observation/action contract differs from this environment.')
    return PPO.load(path, device=device), metadata


def evaluate_policy(model_path, output, config=None, seeds=(1_000_001, 1_000_002, 1_000_003),
                    scenarios=SCENARIOS, fixed_seconds=(30, 60), device='cpu'):
    """Each controller sees identical pre-generated demand for each scenario/seed."""
    import matplotlib.pyplot as plt
    config = replace(config or SumoConfig())
    seeds = tuple(seeds); scenarios = tuple(scenarios)
    if not seeds or len(set(seeds)) != len(seeds) or any(s < 1_000_000 for s in seeds):
        raise ValueError('Use unique held-out seeds >=1,000,000; training seeds are below that boundary.')
    if not scenarios or any(s not in SCENARIOS for s in scenarios): raise ValueError('Unknown evaluation scenario.')
    if not fixed_seconds or any(d not in config.durations for d in fixed_seconds):
        raise ValueError('Each fixed baseline must exist in the configured duration table.')
    model, metadata = load_policy(model_path, config, device)
    output = Path(output).resolve()
    if (output / 'episodes.csv').exists(): raise FileExistsError('Choose a fresh evaluation output folder.')
    output.mkdir(parents=True, exist_ok=True)
    controllers = [('PPO', None)] + [(f'fixed_{d}s', config.durations.index(d)) for d in fixed_seconds]
    rows = []; traces = []
    for scenario in scenarios:
        for seed in seeds:
            for controller, fixed in controllers:
                env = TrafficSumoEnv(replace(config, scenario=scenario))
                try:
                    observation, _ = env.reset(seed=int(seed))
                    done = False
                    while not done:
                        action = int(model.predict(observation, deterministic=True)[0]) if fixed is None else fixed
                        observation, _, terminated, truncated, _ = env.step(action)
                        done = terminated or truncated
                    rows.append({'controller': controller, 'scenario': scenario, 'seed': seed, **env.metrics()})
                    traces.extend({'controller': controller, 'scenario': scenario, 'seed': seed, **item} for item in env.trace)
                finally:
                    env.close()
    episodes = pd.DataFrame(rows)
    episodes.to_csv(output / 'episodes.csv', index=False)
    pd.DataFrame(traces).to_csv(output / 'phase_traces.csv', index=False)
    metrics = ['queued_vehicle_seconds', 'mean_queue_including_pending', 'arrived_vehicles', 'unfinished_demand', 'collisions']
    summary = episodes.groupby(['scenario', 'controller'])[metrics].agg(['mean', 'std'])
    summary.to_csv(output / 'summary.csv')
    paired = episodes.pivot(index=['scenario', 'seed'], columns='controller', values='queued_vehicle_seconds')
    for name, _ in controllers[1:]:
        paired[f'PPO_minus_{name}'] = paired['PPO'] - paired[name]
    paired.to_csv(output / 'paired_queue_deltas.csv')
    episodes.groupby('controller').mean_queue_including_pending.mean().plot.bar(ylabel='Mean queued vehicles (including pending)', rot=0)
    plt.tight_layout(); plt.savefig(output / 'queue_comparison.png', dpi=160); plt.close()
    report = {'model': str(Path(model_path).resolve()), 'contract': metadata['contract'],
              'config': asdict(config), 'seeds': list(seeds), 'scenarios': list(scenarios),
              'note': 'Lower queue is better. Negative paired PPO-minus-baseline deltas favor PPO. Fixed observation horizon; final phase may be partially observed. No real-world performance claim.'}
    (output / 'evaluation.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    return episodes, summary

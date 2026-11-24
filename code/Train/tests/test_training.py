import json
import shutil
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from traffic_training.classifier import audit_dataset, image_transform
from traffic_training.sumo_env import SumoConfig, TrafficSumoEnv, command_for_action
from traffic_training.rl import train_policy, evaluate_policy, load_policy


def test_image_preprocessing_and_leakage(tmp_path):
    rng = np.random.default_rng(7)
    for split in ('train', 'val', 'test'):
        for label in ('busy', 'clear'):
            folder = tmp_path / split / label
            folder.mkdir(parents=True)
            Image.fromarray(rng.integers(0, 256, (40, 80, 3), dtype=np.uint8)).save(folder / 'sample.png')
    assert audit_dataset(tmp_path)['classes'] == ['busy', 'clear']
    tensor = image_transform(64)(Image.new('RGB', (100, 30), (255, 0, 0)))
    assert tuple(tensor.shape) == (3, 64, 64)
    assert tensor[0].min() == 1 and tensor[1:].max() == 0
    shutil.copy2(tmp_path / 'train/busy/sample.png', tmp_path / 'test/busy/sample.png')
    with pytest.raises(ValueError, match='leakage'): audit_dataset(tmp_path)


def test_sumo_strict_holds_and_horizon():
    from stable_baselines3.common.env_checker import check_env
    env = TrafficSumoEnv(SumoConfig(horizon_seconds=50))
    try:
        check_env(env, warn=True)
        first, _ = env.reset(seed=123)
        assert env.elapsed == 2
        _, _, _, done, info = env.step(0)
        assert info['command']['redAxis'] == 'north_south'
        assert info['command']['observed_hold_s'] == 10
        assert info['command']['end_s'] - info['command']['start_s'] == 15
        assert not done and env.next_red_ns is False
        _, _, _, done, info = env.step(7)
        assert done and info['elapsed_s'] == 50
        assert info['command']['observed_yellow_s'] == 0
        assert not info['command']['completed']
        assert env.connection.trafficlight.getRedYellowGreenState('center') == 'GrGr'
        expected, _ = env.reset(seed=123)
        np.testing.assert_array_equal(first, expected)
    finally:
        env.close()


def test_ppo_save_load_and_paired_evaluation(tmp_path):
    config = SumoConfig(horizon_seconds=40)
    train_policy(tmp_path / 'model', config, total_timesteps=16, n_steps=8, batch_size=4)
    model = tmp_path / 'model/policy.zip'
    load_policy(model, config)
    with pytest.raises(ValueError, match='contract'):
        load_policy(model, replace(config, durations=(10, 30)))
    episodes, _ = evaluate_policy(model, tmp_path / 'eval', config, seeds=[1000001], scenarios=['balanced'], fixed_seconds=[30])
    assert len(episodes) == 2
    assert episodes.demand_vehicles.nunique() == 1
    assert episodes.elapsed_s.tolist() == [40, 40]
    assert episodes.collisions.sum() == 0
    assert (tmp_path / 'eval/phase_traces.csv').exists()
    preview = command_for_action(2, 'east_west')
    assert preview['redSeconds'] == 30


def test_notebooks_validate():
    import nbformat
    for path in (Path(__file__).resolve().parents[1] / 'notebooks').glob('*.ipynb'):
        notebook = nbformat.read(path, as_version=4)
        nbformat.validate(notebook)
        for cell in notebook.cells:
            if cell.cell_type == 'code': compile(cell.source, str(path), 'exec')

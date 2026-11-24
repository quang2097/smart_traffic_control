import json
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from traffic_training.simulation_ui import SimulationManager, make_handler
from traffic_training.sumo_env import ROOT


def until(manager, predicate, timeout=25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = manager.state()
        assert state['status'] != 'error', state.get('error')
        if predicate(state): return state
        time.sleep(.02)
    raise AssertionError(manager.state())


def test_interactive_pause_step_and_next_duration(tmp_path):
    # Use the real network sources; reports are isolated in the test directory.
    import shutil
    shutil.copytree(ROOT / 'sumo', tmp_path / 'sumo')
    manager = SimulationManager(tmp_path)
    try:
        manager.control({'action': 'speed', 'value': 100})
        manager.start({'horizon': 100, 'seed': 42, 'duration': 30})
        ready = until(manager, lambda s: s['status'] == 'paused')
        assert ready['elapsed_s'] == 2
        time.sleep(.1)
        assert manager.state()['elapsed_s'] == 2
        manager.control({'action': 'play'})
        until(manager, lambda s: s.get('active_duration') == 30 and s['elapsed_s'] >= 4)
        manager.control({'action': 'pause'})
        paused = manager.state()['elapsed_s']
        time.sleep(.1)
        assert manager.state()['elapsed_s'] == paused
        manager.control({'action': 'duration', 'value': 10})
        assert manager.state()['active_duration'] == 30
        manager.control({'action': 'step'})
        phase = until(manager, lambda s: len(s['trace']) == 1 and s['status'] == 'paused')
        assert phase['trace'][0]['redSeconds'] == 30
        assert phase['elapsed_s'] == 37  # startup + locked 30 + 3 + 2
        manager.control({'action': 'step'})
        phase = until(manager, lambda s: len(s['trace']) == 2 and s['status'] == 'paused')
        assert phase['trace'][1]['redAxis'] == 'east_west'
        assert phase['trace'][1]['redSeconds'] == 10
        assert phase['elapsed_s'] == 52
        manager.control({'action': 'stop'})
        until(manager, lambda s: s['status'] == 'stopped')
        manager.worker.join(5)
        report = manager.state(full=True)
        assert len(report['full_history']) == 52
        assert Path(report['report_path']).exists()
    finally:
        manager.shutdown()


def test_http_contract_and_local_origin(tmp_path):
    manager = SimulationManager(tmp_path)
    server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(manager))
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    base = f'http://127.0.0.1:{server.server_address[1]}'
    try:
        assert b'Live junction' in urlopen(base).read()
        assert json.load(urlopen(base + '/api/state'))['status'] == 'idle'
        request = Request(base + '/api/start', data=json.dumps({'horizon': 1}).encode(), headers={'Content-Type': 'application/json'})
        with pytest.raises(HTTPError) as error: urlopen(request)
        assert error.value.code == 400
        request = Request(base + '/api/control', data=b'{"action":"play"}', headers={'Content-Type': 'application/json', 'Origin': 'https://example.com'})
        with pytest.raises(HTTPError) as error: urlopen(request)
        assert error.value.code == 403
        assert b'time_s,halted_ns' in urlopen(base + '/api/export.csv').read()
        with pytest.raises(ValueError): manager.policy_path('../outside/policy.zip')
    finally:
        server.shutdown(); server.server_close(); manager.shutdown(); thread.join(5)

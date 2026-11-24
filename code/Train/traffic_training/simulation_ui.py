"""Loopback-only SUMO test bench. One worker owns all TraCI calls."""
from __future__ import annotations

import argparse
import base64
import csv
import io
import json
import math
import threading
import time
import uuid
import zipfile
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from .sumo_env import ROOT, SumoConfig, TrafficSumoEnv


class SimulationStopped(Exception):
    pass


class SimulationManager:
    def __init__(self, root=ROOT):
        self.root = Path(root).resolve()
        self.condition = threading.Condition(threading.RLock())
        self.worker = None
        self.paused = True
        self.at_rest = False
        self.single_phase = False
        self.stopping = False
        self.speed = 10.
        self.duration = 30
        self.history = []
        self.snapshot = {'status': 'idle', 'elapsed_s': 0, 'signals': 'rrrr', 'vehicles': [], 'history': [], 'trace': []}

    def state(self, full=False):
        with self.condition:
            return json.loads(json.dumps({**self.snapshot, 'paused': self.paused,
                                         'stepping': self.single_phase,
                                         **({'full_history': self.history} if full else {}),
                                         'speed': self.speed, 'next_duration': self.duration}))

    def policies(self):
        result = []
        for path in sorted((self.root / 'outputs').rglob('policy.zip')):
            if path.with_name('policy_metadata.json').is_file():
                result.append({'id': str(path.relative_to(self.root)).replace('\\', '/'),
                               'name': str(path.parent.relative_to(self.root)).replace('\\', '/')})
        return result

    def policy_path(self, value):
        path = (self.root / str(value)).resolve()
        if not path.is_relative_to(self.root / 'outputs') or path.name != 'policy.zip' or not path.is_file():
            raise ValueError('Choose an available policy from the list, or import a policy and its metadata.')
        return path

    def upload_policy(self, body):
        raw = base64.b64decode(body['model'], validate=True)
        if len(raw) > 32 * 1024 * 1024 or not zipfile.is_zipfile(io.BytesIO(raw)):
            raise ValueError('Choose a PPO policy.zip smaller than 32 MB.')
        metadata = body['metadata']
        if not isinstance(metadata, dict) or metadata.get('algorithm') != 'PPO' or 'contract' not in metadata:
            raise ValueError('Choose the policy_metadata.json exported with this PPO model.')
        folder = self.root / 'outputs' / 'sumo-ui' / 'imports' / uuid.uuid4().hex
        folder.mkdir(parents=True)
        (folder / 'policy.zip').write_bytes(raw)
        (folder / 'policy_metadata.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
        return {'id': str((folder / 'policy.zip').relative_to(self.root)).replace('\\', '/')}

    def start(self, body):
        def integer(name, default, low, high):
            value = body.get(name, default)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value or not low <= value <= high:
                raise ValueError(f'{name} must be an integer from {low} to {high}.')
            return int(value)
        config = SumoConfig(network_dir=str(self.root / 'sumo' / 'junction'),
                            horizon_seconds=integer('horizon', 600, 10, 7200),
                            scenario=body.get('scenario', 'balanced'),
                            ns_rate=float(body.get('ns_rate', .24)), ew_rate=float(body.get('ew_rate', .24)))
        config.validate()
        seed = integer('seed', 2000001, 0, 2**31 - 1)
        duration = integer('duration', 30, 10, 180)
        if duration not in config.durations: raise ValueError('Choose a duration from the action table.')
        controller = body.get('controller', 'fixed')
        if controller not in ('fixed', 'ppo'): raise ValueError('Choose fixed/manual or PPO control.')
        policy = self.policy_path(body.get('policy', '')) if controller == 'ppo' else None
        with self.condition:
            if self.worker is not None and self.worker.is_alive(): raise ValueError('Stop the current simulation before starting another.')
            self.paused = True; self.single_phase = False; self.stopping = False; self.duration = duration
            self.at_rest = False
            self.history = []
            self.snapshot = {'status': 'loading', 'elapsed_s': 0, 'signals': 'rrrr', 'vehicles': [],
                             'history': [], 'trace': [], 'controller': controller, 'config': asdict(config),
                             'seed': seed, 'policy': str(policy.relative_to(self.root)) if policy else None}
            self.worker = threading.Thread(target=self._run, args=(config, seed, policy), daemon=True)
            self.worker.start()
        return self.state()

    def control(self, body):
        with self.condition:
            action = body.get('action')
            if action == 'speed':
                value = float(body['value'])
                if not math.isfinite(value) or not 1 <= value <= 500: raise ValueError('Speed must be 1–500x.')
                self.speed = value
            elif action == 'duration':
                value = body['value']
                if value not in SumoConfig().durations: raise ValueError('Choose a duration from the action table.')
                if self.snapshot.get('controller') == 'ppo': raise ValueError('The PPO policy selects duration in this run.')
                self.duration = int(value)
            elif action in ('play', 'pause', 'step', 'stop'):
                if self.worker is None or not self.worker.is_alive() or self.snapshot['status'] == 'loading':
                    raise ValueError('Load a simulation first.')
                if action == 'stop': self.stopping = True
                elif action == 'play': self.paused = False; self.single_phase = False
                elif action == 'pause':
                    self.paused = True; self.single_phase = False
                    self.condition.notify_all()
                    self.condition.wait_for(lambda: self.at_rest or self.snapshot['status'] in ('finished', 'stopped', 'error'), timeout=5)
                else: self.paused = True; self.single_phase = True
            else: raise ValueError('Unknown simulation control.')
            if self.snapshot['status'] in ('running', 'paused'):
                self.snapshot['status'] = 'running' if not self.paused or self.single_phase else 'paused'
            self.condition.notify_all()
        return self.state()

    def _gate(self):
        with self.condition:
            while self.paused and not self.single_phase and not self.stopping:
                self.at_rest = True
                self.condition.notify_all()
                self.condition.wait()
            self.at_rest = False
            if self.stopping: raise SimulationStopped()

    def _run(self, config, seed, policy):
        env = TrafficSumoEnv(config)
        history = []
        initializing = True
        def tick(current, signals, remaining):
            halted, vehicles, pending, waiting = current._counts()
            ids = current.connection.vehicle.getIDList()
            positions = [{'id': name, 'position': current.connection.vehicle.getPosition(name),
                          'angle': current.connection.vehicle.getAngle(name),
                          'speed': current.connection.vehicle.getSpeed(name)} for name in ids[:400]]
            history.append({'time_s': current.elapsed, 'halted_ns': halted[0], 'halted_ew': halted[1],
                            'pending_ns': pending[0], 'pending_ew': pending[1], 'arrived': current.arrived})
            with self.condition:
                self.history = history
                self.snapshot.update(current.metrics(), signals=signals, stage_remaining_s=remaining,
                    stage='startup' if initializing else ('clearance' if signals == 'rrrr' else 'yellow' if 'y' in signals else 'hold'),
                    vehicles=positions, displayed_vehicles=len(positions), network_vehicles=len(ids),
                    halted=halted, incoming=vehicles, pending=pending, mean_wait=waiting,
                    history=history[-300:], trace=list(current.trace), next_red_axis='north_south' if current.next_red_ns else 'east_west')
            if not initializing:
                self._gate()
                with self.condition:
                    # Speed/pause changes wake this wait; all TraCI calls stay on this worker.
                    self.condition.wait(timeout=1. / self.speed)
                self._gate()
        env.on_tick = tick
        try:
            model = None
            if policy:
                from .rl import load_policy
                model, _ = load_policy(policy, config)
            observation, _ = env.reset(seed=seed)
            initializing = False
            with self.condition: self.snapshot['status'] = 'paused'
            while not env.finished:
                self._gate()
                with self.condition:
                    action = config.durations.index(self.duration) if model is None else None
                if model is not None: action = int(model.predict(observation, deterministic=True)[0])
                with self.condition:
                    self.snapshot.update(active_duration=config.durations[action], active_red_axis='north_south' if env.next_red_ns else 'east_west')
                observation, _, _, _, _ = env.step(action)
                with self.condition:
                    self.snapshot.update(trace=list(env.trace), **env.metrics())
                    if self.single_phase:
                        self.single_phase = False; self.snapshot['status'] = 'paused'
            with self.condition: self.snapshot['status'] = 'finished'
        except SimulationStopped:
            with self.condition: self.snapshot['status'] = 'stopped'
        except Exception as error:
            with self.condition: self.snapshot.update(status='error', error=str(error))
        finally:
            env.close()
            with self.condition:
                self.paused = True
                self.snapshot['trace'] = list(env.trace)
                try:
                    folder = self.root / 'outputs' / 'sumo-ui' / 'runs' / (time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
                    folder.mkdir(parents=True)
                    self.snapshot['report_path'] = str(folder / 'report.json')
                    (folder / 'report.json').write_text(json.dumps({**self.snapshot, 'full_history': history}, indent=2), encoding='utf-8')
                except OSError as error:
                    self.snapshot['save_error'] = str(error)
                self.condition.notify_all()

    def shutdown(self):
        with self.condition:
            self.stopping = True; self.condition.notify_all()
        if self.worker: self.worker.join(timeout=10)


def make_handler(manager):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass

        def send(self, data, content_type='application/json', status=200, filename=None):
            if content_type == 'application/json': data = json.dumps(data).encode()
            elif isinstance(data, str): data = data.encode()
            self.send_response(status)
            self.send_header('Content-Type', content_type + '; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            if filename: self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
            self.end_headers(); self.wfile.write(data)

        def local_request(self):
            port = self.server.server_address[1]
            hosts = (f'127.0.0.1:{port}', f'localhost:{port}')
            origin = self.headers.get('Origin')
            if self.headers.get('Host') not in hosts or origin and origin not in tuple('http://' + h for h in hosts):
                self.send({'error': 'Local same-origin access only.'}, status=403)
                return False
            return True

        def do_GET(self):
            if not self.local_request(): return
            path = urlsplit(self.path).path
            if path == '/': self.send((Path(__file__).parent / 'ui' / 'index.html').read_text(encoding='utf-8'), 'text/html')
            elif path == '/api/state': self.send(manager.state())
            elif path == '/api/policies': self.send(manager.policies())
            elif path == '/api/export': self.send(manager.state(full=True), filename='sumo-run.json')
            elif path == '/api/export.csv':
                state = manager.state(full=True); history = state['full_history']
                stream = io.StringIO(); writer = csv.DictWriter(stream, fieldnames=['time_s', 'halted_ns', 'halted_ew', 'pending_ns', 'pending_ew', 'arrived'])
                writer.writeheader(); writer.writerows(history)
                self.send(stream.getvalue(), 'text/csv', filename='sumo-metrics.csv')
            else: self.send({'error': 'Not found'}, status=404)

        def do_POST(self):
            if not self.local_request(): return
            try:
                if self.headers.get('Content-Type') != 'application/json': raise ValueError('Expected application/json.')
                length = int(self.headers.get('Content-Length', 0))
                if not 0 < length <= 50 * 1024 * 1024: raise ValueError('Invalid request size (50 MB maximum).')
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict): raise ValueError('Expected a settings object.')
                if self.path == '/api/start': result = manager.start(body)
                elif self.path == '/api/control': result = manager.control(body)
                elif self.path == '/api/policy': result = manager.upload_policy(body)
                else: self.send({'error': 'Not found'}, status=404); return
                self.send(result)
            except (ValueError, KeyError, TypeError, OSError) as error:
                self.send({'error': str(error)}, status=400)
    return Handler


def main():
    parser = argparse.ArgumentParser(description='Local SUMO simulation test bench')
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    manager = SimulationManager()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(manager))
    print(f'SUMO Test Bench: http://127.0.0.1:{server.server_address[1]} (Ctrl+C to stop)', flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close(); manager.shutdown()


if __name__ == '__main__': main()

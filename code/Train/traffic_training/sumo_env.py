"""SUMO/TraCI environment with latched ESP32-compatible hold durations.

No HTTP calls, device credentials or live signal control exist in this module.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import uuid
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass
from pathlib import Path

import gymnasium as gym
import numpy as np
import sumolib
import traci
from gymnasium import spaces

ROOT = Path(__file__).resolve().parents[1]
OBSERVATION_NAMES = ['halted_ns', 'halted_ew', 'vehicles_ns', 'vehicles_ew', 'pending_ns', 'pending_ew', 'mean_wait_ns', 'mean_wait_ew', 'next_red_is_ns']
OBSERVATION_SCALE = np.array([50, 50, 100, 100, 100, 100, 180, 180, 1], dtype=np.float32)


@dataclass
class SumoConfig:
    network_dir: str = str(ROOT / 'sumo' / 'junction')
    horizon_seconds: int = 1800
    durations: tuple[int, ...] = (10, 20, 30, 45, 60, 90, 120, 180)
    ns_rate: float = .24  # Combined North+South vehicles/second.
    ew_rate: float = .24
    scenario: str = 'balanced'
    gui: bool = False
    sumo_binary: str | None = None

    def validate(self):
        if self.horizon_seconds < 10 or not self.durations or len(set(self.durations)) != len(self.durations):
            raise ValueError('Use horizon >=10 and unique duration actions.')
        if any(type(value) is not int or value < 10 or value > 180 for value in self.durations):
            raise ValueError('Every hold must be an integer 10–180 seconds, matching the ESP32 API.')
        if not 0 <= self.ns_rate <= 2 or not 0 <= self.ew_rate <= 2:
            raise ValueError('Arrival rates must be 0–2 vehicles/second per combined axis.')
        if self.scenario not in ('balanced', 'ns_peak', 'ew_peak', 'burst'):
            raise ValueError('Unknown demand scenario.')


def find_binary(name):
    """Honor PATH/SUMO_HOME, then the official eclipse-sumo Python distribution."""
    explicit = shutil.which(name)
    if explicit: return explicit
    executable = name + ('.exe' if os.name == 'nt' else '')
    if os.environ.get('SUMO_HOME'):
        candidate = Path(os.environ['SUMO_HOME']) / 'bin' / executable
        if candidate.exists(): return str(candidate)
    try:
        import sumo
        candidate = Path(sumo.__file__).resolve().parent / 'bin' / executable
        if candidate.exists(): return str(candidate)
    except ImportError:
        pass
    try:
        return sumolib.checkBinary(name)
    except Exception as error:
        raise RuntimeError(f'{name} not found. Install eclipse-sumo or configure SUMO_HOME/PATH.') from error


def build_network(directory=None):
    directory = Path(directory or ROOT / 'sumo' / 'junction').resolve()
    result = subprocess.run([find_binary('netconvert'), '--node-files', str(directory / 'junction.nod.xml'),
                             '--edge-files', str(directory / 'junction.edg.xml'), '--connection-files', str(directory / 'junction.con.xml'),
                             '--tllogic-files', str(directory / 'junction.tll.xml'), '--output-file', str(directory / 'junction.net.xml'),
                             '--no-turnarounds', 'true'], capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f'netconvert failed:\n{result.stderr}')
    return directory / 'junction.net.xml'


def make_demand(config: SumoConfig, path: Path, seed: int):
    """Pre-generate all demand independently of policy actions for paired evaluation."""
    rng = np.random.default_rng(seed); vehicles = []
    for second in range(config.horizon_seconds):
        ns, ew = config.ns_rate, config.ew_rate
        if config.scenario == 'ns_peak': ns *= 1.6; ew *= .6
        elif config.scenario == 'ew_peak': ns *= .6; ew *= 1.6
        elif config.scenario == 'burst':
            if (second // 180) % 2 == 0: ns *= 1.8; ew *= .5
            else: ns *= .5; ew *= 1.8
        for axis, rate in [('ns', ns), ('ew', ew)]:
            for _ in range(rng.poisson(rate)):
                route = axis + str(int(rng.integers(0, 2)))
                vehicles.append((second + float(rng.random()), axis, route))
    vehicles.sort(key=lambda item: item[0])
    root = ET.Element('routes')
    ET.SubElement(root, 'vType', id='car', accel='2.6', decel='4.5', sigma='0', length='5', minGap='2.5', maxSpeed='13.89', speedDev='0')
    for name, edges in {'ns0': 'N_in S_out', 'ns1': 'S_in N_out', 'ew0': 'E_in W_out', 'ew1': 'W_in E_out'}.items():
        ET.SubElement(root, 'route', id=name, edges=edges)
    due = [[], []]
    for index, (depart, axis, route) in enumerate(vehicles):
        ET.SubElement(root, 'vehicle', id=f'{axis}_{index}', type='car', route=route, depart=f'{depart:.3f}', departLane='0', departSpeed='max')
        due[0 if axis == 'ns' else 1].append(round(depart, 3))
    ET.ElementTree(root).write(path, encoding='utf-8', xml_declaration=True)
    return [np.asarray(items) for items in due]


class TrafficSumoEnv(gym.Env):
    metadata = {'render_modes': []}

    def __init__(self, config: SumoConfig | None = None):
        super().__init__(); self.config = config or SumoConfig(); self.config.validate()
        self.action_space = spaces.Discrete(len(self.config.durations))
        self.observation_space = spaces.Box(0, 1, shape=(len(OBSERVATION_NAMES),), dtype=np.float32)
        self.connection = None; self.directory = None; self.trace = []
        self.tls = 'center'; self.next_red_ns = True
        self.on_tick = None  # Optional UI observer; training has no observer/pacing.

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed); self.close()
        if seed is None: seed = int(self.np_random.integers(0, 2**31 - 1))
        network = Path(self.config.network_dir) / 'junction.net.xml'
        if not network.exists(): build_network(self.config.network_dir)
        self.directory = tempfile.TemporaryDirectory(prefix='traffic-sumo-')
        folder = Path(self.directory.name); self.tripfile = folder / 'trips.xml'
        self.due = make_demand(self.config, folder / 'routes.rou.xml', int(seed))
        self.departed = [0, 0]; self.arrived = 0; self.integral_queue = 0.; self.max_queue = 0; self.collisions = 0
        self.next_red_ns = True; self.trace = []; self.finished = False; self.elapsed = 0
        label = 'traffic_' + uuid.uuid4().hex
        command = [self.config.sumo_binary or find_binary('sumo-gui' if self.config.gui else 'sumo'),
                   '--net-file', str(network.resolve()), '--route-files', str(folder / 'routes.rou.xml'), '--seed', str(seed),
                   '--step-length', '1', '--no-step-log', 'true', '--duration-log.disable', 'true', '--time-to-teleport', '-1',
                   '--tripinfo-output', str(self.tripfile), '--tripinfo-output.write-unfinished', 'true']
        if self.config.gui: command += ['--start', '--quit-on-end']
        try:
            traci.start(command, label=label, verbose=False)
            self.connection = traci.getConnection(label)
            links = self.connection.trafficlight.getControlledLinks(self.tls)
            incoming = [group[0][0] for group in links]
            if incoming != ['N_in_0', 'E_in_0', 'S_in_0', 'W_in_0']:
                raise ValueError(f'Unexpected TLS link ordering: {incoming}. Do not train with an unverified phase map.')
            self._advance('rrrr', 2)  # Startup all-red, matching the firmware.
            return self._observation(), {'simulation': 'SUMO', 'seed': int(seed)}
        except Exception:
            self.close(); raise

    def _counts(self):
        c = self.connection
        lanes = [('N_in_0', 'S_in_0'), ('E_in_0', 'W_in_0')]
        halted = [sum(c.lane.getLastStepHaltingNumber(lane) for lane in group) for group in lanes]
        vehicles = [sum(c.lane.getLastStepVehicleNumber(lane) for lane in group) for group in lanes]
        waiting = [sum(c.lane.getWaitingTime(lane) for lane in group) / max(vehicles[index], 1) for index, group in enumerate(lanes)]
        pending = [max(0, int(np.searchsorted(self.due[index], self.elapsed, side='right')) - self.departed[index]) for index in range(2)]
        return halted, vehicles, pending, waiting

    def _observation(self):
        halted, vehicles, pending, waiting = self._counts()
        return np.clip(np.array([*halted, *vehicles, *pending, *waiting, float(self.next_red_ns)], dtype=np.float32) / OBSERVATION_SCALE, 0, 1)

    def _advance(self, state, seconds):
        if self.elapsed >= self.config.horizon_seconds:
            return 0  # Observation cutoff must not initiate another signal state.
        self.connection.trafficlight.setRedYellowGreenState(self.tls, state)
        count = 0
        for _ in range(seconds):
            if self.elapsed >= self.config.horizon_seconds: break
            self.connection.simulationStep(); self.elapsed += 1; count += 1
            for vehicle in self.connection.simulation.getDepartedIDList():
                self.departed[0 if vehicle.startswith('ns_') else 1] += 1
            self.arrived += self.connection.simulation.getArrivedNumber()
            self.collisions += self.connection.simulation.getCollidingVehiclesNumber()
            halted, _, pending, _ = self._counts(); queue = sum(halted) + sum(pending)
            self.integral_queue += queue; self.max_queue = max(self.max_queue, queue)
            if self.on_tick is not None:
                self.on_tick(self, state, seconds - count)
        return count

    def step(self, action):
        if self.connection is None or self.finished: raise RuntimeError('Call reset() before step().')
        if not self.action_space.contains(action): raise ValueError('Action outside configured duration table.')
        seconds = self.config.durations[int(action)]  # Latched for this complete decision; no intervening actions.
        before = self.integral_queue; start = self.elapsed; red_ns = self.next_red_ns
        # netconvert orders these links clockwise: N, E, S, W.
        states = [('rGrG' if red_ns else 'GrGr', seconds), ('ryry' if red_ns else 'yryr', 3), ('rrrr', 2)]
        executed = [self._advance(state, duration) for state, duration in states]
        complete = sum(executed) == seconds + 5
        if complete: self.next_red_ns = not self.next_red_ns
        self.finished = self.elapsed >= self.config.horizon_seconds
        record = {'start_s': start, 'end_s': self.elapsed, 'redAxis': 'north_south' if red_ns else 'east_west',
                  'redSeconds': seconds, 'yellowSeconds': 3, 'clearanceSeconds': 2, 'completed': complete,
                  'observed_hold_s': executed[0], 'observed_yellow_s': executed[1], 'observed_clearance_s': executed[2]}
        self.trace.append(record)
        reward = -(self.integral_queue - before) / 1000.
        return self._observation(), float(reward), False, self.finished, {'command': record, **self.metrics()}

    def metrics(self):
        demand = sum(len(values) for values in self.due)
        return {'elapsed_s': self.elapsed, 'demand_vehicles': demand, 'departed_vehicles': sum(self.departed),
                'arrived_vehicles': self.arrived, 'unfinished_demand': demand - self.arrived,
                'queued_vehicle_seconds': self.integral_queue, 'mean_queue_including_pending': self.integral_queue / max(self.elapsed, 1),
                'max_queue_including_pending': self.max_queue, 'collisions': self.collisions,
                'decision_count': len(self.trace)}

    def close(self):
        if self.connection is not None:
            self.connection.close(); self.connection = None
        if self.directory is not None:
            self.directory.cleanup(); self.directory = None


def command_for_action(action: int, red_axis: str, durations=(10,20,30,45,60,90,120,180)):
    """Offline command preview only. Never sends a command to the real server."""
    if red_axis not in ('north_south','east_west') or not 0 <= int(action) < len(durations): raise ValueError('Invalid policy action/axis.')
    return {'redAxis': red_axis, 'redSeconds': int(durations[int(action)]), 'requestId': str(uuid.uuid4())}

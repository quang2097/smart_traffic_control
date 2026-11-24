# Smart Traffic model training

Four Jupyter notebooks cover YOLO **classification** training/evaluation and PPO training/evaluation using **real SUMO + TraCI**. They share importable Python helpers and standalone evaluation scripts. Nothing here sends commands to the server or ESP32.

## Setup (Windows PowerShell)

From this `Train` folder, install Python 3.12 and [uv](https://docs.astral.sh/uv/), then:

```powershell
uv venv --python 3.12 .venv
uv pip install --python .venv -r requirements.txt
.venv\Scripts\python.exe -m jupyterlab
```

Open notebooks in order, edit their configuration cells and run them. Use this environment's Python kernel. CPU works; for CUDA, install the matching PyTorch build first and select a device supported by your installation. Initial model weights may download when a named pretrained checkpoint is first used. Only load trusted `.pt`/`.zip` artifacts.

`eclipse-sumo` supplies Windows SUMO binaries; helpers also honor `PATH` and `SUMO_HOME`. `netconvert` builds the bundled four-arm network on first use. Set `gui=True` in the RL config for a visible SUMO simulation. Close the notebook environment after manual interactive stepping to release the simulator.

## Classification dataset and output

Supply a folder with `train/<class>`, `val/<class>` and `test/<class>`. Every split must contain the same two or more class folders, each with images. Names become model labels. Extract and label the desired video regions before training. Split by **source video, camera and time**, then extract frames, so adjacent frames do not leak across splits. The audit rejects corrupt images and exact cross-split duplicates; it cannot detect near duplicates or validate your labels.

The helper overrides Ultralytics' default center-crop preprocessing with square **stretch resize, RGB, NCHW, float /255**, matching the application's selected-ROI inference. Use a square size divisible by 32 (224 by default), then choose that same resolution in the demo. This prevents Ultralytics from silently rounding the training input size to its stride. There is no random image augmentation by default; this makes preprocessing explicit and avoids changing traffic-density semantics through random cropping. Validation selects `best.pt`; the test split is reserved for the evaluation notebook.

Training exports ordinary `classifier.pt`, its metadata, and Ultralytics training plots/checkpoints. Inference does not require the custom trainer classes. Select or upload the exported `.pt` in the application, or copy it into `../Web/backend/demo-library/models` and use the application's library scan/refresh workflow. Metadata records the input size and class names. Evaluation writes top-1/top-k accuracy, per-class precision/recall/F1, macro F1, a confusion matrix, predictions and warm-up-excluded batch forward latency. For <=5 classes, top-k can be trivially 100%; prefer top-1 and macro F1. Latency excludes decoding, resizing and network transport.

```powershell
.venv\Scripts\python.exe scripts/evaluate_classifier.py --model outputs/cv/classifier.pt --data datasets/traffic/test --output outputs/cv-test --image-size 224
```

## Reinforcement learning contract

The included SUMO junction has four incoming single lanes and straight movements only. It has no pedestrians, turning traffic or adjacent intersections. Demand is generated once per scenario/seed independently of the controller. Scenarios cover balanced, NS peak, EW peak and alternating bursts.

Each PPO action selects the **next red axis's hold duration** from `[10,20,30,45,60,90,120,180]` seconds. Axes alternate automatically, starting with NS red/EW green after 2 seconds startup all-red. The selected duration is locked, followed by 3 seconds yellow and 2 seconds all-red. There are no decisions during that sequence. This follows the ESP32 timer semantics; red duration does not include the added clearance. `command_for_action()` makes an offline JSON preview only.

Observations are normalized/clipped halted counts, incoming vehicle counts, scheduled-but-not-inserted demand and mean waiting time for each axis, plus the next red axis. See `OBSERVATION_NAMES` and `OBSERVATION_SCALE` for exact order/scales. Reward is minus halted-plus-pending vehicle-seconds /1000 over the action. Pending demand prevents a policy from hiding congestion outside the network. PPO uses gamma=1 and lambda=1 to avoid a per-decision discount unfairly favoring different duration lengths. Training timesteps count **decisions**, each advancing 15–185 simulation seconds, so full training can take substantial time.

Training randomizes scenarios and seeds below 1,000,000. Evaluation requires held-out seeds >=1,000,000 and compares deterministic PPO with fixed 30s/60s holds on identical demand, horizon and clearance. Use additional validation seeds to select hyperparameters, then reserve new test seeds for the final report. Outputs include per-episode metrics, mean/std by scenario, paired queue deltas, phase traces and a queue chart. Lower queue and negative PPO-minus-fixed deltas favor PPO; learned policies are not guaranteed to beat baselines. Unfinished demand is reported, and no vehicles teleport away. The fixed observation horizon may cut off a final phase; traces mark it incomplete and no extra switch is applied at cutoff.

```powershell
.venv\Scripts\python.exe scripts/evaluate_rl.py --model outputs/rl/policy.zip --output outputs/rl-test --seeds 2000001 2000002 2000003
```

Keep `policy.zip` and `policy_metadata.json` together: loading rejects mismatched action/observation contracts. Policy files may be placed in the server's policies library for listing, but live RL control remains under development. **SUMO queue observations are not currently supplied by the CV classifier.** A CV-to-observation bridge, deployment validation and real junction configuration are still needed before any deployment.

## Checks

```powershell
.venv\Scripts\python.exe -m pytest tests -q
```

Tests use a tiny generated image fixture and short SUMO simulations, not a labeled traffic benchmark. They check preprocessing, leakage detection, strict phases, action contracts and a PPO save/load/evaluation round trip. Full training requires your dataset and deliberate run settings. Generated datasets, environments and outputs are ignored by git.

For an end-to-end notebook smoke run, use `.venv\Scripts\python.exe scripts/smoke_notebooks.py`. It executes copies of all four notebooks using random images and short simulations, saves the executed notebooks under `outputs/smoke-*`, and verifies the classifier checkpoint loads in a separate process outside the training folder. Random-image accuracy is not a traffic benchmark.

References: [Ultralytics classification](https://docs.ultralytics.com/tasks/classify/), [SB3 PPO](https://stable-baselines3.readthedocs.io/en/master/modules/ppo.html), [SUMO TraCI](https://sumo.dlr.de/docs/TraCI/Interfacing_TraCI_from_Python.html), [manual traffic-light states](https://sumo.dlr.de/docs/Simulation/Traffic_Lights.html).


## SUMO visual test bench

Double-click `Launch-SUMO-UI.cmd` in this folder, then open **http://127.0.0.1:8765** in a browser. Or run:

```powershell
.venv\Scripts\python.exe scripts/launch_sumo_ui.py
```

The UI uses the existing training environment; no additional packages are needed. It binds to this computer only. To use a different port, add `--port 8766`. Ctrl+C in the launcher stops the server and its simulation.

1. Choose a demand scenario, run length (10–7200 seconds), seed, and per-axis base arrival rates.
2. Select **Fixed / manual durations** or a **Trained PPO policy**. Policies in `outputs/**/policy.zip` with a neighboring `policy_metadata.json` appear in the list. You can import those two files from another folder as well. Policy compatibility is checked when loading; errors appear in the UI.
3. Click **Load simulation**. It starts paused after the 2-second startup clearance. Use **Play**, **Pause**, or **Step phase**. Stepping finishes the current phase and its yellow/all-red clearance, then pauses at the next decision. Speed changes wall-clock pacing, not SUMO physics or phase durations; the selected speed is a target subject to machine performance.
4. In manual mode, change **Next phase duration** at any time. The new value is sampled at the next decision; it never changes the current locked hold. PPO chooses from the same action table automatically. Pausing freezes the simulation clock without resetting the hold.
5. Inspect the junction, per-axis stopped queues, pending insertion backlog, countdown, queue history, completed decisions and collisions. Vehicles/signals come from actual SUMO/TraCI; the junction is a readable schematic, not a street map. At most 400 vehicles are drawn; the network count and metrics include all vehicles. No separate SUMO GUI window is needed.
6. Export **Metrics CSV** or **Run JSON**. Exports include the full observed metric history, settings, seed and phase trace. Completed/stopped/failed runs also save JSON under `outputs/sumo-ui/runs/`. An explicit stop may interrupt a simulated phase: its final signal/countdown is saved, but only completed environment decisions appear in the trace. A horizon-cutoff decision is marked incomplete. Restart with the same scenario, seed and rates to compare a second controller on the same generated traffic; use the evaluation notebook for multi-seed aggregate comparisons.

This test bench runs offline simulation only. It does not train models, send ESP32 commands, or connect the CV classifier to RL observations. The RL integration remains marked as developing. Observation/action contracts and timing behavior are shared with the training notebooks.

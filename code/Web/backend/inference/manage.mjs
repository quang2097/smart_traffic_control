import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const python = fileURLToPath(new URL(process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python', import.meta.url));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: directory, stdio: 'inherit', windowsHide: true });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status || 1);
}
if (process.argv[2] === 'setup') {
  run('uv', ['venv', '--allow-existing', '--python', '3.12', '.venv']);
  run('uv', ['pip', 'install', '--python', python, '-r', 'requirements.txt']);
} else if (process.argv[2] === 'test') {
  run(python, ['-m', 'unittest', 'discover', '-s', '.', '-p', 'test_*.py']);
} else { console.error('Use setup or test.'); process.exit(1); }

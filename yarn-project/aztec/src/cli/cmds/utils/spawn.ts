import { spawn } from 'child_process';

/**
 * Spawns a command with inherited stdio and rejects on non-zero exit. With `stdoutToStderr`, the command's stdout goes
 * to this process's stderr, which leaves stdout free for output meant to be read by a caller.
 */
export function run(cmd: string, args: string[], { stdoutToStderr = false } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['inherit', stdoutToStderr ? process.stderr : 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`${cmd} exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

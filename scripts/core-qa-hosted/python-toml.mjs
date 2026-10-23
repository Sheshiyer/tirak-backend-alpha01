import { spawn } from 'node:child_process';

function createTomlReaderScript(selectExpression) {
  return [
    'import json, pathlib, sys, tomllib',
    'path = pathlib.Path(sys.argv[1])',
    'with path.open("rb") as handle:',
    '    data = tomllib.load(handle)',
    `selected = ${selectExpression}`,
    'print(json.dumps(selected))',
  ].join('\n');
}

function spawnJson(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`python3 tomllib parse failed with code ${code}: ${stderr.trim() || 'unknown error'}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`python3 tomllib parse returned invalid JSON: ${String(error?.message || error)}`));
      }
    });
  });
}

export async function readTomlSelection(filePath, selectExpression) {
  return spawnJson('python3', ['-c', createTomlReaderScript(selectExpression), filePath]);
}

export async function readOAuthToml(filePath) {
  return readTomlSelection(
    filePath,
    '{"oauth_token": data.get("oauth_token"), "expiration_time": data.get("expiration_time"), "scopes": data.get("scopes", [])}',
  );
}

export async function readWranglerToml(filePath) {
  return readTomlSelection(filePath, 'data');
}

// VS Code のターミナルなどでは ELECTRON_RUN_AS_NODE が設定されていて Electron が Node として動いてしまうため、外してから起動する
const { spawn } = require('child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env, windowsHide: false });
child.on('close', (code) => process.exit(code ?? 0));

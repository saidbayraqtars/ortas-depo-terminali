// Electron'u geliştirmede açar. Bu makinenin kabuğunda ELECTRON_RUN_AS_NODE=1 tanımlı olabilir;
// o varken Electron düz Node gibi çalışır ve pencere açılmaz. Değişkeni atıp başlatır.
// Kullanım: node scripts/electron-calistir.js [betik.js]   (betik yoksa program açılır)
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const hedef = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const child = spawn(electron, [hedef, ...process.argv.slice(3)], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));

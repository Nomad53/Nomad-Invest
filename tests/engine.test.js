'use strict';
require('node:child_process').execFileSync(process.execPath, [require('node:path').join(__dirname, '../api/nomad.js'), '--test'], { stdio: 'inherit' });

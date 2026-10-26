const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

describe('JavaScript syntax', function () {
    this.timeout(30000);

    for (const file of fs.readdirSync(root).filter(file => file.endsWith('.js')).sort()) {
        it(`parses ${file}`, function () {
            execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
        });
    }
});

// PostToolUse hook: runs `node --check` on a .js file Claude just edited or wrote. A syntax error
// exits 2 with the error on stderr, which Claude Code shows to Claude so it fixes the file at once.
// Named .cjs so the Screeps client never takes it for a game module.
const { spawnSync } = require('child_process');

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
    let file = '';
    try {
        const event = JSON.parse(input);
        file = (event.tool_input && event.tool_input.file_path) || (event.tool_response && event.tool_response.filePath) || '';
    } catch (error) {
        return;
    }
    if (!/\.js$/i.test(file)) return;
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
        process.stderr.write('Syntax check failed for ' + file + ':\n' + (result.stderr || result.error || ''));
        process.exit(2);
    }
});

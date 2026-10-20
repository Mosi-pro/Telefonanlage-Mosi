'use strict';
// Strukturierte JSON-Logs (eine Zeile pro Ereignis) auf stdout/stderr.
function write(level, msg, extra) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}
module.exports = {
  info: (msg, extra) => write('info', msg, extra),
  warn: (msg, extra) => write('warn', msg, extra),
  error: (msg, extra) => write('error', msg, extra),
};

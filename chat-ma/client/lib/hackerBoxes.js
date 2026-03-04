function center(line) {
  const cols = process.stdout.columns || 80;
  const pad = Math.max(0, Math.floor((cols - line.length) / 2));
  return `${' '.repeat(pad)}${line}`;
}

function buildBox(lines = []) {
  const width = Math.max(...lines.map((l) => l.length), 30) + 4;
  const top = `╔${'═'.repeat(width - 2)}╗`;
  const bottom = `╚${'═'.repeat(width - 2)}╝`;
  const rows = lines.map((line) => {
    const pad = width - 2 - line.length;
    const left = Math.floor(pad / 2);
    const right = pad - left;
    return `║${' '.repeat(left)}${line}${' '.repeat(right)}║`;
  });
  return [top, ...rows, bottom].map(center).join('\n');
}

export function showStatusBox(text) {
  process.stdout.write(`${buildBox(['', text, ''])}\n`);
}

export function showAuthorizedBox() {
  showStatusBox('AUTHORIZED TERMINAL');
}

export function showDeniedBox() {
  showStatusBox('ACCESS DENIED');
}

export function showMessageSentBox() {
  showStatusBox('MESSAGE SENT');
}

export function showMessageFailedBox() {
  showStatusBox('MESSAGE FAILED');
}

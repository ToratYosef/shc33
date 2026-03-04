const glyphs = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*+-?<>[]{}';

export function startMatrixRain(screen, targetBox) {
  const width = screen.width;
  const height = screen.height;
  const drops = Array.from({ length: width }, () => Math.floor(Math.random() * height));

  const timer = setInterval(() => {
    const frame = Array.from({ length: height }, () => Array.from({ length: width }, () => ' '));

    for (let x = 0; x < width; x += 1) {
      const y = drops[x];
      frame[y % height][x] = glyphs[Math.floor(Math.random() * glyphs.length)];
      if (Math.random() > 0.96) {
        drops[x] = 0;
      } else {
        drops[x] += 1 + (Math.random() > 0.7 ? 1 : 0);
      }
    }

    targetBox.setContent(`{green-fg}${frame.map((r) => r.join('')).join('\n')}{/green-fg}`);
    screen.render();
  }, 90);

  return () => clearInterval(timer);
}

const glitchChars = '!@#$%^&*?';

function mutate(text) {
  return text
    .split('')
    .map((c) => (Math.random() > 0.8 && c !== ' ' ? glitchChars[Math.floor(Math.random() * glitchChars.length)] : c))
    .join('');
}

export function startHeaderGlitch(headerBox, normalText, screen) {
  const timer = setInterval(() => {
    if (Math.random() > 0.82) {
      headerBox.setContent(`{green-fg}${mutate(normalText)}{/green-fg}`);
      screen.render();
      setTimeout(() => {
        headerBox.setContent(`{green-fg}${normalText}{/green-fg}`);
        screen.render();
      }, 140);
    }
  }, 700);

  return () => clearInterval(timer);
}

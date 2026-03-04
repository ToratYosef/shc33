const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runDecryptAnimation(setLine, message) {
  const initial = 'X'.repeat(message.length);
  setLine(initial);
  const duration = 1400 + Math.floor(Math.random() * 1200);
  const steps = Math.max(20, Math.floor(duration / 45));

  for (let s = 0; s < steps; s += 1) {
    const locked = Math.floor((s / steps) * message.length);
    let line = '';
    for (let i = 0; i < message.length; i += 1) {
      if (i <= locked) {
        line += message[i];
      } else {
        line += chars[Math.floor(Math.random() * chars.length)];
      }
    }
    setLine(line);
    await sleep(45);
  }

  setLine(message);
}

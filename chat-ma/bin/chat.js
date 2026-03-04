#!/usr/bin/env node
import blessed from 'blessed';
import ora from 'ora';
import cliProgress from 'cli-progress';
import { askCredentials, askSendPayload } from '../client/lib/prompts.js';
import { loadLocalConfig, requireAuthConfig, saveLocalConfig } from '../client/lib/localConfig.js';
import { printBanner } from '../client/lib/ui.js';
import {
  showAuthorizedBox,
  showDeniedBox,
  showMessageFailedBox,
  showMessageSentBox,
  showStatusBox
} from '../client/lib/hackerBoxes.js';
import { connectWs } from '../client/lib/wsClient.js';
import { runDecryptAnimation } from '../client/lib/decryptAnimation.js';
import { startHeaderGlitch } from '../client/lib/glitch.js';
import { startMatrixRain } from '../client/lib/matrixRain.js';

const [, , command] = process.argv;

async function postJson(url, payload, token) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function register() {
  printBanner();
  const cfg = loadLocalConfig();
  const { username, password } = await askCredentials('Register');
  const spinner = ora('Provisioning identity...').start();
  try {
    const data = await postJson(`${cfg.serverUrl}/register`, { username, password });
    spinner.succeed('Identity created');
    saveLocalConfig({ token: data.token, username: data.username, serverUrl: cfg.serverUrl });
    showAuthorizedBox();
  } catch (err) {
    spinner.fail(err.message);
    showDeniedBox();
  }
}

async function login() {
  printBanner();
  const cfg = loadLocalConfig();
  const { username, password } = await askCredentials('Login');
  const spinner = ora('Authenticating...').start();
  try {
    const data = await postJson(`${cfg.serverUrl}/login`, { username, password });
    spinner.succeed('Session established');
    saveLocalConfig({ token: data.token, username: data.username, serverUrl: cfg.serverUrl });
    showAuthorizedBox();
  } catch (err) {
    spinner.fail(err.message);
    showDeniedBox();
  }
}

async function send() {
  printBanner();
  const cfg = requireAuthConfig();
  const { to, body } = await askSendPayload();
  const bar = new cliProgress.SingleBar({ format: 'UPLINK [{bar}] {percentage}%' }, cliProgress.Presets.shades_classic);
  bar.start(100, 0);

  showStatusBox('INITIALIZING UPLINK');
  await new Promise((r) => setTimeout(r, 500));
  bar.update(40);
  showStatusBox('ENCAPSULATING PAYLOAD');
  await new Promise((r) => setTimeout(r, 500));
  bar.update(85);

  try {
    await postJson(`${cfg.serverUrl}/send`, { to, body }, cfg.token);
    bar.update(100);
    bar.stop();
    showMessageSentBox();
  } catch (err) {
    bar.stop();
    process.stdout.write(`${err.message}\n`);
    showMessageFailedBox();
  }
}

function askPasswordInScreen(screen) {
  return new Promise((resolve) => {
    const prompt = blessed.prompt({
      parent: screen,
      border: 'line',
      label: ' Decrypt ',
      top: 'center',
      left: 'center',
      width: '50%',
      height: 8,
      keys: true,
      vi: true,
      style: { border: { fg: 'green' }, fg: 'green' }
    });

    prompt.input('Enter password to decrypt:', '', (_err, value) => resolve(value || ''));
  });
}

async function openInbox() {
  const cfg = requireAuthConfig();

  const screen = blessed.screen({ smartCSR: true, title: 'chat-ma terminal' });
  const rain = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    tags: true,
    style: { fg: 'green' }
  });

  const headerText = 'AUTHORIZED TERMINAL';
  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 'center',
    width: 'shrink',
    height: 1,
    tags: true,
    content: `{green-fg}${headerText}{/green-fg}`
  });

  const status = blessed.box({
    parent: screen,
    bottom: 0,
    left: 1,
    height: 1,
    tags: true,
    content: `{green-fg}CONNECTED | USER: ${cfg.username} | ONE TIME MODE{/green-fg}`
  });

  const modal = blessed.list({
    parent: screen,
    width: 40,
    height: 11,
    top: 'center',
    left: 'center',
    border: 'line',
    style: {
      fg: 'green',
      border: { fg: 'green' },
      selected: { bg: 'green', fg: 'black' }
    },
    keys: true,
    vi: true,
    mouse: false,
    tags: true,
    hidden: true,
    label: ' INCOMING '
  });

  const messageBox = blessed.box({
    parent: screen,
    width: '70%',
    height: 9,
    top: 'center',
    left: 'center',
    border: 'line',
    style: { fg: 'green', border: { fg: 'green' } },
    tags: true,
    hidden: true
  });

  const stopRain = startMatrixRain(screen, rain);
  const stopGlitch = startHeaderGlitch(header, headerText, screen);

  let currentIncoming = null;

  const ws = connectWs(cfg.serverUrl, cfg.token, {
    onMessage: async (msg, socket) => {
      if (msg.type === 'INCOMING') {
        currentIncoming = msg;
        modal.setItems([
          '',
          ' NEW ENCRYPTED MESSAGE RECEIVED ',
          ` FROM: ${msg.from} (${msg.len} chars)`,
          '',
          ' [ VIEW ]',
          ' [ DISMISS ]'
        ]);
        modal.select(4);
        modal.show();
        modal.focus();
        screen.render();
        return;
      }

      if (msg.type === 'VIEW_PAYLOAD') {
        messageBox.show();
        messageBox.setContent('{green-fg}Decrypting...{/green-fg}');
        screen.render();

        await runDecryptAnimation((line) => {
          messageBox.setContent(`{green-fg}${line}{/green-fg}\n\n{green-fg}[ CLOSE ]{/green-fg}`);
          screen.render();
        }, msg.body);

        messageBox.key(['enter'], () => {
          socket.send(JSON.stringify({ type: 'VIEW_CLOSE', id: msg.id }));
          messageBox.hide();
          screen.render();
        });
        messageBox.focus();
      }

      if (msg.type === 'VIEW_MISSING') {
        messageBox.show();
        messageBox.setContent('{green-fg}MESSAGE EXPIRED OR ALREADY VIEWED{/green-fg}');
        screen.render();
        setTimeout(() => {
          messageBox.hide();
          screen.render();
        }, 1000);
      }
    }
  });

  modal.on('select', async (_el, index) => {
    if (!currentIncoming) return;
    if (index === 4) {
      modal.hide();
      screen.render();
      const password = await askPasswordInScreen(screen);
      try {
        await postJson(`${cfg.serverUrl}/verify-password`, { password }, cfg.token);
        ws.send(JSON.stringify({ type: 'VIEW_REQUEST', id: currentIncoming.id }));
      } catch {
        modal.setItems(['', ' ACCESS DENIED ', '', ' [ OK ]']);
        modal.select(3);
        modal.show();
        screen.render();
      }
    }

    if (index === 5 || index === 3) {
      modal.hide();
      currentIncoming = null;
      screen.render();
    }
  });

  screen.key(['C-c', 'q'], () => {
    stopRain();
    stopGlitch();
    ws.close();
    return process.exit(0);
  });

  screen.render();
}

async function main() {
  if (command === 'register') return register();
  if (command === 'login') return login();
  if (command === 'send') return send();
  if (command === 'open') return openInbox();

  process.stdout.write('Usage: chat-ma <register|login|send|open>\n');
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});

// Desktop-App: eigenes Fenster, darin Server, Regie und Spielansicht in einem Programm.

import { app, BrowserWindow, desktopCapturer, dialog, Menu, session, shell } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.MATCHDECK_PORT ?? 7270);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const CAPTURE_TITLE = new RegExp(process.env.MATCHDECK_CAPTURE_TITLE ?? '^osu!');

// Flüssiges Bild: GPU immer nutzen und nichts drosseln, auch wenn das Fenster im Hintergrund liegt.
for (const flag of ['ignore-gpu-blocklist', 'enable-gpu-rasterization', 'enable-zero-copy', 'disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows']) {
  app.commandLine.appendSwitch(flag);
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let window = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (window?.isMinimized()) window.restore();
  window?.focus();
});
app.on('window-all-closed', () => app.quit());

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${URL_BASE}/api/state`);
      if (response.ok) return true;
    } catch { /* Server startet noch */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
}

/** Holt das osu!tourney-Fenster in die App. Fremde Fenster werden nie ausgewählt. */
function allowTourneyCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
    const target = sources.find((source) => CAPTURE_TITLE.test(source.name) && !source.name.startsWith('Matchdeck'));
    if (target) callback({ video: target });
    else callback({});
  });
}

async function smokeCheck() {
  const output = process.env.MATCHDECK_SMOKE;
  if (!output) return;
  await new Promise((done) => setTimeout(done, Number(process.env.MATCHDECK_SMOKE_WAIT ?? 4000)));
  writeFileSync(output, (await window.webContents.capturePage()).toPNG());
  app.quit();
}

async function start() {
  process.env.MATCHDECK_DATA ??= join(app.getPath('userData'), 'data');
  Menu.setApplicationMenu(null);
  allowTourneyCapture();

  await import('../server/index.js');
  if (!(await waitForServer())) throw new Error(`Port ${PORT} ist belegt oder der Server startet nicht.`);

  window = new BrowserWindow({
    width: 1600,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    title: 'Matchdeck',
    backgroundColor: '#0b0c10',
    show: false,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  window.loadURL(URL_BASE);
  smokeCheck();
}

app.whenReady().then(start).catch((error) => {
  dialog.showErrorBox('Matchdeck konnte nicht starten', String(error?.stack ?? error));
  app.quit();
});

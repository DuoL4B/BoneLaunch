const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set([
  'app:init',
  'settings:set',
  'settings:reset',
  'game:detect',
  'game:running',
  'game:browse',
  'game:launch',
  'ts:list',
  'ts:readme',
  'mods:list',
  'mods:install',
  'mods:uninstall',
  'mods:toggle',
  'mods:applyEnabled',
  'mods:installZip',
  'ml:uninstall',
  'open:folder',
  'open:url',
  'log:read',
  'bg:pick',
  'cache:clear',
  'win:min',
  'win:max',
  'win:close',
]);
const EVENTS = new Set(['progress', 'win:state']);

contextBridge.exposeInMainWorld('bone', {
  async call(channel, ...args) {
    if (!CHANNELS.has(channel)) throw new Error('Unknown request: ' + channel);
    const res = await ipcRenderer.invoke(channel, ...args);
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  on(event, cb) {
    if (!EVENTS.has(event)) return;
    ipcRenderer.on(event, (_e, data) => cb(data));
  },
});

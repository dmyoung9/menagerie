import { readFile } from 'node:fs/promises';
import { Plugin } from '@opencode/plugin';
import { startDiscovery } from './discovery.ts';

export default Plugin.define({
  id: 'local.menagerie-discovery',
  async setup(ctx) {
    const settings = JSON.parse(
      await readFile(new URL('./settings.json', import.meta.url), 'utf8'),
    );
    const discovery = await startDiscovery(ctx, { baseURL: settings.baseURL });
    return () => discovery.dispose();
  },
});

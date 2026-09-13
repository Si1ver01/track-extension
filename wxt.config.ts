import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Listener Lens',
    description: 'Inspect registered browser listeners without collecting user payloads.',
    permissions: ['tabs'],
    browser_specific_settings: {
      gecko: { id: 'listener-lens@example.invalid', data_collection_permissions: { required: ['none'] } },
    },
  },
});

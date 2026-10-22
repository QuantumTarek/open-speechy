import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  outDir: '.output',
  manifest: {
    name: 'Open Speechy',
    description: 'Read web text aloud with local English and Arabic voices.',
    version: '0.1.0',
    minimum_chrome_version: '116',
    action: {
      default_title: 'Read with Open Speechy',
    },
    permissions: [
      'activeTab',
      'contextMenus',
      'declarativeNetRequest',
      'offscreen',
      'scripting',
      'storage',
      'tabs',
      'tts',
      'unlimitedStorage',
    ],
    host_permissions: [
      '<all_urls>',
      'http://127.0.0.1:5123/*',
      'https://huggingface.co/*',
    ],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    cross_origin_embedder_policy: {
      value: 'require-corp',
    },
    cross_origin_opener_policy: {
      value: 'same-origin',
    },
    commands: {
      'toggle-read': {
        suggested_key: {
          default: 'Alt+Shift+R',
        },
        description: 'Read or pause the current page',
      },
      'read-selection': {
        suggested_key: {
          default: 'Alt+Shift+S',
        },
        description: 'Read selected text',
      },
    },
    web_accessible_resources: [
      {
        resources: ['pdf-viewer.html', 'reader.html', 'assets/*'],
        matches: ['<all_urls>'],
      },
    ],
  },
  vite: () => ({
    define: {
      __OPEN_SPEECHY_FAKE_ENGINE__: JSON.stringify(
        process.env.VITE_OPEN_SPEECHY_FAKE_ENGINE === '1',
      ),
    },
    build: {
      target: 'es2022',
    },
    optimizeDeps: {
      include: ['react', 'react-dom'],
    },
  }),
});

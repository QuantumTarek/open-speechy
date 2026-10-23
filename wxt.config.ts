import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  outDir: '.output',
  manifest: {
    name: 'Open Speechy',
    description: 'Read web text aloud with local English and Arabic voices.',
    version: '0.1.0',
    // Fixes the extension ID (bomfkndoodmcdkcemfdncddboldmlcna) wherever the
    // unpacked build is loaded from. The server installer allows this ID to
    // start its native messaging host.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnDyTZIgo1sTSu5fM/6OUUBp86XvvCXeP+/07CG515ahvLODZyFi1mQxnciw24yaaJMk8F/1KkPAuunQ6a7nP0lqyMl2/PNsRmhCo1z90HeJUU/I3ueWX1diCNPdLLtKAIRUfZ9tSitLIGk5d7qOGd3ptLgMM31SeXhLEc/TAGLnccsjjPg4B4KxMaQiTbL1NwscGX1gpDuhpPACz2QKqd7e+IiTggUOA0mHRZsOzOUQY8quinK1smWpW3ZQ9OOW59WR48wz6rNIsrI9K0Irl1Lcb4E3PiEAXjzYbQaBHKLn6IHlNQ9TJ87N+VeA2lcCjDUOzciL9sUUxWMZ9DY+2PwIDAQAB',
    default_locale: 'en',
    minimum_chrome_version: '116',
    action: {
      default_title: 'Read with Open Speechy',
      default_popup: 'popup.html',
    },
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
    permissions: [
      'activeTab',
      'contextMenus',
      'declarativeNetRequest',
      'nativeMessaging',
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
    // The speech worker imports onnxruntime-web, which splits into chunks.
    worker: {
      format: 'es' as const,
    },
    optimizeDeps: {
      include: ['react', 'react-dom'],
    },
  }),
});

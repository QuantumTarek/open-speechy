declare const __OPEN_SPEECHY_FAKE_ENGINE__: boolean;

interface Window {
  __OPEN_SPEECHY_TEST__?: boolean;
  __OPEN_SPEECHY_TEST_HOOK__?: {
    startRead(): Promise<void>;
  };
}

interface HighlightRegistry {
  set(name: string, highlight: Highlight): this;
  get(name: string): Highlight | undefined;
  has(name: string): boolean;
  delete(name: string): boolean;
}

declare const __OPEN_SPEECHY_FAKE_ENGINE__: boolean;

declare module "@diffusionstudio/piper-wasm/build/piper_phonemize.js" {
  interface PiperPhonemizeModule {
    callMain(args: string[]): void;
    print: (message: string) => void;
  }

  interface PiperPhonemizeOptions {
    locateFile(path: string): string;
    print?(message: string): void;
    printErr?(message: string): void;
  }

  const createPiperPhonemize: (
    options: PiperPhonemizeOptions,
  ) => Promise<PiperPhonemizeModule>;
  export default createPiperPhonemize;
}

declare module "*?url" {
  const url: string;
  export default url;
}

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

import { ContentController } from "../content/controller";
import { defineContentScript } from "wxt/utils/define-content-script";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  main() {
    new ContentController(document, window);
  },
});

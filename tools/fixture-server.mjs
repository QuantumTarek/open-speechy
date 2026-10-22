import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const fixtureRoot = resolve(process.cwd(), "tests/fixtures");
const port = Number(process.env.FIXTURE_PORT ?? 4173);
const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".pdf", "application/pdf"],
  ["", "text/html; charset=utf-8"],
]);

createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const relativePath = decodeURIComponent(
      pathname === "/" ? "/en-article.html" : pathname,
    );
    const filePath = resolve(fixtureRoot, `.${relativePath}`);
    if (
      filePath !== fixtureRoot &&
      !filePath.startsWith(`${fixtureRoot}${sep}`)
    ) {
      response.writeHead(400).end("Invalid fixture path");
      return;
    }

    if (!(await stat(filePath)).isFile()) {
      response.writeHead(404).end("Fixture not found");
      return;
    }
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type":
        contentTypes.get(extname(filePath)) ?? "application/octet-stream",
      "content-length": body.byteLength,
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("Fixture not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Fixture server listening at http://127.0.0.1:${port}`);
});

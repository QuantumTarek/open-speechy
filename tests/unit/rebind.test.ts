import { describe, expect, it } from "vitest";
import { rebindSentencePieces } from "../../src/text/rebind";
import { segmentBlocks } from "../../src/text/segment";
import type { TextBlock } from "../../src/text/extract";

function block(text: string): TextBlock {
  const node = document.createTextNode(text);
  return {
    text,
    pieces: [{ node, start: 0, end: node.length, offset: 0 }],
    element: null,
  };
}

describe("mutation word-map rebind", () => {
  it("keeps audio word indices while replacing detached text-node ranges", () => {
    const original = segmentBlocks([block("First cat stays.")], () => "en");
    const refreshedNode = block("First dog stays.");
    const refreshed = segmentBlocks([refreshedNode], () => "en");

    const rebound = rebindSentencePieces(original, refreshed);

    expect(rebound[0].words.map((word) => word.index)).toEqual([0, 1, 2]);
    expect(rebound[0].words[0].pieces[0].node).toBe(
      refreshedNode.pieces[0].node,
    );
    expect(rebound[0].words[1].pieces).toEqual([]);
    const finalWord = rebound[0].words[2].pieces[0];
    expect(finalWord.node.data.slice(finalWord.start, finalWord.end)).toBe(
      "stays",
    );
  });
});

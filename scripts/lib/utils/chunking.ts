// Parent-child chunking strategy
import { createHash } from "crypto";
import type { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

export interface ParentRecord {
  _id: string;
  content: string;
  source: string;
  url: string;
  category: string;
  scrapedAt: string;
  type: "parent";
}

export interface ChildRecord {
  _id: string;
  content: string;
  parentId: string;
  source: string;
  url: string;
  category: string;
  scrapedAt: string;
  type: "child";
  $vector?: number[];
}

export interface ChunkingResult {
  parentDocs: ParentRecord[];
  childTexts: string[];
  childMeta: { parentId: string }[];
}

export const createParentChildChunks = async (
  content: string,
  parentSplitter: RecursiveCharacterTextSplitter,
  childSplitter: RecursiveCharacterTextSplitter,
  source: string,
  url: string,
  category: string,
  isLowValueContent: (text: string) => boolean,
): Promise<ChunkingResult | null> => {
  // Step 1: Split into parent chunks
  const parentChunks = await parentSplitter.splitText(content);
  const filteredParents = parentChunks.filter(
    (chunk) => chunk.trim().length >= 120 && !isLowValueContent(chunk),
  );

  if (filteredParents.length === 0) {
    return null;
  }

  // Step 2: Split each parent into child chunks
  const scrapedAt = new Date().toISOString();
  const parentDocs: ParentRecord[] = [];
  const childTexts: string[] = [];
  const childMeta: { parentId: string }[] = [];

  for (const parentChunk of filteredParents) {
    const parentId = createHash("md5").update(parentChunk).digest("hex");
    parentDocs.push({
      _id: parentId,
      content: parentChunk,
      source,
      url,
      category,
      scrapedAt,
      type: "parent",
    });

    const children = await childSplitter.splitText(parentChunk);
    const filteredChildren = children.filter(
      (c) => c.trim().length >= 80 && !isLowValueContent(c),
    );
    for (const childChunk of filteredChildren) {
      childTexts.push(childChunk);
      childMeta.push({ parentId });
    }
  }

  if (childTexts.length === 0) {
    return null;
  }

  return { parentDocs, childTexts, childMeta };
};

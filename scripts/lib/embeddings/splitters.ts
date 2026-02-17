// Text splitter initialization
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { EnvConfig } from "../config/env.js";

export interface TextSplitters {
  statsSplitter: RecursiveCharacterTextSplitter;
  defaultSplitter: RecursiveCharacterTextSplitter;
  statsChildSplitter: RecursiveCharacterTextSplitter;
  defaultChildSplitter: RecursiveCharacterTextSplitter;
}

export const initializeSplitters = (config: EnvConfig): TextSplitters => {
  const statsSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: config.STATS_CHUNK_SIZE,
    chunkOverlap: config.STATS_CHUNK_OVERLAP,
  });

  const defaultSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: config.DEFAULT_CHUNK_SIZE,
    chunkOverlap: config.DEFAULT_CHUNK_OVERLAP,
  });

  const statsChildSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: config.STATS_CHILD_CHUNK_SIZE,
    chunkOverlap: config.STATS_CHILD_CHUNK_OVERLAP,
  });

  const defaultChildSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: config.CHILD_CHUNK_SIZE,
    chunkOverlap: config.CHILD_CHUNK_OVERLAP,
  });

  return {
    statsSplitter,
    defaultSplitter,
    statsChildSplitter,
    defaultChildSplitter,
  };
};

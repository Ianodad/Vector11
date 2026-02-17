// OpenAI & Astra DB client initialization
import { DataAPIClient } from "@datastax/astra-db-ts";
import OpenAI from "openai";
import type { Db } from "@datastax/astra-db-ts";
import type { EnvConfig } from "./env.js";

export interface Clients {
  openai: OpenAI;
  astraClient: DataAPIClient;
  db: Db;
}

export const initializeClients = (config: EnvConfig): Clients => {
  const openai = new OpenAI({ apiKey: config.OPEN_API_KEY });
  const astraClient = new DataAPIClient(config.ASTRA_DB_APPLICATION_TOKEN);
  const db = astraClient.db(config.ASTRA_DB_API_ENDPOINT, {
    keyspace: config.ASTRA_DB_NAMESPACE,
  });

  return { openai, astraClient, db };
};

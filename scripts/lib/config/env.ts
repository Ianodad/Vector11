// Environment variable parsing & validation

export interface EnvConfig {
  ASTRA_DB_NAMESPACE: string;
  ASTRA_DB_COLLECTION: string;
  ASTRA_DB_API_ENDPOINT: string;
  ASTRA_DB_APPLICATION_TOKEN: string;
  OPEN_API_KEY: string;
  DEFAULT_VECTOR_DIMENSIONS: number;
  ALLOW_COLLECTION_RECREATE: string | undefined;
  FORCE_COLLECTION_RECREATE: string | undefined;
  MAX_SCRAPE_URLS: string | undefined;
  EPL_TEAM_PAGES: string | undefined;
  EPL_TEAM_SLUGS: string | undefined;
  EPL_TEAMS_ENABLED: string | undefined;
  STATS_CHUNK_SIZE: number;
  STATS_CHUNK_OVERLAP: number;
  DEFAULT_CHUNK_SIZE: number;
  DEFAULT_CHUNK_OVERLAP: number;
  CHILD_CHUNK_SIZE: number;
  CHILD_CHUNK_OVERLAP: number;
  STATS_CHILD_CHUNK_SIZE: number;
  STATS_CHILD_CHUNK_OVERLAP: number;
  FETCH_TIMEOUT_MS: number;
  RETRY_ATTEMPTS: number;
  RETRY_BASE_DELAY_MS: number;
}

export const requiredEnv = (value: string | undefined, name: string): string => {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export const loadEnvConfig = (): EnvConfig => {
  return {
    ASTRA_DB_NAMESPACE: requiredEnv(
      process.env.ASTRA_DB_NAMESPACE,
      "ASTRA_DB_NAMESPACE",
    ),
    ASTRA_DB_COLLECTION: requiredEnv(
      process.env.ASTRA_DB_COLLECTION,
      "ASTRA_DB_COLLECTION",
    ),
    ASTRA_DB_API_ENDPOINT: requiredEnv(
      process.env.ASTRA_DB_API_ENDPOINT,
      "ASTRA_DB_API_ENDPOINT",
    ),
    ASTRA_DB_APPLICATION_TOKEN: requiredEnv(
      process.env.ASTRA_DB_APPLICATION_TOKEN,
      "ASTRA_DB_APPLICATION_TOKEN",
    ),
    OPEN_API_KEY: requiredEnv(process.env.OPEN_API_KEY, "OPEN_API_KEY"),
    DEFAULT_VECTOR_DIMENSIONS:
      Number(process.env.EMBEDDING_DIMENSIONS) || 1536,
    ALLOW_COLLECTION_RECREATE: process.env.ALLOW_COLLECTION_RECREATE,
    FORCE_COLLECTION_RECREATE: process.env.FORCE_COLLECTION_RECREATE,
    MAX_SCRAPE_URLS: process.env.MAX_SCRAPE_URLS,
    EPL_TEAM_PAGES: process.env.EPL_TEAM_PAGES,
    EPL_TEAM_SLUGS: process.env.EPL_TEAM_SLUGS,
    EPL_TEAMS_ENABLED: process.env.EPL_TEAMS_ENABLED,
    STATS_CHUNK_SIZE: Number(process.env.STATS_CHUNK_SIZE) || 1500,
    STATS_CHUNK_OVERLAP: Number(process.env.STATS_CHUNK_OVERLAP) || 200,
    DEFAULT_CHUNK_SIZE: Number(process.env.DEFAULT_CHUNK_SIZE) || 800,
    DEFAULT_CHUNK_OVERLAP: Number(process.env.DEFAULT_CHUNK_OVERLAP) || 150,
    CHILD_CHUNK_SIZE: Number(process.env.CHILD_CHUNK_SIZE) || 400,
    CHILD_CHUNK_OVERLAP: Number(process.env.CHILD_CHUNK_OVERLAP) || 50,
    STATS_CHILD_CHUNK_SIZE: Number(process.env.STATS_CHILD_CHUNK_SIZE) || 400,
    STATS_CHILD_CHUNK_OVERLAP:
      Number(process.env.STATS_CHILD_CHUNK_OVERLAP) || 50,
    FETCH_TIMEOUT_MS: Number(process.env.FETCH_TIMEOUT_MS) || 15000,
    RETRY_ATTEMPTS: Number(process.env.RETRY_ATTEMPTS) || 3,
    RETRY_BASE_DELAY_MS: Number(process.env.RETRY_BASE_DELAY_MS) || 1000,
  };
};

export const isEnabled = (value: string | undefined): boolean => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(normalized);
};

export const resolveMaxUrls = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "all") return undefined;
  const parsed = Number(normalized);
  if (Number.isNaN(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
};

export const resolveTeamPageCount = (value: string | undefined): number => {
  if (!value) return 1;
  const normalized = value.trim().toLowerCase();
  if (normalized === "all") return 10;
  const parsed = Number(normalized);
  if (Number.isNaN(parsed) || parsed <= 0) return 1;
  return Math.min(Math.floor(parsed), 10);
};

export const resolveTeamSlugs = (value: string | undefined): string[] => {
  if (!value) return [];
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === "all") return [];
  return normalized
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

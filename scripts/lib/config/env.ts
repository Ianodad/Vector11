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
  SCRAPE_MATCH_DETAILS: string | undefined; // queue reportUrl + lineupsUrl from Soccerway results
  SOURCE_FILTER: string | undefined; // comma-separated domain/name filter e.g. "bbc,understat"
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

// A chunk size <= 0 makes the chunker's hard-cut loop (`i += maxSize`) spin
// forever, and a non-positive/out-of-range overlap makes no sense either —
// both are rejected here rather than trusted through from the environment.
const parseChunkSize = (raw: string | undefined, name: string, fallback: number): number => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    console.warn(
      `[env] ${name}=${raw} is not a valid chunk size (must be >= 1); using default ${fallback}`,
    );
    return fallback;
  }
  return Math.floor(value);
};

const parseChunkOverlap = (
  raw: string | undefined,
  name: string,
  size: number,
  fallback: number,
): number => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value >= size) {
    console.warn(
      `[env] ${name}=${raw} is not a valid overlap (must be >= 0 and < size ${size}); using default ${fallback}`,
    );
    return fallback;
  }
  return Math.floor(value);
};

export const loadEnvConfig = (): EnvConfig => {
  const statsChunkSize = parseChunkSize(process.env.STATS_CHUNK_SIZE, "STATS_CHUNK_SIZE", 1500);
  const statsChunkOverlap = parseChunkOverlap(
    process.env.STATS_CHUNK_OVERLAP,
    "STATS_CHUNK_OVERLAP",
    statsChunkSize,
    200,
  );
  const defaultChunkSize = parseChunkSize(process.env.DEFAULT_CHUNK_SIZE, "DEFAULT_CHUNK_SIZE", 800);
  const defaultChunkOverlap = parseChunkOverlap(
    process.env.DEFAULT_CHUNK_OVERLAP,
    "DEFAULT_CHUNK_OVERLAP",
    defaultChunkSize,
    150,
  );
  const childChunkSize = parseChunkSize(process.env.CHILD_CHUNK_SIZE, "CHILD_CHUNK_SIZE", 400);
  const childChunkOverlap = parseChunkOverlap(
    process.env.CHILD_CHUNK_OVERLAP,
    "CHILD_CHUNK_OVERLAP",
    childChunkSize,
    50,
  );
  const statsChildChunkSize = parseChunkSize(
    process.env.STATS_CHILD_CHUNK_SIZE,
    "STATS_CHILD_CHUNK_SIZE",
    400,
  );
  const statsChildChunkOverlap = parseChunkOverlap(
    process.env.STATS_CHILD_CHUNK_OVERLAP,
    "STATS_CHILD_CHUNK_OVERLAP",
    statsChildChunkSize,
    50,
  );

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
    SCRAPE_MATCH_DETAILS: process.env.SCRAPE_MATCH_DETAILS,
    SOURCE_FILTER: process.env.SOURCE_FILTER,
    STATS_CHUNK_SIZE: statsChunkSize,
    STATS_CHUNK_OVERLAP: statsChunkOverlap,
    DEFAULT_CHUNK_SIZE: defaultChunkSize,
    DEFAULT_CHUNK_OVERLAP: defaultChunkOverlap,
    CHILD_CHUNK_SIZE: childChunkSize,
    CHILD_CHUNK_OVERLAP: childChunkOverlap,
    STATS_CHILD_CHUNK_SIZE: statsChildChunkSize,
    STATS_CHILD_CHUNK_OVERLAP: statsChildChunkOverlap,
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

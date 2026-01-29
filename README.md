# Vector11

Vector11 is a monochrome football intelligence chat app that answers matchday
questions with a RAG pipeline over football news and stats sources.
<img width="1387" height="893" alt="071b9a19-a987-496c-a1c0-a663d92e7e7e" src="https://github.com/user-attachments/assets/74a3a086-61ec-496e-96f0-de6071be0b43" />

## Features
- RAG chat UI with tactical, data-aware responses
- Vector search powered by DataStax Astra DB
- OpenAI embeddings + chat completions
- Seeder script that scrapes football sources and loads embeddings

## Tech Stack
- Next.js 16 (App Router)
- React 19
- TypeScript
- Tailwind CSS
- DataStax Astra DB (Data API)
- OpenAI API
- LangChain loaders + text splitters

## Getting Started

1) Install dependencies
```bash
npm install
```

2) Create a `.env.local` file (start from `.env.example`)
```bash
ASTRA_DB_NAMESPACE=
ASTRA_DB_COLLECTION=
ASTRA_DB_API_ENDPOINT=
ASTRA_DB_APPLICATION_TOKEN=
OPEN_API_KEY=
EMBEDDING_DIMENSIONS=1000
```

3) (Optional) Seed the vector database
```bash
npm run seed
```

4) Run the dev server
```bash
npm run dev
```

Open `http://localhost:3000` to use the app.

## Scripts
- `npm run dev` - start the dev server
- `npm run build` - build for production
- `npm run start` - start the production server
- `npm run seed` - scrape sources and load embeddings into Astra DB
- `npm run lint` - run ESLint

## How it Works
- The chat UI posts messages to `POST /api/chat`.
- The API embeds the latest user prompt using `text-embedding-3-small`.
- It queries Astra DB for similar chunks, then injects those into a system prompt.
- The assistant replies using `gpt-5-mini`.

## Project Structure
- `app/page.tsx` - chat UI
- `app/api/chat/route.ts` - RAG chat endpoint
- `scripts/loadDb.ts` - data scraping + vector ingestion

## Notes
- The seed script uses Puppeteer; ensure it can run in your environment.
- Update the sources list in `scripts/loadDb.ts` to expand coverage.

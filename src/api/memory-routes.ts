import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MemoryService } from '../memory/service.js';
import type { MemoryTier, MemoryTag } from '../memory/types.js';

interface Route {
  method: string;
  pattern: RegExp;
  handler: (req: IncomingMessage, res: ServerResponse, ...params: string[]) => Promise<void>;
}

/**
 * Build a request matcher that dispatches memory API routes.
 *
 * The returned function is called from the gateway's request handler.
 * Returns `true` when a route matched (and the response is being written),
 * `false` when no route matched (caller should continue to its own 404).
 */
export function registerMemoryRoutes(
  memory: MemoryService,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const routes: Route[] = [
    { method: 'GET', pattern: /^\/api\/memory$/, handler: (req, res) => handleList(req, res, memory) },
    { method: 'GET', pattern: /^\/api\/memory\/([^/]+)$/, handler: async (req, res, id) => {
      const item = await memory.store.get(id);
      if (!item) {
        jsonError(res, 404, 'Memory item not found');
        return;
      }
      jsonOk(res, { item });
    } },
    { method: 'PUT', pattern: /^\/api\/memory\/([^/]+)$/, handler: (req, res, id) => handleUpdate(req, res, memory, id) },
    { method: 'POST', pattern: /^\/api\/memory$/, handler: (req, res) => handleCreate(req, res, memory) },
    { method: 'DELETE', pattern: /^\/api\/memory\/([^/]+)$/, handler: async (req, res, id) => {
      const existing = await memory.store.get(id);
      if (!existing) {
        jsonError(res, 404, 'Memory item not found');
        return;
      }
      await memory.deleteItem(id);
      res.writeHead(204);
      res.end();
    } },
    { method: 'POST', pattern: /^\/api\/memory\/search$/, handler: (req, res) => handleSearch(req, res, memory) },
  ];

  return function matchRoute(req: IncomingMessage, res: ServerResponse): boolean {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(url);
      if (match) {
        const params = match.slice(1);
        route
          .handler(req, res, ...params)
          .catch((err) => {
            console.error('Memory route error:', err);
            jsonError(res, 500, 'Internal server error');
          });
        return true;
      }
    }
    return false;
  };
}

/** GET /api/memory — list items with optional tier, tags, pagination. */
async function handleList(
  req: IncomingMessage,
  res: ServerResponse,
  memory: MemoryService,
): Promise<void> {
  const urlObj = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const tierParam = urlObj.searchParams.get('tier');
  const tier: MemoryTier | undefined =
    tierParam === 'profile' || tierParam === 'episodic' ? tierParam : undefined;

  const tagsParam = urlObj.searchParams.get('tags');
  const tags: MemoryTag[] | undefined = tagsParam
    ? (tagsParam.split(',').filter((t): t is MemoryTag =>
        ['preference', 'person', 'event', 'project', 'correction', 'summary'].includes(t),
      ))
    : undefined;

  const limitRaw = urlObj.searchParams.get('limit');
  const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;

  const offsetRaw = urlObj.searchParams.get('offset');
  const offset = offsetRaw ? parseInt(offsetRaw, 10) : undefined;

  const items = await memory.listItems({
    tier,
    tags: tags?.length ? tags : undefined,
    limit: limit !== undefined && !isNaN(limit) && limit > 0 ? limit : undefined,
    offset: offset !== undefined && !isNaN(offset) && offset >= 0 ? offset : undefined,
  });

  jsonOk(res, { items });
}

/** PUT /api/memory/:id — update an existing item. */
async function handleUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  memory: MemoryService,
  id: string,
): Promise<void> {
  const existing = await memory.store.get(id);
  if (!existing) {
    jsonError(res, 404, 'Memory item not found');
    return;
  }

  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    jsonError(res, 400, 'Invalid JSON body');
    return;
  }

  const item = await memory.upsertItem({
    ...existing,
    content: typeof parsed.content === 'string' ? parsed.content : existing.content,
    tier: isValidTier(parsed.tier) ? parsed.tier : existing.tier,
    tags: Array.isArray(parsed.tags) ? (parsed.tags as MemoryTag[]) : existing.tags,
    importance: typeof parsed.importance === 'number' ? parsed.importance : existing.importance,
    sourceEntryId: parsed.sourceEntryId !== undefined
      ? (parsed.sourceEntryId as string | null)
      : existing.sourceEntryId,
    entities: parsed.entities !== undefined
      ? (parsed.entities as string[])
      : existing.entities,
    id,
  });

  jsonOk(res, { item });
}

/** POST /api/memory — create a new item. */
async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  memory: MemoryService,
): Promise<void> {
  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    jsonError(res, 400, 'Invalid JSON body');
    return;
  }

  if (typeof parsed.content !== 'string' || !parsed.content.trim()) {
    jsonError(res, 400, "'content' is required and must be a non-empty string");
    return;
  }

  const item = await memory.upsertItem({
    tier: isValidTier(parsed.tier) ? parsed.tier : 'episodic',
    content: parsed.content.trim(),
    tags: Array.isArray(parsed.tags) ? (parsed.tags as MemoryTag[]) : [],
    importance: typeof parsed.importance === 'number' ? parsed.importance : 0,
    sourceEntryId: typeof parsed.sourceEntryId === 'string' ? parsed.sourceEntryId : null,
    entities: Array.isArray(parsed.entities) ? (parsed.entities as string[]) : undefined,
  });

  jsonOk(res, { item }, 201);
}

/** POST /api/memory/search — semantic search. */
async function handleSearch(
  req: IncomingMessage,
  res: ServerResponse,
  memory: MemoryService,
): Promise<void> {
  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    jsonError(res, 400, 'Invalid JSON body');
    return;
  }

  if (typeof parsed.query !== 'string' || !parsed.query.trim()) {
    jsonError(res, 400, "'query' is required and must be a non-empty string");
    return;
  }

  const k = typeof parsed.k === 'number' && parsed.k > 0 ? parsed.k : 10;
  const results = await memory.search(parsed.query.trim(), k);

  jsonOk(res, { results });
}

function isValidTier(value: unknown): value is MemoryTier {
  return value === 'profile' || value === 'episodic';
}

function jsonOk(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
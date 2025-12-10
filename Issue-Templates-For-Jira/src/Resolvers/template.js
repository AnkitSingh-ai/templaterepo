import { storage } from '@forge/api';

const GLOBAL_CONFIG_KEY = 'issue-templates:config';

async function readGlobalConfig() {
  const raw = await storage.get(GLOBAL_CONFIG_KEY);
  const def = { allowAllUsers: false, admins: [] };
  if (!raw || typeof raw !== 'object') return def;
  return { ...def, ...raw };
}

function getRequestUser(req) {
  try {
    return req && req.context && req.context.user ? req.context.user : null;
  } catch (e) {
    return null;
  }
}

async function isAdminRequest(req) {
  const user = getRequestUser(req);
  if (!user) return false;
  const cfg = await readGlobalConfig();
  if (Array.isArray(cfg.admins) && cfg.admins.includes(user.accountId)) return true;
  if (user && (user.isProductAdmin || user.isAdmin)) return true;
  return false;
}

// Template routes register function
export function registerTemplateRoutes(resolver) {
  // Key constants used in Forge storage
  const INDEX_KEY = 'issue-templates:index';
  const TEMPLATE_PREFIX = 'issue-templates:template:';

  function templateKey(id) {
    return `${TEMPLATE_PREFIX}${id}`;
  }

  function generateId() {
    // Stable, readable id using time + randomness (no external deps)
    return `tmpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  async function readIndex() {
    const raw = await storage.get(INDEX_KEY);
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [];
  }

  async function writeIndex(list) {
    await storage.set(INDEX_KEY, list);
  }

  function validateCreatePayload(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Payload must be an object');
    }
    const { name, content } = payload;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('`name` is required and must be a non-empty string');
    }
    // content (issue description) can be empty string but must be a string
    if (content !== undefined && typeof content !== 'string') {
      throw new Error('`content` must be a string');
    }
  }

  /**
   * createTemplate
   * Expected payload: { name, summary?, content?, projects?: [projectKey], meta?: {} }
   * Stores a template object in Forge storage and updates an index (newest-first).
   */
  resolver.define('createTemplate', async (req) => {
    try {
      const payload = req.payload || {};
      validateCreatePayload(payload);

      // Permission: controlled by global config (allowAllUsers) or admins only
      const cfg = await readGlobalConfig();
      const isAdmin = await isAdminRequest(req);
      if (!cfg.allowAllUsers && !isAdmin) {
        throw new Error('Not authorized to create templates');
      }

      const id = generateId();
      const now = nowIso();

      // Try to extract requesting user's accountId if present in request context.
      const owner = (req && req.context && req.context.user && req.context.user.accountId) || null;

      const template = {
        id,
        name: String(payload.name).trim(),
        summary: payload.summary ? String(payload.summary) : '',
        content: payload.content || '',
        projects: Array.isArray(payload.projects) ? payload.projects.slice(0) : [],
        meta: payload.meta && typeof payload.meta === 'object' ? payload.meta : {},
        owner,
        createdAt: now,
        updatedAt: now,
      };

      // Persist template and update index atomically-ish (best-effort)
      await storage.set(templateKey(id), template);
      const idx = await readIndex();
      idx.unshift(id);
      await writeIndex(idx);

      return { success: true, data: template };
    } catch (err) {
      // Surface useful error message to frontend while keeping internal logs
      console.error('createTemplate error:', err && err.message ? err.message : err);
      throw new Error(err && err.message ? err.message : 'Failed to create template');
    }
  });

  /**
   * getTemplate
   * payload: { id }
   */
  resolver.define('getTemplate', async (req) => {
    const { id } = req.payload || {};
    if (!id) throw new Error('Template `id` is required');
    const tpl = await storage.get(templateKey(id));
    if (!tpl) throw new Error('Template not found');
    return { success: true, data: tpl };
  });

  /**
   * listTemplates
   * payload: { page?, limit? }
   */
  resolver.define('listTemplates', async (req) => {
    const { page = 1, limit = 50 } = req.payload || {};
    const idx = await readIndex();
    const start = Math.max(0, (Number(page) - 1) * Number(limit));
    const slice = idx.slice(start, start + Number(limit));
    const results = [];
    for (const id of slice) {
      const tpl = await storage.get(templateKey(id));
      if (tpl) results.push(tpl);
    }
    return { success: true, data: { total: idx.length, page: Number(page), limit: Number(limit), templates: results } };
  });

  /**
   * ping - simple health/debug endpoint
   */
  resolver.define('ping', async () => ({ success: true, data: { ts: nowIso() } }));
}

export default registerTemplateRoutes;

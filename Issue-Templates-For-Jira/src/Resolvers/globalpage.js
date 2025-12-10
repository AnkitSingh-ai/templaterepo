import { storage, asUser } from '@forge/api';

// Export a registration function to allow a single resolver to be used
export function registerGlobalPageRoutes(resolver) {

// Storage keys
const INDEX_KEY = 'issue-templates:index';
const TEMPLATE_PREFIX = 'issue-templates:template:'; // per-template
const PROJECT_SETTINGS_KEY = 'issue-templates:projects'; // map projectKey => { enabled: true }
const GLOBAL_CONFIG_KEY = 'issue-templates:config'; // { allowAllUsers: boolean, admins: [accountId] }

function templateKey(id) {
  return `${TEMPLATE_PREFIX}${id}`;
}

function nowIso() {
  return new Date().toISOString();
}

function generateId() {
  return `tmpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;
}

async function readIndex() {
  const raw = await storage.get(INDEX_KEY);
  return Array.isArray(raw) ? raw : [];
}

async function writeIndex(list) {
  await storage.set(INDEX_KEY, list);
}

async function readProjectSettings() {
  const raw = await storage.get(PROJECT_SETTINGS_KEY);
  return (raw && typeof raw === 'object') ? raw : {};
}

async function writeProjectSettings(map) {
  await storage.set(PROJECT_SETTINGS_KEY, map || {});
}

async function readGlobalConfig() {
  const raw = await storage.get(GLOBAL_CONFIG_KEY);
  // defaults
  const def = { allowAllUsers: false, admins: [] };
  if (!raw || typeof raw !== 'object') return def;
  return { ...def, ...raw };
}

async function writeGlobalConfig(cfg) {
  await storage.set(GLOBAL_CONFIG_KEY, cfg || {});
}

function ensureString(v) {
  return v === undefined || v === null ? '' : String(v);
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
  // some contexts may include an explicit admin flag
  if (user && (user.isProductAdmin || user.isAdmin)) return true;
  return false;
}

function validateTemplatePayload(payload, requireDescription = true) {
  if (!payload || typeof payload !== 'object') throw new Error('Payload must be an object');
  if (!payload.name || String(payload.name).trim().length === 0) throw new Error('Template name is required');
  if (requireDescription && (payload.content === undefined || String(payload.content).trim().length === 0)) {
    throw new Error('Template description (content) is required');
  }
}



// Update template (name, summary, content, assignedProjects, assignedIssueTypes, active)
  resolver.define('updateTemplate', async (req) => {
  try {
    const payload = req.payload || {};
    const { id } = payload;
    if (!id) throw new Error('Template id is required');
    const existing = await storage.get(templateKey(id));
    if (!existing || existing.deleted) throw new Error('Template not found');

    // Permission: allow if owner or admin or global allowAllUsers
    const cfg = await readGlobalConfig();
    const user = getRequestUser(req);
    const isAdmin = await isAdminRequest(req);
    if (!cfg.allowAllUsers && !isAdmin) {
      // if not allowed for all and not admin, only owner can edit
      if (!user || existing.owner !== user.accountId) throw new Error('Not authorized to update template');
    }

    const updates = {};
    if (payload.name !== undefined) updates.name = String(payload.name).trim();
    if (payload.summary !== undefined) updates.summary = ensureString(payload.summary);
    if (payload.content !== undefined) updates.content = ensureString(payload.content);
    if (payload.assignedProjects !== undefined) updates.assignedProjects = Array.isArray(payload.assignedProjects) ? payload.assignedProjects.slice(0) : [];
    if (payload.assignedIssueTypes !== undefined) updates.assignedIssueTypes = Array.isArray(payload.assignedIssueTypes) ? payload.assignedIssueTypes.slice(0) : [];
    if (payload.active !== undefined) updates.active = Boolean(payload.active);
    if (payload.meta !== undefined) updates.meta = typeof payload.meta === 'object' ? payload.meta : existing.meta;

    const merged = { ...existing, ...updates, updatedAt: nowIso() };
    await storage.set(templateKey(id), merged);
    return { success: true, data: merged };
  } catch (err) {
    console.error('updateTemplate error', err);
    throw new Error(err && err.message ? err.message : 'Failed to update template');
  }
  });

// Soft delete or hard delete
  resolver.define('deleteTemplate', async (req) => {
  try {
    const { id, hard = false } = req.payload || {};
    if (!id) throw new Error('Template id is required');
    const existing = await storage.get(templateKey(id));
    if (!existing) throw new Error('Template not found');

    const isAdmin = await isAdminRequest(req);
    const cfg = await readGlobalConfig();
    const user = getRequestUser(req);
    if (!cfg.allowAllUsers && !isAdmin) {
      if (!user || existing.owner !== user.accountId) throw new Error('Not authorized to delete template');
    }

    if (hard) {
      await storage.delete(templateKey(id));
      const idx = await readIndex();
      await writeIndex(idx.filter((tid) => tid !== id));
      return { success: true, data: { id, deleted: true } };
    }

    // soft delete
    existing.deleted = true;
    existing.active = false;
    existing.updatedAt = nowIso();
    await storage.set(templateKey(id), existing);
    return { success: true, data: { id, deleted: true } };
  } catch (err) {
    console.error('deleteTemplate error', err);
    throw new Error(err && err.message ? err.message : 'Failed to delete template');
  }
  });

  // Duplicate (clone) a template — useful for "Copy templateId" or "Copy template" actions
  resolver.define('duplicateTemplate', async (req) => {
    try {
      const { id, newName } = req.payload || {};
      if (!id) throw new Error('Template id is required');
      const existing = await storage.get(templateKey(id));
      if (!existing || existing.deleted) throw new Error('Template not found');

      const user = getRequestUser(req);
      const newId = generateId();
      const now = nowIso();

      const clone = {
        ...existing,
        id: newId,
        name: newName && String(newName).trim().length > 0 ? String(newName).trim() : `${existing.name} (copy)`,
        owner: user ? user.accountId : existing.owner,
        createdAt: now,
        updatedAt: now,
        deleted: false,
      };

      await storage.set(templateKey(newId), clone);
      const idx = await readIndex();
      idx.unshift(newId);
      await writeIndex(idx);

      return { success: true, data: clone };
    } catch (err) {
      console.error('duplicateTemplate error', err);
      throw new Error(err && err.message ? err.message : 'Failed to duplicate template');
    }
  });

  // Return only the template id (frontend may copy to clipboard) — convenience helper
  resolver.define('copyTemplateId', async (req) => {
    const { id } = req.payload || {};
    if (!id) throw new Error('Template id is required');
    const tpl = await storage.get(templateKey(id));
    if (!tpl || tpl.deleted) throw new Error('Template not found');
    return { success: true, data: { id: tpl.id } };
  });



  // Assignment and active-status endpoints moved to `templateassign.js`.
  // This module focuses on global page features and admin configuration.

  // Project-level enable/disable switch and global admin configuration
  // have been moved to `adminconfigpage.js` to centralize admin-only endpoints.

// Helper: find applicable template for a given projectKey and issueType
  resolver.define('findApplicableTemplate', async (req) => {
    const { projectKey, issueType } = req.payload || {};
    if (!projectKey) throw new Error('projectKey is required');
    const idx = await readIndex();
    for (const id of idx) {
      const tpl = await storage.get(templateKey(id));
      if (!tpl || tpl.deleted || !tpl.active) continue;
      const assignedProjects = Array.isArray(tpl.assignedProjects) ? tpl.assignedProjects : [];
      const assignedIssueTypes = Array.isArray(tpl.assignedIssueTypes) ? tpl.assignedIssueTypes : [];
      const projectMatch = assignedProjects.length === 0 || assignedProjects.includes(projectKey);
      const issueTypeMatch = assignedIssueTypes.length === 0 || (issueType && assignedIssueTypes.includes(issueType));
      if (projectMatch && issueTypeMatch) return { success: true, data: tpl };
    }
    return { success: true, data: null };
  });

// Apply template to an existing issue (best-effort). This performs a Jira REST API call using asUser().
// NOTE: This requires appropriate scopes (jira-rest-api) and the app to be granted permissions.
  resolver.define('applyTemplateToIssue', async (req) => {
  try {
    const { templateId, issueKey } = req.payload || {};
    if (!templateId || !issueKey) throw new Error('templateId and issueKey are required');
    const tpl = await storage.get(templateKey(templateId));
    if (!tpl || tpl.deleted || !tpl.active) throw new Error('Template not available');

    // Permission: only admins or allowed users can apply templates (global config)
    const cfg = await readGlobalConfig();
    const isAdmin = await isAdminRequest(req);
    const user = getRequestUser(req);
    if (!cfg.allowAllUsers && !isAdmin) {
      if (!user || tpl.owner !== user.accountId) throw new Error('Not authorized to apply template');
    }

    // Attempt to patch the Jira issue as the requesting user
    try {
      const asUserClient = asUser();
      const body = {
        fields: {
          summary: tpl.summary || tpl.name,
          description: tpl.content || '',
        },
      };
      const res = await asUserClient.requestJira(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      // return HTTP status for debugging; asUserClient.requestJira may return a Response-like object
      return { success: true, data: { status: res.status || 'unknown' } };
    } catch (jiraErr) {
      console.error('applyTemplateToIssue - jira error', jiraErr);
      throw new Error('Failed to apply template to issue (Jira API error). Ensure necessary scopes are present and the app is installed.');
    }
  } catch (err) {
    console.error('applyTemplateToIssue error', err);
    throw new Error(err && err.message ? err.message : 'Failed to apply template');
  }
  });

// Admin: list project-level templates (templates assigned to a given project)
  resolver.define('getTemplatesForProject', async (req) => {
    const { projectKey } = req.payload || {};
    if (!projectKey) throw new Error('projectKey is required');
    const idx = await readIndex();
    const results = [];
    for (const id of idx) {
      const tpl = await storage.get(templateKey(id));
      if (!tpl || tpl.deleted) continue;
      if (!tpl.assignedProjects || tpl.assignedProjects.length === 0 || tpl.assignedProjects.includes(projectKey)) results.push(tpl);
    }
    return { success: true, data: results };
  });

  // Search templates by name for autocomplete/select controls
  resolver.define('searchTemplatesByName', async (req) => {
    const { q = '', limit = 10 } = req.payload || {};
    const term = String(q || '').trim().toLowerCase();
    if (!term) return { success: true, data: [] };
    const idx = await readIndex();
    const results = [];
    for (const id of idx) {
      const tpl = await storage.get(templateKey(id));
      if (!tpl || tpl.deleted) continue;
      if (String(tpl.name).toLowerCase().includes(term)) {
        results.push({ id: tpl.id, name: tpl.name, summary: tpl.summary });
        if (results.length >= Number(limit)) break;
      }
    }
    return { success: true, data: results };
  });

  // Return a list of project keys (and counts) that appear in templates to populate Filter by Project dropdown.
  // Note: we return project keys only (no project names) because fetching project metadata requires Jira scopes.
  resolver.define('listFilterProjects', async () => {
    const idx = await readIndex();
    const map = Object.create(null);
    for (const id of idx) {
      const tpl = await storage.get(templateKey(id));
      if (!tpl || tpl.deleted) continue;
      const projects = Array.isArray(tpl.assignedProjects) ? tpl.assignedProjects : [];
      if (projects.length === 0) {
        map['__ALL__'] = (map['__ALL__'] || 0) + 1; // indicates templates not project-specific
      } else {
        for (const p of projects) map[p] = (map[p] || 0) + 1;
      }
    }
    const items = Object.keys(map).map((k) => ({ projectKey: k, count: map[k] }));
    return { success: true, data: items };
  });

  // Filter templates by project (paginated). projectKey='__ALL__' returns templates without assignments.
  resolver.define('filterTemplatesByProject', async (req) => {
    const { projectKey, page = 1, limit = 50 } = req.payload || {};
    if (!projectKey) throw new Error('projectKey is required');
    const idx = await readIndex();
    const results = [];
    for (const id of idx) {
      const tpl = await storage.get(templateKey(id));
      if (!tpl || tpl.deleted) continue;
      const projects = Array.isArray(tpl.assignedProjects) ? tpl.assignedProjects : [];
      if (projectKey === '__ALL__') {
        if (projects.length === 0) results.push(tpl);
      } else {
        if (projects.length === 0 || projects.includes(projectKey)) results.push(tpl);
      }
    }
    const start = Math.max(0, (Number(page) - 1) * Number(limit));
    const slice = results.slice(start, start + Number(limit));
    return { success: true, data: { total: results.length, page: Number(page), limit: Number(limit), templates: slice } };
  });

  // Note: `ping`, `createTemplate`, `getTemplate`, and `listTemplates` are provided
  // by `template.js` to keep template operations centralized. This module focuses
  // on global page features and administration endpoints.
}

export default registerGlobalPageRoutes;

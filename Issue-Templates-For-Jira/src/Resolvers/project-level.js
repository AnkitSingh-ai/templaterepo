import { storage, asUser } from '@forge/api';

// Project-level settings for Issue Templates
export function registerProjectLevelRoutes(resolver) {
  const PROJECT_SETTINGS_KEY = 'issue-templates:projects';
  const INDEX_KEY = 'issue-templates:index';
  const TEMPLATE_PREFIX = 'issue-templates:template:';
  const GLOBAL_CONFIG_KEY = 'issue-templates:config';

  function templateKey(id) {
    return `${TEMPLATE_PREFIX}${id}`;
  }

  async function readProjectSettings() {
    const raw = await storage.get(PROJECT_SETTINGS_KEY);
    return (raw && typeof raw === 'object') ? raw : {};
  }

  async function writeProjectSettings(map) {
    await storage.set(PROJECT_SETTINGS_KEY, map || {});
  }

  async function readIndex() {
    const raw = await storage.get(INDEX_KEY);
    return Array.isArray(raw) ? raw : [];
  }

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

  async function isProjectAdmin(req, projectKey) {
    if (!projectKey) return false;
    try {
      const asUserClient = asUser();
      const res = await asUserClient.requestJira(`/rest/api/3/mypermissions?projectKey=${encodeURIComponent(projectKey)}`);
      if (!res || typeof res.json !== 'function') return false;
      const data = await res.json();
      const perms = data && data.permissions ? data.permissions : {};
      for (const key of Object.keys(perms)) {
        const p = perms[key];
        if (p && p.havePermission) {
          if (key === 'PROJECT_ADMIN' || key === 'ADMINISTER_PROJECTS' || (p.name && String(p.name).toLowerCase().includes('admin'))) return true;
        }
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // Get project-level config (whether this project uses global templates)
  resolver.define('getProjectConfig', async (req) => {
    const { projectKey } = req.payload || {};
    if (!projectKey) throw new Error('projectKey is required');
    const map = await readProjectSettings();
    const entry = map[projectKey] || { enabled: true };
    return { success: true, data: { projectKey, useGlobalTemplates: Boolean(entry.enabled) } };
  });

  // Set project-level toggle. Allowed when global config allows all users or requester is admin.
  resolver.define('setProjectUseGlobalTemplates', async (req) => {
    const { projectKey, enabled } = req.payload || {};
    if (!projectKey) throw new Error('projectKey is required');
    const cfg = await readGlobalConfig();
    const isAdmin = await isAdminRequest(req);
    const isProjAdmin = await isProjectAdmin(req, projectKey);
    if (!cfg.allowAllUsers && !isAdmin && !isProjAdmin) throw new Error('Not authorized to change project settings');
    const map = await readProjectSettings();
    map[projectKey] = { enabled: Boolean(enabled) };
    await writeProjectSettings(map);
    return { success: true, data: { projectKey, useGlobalTemplates: Boolean(enabled) } };
  });

  // Read-only: list templates assigned to a project (for Project Settings page)
  resolver.define('getAssignedTemplatesForProject', async (req) => {
    const { projectKey } = req.payload || {};
    if (!projectKey) throw new Error('projectKey is required');
    const idx = await readIndex();
    const results = [];
    for (const id of idx) {
      const tpl = await storage.get(templateKey(id));
      if (!tpl || tpl.deleted) continue;
      const projects = Array.isArray(tpl.assignedProjects) ? tpl.assignedProjects : [];
      if (projects.length === 0 || projects.includes(projectKey)) {
        results.push({ id: tpl.id, name: tpl.name, assignedIssueTypes: tpl.assignedIssueTypes || [] });
      }
    }
    return { success: true, data: results };
  });
}

export default registerProjectLevelRoutes;

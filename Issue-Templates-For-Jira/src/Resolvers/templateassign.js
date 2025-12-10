import { storage } from '@forge/api';
import { asUser } from '@forge/api';

// Module that contains template assignment logic and enforces
// the "one active template per (project, issueType)" rule.
export function registerTemplateAssignRoutes(resolver) {
  const INDEX_KEY = 'issue-templates:index';
  const TEMPLATE_PREFIX = 'issue-templates:template:';

  function templateKey(id) {
    return `${TEMPLATE_PREFIX}${id}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

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

  async function isProjectAdmin(req, projectKey) {
    // Best-effort: call Jira mypermissions to check PROJECT ADMIN permission
    if (!projectKey) return false;
    try {
      const asUserClient = asUser();
      const res = await asUserClient.requestJira(`/rest/api/3/mypermissions?projectKey=${encodeURIComponent(projectKey)}`);
      if (!res || typeof res.json !== 'function') return false;
      const data = await res.json();
      const perms = data && data.permissions ? data.permissions : {};
      // Check common permission keys that indicate project admin
      const adminKeys = ['PROJECT_ADMIN', 'ADMINISTER_PROJECTS', 'PROJECT_ADMINISTER'];
      for (const key of Object.keys(perms)) {
        const p = perms[key];
        if (p && p.havePermission) {
          if (adminKeys.includes(key) || (p.name && String(p.name).toLowerCase().includes('admin'))) return true;
        }
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  async function readIndex() {
    const raw = await storage.get(INDEX_KEY);
    return Array.isArray(raw) ? raw : [];
  }

  // Helper: detect overlap between two sets where empty means "all"
  function setsOverlap(a = [], b = []) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length === 0 && b.length === 0) return true;
    if (a.length === 0 || b.length === 0) return true; // empty = global -> overlaps
    return a.some((x) => b.includes(x));
  }

  // Enforce rule: for the given template (which is active), find other templates
  // that are active and that overlap on any project+issueType combination and deactivate them.
  // Returns array of deactivated template ids.
  async function enforceUniqueActiveTemplates(template) {
    if (!template || !template.active) return [];
    const idx = await readIndex();
    const deactivated = [];
    for (const id of idx) {
      if (id === template.id) continue;
      const other = await storage.get(templateKey(id));
      if (!other || other.deleted) continue;
      if (!other.active) continue;

      const projectsOverlap = setsOverlap(template.assignedProjects, other.assignedProjects);
      const issueTypesOverlap = setsOverlap(template.assignedIssueTypes, other.assignedIssueTypes);
      if (projectsOverlap && issueTypesOverlap) {
        other.active = false;
        other.updatedAt = nowIso();
        await storage.set(templateKey(id), other);
        deactivated.push(id);
      }
    }
    return deactivated;
  }

  // Assign template to projects (and optionally issueTypes) and enforce active rule
  resolver.define('assignTemplateToProjects', async (req) => {
    const { id, projects, issueTypes } = req.payload || {};
    if (!id) throw new Error('Template id is required');
    if (!Array.isArray(projects)) throw new Error('`projects` must be an array');
    const tpl = await storage.get(templateKey(id));
    if (!tpl || tpl.deleted) throw new Error('Template not found');

    // Permission: require global admin or global allowAllUsers or owner; also allow project admins for the target projects
    const cfg = await readGlobalConfig();
    const reqUser = getRequestUser(req);
    const isAdmin = await isAdminRequest(req);
    if (!cfg.allowAllUsers && !isAdmin) {
      // allow if owner
      if (reqUser && tpl.owner === reqUser.accountId) {
        // owner allowed
      } else {
        // allow if user is project admin for ALL target projects
        let allowed = true;
        for (const p of projects) {
          const pa = await isProjectAdmin(req, p);
          if (!pa) { allowed = false; break; }
        }
        if (!allowed) throw new Error('Not authorized to assign template to projects');
      }
    }

    tpl.assignedProjects = projects.slice(0);
    if (issueTypes !== undefined) tpl.assignedIssueTypes = Array.isArray(issueTypes) ? issueTypes.slice(0) : [];
    tpl.updatedAt = nowIso();
    await storage.set(templateKey(id), tpl);

    // If template is active, enforce uniqueness
    let deactivated = [];
    if (tpl.active) {
      deactivated = await enforceUniqueActiveTemplates(tpl);
    }
    return { success: true, data: { template: tpl, deactivated } };
  });

  // Assign template to issue types (and optionally projects) and enforce active rule
  resolver.define('assignTemplateToIssueTypes', async (req) => {
    const { id, issueTypes, projects } = req.payload || {};
    if (!id) throw new Error('Template id is required');
    if (!Array.isArray(issueTypes)) throw new Error('`issueTypes` must be an array');
    const tpl = await storage.get(templateKey(id));
    if (!tpl || tpl.deleted) throw new Error('Template not found');

    // Permission: require global admin or allowAllUsers or owner
    const cfg = await readGlobalConfig();
    const reqUser = getRequestUser(req);
    const isAdmin = await isAdminRequest(req);
    if (!cfg.allowAllUsers && !isAdmin) {
      if (reqUser && tpl.owner === reqUser.accountId) {
        // allowed
      } else {
        throw new Error('Not authorized to assign template to issue types');
      }
    }

    tpl.assignedIssueTypes = issueTypes.slice(0);
    if (projects !== undefined) tpl.assignedProjects = Array.isArray(projects) ? projects.slice(0) : [];
    tpl.updatedAt = nowIso();
    await storage.set(templateKey(id), tpl);

    let deactivated = [];
    if (tpl.active) {
      deactivated = await enforceUniqueActiveTemplates(tpl);
    }
    return { success: true, data: { template: tpl, deactivated } };
  });

  // Toggle active/inactive with enforcement when activating
  resolver.define('setTemplateActive', async (req) => {
    const { id, active } = req.payload || {};
    if (!id) throw new Error('Template id is required');
    const tpl = await storage.get(templateKey(id));
    if (!tpl || tpl.deleted) throw new Error('Template not found');
    tpl.active = Boolean(active);
    tpl.updatedAt = nowIso();
    await storage.set(templateKey(id), tpl);
    let deactivated = [];
    if (tpl.active) {
      deactivated = await enforceUniqueActiveTemplates(tpl);
    }
    return { success: true, data: { template: tpl, deactivated } };
  });

  // Get assignments for a template
  resolver.define('getTemplateAssignments', async (req) => {
    const { id } = req.payload || {};
    if (!id) throw new Error('Template id is required');
    const tpl = await storage.get(templateKey(id));
    if (!tpl || tpl.deleted) throw new Error('Template not found');
    return { success: true, data: { assignedProjects: tpl.assignedProjects || [], assignedIssueTypes: tpl.assignedIssueTypes || [] } };
  });
}

export default registerTemplateAssignRoutes;

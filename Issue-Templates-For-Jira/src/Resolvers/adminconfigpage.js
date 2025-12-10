import { storage } from '@forge/api';

// Admin configuration routes: manage global permissions and project-level enabled flags
export function registerAdminConfigRoutes(resolver) {
  const GLOBAL_CONFIG_KEY = 'issue-templates:config';
  const PROJECT_SETTINGS_KEY = 'issue-templates:projects';

  async function readGlobalConfig() {
    const raw = await storage.get(GLOBAL_CONFIG_KEY);
    const def = { allowAllUsers: false, admins: [] };
    if (!raw || typeof raw !== 'object') return def;
    return { ...def, ...raw };
  }

  async function writeGlobalConfig(cfg) {
    await storage.set(GLOBAL_CONFIG_KEY, cfg || {});
  }

  async function readProjectSettings() {
    const raw = await storage.get(PROJECT_SETTINGS_KEY);
    return (raw && typeof raw === 'object') ? raw : {};
  }

  async function writeProjectSettings(map) {
    await storage.set(PROJECT_SETTINGS_KEY, map || {});
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

  // Get global config (allowAllUsers, admins list)
  resolver.define('getGlobalConfig', async (req) => {
    const cfg = await readGlobalConfig();
    return { success: true, data: cfg };
  });

  // Set global config (admin only)
  resolver.define('setGlobalConfig', async (req) => {
    const isAdmin = await isAdminRequest(req);
    if (!isAdmin) throw new Error('Not authorized to change global config');
    const { allowAllUsers, admins } = req.payload || {};
    const cfg = await readGlobalConfig();
    const next = { ...cfg };
    if (allowAllUsers !== undefined) next.allowAllUsers = Boolean(allowAllUsers);
    if (Array.isArray(admins)) next.admins = admins.slice(0);
    await writeGlobalConfig(next);
    return { success: true, data: next };
  });

  // Get project-level settings map
  resolver.define('getProjectSettings', async (req) => {
    const map = await readProjectSettings();
    return { success: true, data: map };
  });

  // Set project enabled/disabled (admin only)
  resolver.define('setProjectEnabled', async (req) => {
    const isAdmin = await isAdminRequest(req);
    if (!isAdmin) throw new Error('Not authorized to change project settings');
    const { projectKey, enabled } = req.payload || {};
    if (!projectKey) throw new Error('projectKey is required');
    const map = await readProjectSettings();
    map[projectKey] = { enabled: Boolean(enabled) };
    await writeProjectSettings(map);
    return { success: true, data: { projectKey, enabled: Boolean(enabled) } };
  });
}

export default registerAdminConfigRoutes;

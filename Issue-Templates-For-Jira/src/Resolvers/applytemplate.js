import { storage } from '@forge/api';

// Provides endpoints to support auto-fill behavior in the Jira Create Issue dialog.
// The frontend should call `getPrefillForCreateIssue` when the dialog opens and
// again when the user switches the Issue Type. The resolver will return the
// template summary and description to use (or null) and metadata to help the
// frontend decide whether to overwrite user-typed values.

export function registerApplyTemplateRoutes(resolver) {
  const INDEX_KEY = 'issue-templates:index';
  const TEMPLATE_PREFIX = 'issue-templates:template:';

  function templateKey(id) {
    return `${TEMPLATE_PREFIX}${id}`;
  }

  async function readIndex() {
    const raw = await storage.get(INDEX_KEY);
    return Array.isArray(raw) ? raw : [];
  }

  // Returns the first active template matching projectKey and issueType.
  // Matching rule: template.assignedProjects empty => matches any project.
  // assignedIssueTypes empty => matches any issue type.
  async function findMatchingTemplate(projectKey, issueType) {
    if (!projectKey) return null;
    const idx = await readIndex();
    for (const id of idx) {
      const tpl = await storage.get(templateKey(id));
      if (!tpl || tpl.deleted || !tpl.active) continue;
      const assignedProjects = Array.isArray(tpl.assignedProjects) ? tpl.assignedProjects : [];
      const assignedIssueTypes = Array.isArray(tpl.assignedIssueTypes) ? tpl.assignedIssueTypes : [];
      const projectMatch = assignedProjects.length === 0 || assignedProjects.includes(projectKey);
      const issueTypeMatch = assignedIssueTypes.length === 0 || (issueType && assignedIssueTypes.includes(issueType));
      if (projectMatch && issueTypeMatch) return tpl;
    }
    return null;
  }

  // Main endpoint used by the Create Issue dialog.
  // payload: { projectKey, issueType, currentSummary?, currentDescription? }
  // returns: { templateId|null, summary|null, description|null, applySummary:boolean, applyDescription:boolean }
  resolver.define('getPrefillForCreateIssue', async (req) => {
    const { projectKey, issueType, currentSummary = '', currentDescription = '' } = req.payload || {};
    if (!projectKey) return { success: true, data: null };

    // Find a matching template using the same matching rules as other modules.
    const tpl = await findMatchingTemplate(projectKey, issueType);
    if (!tpl) return { success: true, data: null };

    // Decide whether to suggest applying the summary/description.
    const summaryFromTpl = tpl.summary && String(tpl.summary).trim().length > 0 ? String(tpl.summary) : null;
    const descFromTpl = tpl.content && String(tpl.content).trim().length > 0 ? String(tpl.content) : null;

    // For summary: do not overwrite if user already typed something non-empty.
    const applySummary = !!summaryFromTpl && String(currentSummary || '').trim().length === 0;

    // For description: be conservative. If the user has typed text already, do not overwrite.
    const applyDescription = !!descFromTpl && String(currentDescription || '').trim().length === 0;

    return {
      success: true,
      data: {
        templateId: tpl.id,
        summary: summaryFromTpl,
        description: descFromTpl,
        applySummary,
        applyDescription,
        // Provide template metadata so frontend can show a badge or info
        templateName: tpl.name,
      },
    };
  });

  // Convenience endpoint: return description only by template id
  resolver.define('getTemplateDescription', async (req) => {
    const { id } = req.payload || {};
    if (!id) throw new Error('template id is required');
    const tpl = await storage.get(templateKey(id));
    if (!tpl || tpl.deleted || !tpl.active) throw new Error('template not found');
    return { success: true, data: { templateId: tpl.id, description: tpl.content || '', summary: tpl.summary || '' } };
  });
}

export default registerApplyTemplateRoutes;

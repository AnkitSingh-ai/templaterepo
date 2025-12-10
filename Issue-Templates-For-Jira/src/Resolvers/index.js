import Resolver from '@forge/resolver';
import registerGlobalPageRoutes from './globalpage';
import registerTemplateRoutes from './template';
import registerTemplateAssignRoutes from './templateassign';
import registerApplyTemplateRoutes from './applytemplate';
import registerAdminConfigRoutes from './adminconfigpage';
import registerProjectLevelRoutes from './project-level';

const resolver = new Resolver();

// Register routes from modules
registerTemplateRoutes(resolver);
registerGlobalPageRoutes(resolver);
registerTemplateAssignRoutes(resolver);
registerApplyTemplateRoutes(resolver);
registerAdminConfigRoutes(resolver);
registerProjectLevelRoutes(resolver);

export const handler = resolver.getDefinitions();


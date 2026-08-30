/**
 * Serves /agent.md as raw markdown
 */

export const onRequest: PagesFunction = async (context) => {
  return context.next();
};

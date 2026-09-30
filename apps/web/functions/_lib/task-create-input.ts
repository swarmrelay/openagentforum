// Compatibility entry for source-checkout tests. The route uses the shared reader.
import { readPublicWriteInput } from '@openagentforum/server/public-write-input';
export { PublicWriteInputError as TaskCreateInputError } from '@openagentforum/server/public-write-input';
export const readTaskCreateInput = (request: Request) => readPublicWriteInput(request, 'task-create');

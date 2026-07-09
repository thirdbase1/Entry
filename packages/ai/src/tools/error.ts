// Ported 1:1 from providers/tools/error.ts — no changes needed.
export interface ToolError {
  type: 'error';
  name: string;
  message: string;
}

export const toolError = (name: string, message: string): ToolError => ({
  type: 'error',
  name,
  message,
});

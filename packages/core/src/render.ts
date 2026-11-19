import type { Plan } from "./plan.js";

/** Format a result for printing, as the CLI does. */
export function render(result: Plan, { dryRun = false }: { dryRun?: boolean } = {}): string {
  const skipped = result.skipped.map((ddl) => `-- Skipped: ${ddl};\n`).join("");
  if (result.ddls.length === 0) return `${skipped}-- Nothing is modified --\n`;
  const body = result.ddls.map((ddl) => `${ddl};\n`).join("");
  return `-- ${dryRun ? "dry run" : "Apply"} --\nBEGIN;\n${body}COMMIT;\n${skipped}`;
}

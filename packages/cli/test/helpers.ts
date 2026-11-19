/** Template tag that strips the common indentation and the surrounding blank lines. */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): string {
  const text = String.raw({ raw: strings }, ...values).replace(/^\n+|\s+$/g, "");
  const indent = Math.min(
    ...text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => line.match(/^ */)![0].length),
  );
  return text
    .split("\n")
    .map((line) => line.slice(indent))
    .join("\n");
}

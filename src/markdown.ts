/**
 * The text of a markdown heading without its inline markup, for heading paths, outlines and titles.
 *
 * `**bold**`, `*em*`, `_em_`, `__bold__` and `` `code` `` lose their markers; an underscore inside a
 * word stays, so `ts_bi`, `ADR0019_opentelemetry_adoption` or `X_Workspace_ID` keep the name that
 * `contains` and a reader will look for. (Stripping every `_` turned `ts_bi` into `tsbi`.)
 */
export function headingText(raw: string): string {
  return raw
    .replace(/\\_/g, "_")
    .replace(/(^|[^\w])(__|_)(?=\S)(.+?)(?<=\S)\2(?=[^\w]|$)/g, "$1$3")
    .replace(/[*`]/g, "")
    .trim();
}

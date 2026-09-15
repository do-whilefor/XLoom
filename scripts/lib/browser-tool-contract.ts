/** Default browser-enabled roles: operation tools plus Execute's proposal channel. */
export function matchesBrowserToolContract(role: "chat" | "execute", tools: readonly { name: string }[] | undefined): boolean {
  const expected = ["read", "write", "edit", "powershell", "chrome", ...(role === "execute" ? ["submit"] : [])];
  const names = tools?.map(tool => tool.name) ?? [];
  return names.length === expected.length && new Set(names).size === names.length
    && expected.every(name => names.includes(name));
}

/**
 * Utilities for formatting and inspecting source code blocks rendered in chat.
 * Provides language display normalization, accurate line counting, and line count formatting.
 */

/** Known language identifier mappings for user-friendly display labels. */
const KNOWN_LANGUAGES: Record<string, string> = {
  // JavaScript & TypeScript
  js: "JavaScript",
  javascript: "JavaScript",
  jsx: "JavaScript (JSX)",
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TypeScript (TSX)",
  node: "Node.js",

  // Web & Styling
  html: "HTML",
  htm: "HTML",
  css: "CSS",
  scss: "SCSS",
  sass: "Sass",
  less: "Less",
  json: "JSON",
  jsonc: "JSON",
  json5: "JSON5",
  xml: "XML",
  svg: "SVG",
  md: "Markdown",
  markdown: "Markdown",
  mdx: "MDX",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",

  // Shell & Scripts
  sh: "Bash",
  bash: "Bash",
  zsh: "Bash",
  shell: "Shell",
  ps1: "PowerShell",
  powershell: "PowerShell",
  fish: "Fish",

  // Systems & General Purpose Languages
  c: "C",
  cpp: "C++",
  "c++": "C++",
  cc: "C++",
  cxx: "C++",
  cs: "C#",
  csharp: "C#",
  "c#": "C#",
  rs: "Rust",
  rust: "Rust",
  go: "Go",
  golang: "Go",
  py: "Python",
  python: "Python",
  rb: "Ruby",
  ruby: "Ruby",
  php: "PHP",
  java: "Java",
  kt: "Kotlin",
  kotlin: "Kotlin",
  swift: "Swift",
  dart: "Dart",
  r: "R",
  lua: "Lua",

  // Query & Data
  sql: "SQL",
  graphql: "GraphQL",
  gql: "GraphQL",
  proto: "Protobuf",
  protobuf: "Protobuf",

  // Dev & Infra
  docker: "Dockerfile",
  dockerfile: "Dockerfile",
  makefile: "Makefile",
  make: "Makefile",
  diff: "Diff",
  wasm: "WebAssembly",
};

/**
 * Returns a human-friendly display label for a code block language identifier.
 *
 * @param lang - Raw language identifier from markdown fence (e.g. "ts", "py", "sh").
 * @returns Normalized language name (e.g. "TypeScript", "Python", "Bash"), or "Code" if unspecified.
 *
 * @example
 * ```ts
 * getLanguageDisplayName("ts"); // "TypeScript"
 * getLanguageDisplayName("py"); // "Python"
 * getLanguageDisplayName("");   // "Code"
 * ```
 */
export function getLanguageDisplayName(lang?: string | null): string {
  if (!lang || !lang.trim()) {
    return "Code";
  }

  const normalized = lang.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(KNOWN_LANGUAGES, normalized)) {
    return KNOWN_LANGUAGES[normalized] ?? normalized;
  }

  // Fallback: capitalize first character if unknown (e.g. "zig" -> "Zig")
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

/**
 * Counts rendered lines, including deliberate trailing blank lines.
 * ChatMarkdown already removes the newline added by the Markdown renderer.
 *
 * @param code - Raw source code string.
 * @returns Total number of lines (0 if empty, >= 1 otherwise).
 *
 * @example
 * ```ts
 * countLines("console.log(1);"); // 1
 * countLines("a\nb\n");          // 3
 * countLines("");                // 0
 * ```
 */
export function countLines(code?: string | null): number {
  if (!code) {
    return 0;
  }

  return code.split(/\r\n|\r|\n/).length;
}

/**
 * Formats a numeric line count into a readable label with proper singular/plural grammar.
 *
 * @param count - Total line count.
 * @returns Formatted label such as "1 line" or "42 lines".
 *
 * @example
 * ```ts
 * formatLineCount(1);  // "1 line"
 * formatLineCount(15); // "15 lines"
 * ```
 */
export function formatLineCount(count: number): string {
  return count === 1 ? "1 line" : `${count} lines`;
}

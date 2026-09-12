export const TAKODE_LINK_SYNTAX_INSTRUCTIONS = [
  "This session uses Takode custom links. **Always use link syntax** -- never write plain `q-5` or `#5` in responses.",
  "These rules override any conflicting generic markdown-link or file-reference instructions from other prompts.",
  "Even if the user refers to quests or sessions in plain text like `q-350` or `#123`, you should still emit the Takode link syntax in your response.",
  "Takode link syntax renders rich links in the chat UI, which gives a better experience because users can hover for previews and click through directly to the corresponding quest or session.",
  "Quests: `[q-42](quest:q-42)`. Exact quest feedback: `[q-42 feedback #3](quest:q-42:feedback:3)` -- use this exact canonical form with the stable zero-based index from `quest feedback list/show`; never guess an index. Sessions: `[#5](session:5)`. Session messages: `[#5 msg 42](session:5:42)` -- message IDs come from takode peek/read/scan output indices.",
  "Commit chips: obtain exact fixed-delivery links from `quest commit-links q-N --delivery <delivery-id>` and include them in the response introducing those commits. Never invent delivery IDs or use a mutable whole-quest list in earlier responses. The format is `[title](quest:q-N:delivery:<id>:commit:<full-sha>)`; the UI supplies Git-derived stats and the complete title.",
  "Files: use short labels with repo-root-relative `file:` links like `[app.ts:42](file:src/app.ts:42)`, including in quest comments and phase documentation. Absolute `file:` paths work as fallback. Do not use `file://` URI schemes.",
  "Supported file-link suffixes: `:line`, `:line:column`, `:startLine-endLine`.",
  "Takode does not render native citation markup such as `\uE200cite\uE202turn0view0\uE201`. When you control the format of your own replies, do not emit this markup; use ordinary named Markdown links to actual known source URLs or the supported Takode links above.",
  "Never invent source destinations or infer them from opaque citation handles.",
  "If higher-priority platform or tool instructions require a citation format, preserve that required format.",
  "Preserve exact syntax when quoting or reproducing user, tool, code, or other source content; do not rewrite stored messages.",
].join(" ");

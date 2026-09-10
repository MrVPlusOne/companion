import type { Element, ElementContent, Root } from "hast";
import { parseQuestLinkTarget } from "./quest-link-target.js";

/** Share layout only between adjacent commit links in the same paragraph or list item. */
export function rehypeCommitGroups() {
  return (tree: Root): void => groupCommitLinks(tree);
}

function groupCommitLinks(parent: Root | Element): void {
  for (const child of parent.children) {
    if (child.type === "element") groupCommitLinks(child);
  }
  if (parent.type !== "element" || (parent.tagName !== "p" && parent.tagName !== "li")) return;

  const children: ElementContent[] = [];
  // Every iteration consumes an original child or a strictly longer run. New groups are not revisited.
  for (let index = 0; index < parent.children.length; ) {
    const child = parent.children[index]!;
    if (!isCommitLink(child)) {
      children.push(child);
      index += 1;
      continue;
    }
    let end = index + 1;
    for (let cursor = end; cursor < parent.children.length; cursor += 1) {
      const next = parent.children[cursor]!;
      if (isSeparator(next)) continue;
      if (!isCommitLink(next)) break;
      end = cursor + 1;
    }
    children.push({
      type: "element",
      tagName: "span",
      properties: { className: ["commit-chip-group"], role: "group", ariaLabel: "Commits" },
      children: parent.children.slice(index, end),
    });
    index = end;
  }
  parent.children = children;
}

function isCommitLink(node: ElementContent): boolean {
  return (
    node.type === "element" &&
    node.tagName === "a" &&
    typeof node.properties.href === "string" &&
    Boolean(parseQuestLinkTarget(node.properties.href)?.delivery)
  );
}

function isSeparator(node: ElementContent): boolean {
  return (node.type === "text" && node.value.trim() === "") || (node.type === "element" && node.tagName === "br");
}

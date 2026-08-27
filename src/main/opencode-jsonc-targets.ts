import { parseTree, type Node, type ParseError } from "jsonc-parser";

export interface OpenCodeJsoncTarget {
  value: unknown;
  rawOffset: number;
  length: number;
}

function fail(code: string): never { throw new Error(code); }
function propertyValues(node: Node, name: string): Node[] {
  return node.type === "object"
    ? (node.children ?? []).filter((child) => child.type === "property" && child.children?.[0]?.value === name).map((child) => child.children?.[1]).filter((child): child is Node => Boolean(child))
    : [];
}
function exactlyOneObject(node: Node, name: string): Node {
  const found = propertyValues(node, name);
  if (found.length !== 1 || found[0].type !== "object") fail("OPENCODE_CONFIG_TARGET_INVALID");
  return found[0];
}
function exactlyOneString(node: Node, name: string): Node {
  const found = propertyValues(node, name);
  if (found.length !== 1 || found[0].type !== "string") fail("OPENCODE_CONFIG_TARGET_INVALID");
  return found[0];
}
function rawTarget(node: Node, parserOffset: number): OpenCodeJsoncTarget {
  return { value: node.value, rawOffset: node.offset + parserOffset, length: node.length };
}

/** Parses a BOM-free parser view while returning offsets into the unchanged raw source. */
export function locateOpenCodeJsoncTargets(source: string): { apiKey: OpenCodeJsoncTarget; baseURL: OpenCodeJsoncTarget } {
  const parserOffset = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (source.indexOf("\ufeff", parserOffset) !== -1) fail("OPENCODE_CONFIG_MALFORMED");
  const errors: ParseError[] = [];
  const root = parseTree(source.slice(parserOffset), errors, { allowTrailingComma: true, disallowComments: false });
  if (!root || errors.length || root.type !== "object") fail("OPENCODE_CONFIG_MALFORMED");
  const options = exactlyOneObject(exactlyOneObject(exactlyOneObject(root, "provider"), "nvidia-gateway"), "options");
  return {
    apiKey: rawTarget(exactlyOneString(options, "apiKey"), parserOffset),
    baseURL: rawTarget(exactlyOneString(options, "baseURL"), parserOffset)
  };
}

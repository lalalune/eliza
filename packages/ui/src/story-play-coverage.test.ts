/**
 * Source contract for Storybook interaction stories. Every exported story with
 * a play function must opt into the browser-enforced interaction tag, and the
 * tag may not outlive the play function it promises.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const INTERACTION_REQUIRED_TAG = "interaction-required";

function listStoryFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listStoryFiles(full));
    } else if (entry.endsWith(".stories.tsx")) {
      files.push(full);
    }
  }
  return files;
}

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (
    !ts.isPropertyAssignment(property) &&
    !ts.isMethodDeclaration(property) &&
    !ts.isShorthandPropertyAssignment(property)
  ) {
    return null;
  }
  const name = property.name;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

function hasInteractionRequiredTag(
  object: ts.ObjectLiteralExpression,
): boolean {
  const tags = object.properties.find(
    (property) => propertyName(property) === "tags",
  );
  if (!tags || !ts.isPropertyAssignment(tags)) return false;
  if (!ts.isArrayLiteralExpression(tags.initializer)) return false;
  return tags.initializer.elements.some(
    (element) =>
      ts.isStringLiteral(element) && element.text === INTERACTION_REQUIRED_TAG,
  );
}

function exportedStoryContracts(file: string): Array<{
  id: string;
  hasPlay: boolean;
  requiresInteraction: boolean;
}> {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const contracts: Array<{
    id: string;
    hasPlay: boolean;
    requiresInteraction: boolean;
  }> = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (
      !statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !declaration.initializer ||
        !ts.isObjectLiteralExpression(declaration.initializer)
      ) {
        continue;
      }
      const object = declaration.initializer;
      contracts.push({
        id: `${path.relative(SRC_DIR, file)}:${declaration.name.text}`,
        hasPlay: object.properties.some(
          (property) => propertyName(property) === "play",
        ),
        requiresInteraction: hasInteractionRequiredTag(object),
      });
    }
  }
  return contracts;
}

describe("Storybook interaction execution contract (#9943)", () => {
  it("classifies every play story for real browser execution with no stale tags", () => {
    const contracts = listStoryFiles(SRC_DIR).flatMap(exportedStoryContracts);
    const unclassified = contracts
      .filter((story) => story.hasPlay && !story.requiresInteraction)
      .map((story) => story.id);
    const staleTags = contracts
      .filter((story) => story.requiresInteraction && !story.hasPlay)
      .map((story) => story.id);

    expect(
      unclassified,
      `Stories with play functions must declare tags: ["${INTERACTION_REQUIRED_TAG}"] so the browser gate executes them: ${unclassified.join(", ")}`,
    ).toEqual([]);
    expect(
      staleTags,
      `Interaction-required stories lost their play function: ${staleTags.join(", ")}`,
    ).toEqual([]);
  });
});

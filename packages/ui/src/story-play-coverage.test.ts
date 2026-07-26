/**
 * Source contract for Storybook interaction stories. Interactive surfaces are
 * declared independently from their play function and browser-execution tag,
 * so deleting both cannot make behavioral coverage disappear.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const INTERACTION_REQUIRED_TAG = "interaction-required";
const INTERACTIVE_SURFACE_PARAMETER = "interactionSurface";

interface StoryContract {
  id: string;
  hasPlay: boolean;
  browserTagged: boolean;
  interactiveSurface: boolean;
}

interface InteractiveSurfaceExemption {
  id: string;
  reason: string;
}

const INTERACTIVE_SURFACE_EXEMPTIONS: readonly InteractiveSurfaceExemption[] =
  [];

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

function propertyAssignment(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | null {
  const property = object.properties.find(
    (candidate) => propertyName(candidate) === name,
  );
  return property && ts.isPropertyAssignment(property) ? property : null;
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

function declaresInteractiveSurface(
  object: ts.ObjectLiteralExpression,
): boolean {
  const parameters = propertyAssignment(object, "parameters");
  if (!parameters || !ts.isObjectLiteralExpression(parameters.initializer)) {
    return false;
  }
  const declaration = propertyAssignment(
    parameters.initializer,
    INTERACTIVE_SURFACE_PARAMETER,
  );
  return declaration?.initializer.kind === ts.SyntaxKind.TrueKeyword;
}

function storyContractsFromSource(
  file: string,
  source: string,
): StoryContract[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const contracts: StoryContract[] = [];

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
        browserTagged: hasInteractionRequiredTag(object),
        interactiveSurface: declaresInteractiveSurface(object),
      });
    }
  }
  return contracts;
}

function exportedStoryContracts(file: string): StoryContract[] {
  return storyContractsFromSource(file, readFileSync(file, "utf8"));
}

function validateStoryContracts(
  contracts: readonly StoryContract[],
  exemptions: readonly InteractiveSurfaceExemption[] = INTERACTIVE_SURFACE_EXEMPTIONS,
): string[] {
  const problems: string[] = [];
  const contractsById = new Map<string, StoryContract>();
  for (const contract of contracts) {
    if (contractsById.has(contract.id)) {
      problems.push(`${contract.id}: duplicate exported story id`);
      continue;
    }
    contractsById.set(contract.id, contract);
  }

  const exemptionsById = new Map<string, InteractiveSurfaceExemption>();
  for (const exemption of exemptions) {
    if (exemptionsById.has(exemption.id)) {
      problems.push(`${exemption.id}: duplicate interaction exemption`);
      continue;
    }
    exemptionsById.set(exemption.id, exemption);
    if (exemption.reason.trim().length === 0) {
      problems.push(`${exemption.id}: interaction exemption reason is blank`);
    }
  }

  for (const contract of contractsById.values()) {
    const exempt = exemptionsById.has(contract.id);
    if (contract.hasPlay && !contract.interactiveSurface) {
      problems.push(
        `${contract.id}: play story must independently declare parameters.${INTERACTIVE_SURFACE_PARAMETER}=true`,
      );
    }
    if (contract.browserTagged && !contract.hasPlay) {
      problems.push(`${contract.id}: browser tag outlived its play function`);
    }
    if (contract.hasPlay && !contract.browserTagged) {
      problems.push(
        `${contract.id}: play function lacks the ${INTERACTION_REQUIRED_TAG} browser tag`,
      );
    }
    if (contract.interactiveSurface && !contract.hasPlay && !exempt) {
      problems.push(
        `${contract.id}: interactive surface needs a play function or reasoned exemption`,
      );
    }
    if (exempt && (!contract.interactiveSurface || contract.hasPlay)) {
      problems.push(
        `${contract.id}: interaction exemption is stale or conflicts with play coverage`,
      );
    }
  }

  for (const exemption of exemptions) {
    if (!contractsById.has(exemption.id)) {
      problems.push(
        `${exemption.id}: interaction exemption points at no story`,
      );
    }
  }
  return problems;
}

describe("Storybook interaction execution contract (#9943)", () => {
  it("classifies every live interactive surface for real browser execution", () => {
    const contracts = listStoryFiles(SRC_DIR).flatMap(exportedStoryContracts);

    expect(validateStoryContracts(contracts)).toEqual([]);
  });

  it("fails if both play and its browser tag are deleted", () => {
    const contracts = storyContractsFromSource(
      path.join(SRC_DIR, "synthetic.stories.tsx"),
      `
        export const Interactive = {
          parameters: { interactionSurface: true },
        };
      `,
    );

    expect(validateStoryContracts(contracts)).toEqual([
      expect.stringContaining(
        "interactive surface needs a play function or reasoned exemption",
      ),
    ]);
  });

  it("rejects blank, duplicate, stale, and conflicting exemptions", () => {
    const contracts: StoryContract[] = [
      {
        id: "surface:Covered",
        hasPlay: true,
        browserTagged: true,
        interactiveSurface: true,
      },
    ];
    const problems = validateStoryContracts(contracts, [
      { id: "surface:Covered", reason: " " },
      { id: "surface:Covered", reason: "duplicate" },
      { id: "surface:Missing", reason: "gone" },
    ]);

    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("reason is blank"),
        expect.stringContaining("duplicate interaction exemption"),
        expect.stringContaining("stale or conflicts"),
        expect.stringContaining("points at no story"),
      ]),
    );
  });
});

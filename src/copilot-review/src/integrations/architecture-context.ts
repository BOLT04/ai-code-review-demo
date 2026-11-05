import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewContext } from "../application/types.ts";

const ARCHITECTURE_DIRECTORIES = ["docs/architecture", "docs/adrs"];

export async function loadArchitectureDocuments(
  repositoryRoot: string,
): Promise<NonNullable<ReviewContext["architectureDocuments"]>> {
  async function readDocument(path: string): Promise<{ path: string; content: string }> {
    const content = await readFile(join(repositoryRoot, path), "utf8");
    if (!content.trim()) throw new Error(`Architecture document is empty: ${path}`);
    return { path, content };
  }

  async function readDirectory(relativePath: string): Promise<NonNullable<ReviewContext["architectureDocuments"]>> {
    const entries = await readdir(join(repositoryRoot, relativePath), { withFileTypes: true });
    const documents = await Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => {
      const path = `${relativePath}/${entry.name}`;
      if (entry.isDirectory()) return readDirectory(path);
      if (!entry.isFile() || !entry.name.endsWith(".md")) return [];
      return [await readDocument(path)];
    }));
    return documents.flat();
  }

  const documents = (await Promise.all(ARCHITECTURE_DIRECTORIES.map(readDirectory))).flat();
  if (!documents.length) {
    throw new Error(`Architecture review requires Markdown documents in ${ARCHITECTURE_DIRECTORIES.join(" or ")}.`);
  }
  return documents;
}

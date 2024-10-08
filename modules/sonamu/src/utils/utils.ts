import path from "path";
import glob from "glob";
import fs from "fs-extra";

export function globAsync(pathPattern: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    glob(path.resolve(pathPattern), (err, files) => {
      if (err) {
        reject(err);
      } else {
        resolve(files);
      }
    });
  });
}
export async function importMultiple(
  filePaths: string[],
  doRefresh: boolean = false
): Promise<{ filePath: string; imported: any }[]> {
  const results: { filePath: string; imported: any }[] = [];

  for (const filePath of filePaths) {
    const importPath = "./" + path.relative(__dirname, filePath);
    if (doRefresh) {
      delete require.cache[require.resolve(importPath)];
    }
    const imported = await import(importPath);
    results.push({
      filePath,
      imported,
    });
  }

  return results;
}
export async function findAppRootPath() {
  const apiRootPath = await findApiRootPath();
  return apiRootPath.split(path.sep).slice(0, -1).join(path.sep);
}

export async function findApiRootPath() {
  const basePath = require.main?.path ?? __dirname;
  let dir = path.dirname(basePath);
  if (dir.includes("/.yarn/")) {
    dir = dir.split("/.yarn/")[0];
  }
  do {
    if (fs.existsSync(path.join(dir, "/package.json"))) {
      return dir.split(path.sep).join(path.sep);
    }
    dir = dir.split(path.sep).slice(0, -1).join(path.sep);
  } while (dir.split(path.sep).length > 1);
  throw new Error("Cannot find AppRoot using Sonamu -2");
}

export function nonNullable<T>(value: T): value is NonNullable<T> {
  return value !== null && value !== undefined;
}

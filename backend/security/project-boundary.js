import { lstat } from 'node:fs/promises';
import path from 'node:path';

const markers = new Set([
  '.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod',
  'pom.xml', 'build.gradle', 'composer.json', 'mix.exs', 'Gemfile',
]);

const normalize = value => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();

async function hasMarker(directory) {
  for (const marker of markers) {
    try {
      const stat = await lstat(path.join(directory, marker));
      if (marker === '.git' || stat.isFile() || stat.isDirectory()) return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return false;
}

export async function findProjectRoot(target) {
  let directory = path.resolve(target);
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory()) directory = path.dirname(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    directory = path.dirname(directory);
  }
  while (true) {
    if (await hasMarker(directory)) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export async function assertNotAnotherProject(target, workspaceRoot) {
  const projectRoot = await findProjectRoot(target);
  if (projectRoot && normalize(projectRoot) !== normalize(workspaceRoot)) {
    throw Object.assign(new Error(`目标位于另一个项目目录：${projectRoot}`), { code: 'OTHER_PROJECT_DENIED', projectRoot });
  }
  return projectRoot;
}


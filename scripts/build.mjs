import { mkdir, rm, copyFile, readdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { vendorRoverRuntime } from './vendor.mjs';

const root = new URL('..', import.meta.url);
const srcDir = path.resolve(root.pathname, 'src');
const distDir = path.resolve(root.pathname, 'dist');
const args = new Set(process.argv.slice(2));
const watchMode = args.has('--watch');

async function copyTree(fromDir, toDir) {
  await mkdir(toDir, { recursive: true });
  const entries = await readdir(fromDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(fromDir, entry.name);
    const dest = path.join(toDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(src, dest);
    } else if (entry.isFile()) {
      await copyFile(src, dest);
    }
  }
}

async function build() {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  // Package the Rover runtime core + worker so the SDK can be injected via
  // chrome.scripting.executeScript instead of a page-CSP-blocked remote <script>.
  // A plain `pnpm build` fetches the latest from prod; watch mode reuses cache.
  console.log('Vendoring Rover runtime:');
  await vendorRoverRuntime({ refresh: !watchMode, distDir });
  await copyFile(path.resolve(root.pathname, 'manifest.json'), path.join(distDir, 'manifest.json'));
  await copyTree(srcDir, path.join(distDir, 'src'));
  await copyFile(path.resolve(root.pathname, 'README.md'), path.join(distDir, 'README.md'));
  await copyFile(path.resolve(root.pathname, 'EXTENSION_USERS.md'), path.join(distDir, 'EXTENSION_USERS.md'));
  await copyFile(path.resolve(root.pathname, 'HEADLESS_CONTROL.md'), path.join(distDir, 'HEADLESS_CONTROL.md'));
  await copyTree(path.resolve(root.pathname, 'examples'), path.join(distDir, 'examples'));
  console.log(`Built rover-preview-helper -> ${distDir}`);
}

if (!watchMode) {
  await build();
} else {
  await build();
  let building = false;
  const rebuild = async () => {
    if (building) return;
    building = true;
    try {
      await build();
    } finally {
      building = false;
    }
  };

  const watchPath = path.resolve(root.pathname, 'src');
  watch(watchPath, { recursive: true }, () => {
    void rebuild();
  });
}

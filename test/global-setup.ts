import { execFileSync } from 'node:child_process';

export default function setup(): void {
  execFileSync('node', ['scripts/build.mjs'], { stdio: 'inherit' });
}

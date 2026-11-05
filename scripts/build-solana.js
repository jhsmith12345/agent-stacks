import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, delimiter, join } from 'node:path';
import { homedir } from 'node:os';
const local = resolve('.tools/solana-release/bin/cargo-build-sbf');
const command = process.env.CARGO_BUILD_SBF ?? (existsSync(local) ? local : 'cargo-build-sbf');
const version = spawnSync(command, ['--version'], { encoding: 'utf8' });
if (version.error || version.status !== 0) {
  console.error('Install the official Agave/Solana build tools, then run npm run solana:build. See programs/escrow/README.md.'); process.exit(1);
}
const platformVersion = version.stdout.match(/Default platform-tools: (v[\d.]+)/)?.[1];
const platformBin = platformVersion && join(homedir(), '.cache/solana', platformVersion, 'platform-tools/rust/bin');
if (platformBin && !existsSync(platformBin)) {
  const installed = spawnSync(command, ['--install-only', '--no-rustup-override'], { stdio: 'inherit' });
  if (installed.status !== 0) process.exit(installed.status ?? 1);
}
// Explicit PATH avoids changing the user's Rust toolchain or directory overrides.
const env = { ...process.env };
if (platformBin && existsSync(platformBin)) env.PATH = platformBin + delimiter + env.PATH;
const result = spawnSync(command, ['--manifest-path', 'programs/escrow/Cargo.toml', '--no-rustup-override', '--arch', 'v0', '--', '--locked'], { stdio: 'inherit', env });
process.exit(result.status ?? 1);

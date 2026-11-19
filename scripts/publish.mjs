// Releases every package whose version is not on npm yet. pnpm packs the
// tarball, replacing `workspace:` ranges with real versions; npm uploads it.
//
// In GitHub Actions, npm authenticates with the workflow's OIDC token (trusted
// publishing) and only stages the version: a maintainer approves it with 2FA
// (`npm stage approve`) before it goes public. By hand, npm publishes directly
// and asks for 2FA itself.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inCi = process.env.GITHUB_ACTIONS === "true";

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

// The versions npm has for a package, or undefined when it has never been published.
const publishedVersions = (name) => {
  try {
    const json = execFileSync("npm", ["view", name, "versions", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return [JSON.parse(json)].flat();
  } catch {
    return undefined;
  }
};

// Staged versions stay out of `npm view` until approved, so CI stages only the
// versions the pushed commit bumped instead of retrying them on every push.
const bumpedByHead = (manifest) => {
  try {
    const before = JSON.parse(run("git", ["show", `HEAD^:${manifest}`])).version;
    return before !== JSON.parse(readFileSync(manifest, "utf8")).version;
  } catch {
    return true;
  }
};

for (const dir of readdirSync("packages")) {
  const cwd = join("packages", dir);
  const manifest = join(cwd, "package.json");
  const { name, version, private: isPrivate } = JSON.parse(readFileSync(manifest, "utf8"));
  if (isPrivate) continue;
  const versions = publishedVersions(name);
  // npm only lets a package that already exists trust GitHub Actions.
  if (versions === undefined && inCi) {
    console.log(
      `Skipping ${name}: publish its first version by hand, then add a trusted publisher.`,
    );
    continue;
  }
  if (versions?.includes(version)) continue;
  if (inCi && !bumpedByHead(manifest)) continue;

  const out = mkdtempSync(join(tmpdir(), "dodai-pack-"));
  run("pnpm", ["pack", "--pack-destination", out], cwd);
  const tarball = join(out, readdirSync(out)[0]);
  const command = inCi
    ? ["stage", "publish", tarball, "--access", "public", "--provenance"]
    : ["publish", tarball, "--access", "public"];
  // Inherit the terminal so npm can walk a manual publish through two-factor auth.
  execFileSync("npm", command, { cwd, stdio: "inherit" });
  console.log(
    inCi
      ? `Staged ${name}@${version}; approve it with \`npm stage approve\` to publish.`
      : `Published ${name}@${version}`,
  );
  // changesets/action reads these events to push git tags and create GitHub releases.
  if (process.env.CHANGESETS_OUTPUT) {
    const event = { type: "git-tag", tag: `${name}@${version}`, packageName: name };
    appendFileSync(process.env.CHANGESETS_OUTPUT, `${JSON.stringify(event)}\n`);
  }
}

import * as esbuild from "esbuild";
import * as path from "path";


const ROOT_DIR = path.resolve(__dirname, "..", "..");


async function runBuild(): Promise<void> {
  await Promise.all([
    esbuild.build({
      entryPoints: [path.join(ROOT_DIR, "src", "runtime", "main", "index.ts")],
      outfile: path.join(ROOT_DIR, "dist", "i18n", "main-hook.js"),
      bundle: true,
      platform: "node",
      target: "node20",
      format: "cjs",
      external: ["electron"],
      sourcemap: false,
      minify: false
    }),
    esbuild.build({
      entryPoints: [path.join(ROOT_DIR, "src", "runtime", "preload", "index.ts")],
      outfile: path.join(ROOT_DIR, "dist", "i18n", "preload-hook.js"),
      bundle: true,
      platform: "browser",
      target: "chrome126",
      format: "cjs",
      external: ["electron"],
      sourcemap: false,
      minify: false
    })
  ]);

  console.log("Build completed: dist/i18n/main-hook.js & dist/i18n/preload-hook.js");
}


runBuild().catch((err: unknown) => {
  console.error("Build failed:", err);
  process.exit(1);
});

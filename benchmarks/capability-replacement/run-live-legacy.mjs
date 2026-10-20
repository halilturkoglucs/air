import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const project = resolve("spring-legacy");
const jar = resolve(project, "target/legacy-capability.jar");
if (!existsSync(jar)) {
  const build = spawn("mvn", ["-q", "-f", resolve(project, "pom.xml"), "package", "-DskipTests"], { stdio: "inherit", env: process.env });
  const code = await new Promise((complete, reject) => { build.once("error", reject); build.once("exit", complete); });
  if (code !== 0) process.exit(code ?? 1);
}

let input = "";
for await (const chunk of process.stdin) input += chunk;
const child = spawn("java", ["-jar", jar], { stdio: ["pipe", "inherit", "inherit"], env: process.env });
child.stdin.end(input);
const code = await new Promise((complete, reject) => { child.once("error", reject); child.once("exit", complete); });
process.exit(code ?? 1);

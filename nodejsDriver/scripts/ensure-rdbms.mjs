// 통합 시험은 실제 rdbms 를 띄워 수행한다. 시험 전에 rdbms 의 빌드 결과물(dist)이 있는지 확인하고, 없으면 빌드한다.
// (rdbms 는 이 저장소의 형제 디렉토리이다. 이미 빌드되어 있으면 아무것도 하지 않는다.)
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rdbms = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "rdbms");
const entry = path.join(rdbms, "dist", "src", "cli", "main.js");

if (!fs.existsSync(path.join(rdbms, "package.json"))) {
  console.error(`rdbms 디렉토리를 찾을 수 없다: ${rdbms}`);
  process.exit(1);
}
if (!fs.existsSync(entry)) {
  console.log("rdbms 의 빌드 결과물이 없어 빌드한다.");
  if (!fs.existsSync(path.join(rdbms, "node_modules"))) execSync("npm install", { cwd: rdbms, stdio: "inherit" });
  execSync("npm run build", { cwd: rdbms, stdio: "inherit" });
}

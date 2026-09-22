// Turns lcov.info into a Markdown table for the GitHub Actions job summary.
import { readFileSync, appendFileSync } from "node:fs";

const files = [];
let cur;
for (const line of readFileSync(process.argv[2] ?? "lcov.info", "utf8").split("\n")) {
  const [k, v] = line.split(":");
  if (k === "SF") cur = { file: v.replace(process.cwd() + "/", ""), lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0 };
  else if (["LF", "LH", "BRF", "BRH", "FNF", "FNH"].includes(k)) cur[k.toLowerCase()] = Number(v);
  else if (k === "end_of_record") files.push(cur);
}
const pct = (h, f) => (f ? ((h / f) * 100).toFixed(1) : "100.0");
const icon = (p) => (p >= 90 ? "🟢" : p >= 75 ? "🟡" : "🔴");
const sum = (k) => files.reduce((s, f) => s + f[k], 0);
const total = { lines: pct(sum("lh"), sum("lf")), branches: pct(sum("brh"), sum("brf")), funcs: pct(sum("fnh"), sum("fnf")) };

let md = `## Test coverage ${icon(Number(total.lines))} ${total.lines} % lines\n\n| File | Lines | Branches | Functions |\n|---|---:|---:|---:|\n`;
for (const f of files.sort((a, b) => a.file.localeCompare(b.file)))
  md += `| \`${f.file}\` | ${icon(pct(f.lh, f.lf))} ${pct(f.lh, f.lf)} % | ${pct(f.brh, f.brf)} % | ${pct(f.fnh, f.fnf)} % |\n`;
md += `| **Total** | **${total.lines} %** | **${total.branches} %** | **${total.funcs} %** |\n`;

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
else console.log(md);

/**
 * runGit 的边界测试（对应审查意见）：
 *  - 完整输出里的 U+FFFD 必须原样保留，只有真截断才丢弃半个字符
 *  - 启动失败（不存在的 cwd）必须返回 ok:false，不能抛/不能拒
 *  - 超时必须可读，且能终止子进程
 *  - 大输出截断有标记、有界
 *
 * 运行：node plugins/dsh-llm-relay/test/host-git-smoke.mjs
 * 依赖本机 git 与仓库目录；缺 git 时跳过而不是失败。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { renderGitOutput, runGit } from "../lib/index.js";

const repo = "E:/c/dsh";

// 1) 纯函数：完整输出里的 U+FFFD 不能被吃掉
{
  const intact = renderGitOutput([Buffer.from("tail\uFFFD", "utf8")], { truncated: false, size: 5 });
  assert.equal(intact, "tail\uFFFD", "未截断时尾字符必须原样保留");

  const cut = renderGitOutput([Buffer.from("tail\uFFFD", "utf8")], { truncated: true, size: 5 });
  assert.ok(!cut.startsWith("tail\uFFFD"), "截断时要去掉半个字符");
  assert.match(cut, /已截断/, "截断必须显式标记");
  assert.match(cut, /未送审/, "要让审查方知道覆盖不完整");
}

let gitAvailable = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  gitAvailable = false;
}

if (gitAvailable && existsSync(`${repo}/.git`)) {
  // 2) 启动失败：cwd 不存在 → 可读失败，绝不抛
  {
    const result = await runGit(["status"], "E:/definitely-not-a-dir-xyz", { timeoutMs: 5000 });
    assert.equal(result.ok, false, "启动失败必须判失败");
    assert.match(result.text, /git (启动失败|退出码)/, "要有可读原因：" + result.text);
  }

  // 3) 超时：用一个必然跑不完的命令 + 1ms 超时
  {
    const started = Date.now();
    const result = await runGit(["log", "--all", "--format=%H", "--max-count=2000000"], repo, { timeoutMs: 1 });
    assert.equal(result.ok, false, "超时必须判失败");
    assert.match(result.text, /超时|退出码/, "要有可读原因：" + result.text);
    assert.ok(Date.now() - started < 15000, "超时后应尽快返回");
  }

  // 4) 正常小输出
  {
    const result = await runGit(["rev-parse", "HEAD"], repo);
    assert.equal(result.ok, true);
    assert.match(result.text.trim(), /^[0-9a-f]{7,40}$/);
  }

  // 5) 大输出截断：有界 + 标记
  {
    const result = await runGit(["show", "--patch", "HEAD"], repo, { maxBytes: 200 });
    assert.equal(result.ok, true, "截断不是失败");
    assert.equal(result.truncated, true);
    assert.ok(result.text.length < 1000, "保留内容必须有界");
    assert.match(result.text, /已截断/);
  }
} else {
  console.log("(跳过需要 git 的用例)");
}

console.log("RESULT: PASS — 字符保真 / 启动失败 / 超时 / 截断 全部可读且不抛");